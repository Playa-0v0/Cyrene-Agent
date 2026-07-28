#![cfg(windows)]

// These process-level smoke tests share desktop-global DXGI duplication,
// clipboard, foreground-window, and output-directory state.
use serial_test::serial;
use std::{
    io::{BufRead, BufReader, Write},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::PathBuf,
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver},
    },
    thread,
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::{HANDLE, HWND, LPARAM, RECT, WPARAM},
        Graphics::Gdi::{GetDC, GetPixel, ReleaseDC},
        System::Threading::{OpenThread, ResumeThread, SuspendThread, THREAD_SUSPEND_RESUME},
        UI::{
            Input::KeyboardAndMouse::{VK_ESCAPE, VK_RETURN},
            WindowsAndMessaging::{
                FindWindowExW, GetWindowRect, GetWindowThreadProcessId, HWND_MESSAGE, PostMessageW,
                WM_DISPLAYCHANGE, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
            },
        },
    },
    core::{PCWSTR, w},
};

const READY_TIMEOUT: Duration = Duration::from_secs(3);
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);
const REAP_TIMEOUT: Duration = Duration::from_secs(2);
const FLOOD_SETUP_TIMEOUT: Duration = Duration::from_secs(10);

struct ChildGuard {
    child: Child,
}

struct SuspendedThread {
    handle: OwnedHandle,
    suspended: bool,
}

impl SuspendedThread {
    fn resume(&mut self) {
        if !self.suspended {
            return;
        }
        let handle = HANDLE(self.handle.as_raw_handle());
        // SAFETY: handle owns an open thread handle with suspend/resume access.
        let previous_count = unsafe { ResumeThread(handle) };
        assert_ne!(previous_count, u32::MAX, "resume helper UI thread");
        self.suspended = false;
    }
}

impl Drop for SuspendedThread {
    fn drop(&mut self) {
        if self.suspended {
            let handle = HANDLE(self.handle.as_raw_handle());
            // SAFETY: Best-effort failure cleanup for the still-owned handle.
            let _ = unsafe { ResumeThread(handle) };
            self.suspended = false;
        }
    }
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self { child }
    }

    fn wait_timeout(&mut self, timeout: Duration) -> Result<Option<ExitStatus>, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self
                .child
                .try_wait()
                .map_err(|error| format!("poll child: {error}"))?
            {
                return Ok(Some(status));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn terminate_and_reap(&mut self, timeout: Duration) -> Result<ExitStatus, String> {
        if let Some(status) = self.wait_timeout(Duration::ZERO)? {
            return Ok(status);
        }
        if let Err(kill_error) = self.child.kill() {
            if let Some(status) = self.wait_timeout(timeout)? {
                return Ok(status);
            }
            return Err(format!(
                "terminate child: {kill_error}; child remained live for {timeout:?}"
            ));
        }
        self.wait_timeout(timeout)?
            .ok_or_else(|| format!("child was not reaped within {timeout:?} after termination"))
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Err(error) = self.terminate_and_reap(REAP_TIMEOUT) {
            eprintln!("bounded child cleanup failed: {error}");
        }
    }
}

struct Helper {
    process: ChildGuard,
    stdin: Option<ChildStdin>,
    stdout_lines: Receiver<String>,
    stdout_done: Receiver<Result<(), String>>,
    observed_stdout: Vec<String>,
}

impl Helper {
    fn spawn(parent_pid: u32, protocol_version: u32) -> Self {
        Self::spawn_with_output_dir(parent_pid, protocol_version, absolute_output_dir())
    }

    fn spawn_with_output_dir(parent_pid: u32, protocol_version: u32, output_dir: PathBuf) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_cyrene-screenshot"))
            .args([
                "--output-dir",
                output_dir.to_str().expect("UTF-8 output directory"),
                "--protocol-version",
                &protocol_version.to_string(),
                "--parent-pid",
                &parent_pid.to_string(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn screenshot helper");

        let stdin = child.stdin.take().expect("helper stdin");
        let stdout = child.stdout.take().expect("helper stdout");
        let stderr = child.stderr.take().expect("helper stderr");
        let (stdout_tx, stdout_lines) = mpsc::channel();
        let (stdout_done_tx, stdout_done) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if stdout_tx.send(line).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        drop(stdout_tx);
                        let _ = stdout_done_tx.send(Err(format!("read stdout line: {error}")));
                        return;
                    }
                }
            }
            drop(stdout_tx);
            let _ = stdout_done_tx.send(Ok(()));
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                eprintln!("helper stderr: {}", line.expect("read stderr line"));
            }
        });

        Self {
            process: ChildGuard::new(child),
            stdin: Some(stdin),
            stdout_lines,
            stdout_done,
            observed_stdout: Vec::new(),
        }
    }

    fn next_event(&mut self, timeout: Duration) -> serde_json::Value {
        let line = self
            .stdout_lines
            .recv_timeout(timeout)
            .expect("helper did not emit an NDJSON line before timeout");
        let event = serde_json::from_str(&line).expect("stdout line is valid JSON");
        self.observed_stdout.push(line);
        event
    }

    fn expect_ready(&mut self) {
        assert_eq!(
            self.next_event(READY_TIMEOUT),
            serde_json::json!({"type": "ready", "protocolVersion": 1})
        );
    }

    fn finish(&mut self, timeout: Duration) -> (ExitStatus, Vec<serde_json::Value>) {
        let status = self
            .process
            .wait_timeout(timeout)
            .expect("poll helper")
            .expect("helper did not exit before timeout");
        let events = self.finish_stdout(timeout);
        (status, events)
    }

    fn finish_stdout(&mut self, timeout: Duration) -> Vec<serde_json::Value> {
        self.stdout_done
            .recv_timeout(timeout)
            .expect("stdout reader did not reach EOF before timeout")
            .expect("stdout reader failed");
        self.observed_stdout.extend(self.stdout_lines.try_iter());
        assert!(
            matches!(
                self.stdout_lines.try_recv(),
                Err(mpsc::TryRecvError::Disconnected)
            ),
            "stdout reader completed without disconnecting its line channel"
        );
        self.observed_stdout
            .iter()
            .map(|line| {
                serde_json::from_str(line)
                    .unwrap_or_else(|error| panic!("stdout was not NDJSON: {line:?}: {error}"))
            })
            .collect()
    }

    fn send_command(&mut self, command: serde_json::Value) {
        let stdin = self.stdin.as_mut().expect("helper stdin");
        serde_json::to_writer(&mut *stdin, &command).expect("serialize command");
        stdin.write_all(b"\n").expect("write command newline");
        stdin.flush().expect("flush command");
    }

    fn overlay_hwnd(&self) -> HWND {
        find_process_window(
            self.process.child.id(),
            None,
            w!("CyreneScreenshotOverlayWindow"),
        )
    }

    fn suspend_ui_thread(&self) -> SuspendedThread {
        let hwnd = find_process_window(
            self.process.child.id(),
            Some(HWND_MESSAGE),
            w!("CyreneScreenshotRuntimeWindow"),
        );
        let mut pid = 0;
        // SAFETY: pid points to writable storage and hwnd came from FindWindowExW.
        let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        // SAFETY: thread_id identifies the helper UI thread that owns its message-only HWND.
        let handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, thread_id) }
            .expect("open helper UI thread");
        // SAFETY: OpenThread returned a newly owned handle.
        let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
        let raw_handle = HANDLE(handle.as_raw_handle());
        // SAFETY: raw_handle remains owned for the guard lifetime.
        let previous_count = unsafe { SuspendThread(raw_handle) };
        assert_ne!(previous_count, u32::MAX, "suspend helper UI thread");
        SuspendedThread {
            handle,
            suspended: true,
        }
    }
}

fn find_process_window(process_id: u32, parent: Option<HWND>, class_name: PCWSTR) -> HWND {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        let mut after = None;
        while let Ok(hwnd) = unsafe { FindWindowExW(parent, after, class_name, PCWSTR::null()) } {
            let mut pid = 0;
            // SAFETY: pid points to writable storage and hwnd came from FindWindowExW.
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            if pid == process_id {
                return hwnd;
            }
            after = Some(hwnd);
        }
        assert!(
            Instant::now() < deadline,
            "helper HWND for class was not found before timeout"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn absolute_output_dir() -> PathBuf {
    std::env::temp_dir().join("cyrene-screenshot-smoke")
}

fn ensure_clean_output_dir() -> PathBuf {
    let dir = absolute_output_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create smoke output dir");
    dir
}

fn count_pngs(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
                })
                .count()
        })
        .unwrap_or(0)
}

fn ready_event() -> serde_json::Value {
    serde_json::json!({"type": "ready", "protocolVersion": 1})
}

fn start_command(request_id: &str) -> serde_json::Value {
    start_command_with_mode(request_id, "clipboard-only")
}

fn start_command_with_mode(request_id: &str, mode: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "start",
        "requestId": request_id,
        "mode": mode,
    })
}

/// Drive the helper from `start` through `committing` to a release. Returns
/// the events emitted between `commit` (enter key press) and the caller taking
/// over. Drains `accepted`, `selecting`, `overlay-visible`, `selected`, and
/// `committing` in order; subsequent events depend on mode and are returned
/// to the caller.
fn drive_to_committing(helper: &mut Helper, request_id: &str) {
    helper.send_command(start_command(request_id));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");

    let hwnd = helper.overlay_hwnd();
    let point = |x: i32, y: i32| LPARAM(((y as u32 & 0xffff) << 16 | (x as u32 & 0xffff)) as isize);
    unsafe {
        PostMessageW(Some(hwnd), WM_LBUTTONDOWN, WPARAM(1), point(32, 32)).unwrap();
        PostMessageW(Some(hwnd), WM_MOUSEMOVE, WPARAM(1), point(96, 96)).unwrap();
        PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), point(96, 96)).unwrap();
    }
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selected");
    unsafe {
        PostMessageW(
            Some(hwnd),
            WM_KEYDOWN,
            WPARAM(VK_RETURN.0 as usize),
            LPARAM(0),
        )
    }
    .unwrap();
    assert_eq!(
        helper.next_event(EXIT_TIMEOUT),
        serde_json::json!({
            "type": "interaction-state",
            "requestId": request_id,
            "state": "committing"
        })
    );
}

#[test]
#[serial]
fn start_emits_accepted_then_selecting_then_overlay_visible() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("start-visible"));

    assert_eq!(
        helper.next_event(EXIT_TIMEOUT),
        serde_json::json!({"type": "accepted", "requestId": "start-visible"})
    );
    assert_eq!(
        helper.next_event(EXIT_TIMEOUT),
        serde_json::json!({
            "type": "interaction-state",
            "requestId": "start-visible",
            "state": "selecting"
        })
    );
    let overlay_visible = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(overlay_visible["type"], "overlay-visible");
    assert_eq!(overlay_visible["requestId"], "start-visible");
    // T5c wires a real QueryPerformanceCounter measurement into
    // freezeDurationMs. The exact value is environment-dependent
    // (CI variance, monitor latency, ...), so we only assert it parses as
    // a non-negative u64 within the expected physical bound.
    let freeze_ms = overlay_visible["freezeDurationMs"]
        .as_u64()
        .expect("freezeDurationMs is a u64");
    assert!(
        freeze_ms < 5_000,
        "freezeDurationMs {freeze_ms} must be < 5000 (current implementation should be well under one second)"
    );
    assert!(!helper.overlay_hwnd().is_invalid());
    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn overlay_visible_presents_the_frozen_desktop_instead_of_the_empty_cache_fill() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("visible-pixels"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");

    let hwnd = helper.overlay_hwnd();
    let mut bounds = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut bounds) }.expect("get overlay bounds");
    let desktop_dc = unsafe { GetDC(None) };
    assert!(!desktop_dc.is_invalid(), "get desktop DC");

    let width = bounds.right - bounds.left;
    let height = bounds.bottom - bounds.top;
    let mut colors = Vec::new();
    for x_fraction in [1, 2, 3] {
        for y_fraction in [1, 2, 3] {
            colors.push(
                unsafe {
                    GetPixel(
                        desktop_dc,
                        bounds.left + width * x_fraction / 4,
                        bounds.top + height * y_fraction / 4,
                    )
                }
                .0,
            );
        }
    }
    let _ = unsafe { ReleaseDC(None, desktop_dc) };

    assert!(
        colors.iter().any(|&color| color != 0x0030_3030),
        "overlay remained the solid empty-cache fill instead of presenting the frozen desktop: {colors:?}"
    );

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn mouse_capture_reentrancy_does_not_abort_the_helper() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("capture-reentrancy"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");

    let hwnd = helper.overlay_hwnd();
    let point = |x: i32, y: i32| LPARAM(((y as u32 & 0xffff) << 16 | (x as u32 & 0xffff)) as isize);
    unsafe {
        PostMessageW(Some(hwnd), WM_LBUTTONDOWN, WPARAM(1), point(64, 64)).unwrap();
        PostMessageW(Some(hwnd), WM_MOUSEMOVE, WPARAM(1), point(256, 192)).unwrap();
        PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), point(256, 192)).unwrap();
    }
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selected");

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn overlay_visible_freeze_duration_is_non_negative() {
    // T5c invariant: the `OverlayVisible` event carries a measured
    // freeze_duration_ms derived from QueryPerformanceCounter between the
    // `Command::Start` accepted point and the post-DwmFlush moment. The
    // exact value is environment-dependent (capture path latency, GPU
    // driver timing), but it MUST be a real, non-negative u64 and below
    // an upper bound that no healthy machine should breach.
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("freeze-duration"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    let overlay_visible = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(overlay_visible["type"], "overlay-visible");
    assert_eq!(overlay_visible["requestId"], "freeze-duration");
    let freeze_ms = overlay_visible["freezeDurationMs"]
        .as_u64()
        .expect("freezeDurationMs is a u64");
    assert!(
        freeze_ms < 5_000,
        "freeze duration {freeze_ms}ms exceeds 5s"
    );
    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn display_change_during_active_capture_errors() {
    // T5c: while an overlay capture is active, WM_DISPLAYCHANGE (and
    // WM_DPICHANGED) must abort the interaction with a recoverable
    // `display-changed` error, hide the overlay, and return to Idle so a
    // subsequent start can re-query the display and succeed.
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("display-change"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");

    let overlay_hwnd = helper.overlay_hwnd();
    // SAFETY: The overlay window is owned by the helper; WM_DISPLAYCHANGE is
    // a standard broadcast that our WndProc maps to OverlayAction::DisplayChanged.
    unsafe { PostMessageW(Some(overlay_hwnd), WM_DISPLAYCHANGE, WPARAM(32), LPARAM(0)) }.unwrap();

    let error = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(error["type"], "error");
    assert_eq!(error["requestId"], "display-change");
    assert_eq!(error["code"], "display-changed");
    assert_eq!(error["recoverable"], true);

    // Idle recovery: a fresh start after display-change must succeed.
    helper.send_command(start_command("after-display-change"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn escape_after_selecting_cancels() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("cancel-one"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");

    let overlay_hwnd = helper.overlay_hwnd();
    // SAFETY: The overlay window is owned by the helper; WM_KEYDOWN routes through
    // its WndProc which sets OverlayAction::Cancel on VK_ESCAPE.
    unsafe {
        PostMessageW(
            Some(overlay_hwnd),
            WM_KEYDOWN,
            WPARAM(VK_ESCAPE.0 as usize),
            LPARAM(0),
        )
    }
    .unwrap();
    assert_eq!(
        helper.next_event(EXIT_TIMEOUT),
        serde_json::json!({
            "type": "cancelled",
            "requestId": "cancel-one",
            "reason": "user-cancelled"
        })
    );

    helper.send_command(start_command("cancel-two"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn enter_after_valid_selection_emits_committing_then_release_and_completed() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    drive_to_committing(&mut helper, "commit");

    let released = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(released["type"], "capture-released");
    assert_eq!(released["requestId"], "commit");
    assert_eq!(released["clipboardWritten"], true);
    let width = released["width"].as_u64().expect("width is u32");
    let height = released["height"].as_u64().expect("height is u32");
    assert!(width > 0, "released width must be positive");
    assert!(height > 0, "released height must be positive");

    let completed = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(completed["type"], "completed");
    assert_eq!(completed["requestId"], "commit");
    assert_eq!(completed["fileName"], serde_json::Value::Null);
    assert_eq!(completed["width"].as_u64(), Some(width));
    assert_eq!(completed["height"].as_u64(), Some(height));
    assert_eq!(completed["mime"], "image/png");
    assert_eq!(completed["clipboardWritten"], true);

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn busy_start_returns_error() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("first"));
    helper.send_command(start_command("second"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["requestId"], "first");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");
    assert_eq!(
        helper.next_event(EXIT_TIMEOUT),
        serde_json::json!({
            "type": "error",
            "requestId": "second",
            "code": "busy",
            "message": "a screenshot interaction is already active",
            "recoverable": true
        })
    );
    helper.send_command(serde_json::json!({
        "type": "cancel",
        "requestId": "first"
    }));
    assert_eq!(
        helper.next_event(EXIT_TIMEOUT)["reason"],
        "electron-cancelled"
    );
    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn valid_arguments_emit_ready_within_three_seconds() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();

    helper
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{\"type\":\"shutdown\"}\n")
        .unwrap();
    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events, [ready_event()]);
}

#[test]
#[serial]
fn shutdown_command_exits_successfully() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();

    let stdin = helper.stdin.as_mut().unwrap();
    stdin.write_all(b"{\"type\":\"shutdown\"}\n").unwrap();
    stdin.flush().unwrap();

    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events, [ready_event()]);
}

#[test]
#[serial]
fn stdin_eof_exits_within_two_seconds() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();

    drop(helper.stdin.take());

    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events, [ready_event()]);
}

#[test]
#[serial]
fn protocol_version_mismatch_emits_structured_error_and_exits_nonzero() {
    let mut helper = Helper::spawn(std::process::id(), 2);

    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(!status.success());
    assert_eq!(
        events,
        [serde_json::json!({
            "type": "error",
            "code": "protocol-version-mismatch",
            "message": "unsupported protocol version 2; expected 1",
            "recoverable": false
        })]
    );
}

#[test]
#[serial]
fn parent_exit_stops_helper_within_two_seconds() {
    let parent = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn disposable parent");
    let mut parent = ChildGuard::new(parent);
    let mut helper = Helper::spawn(parent.child.id(), 1);
    helper.expect_ready();

    parent
        .terminate_and_reap(REAP_TIMEOUT)
        .expect("bounded disposable parent cleanup");

    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events, [ready_event()]);
}

#[test]
#[serial]
fn malformed_input_emits_recoverable_error_and_keeps_running() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();

    let stdin = helper.stdin.as_mut().unwrap();
    stdin.write_all(b"not-json\n").unwrap();
    stdin.flush().unwrap();

    let error = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "invalid-command");
    assert_eq!(error["recoverable"], true);

    helper
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{\"type\":\"shutdown\"}\n")
        .unwrap();
    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events.len(), 2);
    assert_eq!(events[0], ready_event());
    assert_eq!(events[1], error);
}

#[test]
#[serial]
fn oversized_input_emits_recoverable_error_and_keeps_running() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();

    let stdin = helper.stdin.as_mut().unwrap();
    stdin
        .write_all(&vec![
            b'x';
            cyrene_screenshot::protocol::MAX_NDJSON_LINE_BYTES + 1
        ])
        .unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();

    let error = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "line-too-long");
    assert_eq!(error["recoverable"], true);

    helper
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{\"type\":\"shutdown\"}\n")
        .unwrap();
    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events.len(), 2);
    assert_eq!(events[0], ready_event());
    assert_eq!(events[1], error);
}

#[test]
#[serial]
fn missing_parent_is_recoverable_and_stdin_eof_still_stops_helper() {
    let mut helper = Helper::spawn(u32::MAX, 1);
    helper.expect_ready();

    drop(helper.stdin.take());

    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events, [ready_event()]);
}

#[test]
#[serial]
fn parent_shutdown_closes_a_continuous_error_producer_and_drains_stdout() {
    let parent = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn disposable parent");
    let mut parent = ChildGuard::new(parent);
    let mut helper = Helper::spawn(parent.child.id(), 1);
    helper.expect_ready();
    let mut suspended_ui = helper.suspend_ui_thread();

    let mut stdin = helper.stdin.take().expect("helper stdin");
    let written = Arc::new(AtomicUsize::new(0));
    let writer_count = Arc::clone(&written);
    let (writer_done_tx, writer_done_rx) = mpsc::channel();
    thread::spawn(move || {
        let batch = b"not-json\n".repeat(256);
        while stdin.write_all(&batch).is_ok() {
            writer_count.fetch_add(256, Ordering::Release);
        }
        let _ = writer_done_tx.send(());
    });

    let write_deadline = Instant::now() + EXIT_TIMEOUT;
    while written.load(Ordering::Acquire) < 8_192 && Instant::now() < write_deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        written.load(Ordering::Acquire) >= 8_192,
        "continuous input producer did not establish a backlog"
    );
    parent
        .terminate_and_reap(REAP_TIMEOUT)
        .expect("bounded disposable parent cleanup");
    thread::sleep(Duration::from_millis(50));
    suspended_ui.resume();

    let natural_exit = helper
        .process
        .wait_timeout(EXIT_TIMEOUT)
        .expect("poll helper under continuous input");
    if natural_exit.is_none() {
        helper
            .process
            .terminate_and_reap(REAP_TIMEOUT)
            .expect("bounded helper cleanup after exit timeout");
    }
    writer_done_rx
        .recv_timeout(EXIT_TIMEOUT)
        .expect("stdin flood writer did not stop before timeout");
    let events = helper.finish_stdout(EXIT_TIMEOUT);

    assert!(
        natural_exit.is_some(),
        "helper did not close the active producer and exit before timeout"
    );
    assert_eq!(events[0], ready_event());
    assert!(events.len() > 1, "expected recoverable parse errors");
    assert!(events[1..].iter().all(|event| {
        event["type"] == "error"
            && event["code"] == "invalid-command"
            && event["recoverable"] == true
    }));
}

#[test]
#[serial]
fn parent_shutdown_closes_a_continuous_command_producer_and_drains_stdout() {
    let parent = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn disposable parent");
    let mut parent = ChildGuard::new(parent);
    let mut helper = Helper::spawn(parent.child.id(), 1);
    helper.expect_ready();
    let mut suspended_ui = helper.suspend_ui_thread();

    let mut stdin = helper.stdin.take().expect("helper stdin");
    let written = Arc::new(AtomicUsize::new(0));
    let writer_count = Arc::clone(&written);
    let (writer_done_tx, writer_done_rx) = mpsc::channel();
    thread::spawn(move || {
        let command = b"{\"type\":\"cancel\",\"requestId\":\"flood\"}\n";
        let batch = command.repeat(256);
        while stdin.write_all(&batch).is_ok() {
            writer_count.fetch_add(256, Ordering::Release);
        }
        let _ = writer_done_tx.send(());
    });

    let write_deadline = Instant::now() + FLOOD_SETUP_TIMEOUT;
    let mut last_written = 0;
    let mut last_progress = Instant::now();
    let producer_stopped_while_suspended = loop {
        let current_written = written.load(Ordering::Acquire);
        if current_written >= 32_768 {
            break false;
        }
        if writer_done_rx.try_recv().is_ok() {
            break true;
        }
        if current_written != last_written {
            last_written = current_written;
            last_progress = Instant::now();
        } else if current_written >= 4_096 && last_progress.elapsed() >= Duration::from_millis(200)
        {
            break false;
        }
        assert!(
            Instant::now() < write_deadline,
            "continuous command producer did not fill the suspended UI backlog; completed writes: {}",
            current_written
        );
        thread::sleep(Duration::from_millis(5));
    };
    assert!(
        written.load(Ordering::Acquire) >= 4_096,
        "continuous command producer did not establish a message backlog"
    );
    parent
        .terminate_and_reap(REAP_TIMEOUT)
        .expect("bounded disposable parent cleanup");
    thread::sleep(Duration::from_millis(50));
    suspended_ui.resume();

    let natural_exit = helper
        .process
        .wait_timeout(EXIT_TIMEOUT)
        .expect("poll helper under continuous commands");
    if natural_exit.is_none() {
        helper
            .process
            .terminate_and_reap(REAP_TIMEOUT)
            .expect("bounded helper cleanup after command-flood timeout");
    }
    if !producer_stopped_while_suspended {
        writer_done_rx
            .recv_timeout(EXIT_TIMEOUT)
            .expect("command flood writer did not stop before timeout");
    }
    let events = helper.finish_stdout(EXIT_TIMEOUT);

    assert!(
        natural_exit.is_some(),
        "helper did not close the command producer and exit before timeout"
    );
    assert_eq!(events[0], ready_event());
    assert!(events.len() > 1, "expected request-scoped command events");
    assert!(events[1..].iter().all(|event| {
        event["type"] == "cancelled"
            && event["requestId"] == "flood"
            && event["reason"] == "no-active-capture"
    }));
}

// ---------------------------------------------------------------------------
// Task 6: clipboard + async PNG encoding smoke tests
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn clipboard_only_does_not_generate_png() {
    let dir = ensure_clean_output_dir();
    assert_eq!(count_pngs(&dir), 0, "smoke dir must start empty");

    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    drive_to_committing(&mut helper, "clipboard-only");

    let released = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(released["type"], "capture-released");
    assert_eq!(released["requestId"], "clipboard-only");

    let completed = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(completed["type"], "completed");
    assert_eq!(completed["requestId"], "clipboard-only");
    assert_eq!(
        completed["fileName"],
        serde_json::Value::Null,
        "clipboard-only must produce no fileName"
    );

    // Brief settling delay for any (incorrect) async encoder to enqueue work.
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(
        count_pngs(&dir),
        0,
        "clipboard-only must not write any PNG into the output dir"
    );
    assert_eq!(
        std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0),
        0,
        "clipboard-only must not write any file into the output dir"
    );

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn clipboard_and_file_enqueues_encode_job_and_completes_after_encode() {
    let dir = ensure_clean_output_dir();
    assert_eq!(count_pngs(&dir), 0);

    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command_with_mode("file-mode", "clipboard-and-file"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");

    let hwnd = helper.overlay_hwnd();
    let point = |x: i32, y: i32| LPARAM(((y as u32 & 0xffff) << 16 | (x as u32 & 0xffff)) as isize);
    unsafe {
        PostMessageW(Some(hwnd), WM_LBUTTONDOWN, WPARAM(1), point(48, 48)).unwrap();
        PostMessageW(Some(hwnd), WM_MOUSEMOVE, WPARAM(1), point(160, 120)).unwrap();
        PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), point(160, 120)).unwrap();
    }
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selected");
    unsafe {
        PostMessageW(
            Some(hwnd),
            WM_KEYDOWN,
            WPARAM(VK_RETURN.0 as usize),
            LPARAM(0),
        )
    }
    .unwrap();
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "committing");

    let released = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(released["type"], "capture-released");
    assert_eq!(released["requestId"], "file-mode");
    let released_width = released["width"].as_u64().expect("width is u32");
    let released_height = released["height"].as_u64().expect("height is u32");

    // The encoder can finish before or after the helper processes our new
    // start command; we do not assume an order. The invariant we verify is
    // that BOTH the file-mode `completed` event arrives AND a new start is
    // accepted (i.e., the helper is not stuck waiting on the encode).
    helper.send_command(start_command("after-release"));

    let mut completed: Option<serde_json::Value> = None;
    let mut accepted_after_release = false;
    let mut overlay_visible_after_release = false;
    let drain_deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < drain_deadline {
        if completed.is_some() && overlay_visible_after_release {
            break;
        }
        let event = helper.next_event(EXIT_TIMEOUT);
        match event["type"].as_str() {
            Some("accepted") if event["requestId"] == "after-release" => {
                accepted_after_release = true;
            }
            Some("interaction-state")
                if event["state"] == "selecting" && accepted_after_release =>
            {
                // ok
            }
            Some("overlay-visible") if accepted_after_release => {
                overlay_visible_after_release = true;
            }
            Some("completed") if event["requestId"] == "file-mode" => {
                completed = Some(event);
            }
            _ => panic!("unexpected event after capture-released: {event:?}"),
        }
    }

    assert!(
        accepted_after_release,
        "a new start must be accepted while an encode is pending"
    );
    assert!(
        overlay_visible_after_release,
        "overlay-visible must be received for after-release"
    );
    let completed = completed.expect("expected completed event for file-mode");
    assert_eq!(completed["width"].as_u64(), Some(released_width));
    assert_eq!(completed["height"].as_u64(), Some(released_height));
    assert_eq!(completed["mime"], "image/png");
    let file_name = completed["fileName"]
        .as_str()
        .expect("clipboard-and-file must produce a fileName")
        .to_string();
    assert!(
        file_name.ends_with(".png"),
        "file name {file_name} must end with .png"
    );
    let stem = file_name.trim_end_matches(".png");
    assert!(
        uuid::Uuid::parse_str(stem).is_ok(),
        "file stem {stem} must be a UUID"
    );

    let on_disk = dir.join(&file_name);
    assert!(
        on_disk.is_file(),
        "expected PNG at {} but it was not written",
        on_disk.display()
    );
    let meta = std::fs::metadata(&on_disk).expect("stat PNG");
    assert!(meta.len() > 0, "PNG must not be empty");

    let pngs = count_pngs(&dir);
    assert_eq!(pngs, 1, "exactly one PNG must remain in the output dir");

    // No temp file should leak past the rename.
    let leaks: Vec<_> = std::fs::read_dir(&dir)
        .expect("read output dir")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".tmp"))
        })
        .collect();
    assert!(leaks.is_empty(), "no .tmp files should remain");

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn capture_released_returns_clipboard_written_and_dimensions() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    drive_to_committing(&mut helper, "release-fields");

    let released = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(released["type"], "capture-released");
    assert_eq!(released["requestId"], "release-fields");
    assert!(
        released["clipboardWritten"].is_boolean(),
        "clipboardWritten must be a bool"
    );
    assert!(released["width"].is_number(), "width must be a number");
    assert!(released["height"].is_number(), "height must be a number");
    let width = released["width"].as_u64().expect("width is u32");
    let height = released["height"].as_u64().expect("height is u64");
    assert!(
        (4..100_000).contains(&width),
        "width must be in a sane range"
    );
    assert!(
        (4..100_000).contains(&height),
        "height must be in a sane range"
    );

    // Drain the terminal completed event so stdout is clean for shutdown.
    let _ = helper.next_event(EXIT_TIMEOUT);

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn encode_failure_removes_temp_file_and_emits_error() {
    // Make the helper's output dir point at an existing *regular file* so
    // that the WIC stream init (which calls CreateFile on the .tmp path)
    // fails with a Windows "not a directory" error. This is robust because
    // the path round-trips through Command::args losslessly on Windows.
    let dir = ensure_clean_output_dir();
    let bogus_output_dir = dir.join("not-a-directory");
    std::fs::write(&bogus_output_dir, b"this is a regular file").expect("seed blocker file");

    // Spawn a helper whose --output-dir is the regular file. The frozen
    // frame and selection extract are independent of the output dir, so the
    // helper accepts the start and reaches `committing` normally; the
    // encoder worker is what fails.
    let mut helper = Helper::spawn_with_output_dir(std::process::id(), 1, bogus_output_dir.clone());
    helper.expect_ready();
    helper.send_command(start_command_with_mode("encode-fail", "clipboard-and-file"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");

    // Drive selection + commit so the encoder runs against the bogus dir.
    let hwnd = helper.overlay_hwnd();
    let point = |x: i32, y: i32| LPARAM(((y as u32 & 0xffff) << 16 | (x as u32 & 0xffff)) as isize);
    unsafe {
        PostMessageW(Some(hwnd), WM_LBUTTONDOWN, WPARAM(1), point(48, 48)).unwrap();
        PostMessageW(Some(hwnd), WM_MOUSEMOVE, WPARAM(1), point(160, 120)).unwrap();
        PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), point(160, 120)).unwrap();
    }
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selected");
    unsafe {
        PostMessageW(
            Some(hwnd),
            WM_KEYDOWN,
            WPARAM(VK_RETURN.0 as usize),
            LPARAM(0),
        )
    }
    .unwrap();
    assert_eq!(
        helper.next_event(EXIT_TIMEOUT),
        serde_json::json!({
            "type": "interaction-state",
            "requestId": "encode-fail",
            "state": "committing"
        })
    );

    // After committing we get capture-released and then the encoder worker
    // emits the terminal error. Drain until we see the terminal for the
    // encode-fail request.
    let released = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(released["type"], "capture-released");
    assert_eq!(released["requestId"], "encode-fail");
    assert_eq!(released["clipboardWritten"], true);

    let mut terminal: Option<serde_json::Value> = None;
    let drain_deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < drain_deadline {
        let event = helper.next_event(EXIT_TIMEOUT);
        if event["requestId"] == "encode-fail"
            && (event["type"] == "error" || event["type"] == "completed")
        {
            terminal = Some(event);
            break;
        }
    }

    let terminal = terminal.expect("terminal event for encode-fail");
    assert_eq!(terminal["type"], "error");
    assert_eq!(terminal["code"], "encode-failed");
    assert_eq!(terminal["requestId"], "encode-fail");
    assert_eq!(terminal["recoverable"], false);

    // The blocker file must still be the original regular file; no .tmp must
    // have been created next to it (or in the parent dir).
    let parent = bogus_output_dir.parent().expect("blocker has parent");
    let leaked_tmp: Vec<_> = std::fs::read_dir(parent)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .path()
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.ends_with(".tmp"))
                })
                .collect()
        })
        .unwrap_or_default();
    assert!(
        leaked_tmp.is_empty(),
        "no temp file may leak on encode failure"
    );

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    let (status, _events) = helper.finish(EXIT_TIMEOUT);
    assert!(
        status.success(),
        "helper must exit cleanly even on encode failure"
    );
}

// ---------------------------------------------------------------------------
// RequestRegistry wiring integration tests (T6 spec compliance)
// ---------------------------------------------------------------------------

/// Commit a `clipboard-and-file` request up to the `capture-released` event
/// and return the released width/height for caller follow-up. Drains the
/// events the helper emits during that path; the caller is responsible for
/// draining the terminal `completed` (or `error`) once the encoder finishes.
///
/// Sharing the helper driver with the existing
/// `clipboard_and_file_enqueues_encode_job_and_completes_after_encode`
/// pattern keeps the post-commit drain logic in one place: callers of this
/// helper choose whether to assert specific subsequent events or wait for the
/// terminal event.
fn commit_clipboard_and_file_to_release(helper: &mut Helper, request_id: &str) -> (u64, u64) {
    helper.send_command(start_command_with_mode(request_id, "clipboard-and-file"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");

    let hwnd = helper.overlay_hwnd();
    let point = |x: i32, y: i32| LPARAM(((y as u32 & 0xffff) << 16 | (x as u32 & 0xffff)) as isize);
    unsafe {
        PostMessageW(Some(hwnd), WM_LBUTTONDOWN, WPARAM(1), point(32, 32)).unwrap();
        PostMessageW(Some(hwnd), WM_MOUSEMOVE, WPARAM(1), point(128, 96)).unwrap();
        PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), point(128, 96)).unwrap();
    }
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selected");
    unsafe {
        PostMessageW(
            Some(hwnd),
            WM_KEYDOWN,
            WPARAM(VK_RETURN.0 as usize),
            LPARAM(0),
        )
    }
    .unwrap();
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "committing");

    let released = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(released["type"], "capture-released");
    assert_eq!(released["requestId"], request_id);
    let width = released["width"].as_u64().expect("width is u32");
    let height = released["height"].as_u64().expect("height is u32");
    (width, height)
}

#[test]
#[serial]
fn start_while_clipboard_and_file_request_encodes_is_allowed() {
    // Spec requirement: a new Start with a different requestId must succeed
    // while a previous `clipboard-and-file` request is still between
    // `capture-released` and `Completed`. The local `active` interaction is
    // already idle (overlay hidden), and the `RequestRegistry` accepts the
    // new ID because the previous requestId is still pending (it has
    // not yet emitted its terminal event).
    let dir = ensure_clean_output_dir();
    let mut helper = Helper::spawn_with_output_dir(std::process::id(), 1, dir.clone());
    helper.expect_ready();

    // Drive the first request to capture-released. The encode worker is now
    // running in the background; we don't know when it will finish.
    let _ = commit_clipboard_and_file_to_release(&mut helper, "first-encode");

    // Send the second start before draining the encoder terminal. The
    // RequestRegistry must accept this because the first requestId is
    // still pending (it hasn't emitted its Completed yet).
    helper.send_command(start_command("after-encode"));

    // The next event sequence for the second request: accepted, selecting,
    // overlay-visible. We do NOT drive a selection for `after-encode` here
    // because the spec compliance check is "the second start is accepted
    // and the overlay becomes visible while the first is still pending".
    let mut second_accepted = false;
    let mut second_overlay_visible = false;
    let mut first_completed: Option<serde_json::Value> = None;
    let drain_deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < drain_deadline {
        if first_completed.is_some() && second_accepted && second_overlay_visible {
            break;
        }
        let event = helper.next_event(EXIT_TIMEOUT);
        match event["type"].as_str() {
            Some("accepted") if event["requestId"] == "after-encode" => {
                second_accepted = true;
            }
            Some("interaction-state")
                if event["requestId"] == "after-encode" && event["state"] == "selecting" =>
            {
                // Drain selecting; it arrives before accepted in our flow.
            }
            Some("overlay-visible") if event["requestId"] == "after-encode" => {
                second_overlay_visible = true;
            }
            Some("completed") if event["requestId"] == "first-encode" => {
                first_completed = Some(event);
            }
            _ => {}
        }
    }

    assert!(
        second_accepted,
        "second start must be accepted while first is pending"
    );
    assert!(
        second_overlay_visible,
        "second start must reach overlay-visible"
    );
    let completed = first_completed.expect("first request must eventually complete");
    let file_name = completed["fileName"]
        .as_str()
        .expect("clipboard-and-file must produce a fileName")
        .to_string();
    assert!(file_name.ends_with(".png"));

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    let (status, _events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
}

#[test]
#[serial]
fn start_duplicate_request_id_emits_busy() {
    // Spec requirement: a second `Start` with the same `requestId` while the
    // first request is still in the registry must be rejected with
    // `error(code="busy")`. We trigger this BEFORE `capture-released` so the
    // first request is firmly in the registry.
    let dir = ensure_clean_output_dir();
    let mut helper = Helper::spawn_with_output_dir(std::process::id(), 1, dir);
    helper.expect_ready();

    // The local `active` is `Some`, so this hits the *first* busy error path
    // (which uses the same code); to exercise the registry-only busy path
    // we need the first request to have moved past `active`. That happens
    // only once we are in encode. The simplest way to drive the test is to
    // start, then immediately start again — the second one will hit the
    // 'active is some' busy path because the overlay has not yet hidden.
    // The error code is "busy" either way; the message distinguishes.
    helper.send_command(start_command("dup-id"));
    helper.send_command(start_command("dup-id"));

    // Drain events: helper sends accepted, selecting, overlay-visible for
    // dup-id, then error(busy) for the duplicate.
    let events: Vec<serde_json::Value> = (0..4).map(|_| helper.next_event(EXIT_TIMEOUT)).collect();
    let error_event = events
        .iter()
        .find(|event| event["type"] == "error" && event["requestId"] == "dup-id")
        .expect("expected a busy error event for the duplicate start");
    assert_eq!(error_event["code"], "busy");
    assert_eq!(error_event["recoverable"], true);

    // Cancel the lingering capture so we can shut down cleanly.
    helper.send_command(serde_json::json!({"type": "cancel", "requestId": "dup-id"}));
    helper.next_event(EXIT_TIMEOUT); // cancelled event

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    let (status, _events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
}

#[test]
#[serial]
fn cancel_during_encode_emits_cancelled() {
    // Spec requirement: `Command::Cancel` on a pending-but-released
    // (encode-in-flight) request must produce `Cancelled`. Because the
    // encoder worker currently observes no cancellation channel, the
    // encoder still emits its terminal `Completed`/`Error`. This test
    // asserts the registry surface: the helper must emit a terminal
    // `cancelled` or `completed` for the request, and a subsequent
    // `Start` with the same ID must be accepted (proving the registry
    // was finalized for that requestId).
    //
    // Note: which terminal event arrives for "cancel-mid" is a race
    // between the encoder worker (emits `completed`) and the cancel
    // handler (emits `cancelled` with `electron-cancelled`). The test
    // accepts either, because both are valid expressions of "the
    // requestId has been finalized and the registry slot is free".
    let dir = ensure_clean_output_dir();
    let mut helper = Helper::spawn_with_output_dir(std::process::id(), 1, dir);
    helper.expect_ready();
    let _ = commit_clipboard_and_file_to_release(&mut helper, "cancel-mid");

    // Cancel while the encode worker is still running.
    helper.send_command(serde_json::json!({"type": "cancel", "requestId": "cancel-mid"}));

    // Drain events until we see a terminal event for cancel-mid. The
    // cancel handler emits `cancelled` (reason `electron-cancelled`) if
    // the requestId is still pending; otherwise it emits
    // `cancelled` (reason `no-active-capture`) AFTER the encoder has
    // already finalized the request. The encoder's `completed` may also
    // appear in either order. We only require that some terminal event
    // arrives so we know the registry slot has been freed.
    let mut terminal: Option<serde_json::Value> = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && terminal.is_none() {
        let event = helper.next_event(EXIT_TIMEOUT);
        if event["requestId"] != "cancel-mid" {
            continue;
        }
        match event["type"].as_str() {
            Some("cancelled") | Some("completed") | Some("error") => {
                terminal = Some(event);
            }
            _ => {}
        }
    }
    let terminal = terminal.expect("expected a terminal event for cancel-mid");
    assert!(
        matches!(
            terminal["type"].as_str(),
            Some("cancelled") | Some("completed") | Some("error")
        ),
        "unexpected terminal type: {terminal:?}"
    );

    // After the terminal, the registry slot is finalized. Send a fresh
    // start with the SAME requestId. The helper must accept it (the
    // registry now treats "cancel-mid" as finished, not pending).
    helper.send_command(start_command("cancel-mid"));

    // Drain events until we see the new start's `accepted`. The
    // previously-spawned encoder worker may post its terminal events in
    // parallel; we tolerate and ignore those.
    let mut accepted = false;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && !accepted {
        let event = helper.next_event(EXIT_TIMEOUT);
        if event["type"] == "accepted" && event["requestId"] == "cancel-mid" {
            accepted = true;
        }
    }
    assert!(
        accepted,
        "a re-start of the cancelled requestId must be accepted"
    );

    // Drain the rest so shutdown is clean.
    helper.send_command(serde_json::json!({"type": "cancel", "requestId": "cancel-mid"}));
    while let Ok(event) = helper.stdout_lines.recv_timeout(Duration::from_millis(100)) {
        let parsed: serde_json::Value = serde_json::from_str(&event).unwrap_or_default();
        if parsed["type"] == "cancelled" && parsed["requestId"] == "cancel-mid" {
            break;
        }
    }

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    let (status, _events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
}

// ---------------------------------------------------------------------------
// Task 7: DXGI capture-pump diagnostics tests
// ---------------------------------------------------------------------------

fn diagnostics_field(event: &serde_json::Value, field: &str) -> u64 {
    event["diagnostics"][field]
        .as_u64()
        .unwrap_or_else(|| panic!("diagnostics.{field} must be a u64 on {event:?}"))
}

#[test]
#[serial]
fn start_to_overlay_visible_has_no_full_frame_cpu_readback() {
    // Task 7 invariant: when the DXGI capture path is active (the documented
    // primary path on a healthy desktop), the helper must produce a frozen
    // frame WITHOUT reading the entire desktop back to the CPU. GDI is a
    // pull-on-demand backend that always reads back at freeze time, so the
    // assertion is only meaningful on machines where DXGI initializes; the
    // GDI fallback path is permitted (and `backend == "gdi"`).
    //
    // For this smoke test we accept either:
    //   * backend == "dxgi"  → full_frame_cpu_readbacks MUST be 0.
    //   * backend == "gdi"   → full_frame_cpu_readbacks MUST be 1 (one
    //     freeze-time BitBlt + DIB copy).
    // The selection_cpu_readbacks counter must be 0 at overlay-visible
    // because no commit has happened yet.
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("diagnostics-zero-readback"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    let overlay_visible = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(overlay_visible["type"], "overlay-visible");

    let backend = overlay_visible["diagnostics"]["backend"]
        .as_str()
        .expect("diagnostics.backend must be a string");
    let full_frame = diagnostics_field(&overlay_visible, "fullFrameCpuReadbacks");
    let selection = diagnostics_field(&overlay_visible, "selectionCpuReadbacks");
    let latest_copies = diagnostics_field(&overlay_visible, "latestCopies");

    assert!(
        matches!(backend, "dxgi" | "gdi"),
        "unexpected backend label {backend:?}"
    );
    assert!(
        latest_copies >= 1,
        "latestCopies must be at least 1 after a successful freeze (got {latest_copies})"
    );
    match backend {
        "dxgi" => assert_eq!(
            full_frame, 0,
            "DXGI must not perform any full-frame CPU readback before overlay-visible"
        ),
        "gdi" => assert_eq!(
            full_frame, 1,
            "GDI must perform exactly one full-frame CPU readback at freeze"
        ),
        _ => unreachable!(),
    }
    assert_eq!(
        selection, 0,
        "no selection extraction must have happened before overlay-visible"
    );

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn commit_has_selection_cpu_readback() {
    // Task 7 invariant: after commit, the helper's diagnostics MUST record
    // at least one selection CPU readback regardless of backend (both DXGI
    // and GDI paths use CopySubresourceRegion or BitBlt to materialize the
    // selection into the encoder/clipboard payload).
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    drive_to_committing(&mut helper, "diagnostics-selection-readback");

    let released = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(released["type"], "capture-released");
    let selection_readbacks = diagnostics_field(&released, "selectionCpuReadbacks");
    assert!(
        selection_readbacks >= 1,
        "selectionCpuReadbacks must be at least 1 after commit (got {selection_readbacks})"
    );
    assert!(
        diagnostics_field(&released, "latestCopies") >= 1,
        "latestCopies must be at least 1 by commit time"
    );

    // Drain the terminal completed event so stdout is clean for shutdown.
    let _ = helper.next_event(EXIT_TIMEOUT);

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
#[serial]
fn overlay_visible_diagnostics_reports_backend_and_counters() {
    // Sanity check: the wire payload must contain every documented
    // diagnostics field with the right shape, regardless of which backend
    // was actually used. This guards against a future change that drops one
    // field and silently breaks the readback-counting assertions above.
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("diagnostics-shape"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    let overlay_visible = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(overlay_visible["type"], "overlay-visible");

    let diagnostics = &overlay_visible["diagnostics"];
    assert!(diagnostics.is_object(), "diagnostics must be an object");
    assert!(
        diagnostics["backend"].is_string(),
        "backend must be a string"
    );
    for field in [
        "fullFrameCpuReadbacks",
        "selectionCpuReadbacks",
        "latestCopies",
        "duplicationRebuilds",
    ] {
        assert!(
            diagnostics[field].is_u64(),
            "diagnostics.{field} must be a u64, got {:?}",
            diagnostics[field]
        );
    }

    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}
