//! Async WIC PNG encoder for `clipboard-and-file` commits.
//!
//! The encoder runs on a worker thread (spawned by `app.rs` per commit) so
//! the UI thread stays responsive while WIC processes a full-screen PNG.
//! Each job owns its [`EncodeJob`] so the worker can move the data into the
//! thread without holding any reference back into the UI thread's state.
//!
//! File lifecycle:
//!   * The worker writes `<uuid>.png.tmp` in `output_dir`.
//!   * On success, the temp file is atomically renamed to `<uuid>.png`.
//!     `std::fs::rename` on Windows uses `MoveFileExW` which is atomic
//!     within the same volume (we never cross volumes because both names
//!     live in the same directory).
//!   * On failure, the temp file is deleted if it exists and an
//!     `Event::Error { code: "encode-failed" }` is sent.
//!
//! COM/WIC initialization:
//!   * Each worker calls `CoInitializeEx(COINIT_MULTITHREADED)` and pairs
//!     it with `CoUninitialize` in a guard, even on the encode-failure
//!     path. Using `COINIT_MULTITHREADED` (instead of the apartment-threaded
//!     variant) lets the future-proof path keep WIC objects across calls
//!     without proxying.
//!   * The WIC imaging factory is created via the documented
//!     `CLSID_WICImagingFactory` CoCreateInstance path.

use std::{
    fs,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc::Sender},
    thread,
};

use uuid::Uuid;
use windows::{
    Win32::{
        Foundation::GENERIC_WRITE,
        Graphics::Imaging::{
            CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGRA,
            IWICBitmapEncoder, IWICBitmapFrameEncode, IWICImagingFactory, IWICStream,
            WICBitmapEncoderNoCache,
        },
        System::{
            Com::StructuredStorage::IPropertyBag2,
            Com::{
                CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize,
            },
        },
    },
    core::{HRESULT, PCWSTR},
};

use crate::{
    error::HelperError, protocol::Event, request::RequestRegistry, win::capture::CpuBgraFrame,
};

/// One async PNG encode. The worker owns the frame so the UI thread can drop
/// its reference immediately after spawning.
pub struct EncodeJob {
    pub request_id: String,
    pub file_name: String,
    pub output_dir: PathBuf,
    pub frame: CpuBgraFrame,
    pub has_annotations: bool,
}

/// Spawn a worker thread that runs [`run_encode_job`] with `job` and posts
/// the resulting [`Event`] on `event_tx`. The shared `registry` is finalized
/// on the worker when it emits the terminal event, so a second `Start` for
/// the same `request_id` is rejected even if it arrives before this worker
/// has shut down.
///
/// The worker is detached (no `JoinHandle` is returned) because the helper's
/// stdout writer drains the channel independently of commit completion; if
/// the helper shuts down before the encoder posts its event, the
/// `Event::Completed` is simply dropped (the request ID was never observed
/// in the pending registry at that point either).
///
/// On `Builder::spawn` failure (resource exhaustion, etc.) we surface an
/// `error("encode-failed", "failed to spawn encoder")` event on the existing
/// `event_tx` and finalize the registry entry, so the requestId never stays
/// in pending forever. We never panic the helper process from this path.
pub fn spawn_encode_job(
    job: EncodeJob,
    event_tx: Sender<Event>,
    registry: Arc<Mutex<RequestRegistry>>,
) {
    let request_id_for_failure = job.request_id.clone();
    let event_tx_for_worker = event_tx.clone();
    let registry_for_worker = Arc::clone(&registry);
    let spawn_result = thread::Builder::new()
        .name("cyrene-encode".into())
        .spawn(move || {
            let outcome = run_encode_job(&job);
            let event = match outcome {
                Ok(()) => Event::Completed {
                    request_id: job.request_id.clone(),
                    file_name: Some(job.file_name),
                    width: job.frame.width,
                    height: job.frame.height,
                    mime: "image/png",
                    clipboard_written: true,
                    has_annotations: job.has_annotations,
                },
                Err(error) => Event::Error {
                    request_id: Some(job.request_id.clone()),
                    code: "encode-failed".into(),
                    message: error.to_string(),
                    recoverable: false,
                },
            };
            // Best-effort: if the helper has already dropped the channel
            // (e.g., during shutdown) there is nothing to send.
            let _ = event_tx_for_worker.send(event);
            // Finalize the registry entry on the worker thread so a follow-up
            // `Start` for the same requestId observes a clean state. The
            // `Cancel`-during-encode path also calls `registry.cancel` from
            // the UI thread; whoever gets there first wins (the second
            // observes `AlreadyFinished` and is logged-and-ignored).
            finalize_registry(&registry_for_worker, &job.request_id, "complete");
        });
    if let Err(error) = spawn_result {
        let _ = event_tx.send(Event::Error {
            request_id: Some(request_id_for_failure.clone()),
            code: "encode-failed".into(),
            message: format!("failed to spawn encoder: {error}"),
            recoverable: false,
        });
        finalize_registry(&registry, &request_id_for_failure, "cancel");
    }
}

/// Lock `registry` briefly to finalize `request_id`. Errors are logged
/// instead of propagated because the wire event has already been emitted.
fn finalize_registry(registry: &Arc<Mutex<RequestRegistry>>, request_id: &str, mode: &str) {
    match registry.lock() {
        Ok(mut registry_guard) => {
            let outcome = match mode {
                "complete" => registry_guard.complete(request_id, None),
                _ => registry_guard.cancel(request_id, mode),
            };
            if let Err(error) = outcome {
                eprintln!(
                    "cyrene-screenshot: encoder finalize ({mode}) for {request_id} failed: {error}"
                );
            }
        }
        Err(poison) => {
            eprintln!(
                "cyrene-screenshot: encoder finalize lock unavailable for {request_id}: {poison}"
            );
        }
    }
}

/// RAII guard for `CoInitializeEx` / `CoUninitialize` on the encode worker
/// thread. CoInitializeEx returns `S_FALSE` (== 0x00000001) if COM was
/// already initialized on this thread; treat that as success so a test
/// thread that called `CoInitializeEx` upstream can still spawn an encode.
struct ComGuard {
    /// True only when `CoInitializeEx` returned `S_OK` and this thread owns
    /// the matching init. `S_FALSE` (already initialized) does NOT entitle
    /// us to call `CoUninitialize`, which would tear down an init owned by
    /// another upstream component.
    owns_init: bool,
}

impl ComGuard {
    fn initialize() -> Result<Self, HelperError> {
        // SAFETY: CoInitializeEx has no preconditions; passing None for the
        // reserved pointer matches the documented FFI signature.
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result.is_ok() {
            Ok(Self { owns_init: true })
        } else if result == HRESULT(0x0000_0001) {
            // COM was already initialized on this thread (e.g., a test
            // harness called CoInitializeEx upstream). We do not own that
            // init, so do not pair it with CoUninitialize.
            Ok(Self { owns_init: false })
        } else {
            Err(HelperError::CaptureFailed(format!(
                "CoInitializeEx failed: {result:?}"
            )))
        }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if !self.owns_init {
            return;
        }
        // SAFETY: `owns_init` was set only when CoInitializeEx returned
        // S_OK, so this thread currently owns a matching CoInitialize;
        // CoUninitialize is the documented pair. The HRESULT is
        // intentionally ignored because the worker thread is about to
        // exit anyway.
        unsafe {
            CoUninitialize();
        }
    }
}

/// Run one encode job to completion. Returns `Ok(())` only when the final
/// `<uuid>.png` exists on disk; any failure removes the partial `.tmp` and
/// returns an error suitable for an `Event::Error` payload.
fn run_encode_job(job: &EncodeJob) -> Result<(), HelperError> {
    let _com = ComGuard::initialize()?;

    if job.frame.width == 0 || job.frame.height == 0 {
        return Err(HelperError::CaptureFailed(
            "encoder received an empty frame".into(),
        ));
    }

    // WIC InitializeFromFilename does not create parent directories; a
    // missing output dir surfaces as 0x80070003 (ERROR_PATH_NOT_FOUND).
    // create_dir_all is idempotent, so this is a cheap belt-and-suspenders
    // alongside the Electron-side mkdir before spawn.
    fs::create_dir_all(&job.output_dir).map_err(|error| {
        HelperError::CaptureFailed(format!(
            "create output dir {} failed: {error}",
            job.output_dir.display()
        ))
    })?;

    // SAFETY: CoCreateInstance with CLSID_WICImagingFactory and an
    // IUnknown-derived interface (IWICImagingFactory). The factory is
    // thread-safe (WIC documentation); using CLSCTX_INPROC_SERVER (the
    // default) keeps the factory in-process so no RPC boundary is crossed.
    let factory: IWICImagingFactory =
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }.map_err(
            |error| {
                HelperError::CaptureFailed(format!(
                    "CoCreateInstance(WICImagingFactory) failed: {error}"
                ))
            },
        )?;

    // Compute paths inside the caller-supplied output dir. The caller is
    // responsible for ensuring the dir exists; the encoder surfaces an
    // io::Error-derived HelperError otherwise.
    let tmp_path = job.output_dir.join(format!("{}.tmp", job.file_name));
    let final_path = job.output_dir.join(&job.file_name);

    let encode_result = encode_to_path(&factory, &job.frame, &tmp_path);

    match encode_result {
        Ok(()) => {
            // Atomically rename the temp file to its final name. Both
            // paths live in the same directory, so std::fs::rename uses
            // MoveFileExW without crossing volumes and is atomic from the
            // user's perspective.
            if let Err(error) = fs::rename(&tmp_path, &final_path) {
                // Best-effort cleanup of the temp file we wrote; surface
                // the rename failure to the caller.
                let _ = fs::remove_file(&tmp_path);
                return Err(HelperError::CaptureFailed(format!(
                    "atomic rename to {} failed: {error}",
                    final_path.display()
                )));
            }
            Ok(())
        }
        Err(error) => {
            // Encode failed: remove the partial temp file if any.
            let _ = fs::remove_file(&tmp_path);
            Err(error)
        }
    }
}

/// Write the frame to `path` via WIC.
///
/// This is a free function so unit tests can exercise the encoding path
/// without spinning up the worker thread.
fn encode_to_path(
    factory: &IWICImagingFactory,
    frame: &CpuBgraFrame,
    path: &Path,
) -> Result<(), HelperError> {
    // SAFETY: CreateStream returns a fresh IWICStream; we own the only
    // reference and drop it on every error path below.
    let stream: IWICStream = unsafe { factory.CreateStream() }
        .map_err(|error| HelperError::CaptureFailed(format!("WIC CreateStream failed: {error}")))?;

    // Bind the stream to the on-disk path. The wide string lives until
    // Initialize returns (Initialize is synchronous on the calling
    // thread); after that WIC owns the path internally.
    let wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let wide_path_pcwstr = PCWSTR(wide_path.as_ptr());
    unsafe { stream.InitializeFromFilename(wide_path_pcwstr, GENERIC_WRITE.0) }.map_err(
        |error| {
            HelperError::CaptureFailed(format!(
                "WIC stream init from {} failed: {error}",
                path.display()
            ))
        },
    )?;

    // SAFETY: CreateEncoder returns a fresh IWICBitmapEncoder; we own the
    // only reference and drop it on every error path below.
    let encoder: IWICBitmapEncoder =
        unsafe { factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null()) }.map_err(
            |error| HelperError::CaptureFailed(format!("WIC CreateEncoder(PNG) failed: {error}")),
        )?;

    // SAFETY: Initialize takes the IWICStream by reference; the stream
    // outlives the encoder (encoder commits to the stream).
    unsafe { encoder.Initialize(&stream, WICBitmapEncoderNoCache) }.map_err(|error| {
        HelperError::CaptureFailed(format!("WIC encoder Initialize failed: {error}"))
    })?;

    // SAFETY: CreateNewFrame returns a fresh frame encoder. The
    // IPropertyBag2 out-parameter is unused; pass a null pointer so WIC
    // uses its defaults.
    let mut frame_opt: Option<IWICBitmapFrameEncode> = None;
    let mut bag_opt: Option<IPropertyBag2> = None;
    unsafe { encoder.CreateNewFrame(&mut frame_opt, &mut bag_opt) }.map_err(|error| {
        HelperError::CaptureFailed(format!("WIC CreateNewFrame failed: {error}"))
    })?;
    let frame_encoder = frame_opt.expect("CreateNewFrame returned null frame encoder");

    // The frame encoder must be initialized with the (optional) property bag
    // before any SetSize / SetPixelFormat / WritePixels call. Passing a null
    // pointer / None means "use defaults".
    unsafe { frame_encoder.Initialize(std::option::Option::<&IPropertyBag2>::None) }.map_err(
        |error| HelperError::CaptureFailed(format!("WIC frame Initialize failed: {error}")),
    )?;

    let width = frame.width;
    let height = frame.height;
    let mut pixel_format = GUID_WICPixelFormat32bppBGRA;

    // SAFETY: SetSize and SetPixelFormat take plain integers / GUIDs and
    // mutate the frame encoder in place.
    unsafe { frame_encoder.SetSize(width, height) }
        .map_err(|error| HelperError::CaptureFailed(format!("WIC SetSize failed: {error}")))?;
    unsafe { frame_encoder.SetPixelFormat(&mut pixel_format) }.map_err(|error| {
        HelperError::CaptureFailed(format!("WIC SetPixelFormat failed: {error}"))
    })?;
    if pixel_format != GUID_WICPixelFormat32bppBGRA {
        return Err(HelperError::CaptureFailed(format!(
            "WIC rejected 32bppBGRA pixel format; got {pixel_format:?}"
        )));
    }

    // Write the BGRA pixels. Pitch is the row stride in bytes; the encoder
    // will pack them in PNG without padding because we supply exactly
    // width*4 bytes per row.
    let pitch = frame.width * 4;
    let expected_bytes = frame.height.checked_mul(pitch).ok_or_else(|| {
        HelperError::EncodeFailed(format!(
            "encoder pixel buffer overflow computing {}*{}",
            frame.height, pitch
        ))
    })?;
    let bytes = frame.pixels.len() as u32;
    if bytes != expected_bytes {
        return Err(HelperError::CaptureFailed(format!(
            "encoder pixel buffer mismatch: bytes={bytes} expected={expected_bytes}"
        )));
    }
    unsafe { frame_encoder.WritePixels(height, pitch, frame.pixels.as_slice()) }
        .map_err(|error| HelperError::CaptureFailed(format!("WIC WritePixels failed: {error}")))?;

    // Commit the frame, then the encoder; both can fail and both report
    // back via HRESULT. Any failure leaves the stream in an unknown state
    // and we discard the partial file in the caller.
    unsafe { frame_encoder.Commit() }
        .map_err(|error| HelperError::CaptureFailed(format!("WIC frame Commit failed: {error}")))?;
    unsafe { encoder.Commit() }.map_err(|error| {
        HelperError::CaptureFailed(format!("WIC encoder Commit failed: {error}"))
    })?;

    Ok(())
}

/// Generate a new `<uuid>.png` file name without the directory.
pub fn new_png_file_name() -> String {
    format!("{}.png", Uuid::new_v4())
}
