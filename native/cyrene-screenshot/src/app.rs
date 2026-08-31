use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        mpsc::{Receiver, Sender},
    },
};

use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WAIT_FAILED, WPARAM},
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, HWND_MESSAGE, MSG,
            MWMO_INPUTAVAILABLE, MsgWaitForMultipleObjectsEx, PM_REMOVE, PeekMessageW, QS_ALLINPUT,
            RegisterClassW, TranslateMessage, UnregisterClassW, WINDOW_EX_STYLE, WINDOW_STYLE,
            WM_QUIT, WNDCLASSW,
        },
    },
    core::{Error as WindowsError, PCWSTR, w},
};

use crate::{
    WM_APP_COMMAND, WM_APP_SHUTDOWN,
    cli::CliOptions,
    error::{AppError, HelperError},
    ipc::{
        InputGate, MessageTarget, RuntimeChannels, create_runtime_channels, spawn_stdin_reader,
        spawn_stdout_writer,
    },
    parent_watch,
    protocol::{CaptureMode, Command, Event, InteractionStateEvent, PROTOCOL_VERSION},
    request::RequestRegistry,
    win::{
        capture::{CaptureBackend, FrozenFrame, RefreshOutcome},
        capture_dxgi::DxgiCaptureBackend,
        capture_gdi::GdiCaptureBackend,
        clipboard::write_cf_dibv5,
        display::{DisplayInfo, query_primary_display},
        encoder::{self, EncodeJob},
        renderer::{
            OverlayRenderer, burn_annotations, present_first_frame, qpc_elapsed_ms, qpc_now,
        },
        window::{OverlayAction, OverlayWindow},
    },
};

const WINDOW_CLASS: PCWSTR = w!("CyreneScreenshotRuntimeWindow");
const INPUT_BATCH_LIMIT: usize = 64;
const CAPTURE_PUMP_TIMEOUT_MS: u32 = 16;

pub fn run(options: CliOptions) -> Result<(), AppError> {
    let window = MessageWindow::create()?;
    let target = MessageTarget::new(window.hwnd);
    let (channels, input_gate, event_rx, input_event_rx) = create_runtime_channels(target);
    let stdout_thread = spawn_stdout_writer(event_rx);

    parent_watch::start(options.parent_pid, target);
    spawn_stdin_reader(target, input_gate.clone());
    channels
        .event_tx
        .send(Event::Ready {
            protocol_version: PROTOCOL_VERSION,
        })
        .map_err(|_| AppError::Runtime("stdout writer stopped before ready".into()))?;

    let message_result = run_message_loop(
        &window,
        &channels,
        &input_gate,
        &input_event_rx,
        options.output_dir.clone(),
    );
    for event in input_gate.close() {
        let _ = channels.event_tx.send(event);
    }
    drain_closed_input_events(&channels.event_tx, &input_event_rx);
    drop(channels);
    let stdout_result = stdout_thread
        .join()
        .map_err(|_| AppError::Runtime("stdout writer panicked".into()))?;

    message_result?;
    stdout_result?;
    Ok(())
}

fn run_message_loop(
    window: &MessageWindow,
    channels: &RuntimeChannels,
    input_gate: &InputGate,
    input_event_rx: &Receiver<Event>,
    output_dir: PathBuf,
) -> Result<(), AppError> {
    let display = query_primary_display()?;
    let overlay = OverlayWindow::create(&display)?;
    let capture: Box<dyn CaptureBackend> = match DxgiCaptureBackend::new(&display, false) {
        Ok(c) => {
            eprintln!("cyrene-screenshot: using DXGI capture backend");
            Box::new(c)
        }
        Err(error) => {
            eprintln!("cyrene-screenshot: DXGI init failed ({error}), falling back to GDI");
            Box::new(GdiCaptureBackend::new()?)
        }
    };
    let mut app_state = OverlayApp::new(display, overlay, capture, output_dir)?;
    let mut message = MSG::default();
    loop {
        // Drain all currently-pending messages without blocking. The DXGI
        // capture pump below owns the bounded wait while the overlay is idle,
        // so Windows messages and fresh desktop frames share this UI thread.
        while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() } {
            if message.message == WM_QUIT || message.message == WM_APP_SHUTDOWN {
                return Ok(());
            }
            if message.hwnd == window.hwnd && message.message == WM_APP_COMMAND {
                let batch =
                    input_gate.drain_batch(&channels.command_rx, input_event_rx, INPUT_BATCH_LIMIT);
                for event in batch.events {
                    let _ = channels.event_tx.send(event);
                }
                for command in batch.commands {
                    if !app_state.handle_command(command, &channels.event_tx) {
                        return Ok(());
                    }
                }
                continue;
            }

            // SAFETY: PeekMessageW populated message with a valid record.
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            app_state.process_overlay_action(&channels.event_tx);
        }

        match pump_capture_if_idle(app_state.active.is_some(), |timeout_ms| {
            app_state.capture.refresh_latest(timeout_ms)
        }) {
            Ok(Some(RefreshOutcome::Lost)) => app_state.recover_capture()?,
            Ok(Some(RefreshOutcome::Updated | RefreshOutcome::Unchanged) | None) => {}
            Err(error) => {
                eprintln!(
                    "cyrene-screenshot: idle DXGI refresh failed ({error}); rebuilding capture"
                );
                app_state.recover_capture()?;
            }
        }

        // Avoid a busy loop for the pull-on-demand GDI fallback and yield to
        // input between DXGI refresh attempts. The wait is bounded and wakes
        // immediately as soon as any message enters this thread's queue.
        let wait_result = unsafe {
            MsgWaitForMultipleObjectsEx(
                None,
                CAPTURE_PUMP_TIMEOUT_MS,
                QS_ALLINPUT,
                MWMO_INPUTAVAILABLE,
            )
        };
        if wait_result == WAIT_FAILED {
            return Err(WindowsError::from_thread().into());
        }
    }
}

fn pump_capture_if_idle(
    overlay_active: bool,
    refresh: impl FnOnce(u32) -> Result<RefreshOutcome, HelperError>,
) -> Result<Option<RefreshOutcome>, HelperError> {
    if overlay_active {
        return Ok(None);
    }
    refresh(CAPTURE_PUMP_TIMEOUT_MS).map(Some)
}

fn drain_closed_input_events(
    event_tx: &std::sync::mpsc::Sender<Event>,
    input_event_rx: &Receiver<Event>,
) {
    while let Ok(event) = input_event_rx.recv() {
        if event_tx.send(event).is_err() {
            return;
        }
    }
}

struct ActiveRequest {
    request_id: String,
    mode: CaptureMode,
    /// Frozen frame retained for the lifetime of the interaction. Uploaded by
    /// reference into the GDI cache on present; the clipboard / encoder path
    /// consumes it after commit.
    frame: FrozenFrame,
}

struct OverlayApp {
    display: DisplayInfo,
    overlay: OverlayWindow,
    capture: Box<dyn CaptureBackend>,
    renderer: OverlayRenderer,
    /// Interaction state for the currently-visible overlay. Cleared as soon as
    /// the overlay hides (after `capture-released` or any error path). Does NOT
    /// track the encoded/Pending lifecycle of a `clipboard-and-file` request —
    /// see `requests` for that.
    active: Option<ActiveRequest>,
    /// Persistent registry of request IDs and their lifecycle. A requestId
    /// stays in this registry from `accept` through `capture_released` (which
    /// records the release metadata) until a terminal event (`Completed`,
    /// `Cancelled`, or `Error`) finishes it. Gates `Start` against duplicate
    /// IDs and lives independently of the overlay interaction, so a second
    /// `Start` can be accepted while a previous `clipboard-and-file` request
    /// is still encoding.
    ///
    /// The registry is shared with the encode worker thread via a `Mutex`:
    /// the worker needs to mark its request finished when it emits the
    /// terminal `Completed` / `Error`. The `Arc` lets us clone a handle into
    /// the worker without holding the UI thread's `&mut` borrow across the
    /// `spawn` boundary. The lock is only briefly held when the worker emits
    /// its terminal event, so command-path throughput is unaffected.
    requests: Arc<Mutex<RequestRegistry>>,
    output_dir: PathBuf,
}

impl OverlayApp {
    fn new(
        display: DisplayInfo,
        overlay: OverlayWindow,
        capture: Box<dyn CaptureBackend>,
        output_dir: PathBuf,
    ) -> Result<Self, AppError> {
        Ok(Self {
            display,
            overlay,
            capture,
            renderer: OverlayRenderer::new()?,
            active: None,
            requests: Arc::new(Mutex::new(RequestRegistry::default())),
            output_dir,
        })
    }

    fn handle_command(
        &mut self,
        command: Command,
        event_tx: &std::sync::mpsc::Sender<Event>,
    ) -> bool {
        match command {
            Command::Start { request_id, mode } => {
                // Two distinct "busy" gates must both pass:
                //   1. The local `active` flag — only one interaction session
                //      can have a visible overlay at a time; a Start arriving
                //      while the previous overlay is still on-screen is the
                //      classic "race" the T6 plan calls out.
                //   2. The `RequestRegistry` — the same `request_id` may not
                //      be reused while a previous request with that ID is
                //      still pending (between `accept` and the terminal
                //      event). This is independent of `active` because
                //      clipboard-and-file requests stay pending across the
                //      overlay teardown.
                if self.active.is_some() {
                    send_error(
                        event_tx,
                        Some(request_id.clone()),
                        "busy",
                        "a screenshot interaction is already active",
                        true,
                    );
                    return true;
                }
                // Lock the registry briefly. If the mutex is poisoned we
                // take the inner guard anyway (callers are idempotent) and
                // proceed; on the edge case that the lock itself fails, we
                // surface a busy error so the caller can retry.
                let mut registry_guard = match lock_registry(&self.requests) {
                    Ok(guard) => guard,
                    Err(_) => {
                        send_error(
                            event_tx,
                            Some(request_id.clone()),
                            "busy",
                            "request registry is unavailable",
                            true,
                        );
                        return true;
                    }
                };
                let accept_result = registry_guard
                    .accept(&request_id, mode)
                    .map_err(|error| error.to_string());
                // Release the registry guard immediately so the rest of this
                // function (which mutates `self`) is not blocked behind the
                // mutex lock for the duration of the freeze and overlay
                // presentation. The encoder worker will re-acquire the lock
                // on its terminal event publish.
                drop(registry_guard);
                if let Err(reason) = accept_result {
                    // The locked spec surface uses code "busy" for any
                    // duplicate-id rejection; the underlying
                    // `request-already-pending` / `request-already-finished`
                    // distinction is preserved in the message so the
                    // Electron side can log it without a wire-format change.
                    send_error(
                        event_tx,
                        Some(request_id.clone()),
                        "busy",
                        &format!("request {request_id} is already pending: {reason}"),
                        true,
                    );
                    return true;
                }

                // Measure freeze duration from the moment Start is accepted
                // (immediately before freeze begins) until DwmFlush succeeds.
                let freeze_start = qpc_now();

                // Re-query display so a prior display-changed recovery sees
                // the latest topology before freezing.
                match query_primary_display() {
                    Ok(display) => {
                        let capture_geometry_changed = display.bounds.width
                            != self.display.bounds.width
                            || display.bounds.height != self.display.bounds.height
                            || display.rotation != self.display.rotation;
                        self.display = display;
                        if capture_geometry_changed && let Err(error) = self.recover_capture() {
                            finalize_request(&self.requests, &request_id, "cancel");
                            send_error(
                                event_tx,
                                Some(request_id),
                                error.code(),
                                &error.to_string(),
                                true,
                            );
                            return true;
                        }
                    }
                    Err(error) => {
                        finalize_request(&self.requests, &request_id, "cancel");
                        send_error(
                            event_tx,
                            Some(request_id),
                            error.code(),
                            &error.to_string(),
                            true,
                        );
                        return true;
                    }
                }

                let frame = match self.freeze_with_recovery() {
                    Ok(frame) => frame,
                    Err(error) => {
                        finalize_request(&self.requests, &request_id, "cancel");
                        send_error(
                            event_tx,
                            Some(request_id),
                            error.code(),
                            &error.to_string(),
                            true,
                        );
                        return true;
                    }
                };

                self.active = Some(ActiveRequest {
                    request_id: request_id.clone(),
                    mode,
                    frame,
                });
                let _ = event_tx.send(Event::Accepted {
                    request_id: request_id.clone(),
                });
                // The locked `InteractionStateEvent` enum (in `protocol.rs`) only
                // exposes `Selecting | Selected | Committing`. The internal state
                // machine here also tracks `Freezing` and `Cancelling`; those are
                // projected onto the wire by emitting `OverlayVisible` (after the
                // freeze completes) and `Cancelled` (when the user cancels),
                // respectively, so the locked protocol surface stays unchanged.
                let _ = event_tx.send(Event::InteractionState {
                    request_id: request_id.clone(),
                    state: InteractionStateEvent::Selecting,
                });

                if let Err(error) = self.present_overlay() {
                    self.finish_error(event_tx, error.code(), &error.to_string(), true);
                    return true;
                }

                let freeze_end = qpc_now();
                let freeze_duration_ms = qpc_elapsed_ms(freeze_start, freeze_end);
                let _ = event_tx.send(Event::OverlayVisible {
                    request_id,
                    freeze_duration_ms,
                    diagnostics: self.capture.diagnostics(),
                });
                true
            }
            Command::Cancel { request_id } => {
                if self
                    .active
                    .as_ref()
                    .is_some_and(|active| active.request_id == request_id)
                {
                    self.cancel(event_tx, "electron-cancelled");
                } else if registry_is_pending(&self.requests, &request_id) {
                    // The interaction has moved past capture-released into
                    // the encode phase. The overlay is hidden and `active`
                    // is `None`, but the requestId is still in the registry.
                    // Surface a `Cancelled` event matching the
                    // active-capture path; the encoder worker still emits
                    // its terminal `Completed` / `Error` event but the
                    // registry has already finalized the slot. (We don't
                    // kill the encoder mid-flight because the encode worker
                    // doesn't currently observe a cancellation channel; the
                    // Electron-side cancellation acknowledgement comes
                    // through this Cancelled event.)
                    let _ = event_tx.send(Event::Cancelled {
                        request_id: request_id.clone(),
                        reason: "electron-cancelled".into(),
                    });
                    finalize_request(&self.requests, &request_id, "cancel");
                } else {
                    let _ = event_tx.send(Event::Cancelled {
                        request_id,
                        reason: "no-active-capture".into(),
                    });
                }
                true
            }
            Command::Shutdown => false,
        }
    }

    /// Spec ordering for first presentation:
    /// ShowWindow / SetForegroundWindow
    /// → upload frozen frame
    /// → InvalidateRect + UpdateWindow (WM_PAINT path only; no stacked &mut)
    /// → DwmFlush
    /// (caller then emits OverlayVisible)
    fn present_overlay(&mut self) -> Result<(), crate::error::HelperError> {
        // Split borrows: upload from the stored frozen frame by reference
        // without cloning the full BGRA buffer.
        let Self {
            renderer,
            overlay,
            display,
            active,
            ..
        } = self;
        let frame_ref = match active.as_ref().map(|a| &a.frame) {
            Some(frame) => frame,
            None => {
                return Err(crate::error::HelperError::CaptureFailed(
                    "present_overlay called without an active request".into(),
                ));
            }
        };

        renderer.clear_frozen();
        overlay.attach_renderer(renderer);
        // Show first so the HWND is mapped, then size resources to it.
        overlay.show(display)?;
        renderer.resize(overlay.hwnd(), display)?;

        match frame_ref {
            FrozenFrame::Gpu(gpu) => {
                // Upload GPU frozen frame → D2D bitmap
                match renderer.upload_frozen_gpu(gpu, overlay.hwnd(), display) {
                    Ok(()) => {}
                    Err(error) => {
                        // GPU upload failed; fall back to GDI for this request
                        eprintln!(
                            "cyrene-screenshot: GPU upload failed ({error}), falling back to GDI for this session"
                        );
                        // Read the GPU texture back to CPU, then use GDI path
                        let cpu_bgra = gpu.readback_to_cpu()?;
                        renderer.upload_frozen(&cpu_bgra)?;
                    }
                }
            }
            FrozenFrame::Cpu(cpu) => {
                // Upload CPU BGRA → GDI cache
                renderer.upload_frozen(cpu)?;
            }
        }

        // Exclusive borrow ends after upload; present_first_frame must not hold
        // &mut OverlayRenderer across UpdateWindow (WM_PAINT re-enters via NonNull).
        present_first_frame(overlay)?;
        Ok(())
    }

    fn process_overlay_action(&mut self, event_tx: &std::sync::mpsc::Sender<Event>) {
        let Some(action) = self.overlay.take_action() else {
            return;
        };
        if action == OverlayAction::DisplayChanged {
            if self.active.is_some() {
                self.finish_error(
                    event_tx,
                    "display-changed",
                    "display topology or DPI changed during capture",
                    true,
                );
            }
            if let Err(error) = self.recover_capture() {
                eprintln!("cyrene-screenshot: display-change recovery failed: {error}");
            }
            return;
        }
        let Some(active) = self.active.as_ref() else {
            return;
        };
        let request_id = active.request_id.clone();
        match action {
            OverlayAction::Selected => {
                let _ = event_tx.send(Event::InteractionState {
                    request_id,
                    state: InteractionStateEvent::Selected,
                });
            }
            OverlayAction::Commit => {
                let _ = event_tx.send(Event::InteractionState {
                    request_id: request_id.clone(),
                    state: InteractionStateEvent::Committing,
                });
                self.commit(event_tx);
            }
            OverlayAction::Cancel => self.cancel(event_tx, "user-cancelled"),
            OverlayAction::DisplayChanged => unreachable!("display change handled above"),
        }
    }

    fn recover_capture(&mut self) -> Result<(), HelperError> {
        let display = query_primary_display()?;
        self.overlay.detach_renderer();
        self.renderer.reset_gpu_resources();
        match self.capture.recover(&display) {
            Ok(()) => {
                self.display = display;
                Ok(())
            }
            Err(error) => {
                eprintln!(
                    "cyrene-screenshot: {} recovery failed ({error}), falling back to GDI",
                    self.capture.name()
                );
                self.capture = Box::new(GdiCaptureBackend::new()?);
                self.display = display;
                Ok(())
            }
        }
    }

    fn freeze_with_recovery(&mut self) -> Result<FrozenFrame, HelperError> {
        let first = self.capture.freeze(&self.display);
        let frame = match first {
            Ok(frame) => frame,
            Err(error) if self.capture.name() == "dxgi" => {
                eprintln!(
                    "cyrene-screenshot: DXGI freeze failed ({error}); rebuilding before retry"
                );
                self.overlay.detach_renderer();
                self.renderer.reset_gpu_resources();
                if let Err(rebuild_error) = self.capture.recover(&self.display) {
                    eprintln!(
                        "cyrene-screenshot: DXGI rebuild failed ({rebuild_error}); using GDI"
                    );
                    self.capture = Box::new(GdiCaptureBackend::new()?);
                }
                match self.capture.freeze(&self.display) {
                    Ok(frame) => frame,
                    Err(retry_error) if self.capture.name() == "dxgi" => {
                        eprintln!(
                            "cyrene-screenshot: rebuilt DXGI freeze failed ({retry_error}); using GDI"
                        );
                        self.capture = Box::new(GdiCaptureBackend::new()?);
                        self.capture.freeze(&self.display)?
                    }
                    Err(retry_error) => return Err(retry_error),
                }
            }
            Err(error) => return Err(error),
        };

        if self.capture.should_fallback_to_gdi() {
            eprintln!("cyrene-screenshot: DXGI cursor policy requires GDI for the current session");
            self.capture = Box::new(GdiCaptureBackend::new()?);
            return self.capture.freeze(&self.display);
        }
        Ok(frame)
    }

    /// Execute the real commit path described in the T6 plan:
    ///   1. Extract the selection BGRA from the frozen cache (best effort;
    ///      failure aborts the commit with `selection-extract-failed`).
    ///   2. Publish the selection to the clipboard (failure sets
    ///      `clipboard_written: false` but continues).
    ///   3. Hide the overlay, clear the GDI cache, and release the
    ///      interaction state to Idle.
    ///   4. Emit `Event::CaptureReleased` so the Electron side can unblock
    ///      the user immediately (paste works, attachment does not).
    ///   5. For `clipboard-only`, emit `Event::Completed { fileName: None }`
    ///      with the clipboard flag.
    ///   6. For `clipboard-and-file`, spawn the encoder thread (owning the
    ///      selection BGRA) and emit `Event::Completed { fileName: Some }`
    ///      or `Event::Error { code: encode-failed }` from the worker.
    fn commit(&mut self, event_tx: &Sender<Event>) {
        // Step 1: read selection while it is still valid (overlay still up).
        let selection = self.overlay.selection().unwrap_or(crate::geometry::RectI {
            x: 0,
            y: 0,
            width: self.display.bounds.width,
            height: self.display.bounds.height,
        });
        let annotations = self.overlay.annotations();
        let has_annotations = !annotations.is_empty();
        let gpu_frame = self.active.as_ref().and_then(|active| match &active.frame {
            FrozenFrame::Gpu(gpu) => Some(gpu),
            FrozenFrame::Cpu(_) => None,
        });
        let mut frame = match self.renderer.extract_selection(selection, gpu_frame) {
            Ok(selection) => {
                self.capture.record_selection_readback();
                selection
            }
            Err(error) => {
                self.finish_error(
                    event_tx,
                    "selection-extract-failed",
                    &error.to_string(),
                    true,
                );
                return;
            }
        };
        burn_annotations(
            &mut frame,
            &annotations,
            crate::geometry::PointI {
                x: selection.x,
                y: selection.y,
            },
        );
        let selection_width = frame.width;
        let selection_height = frame.height;
        // 排查偶发截图方向异常：记录当次捕获的关键几何/后端信息，
        // 复现时可直接从日志定位是 rotation 检测、后端回退还是别的环节。
        eprintln!(
            "cyrene-screenshot: committed selection={}x{} at ({},{}) display={:?} rotation={:?} backend={} diag={:?}",
            selection.width,
            selection.height,
            selection.x,
            selection.y,
            self.display.bounds,
            self.display.rotation,
            self.capture.name(),
            self.capture.diagnostics()
        );

        // Step 2: clipboard (best effort — capture-released records the flag).
        let clipboard_written = write_cf_dibv5(self.overlay.hwnd(), &frame)
            .map(|()| true)
            .unwrap_or_else(|error| {
                eprintln!("cyrene-screenshot: clipboard write failed: {error}");
                false
            });

        // Step 3: take the active request, hide overlay, free GDI cache, and
        // mark the overlay input state as Idle.
        let active = match self.active.take() {
            Some(active) => active,
            None => return,
        };
        self.teardown_overlay();

        // Step 4: capture-released so the caller can immediately offer
        // clipboard-based paste. Record the release in the registry so the
        // request's metadata is visible to subsequent Start/Cancel handling
        // until the terminal event below.
        let _ = event_tx.send(Event::CaptureReleased {
            request_id: active.request_id.clone(),
            clipboard_written,
            width: selection_width,
            height: selection_height,
            diagnostics: self.capture.diagnostics(),
        });
        match lock_registry(&self.requests) {
            Ok(mut registry_guard) => {
                if let Err(error) = registry_guard.capture_released(
                    &active.request_id,
                    clipboard_written,
                    selection_width,
                    selection_height,
                ) {
                    // A capture_released error means the registry has lost
                    // track of the request ID (e.g., a cancel arrived
                    // mid-commit). The wire events have already been
                    // published; surface the inconsistency so the underlying
                    // channel can match the registry in the future.
                    eprintln!("cyrene-screenshot: registry capture_released failed: {error}");
                }
            }
            Err(error) => {
                eprintln!("cyrene-screenshot: registry capture_released lock unavailable: {error}");
            }
        }

        // Step 5/6: terminal event depends on capture mode.
        match active.mode {
            CaptureMode::ClipboardOnly => {
                let request_id = active.request_id;
                let _ = event_tx.send(Event::Completed {
                    request_id: request_id.clone(),
                    file_name: None,
                    width: selection_width,
                    height: selection_height,
                    mime: "image/png",
                    clipboard_written,
                    has_annotations,
                });
                // Terminal event: remove the requestId from the registry so a
                // future Start with the same ID can succeed.
                finalize_request(&self.requests, &request_id, "complete");
            }
            CaptureMode::ClipboardAndFile => {
                let file_name = encoder::new_png_file_name();
                let job = EncodeJob {
                    request_id: active.request_id,
                    file_name,
                    output_dir: self.output_dir.clone(),
                    frame,
                    has_annotations,
                };
                // The encoder worker is the producer of the terminal
                // `Completed`/`Error` event for this requestId. It will
                // finalize the registry entry when it emits that event.
                encoder::spawn_encode_job(job, event_tx.clone(), Arc::clone(&self.requests));
            }
        }
    }

    fn cancel(&mut self, event_tx: &std::sync::mpsc::Sender<Event>, reason: &str) {
        let Some(active) = self.active.take() else {
            return;
        };
        self.teardown_overlay();
        // The internal state machine transitions through `Cancelling` before
        // reaching a terminal state, but the wire protocol surfaces a single
        // terminal `Cancelled` event (no `Cancelling` variant exists on
        // `InteractionStateEvent`). The requestId is finalized in the registry
        // so a subsequent Start with the same ID can succeed.
        let request_id = active.request_id;
        let _ = event_tx.send(Event::Cancelled {
            request_id: request_id.clone(),
            reason: reason.into(),
        });
        finalize_request(&self.requests, &request_id, "cancel");
    }

    fn finish_error(
        &mut self,
        event_tx: &std::sync::mpsc::Sender<Event>,
        code: &str,
        message: &str,
        recoverable: bool,
    ) {
        let request_id = self.active.take().map(|active| active.request_id);
        self.teardown_overlay();
        // Terminal event: a non-recoverable error finishes the requestId in
        // the registry; a recoverable error does the same because the
        // overlay has been torn down and no further events for the request
        // will be published.
        if let Some(id) = &request_id {
            finalize_request(&self.requests, id, "cancel");
        }
        send_error(event_tx, request_id, code, message, recoverable);
    }

    fn teardown_overlay(&mut self) {
        self.overlay.detach_renderer();
        self.renderer.clear_frozen();
        let _ = self.overlay.hide();
        self.capture.invalidate();
    }
}

fn send_error(
    event_tx: &std::sync::mpsc::Sender<Event>,
    request_id: Option<String>,
    code: &str,
    message: &str,
    recoverable: bool,
) {
    let _ = event_tx.send(Event::Error {
        request_id,
        code: code.into(),
        message: message.into(),
        recoverable,
    });
}

/// Lock the registry for a brief mutation. Recoverable from a poisoned mutex
/// because the only mutation paths are command-/event-driven and idempotent;
/// `PoisonError::into_inner` hands back the guard so an eventual poisoned
/// state never blocks progress.
fn lock_registry(
    registry: &Arc<Mutex<RequestRegistry>>,
) -> std::sync::LockResult<std::sync::MutexGuard<'_, RequestRegistry>> {
    // `PoisonError::into_inner` returns the inner guard. Wrapping it in
    // `PoisonError::new`-equivalent would re-poison; the simplest way to
    // return a `LockResult` is to use the `ok` conversion on the guard
    // directly via `Ok(guard.into_inner())` equivalent — which is what
    // `PoisonError::into_inner` already does. But that returns the guard
    // itself rather than a new `LockResult`, so we wrap it back manually.
    match registry.lock() {
        Ok(guard) => Ok(guard),
        Err(poison) => {
            eprintln!("cyrene-screenshot: requests mutex poisoned, recovering");
            Ok(poison.into_inner())
        }
    }
}

/// Look up whether a requestId is currently pending. Reads the registry
/// without disturbing any in-progress mutation.
fn registry_is_pending(registry: &Arc<Mutex<RequestRegistry>>, request_id: &str) -> bool {
    match lock_registry(registry) {
        Ok(registry_guard) => registry_guard.is_pending(request_id),
        Err(_) => false,
    }
}

/// Finalize a requestId in the registry after a terminal event has been
/// published to the wire. `mode` is "complete" (success path) or "cancel"
/// (cancel/error path); both currently route to `RequestRegistry::finish`
/// internally. Errors are logged instead of propagated because the wire event
/// has already been emitted and a registry mismatch cannot be undone.
fn finalize_request(registry: &Arc<Mutex<RequestRegistry>>, request_id: &str, mode: &str) {
    match lock_registry(registry) {
        Ok(mut registry_guard) => {
            let outcome = match mode {
                "complete" => registry_guard.complete(request_id, None),
                _ => registry_guard.cancel(request_id, mode),
            };
            if let Err(error) = outcome {
                eprintln!(
                    "cyrene-screenshot: requests finalize ({mode}) for {request_id} failed: {error}"
                );
            }
        }
        Err(_) => {
            eprintln!("cyrene-screenshot: requests finalize lock unavailable");
        }
    }
}

struct MessageWindow {
    hwnd: HWND,
}

impl MessageWindow {
    fn create() -> Result<Self, AppError> {
        let window_class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            lpszClassName: WINDOW_CLASS,
            ..Default::default()
        };
        // SAFETY: window_class points to valid static class-name storage and a
        // process-lifetime window procedure.
        if unsafe { RegisterClassW(&window_class) } == 0 {
            return Err(WindowsError::from_thread().into());
        }

        // SAFETY: The registered class and all optional handles remain valid;
        // HWND_MESSAGE creates a non-visible message-only window.
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                WINDOW_CLASS,
                w!(""),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
        };
        match hwnd {
            Ok(hwnd) => Ok(Self { hwnd }),
            Err(error) => {
                // SAFETY: The class was registered by this call and no window was
                // created from it.
                let _ = unsafe { UnregisterClassW(WINDOW_CLASS, None) };
                Err(error.into())
            }
        }
    }
}

impl Drop for MessageWindow {
    fn drop(&mut self) {
        // SAFETY: hwnd is owned by this UI thread and destroyed exactly once.
        let _ = unsafe { DestroyWindow(self.hwnd) };
        // SAFETY: All windows created from this process-local class are gone.
        let _ = unsafe { UnregisterClassW(WINDOW_CLASS, None) };
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: This procedure forwards untouched parameters supplied by Windows.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::win::capture::RefreshOutcome;

    #[test]
    fn idle_capture_pump_refreshes_with_a_bounded_timeout() {
        let outcome = pump_capture_if_idle(false, |timeout_ms| {
            assert_eq!(timeout_ms, 16);
            Ok(RefreshOutcome::Updated)
        })
        .expect("idle pump should propagate a successful refresh");

        assert_eq!(outcome, Some(RefreshOutcome::Updated));
    }

    #[test]
    fn visible_overlay_never_advances_the_live_capture_texture() {
        let outcome = pump_capture_if_idle(true, |_| {
            panic!("capture refresh must not run while a frozen overlay is active")
        })
        .expect("active overlay should be a successful no-op");

        assert_eq!(outcome, None);
    }
}
