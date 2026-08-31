//! DXGI Desktop Duplication capture backend.
//!
//! This is the **primary** capture path. It builds a D3D11 device,
//! duplicates the primary monitor output, and keeps a small pool of GPU
//! textures alive for the duration of an interaction so that
//!
//!   * the first frame is presented to the overlay with **no full-screen CPU
//!     readback** (the renderer paints the frozen GPU texture directly via
//!     D2D),
//!   * mouse moves do not re-upload the frame (only the D2D repaint is
//!     invalidated),
//!   * the commit path performs a single selection-sized `CopySubresourceRegion`
//!     + `Map` to hand the encoder/clipboard a CPU BGRA buffer.
//!
//! When DXGI init fails (no D3D11 device available, no primary output, or
//! `DuplicateOutput` returns `DXGI_ERROR_UNSUPPORTED` /
//! `DXGI_ERROR_ACCESS_LOST` at startup), the helper falls back to
//! [`crate::win::capture_gdi::GdiCaptureBackend`] for the whole session.
//!
//! The capture pump lives on the UI thread and is driven by
//! [`DxgiCaptureBackend::refresh_latest`]: each call to `AcquireNextFrame`
//! uses a 16–50 ms timeout (never `INFINITE`) so the message loop remains
//! responsive even when the desktop is idle.

use windows::{
    Win32::{
        Foundation::{HMODULE, RECT},
        Graphics::{
            Direct2D::{
                Common as D2D, D2D1_BITMAP_OPTIONS_CANNOT_DRAW, D2D1_BITMAP_OPTIONS_NONE,
                D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_PROPERTIES1,
                D2D1_DEVICE_CONTEXT_OPTIONS_NONE, D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
                D2D1CreateDevice, ID2D1Bitmap1, ID2D1Image,
            },
            Direct3D::{
                D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_9_1, D3D_FEATURE_LEVEL_9_2,
                D3D_FEATURE_LEVEL_9_3, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1,
                D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
            },
            Direct3D11::{
                D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_SDK_VERSION,
                D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11CreateDevice,
                ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
            },
            Dxgi::{
                Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
                DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_DEVICE_REMOVED, DXGI_ERROR_DEVICE_RESET,
                DXGI_ERROR_UNSUPPORTED, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
                IDXGIAdapter, IDXGIDevice, IDXGIOutput, IDXGIOutput1, IDXGIOutputDuplication,
                IDXGIResource, IDXGISurface,
            },
        },
        UI::WindowsAndMessaging::{CURSOR_SHOWING, CURSORINFO, GetCursorInfo},
    },
    core::Interface,
};
use windows_numerics::Matrix3x2;

use crate::{
    error::HelperError,
    geometry::{DisplayRotation, RectI},
    win::{
        capture::{
            CaptureBackend, CaptureDiagnostics, CpuBgraFrame, FrozenFrame, GpuFrozenFrame,
            RefreshOutcome,
        },
        display::DisplayInfo,
    },
};

/// Cursor visibility probe so we can choose the per-session capture strategy
/// without consulting the expensive `GetFramePointerShape` API.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorVisibility {
    Hidden,
    /// Cursor is visible inside the primary monitor's client area.
    VisibleInside,
    /// Cursor is visible but outside the primary monitor (or off-screen).
    VisibleOutside,
}

/// Selection rectangle in canonical display-local coordinates. A separate
/// type so the renderer cannot accidentally pass physical-pixel coordinates
/// to the GPU readback path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RectISelection {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl From<RectI> for RectISelection {
    fn from(rect: RectI) -> Self {
        // The renderer only ever sends selections whose origin is in the
        // canonical display-local frame (matching `display.bounds` with
        // origin at top-left); clamp negatives defensively.
        Self {
            x: rect.x.max(0) as u32,
            y: rect.y.max(0) as u32,
            width: rect.width,
            height: rect.height,
        }
    }
}

/// DXGI-backed capture of the primary monitor.
///
/// Owns a D3D11 device, the duplication interface, and two texture pools:
///
///   * `latest_texture` — receives `CopyResource` from each acquired frame.
///   * `frozen_texture` — the GPU-resident frame that the renderer binds as
///     a D2D bitmap. Mouse-move repaints do not touch this texture.
///
/// All COM resources are released when the backend is dropped (via the COM
/// reference-counting contract — there are no manual `Release` calls).
pub struct DxgiCaptureBackend {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    latest_texture: ID3D11Texture2D,
    frozen_texture: ID3D11Texture2D,
    /// Display-oriented frozen texture (size matches canonical display
    /// bounds). `Some` for non-identity rotations, `None` for identity.
    frozen_oriented: Option<ID3D11Texture2D>,
    /// Width/height of `latest_texture` (physical pixels, before rotation).
    physical_width: u32,
    physical_height: u32,
    /// Canonical width/height matching `display.bounds` (after rotation).
    canonical_width: u32,
    canonical_height: u32,
    rotation: DisplayRotation,
    /// Set by `freeze()` after a successful GPU freeze; consumed by
    /// `OverlayRenderer::upload_frozen`. Reset on `invalidate`.
    last_frame_info: Option<DXGI_OUTDUPL_FRAME_INFO>,
    /// Cumulative counters surfaced through `CaptureDiagnostics`.
    full_frame_cpu_readbacks: u64,
    selection_cpu_readbacks: u64,
    latest_copies: u64,
    duplication_rebuilds: u64,
}

impl std::fmt::Debug for DxgiCaptureBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DxgiCaptureBackend")
            .field("physical_width", &self.physical_width)
            .field("physical_height", &self.physical_height)
            .field("canonical_width", &self.canonical_width)
            .field("canonical_height", &self.canonical_height)
            .field("rotation", &self.rotation)
            .field("full_frame_cpu_readbacks", &self.full_frame_cpu_readbacks)
            .field("selection_cpu_readbacks", &self.selection_cpu_readbacks)
            .field("latest_copies", &self.latest_copies)
            .field("duplication_rebuilds", &self.duplication_rebuilds)
            .finish_non_exhaustive()
    }
}

impl DxgiCaptureBackend {
    /// Initialize the DXGI capture pipeline against `display`. The caller is
    /// responsible for re-querying `display` between sessions so the device
    /// tracks the current monitor topology.
    ///
    /// `force_init_failure` is a test seam that lets the integration tests
    /// assert the documented GDI fallback path without rebooting into a
    /// headless session. Production callers should always pass `false`.
    pub fn new(display: &DisplayInfo, force_init_failure: bool) -> Result<Self, HelperError> {
        if force_init_failure {
            return Err(HelperError::CaptureFailed(
                "DXGI init failure forced by test seam".into(),
            ));
        }

        let (device, context) = create_d3d11_device()?;
        let duplication = create_duplication(&device, display)?;
        let duplication_desc = unsafe { duplication.GetDesc() };

        let (physical_width, physical_height) = physical_dimensions(display);
        let (canonical_width, canonical_height) = (display.bounds.width, display.bounds.height);
        if duplication_desc.ModeDesc.Width != physical_width
            || duplication_desc.ModeDesc.Height != physical_height
        {
            return Err(HelperError::CaptureFailed(format!(
                "DXGI output dimensions {}x{} do not match primary display {}x{}",
                duplication_desc.ModeDesc.Width,
                duplication_desc.ModeDesc.Height,
                physical_width,
                physical_height
            )));
        }

        let latest_texture = create_default_texture(&device, physical_width, physical_height, 0)?;
        let frozen_texture = create_default_texture(
            &device,
            physical_width,
            physical_height,
            (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
        )?;

        Ok(Self {
            device,
            context,
            duplication,
            latest_texture,
            frozen_texture,
            frozen_oriented: None,
            physical_width,
            physical_height,
            canonical_width,
            canonical_height,
            rotation: display.rotation,
            last_frame_info: None,
            full_frame_cpu_readbacks: 0,
            selection_cpu_readbacks: 0,
            latest_copies: 0,
            duplication_rebuilds: 0,
        })
    }

    /// Rebuild the DXGI duplication + texture pool after
    /// `DXGI_ERROR_ACCESS_LOST` / `DXGI_ERROR_DEVICE_REMOVED` /
    /// `DXGI_ERROR_DEVICE_RESET` / `WM_DISPLAYCHANGE` /
    /// `WM_DPICHANGED`. Returns the new backend; the caller is expected to
    /// replace the existing backend with this one.
    pub fn rebuild(&self, display: &DisplayInfo) -> Result<Self, HelperError> {
        let mut next = Self::new(display, false)?;
        next.duplication_rebuilds = self.duplication_rebuilds.saturating_add(1);
        Ok(next)
    }

    /// Returns the cursor's current visibility status (visible/hidden, and
    /// whether the cursor is over the primary monitor). This is used to
    /// decide whether the helper should fall back to a GDI freeze to avoid
    /// capturing the system arrow.
    pub fn cursor_visibility(&self) -> CursorVisibility {
        let mut info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: GetCursorInfo reads into the supplied CURSORINFO; the
        // `cbSize` field is correctly set above.
        let ok = unsafe { GetCursorInfo(&mut info) };
        if !ok.is_ok() {
            return CursorVisibility::Hidden;
        }
        if (info.flags.0 & CURSOR_SHOWING.0) == 0 {
            return CursorVisibility::Hidden;
        }
        let pt = info.ptScreenPos;
        let inside = pt.x >= 0
            && pt.y >= 0
            && (pt.x as u64) < u64::from(self.canonical_width)
            && (pt.y as u64) < u64::from(self.canonical_height);
        if inside {
            CursorVisibility::VisibleInside
        } else {
            CursorVisibility::VisibleOutside
        }
    }

    /// Decide whether the helper should opt-out of DXGI for the current
    /// session. When the cursor is visible AND the DXGI frame info reports
    /// `PointerPosition.Visible == false`, the cursor is composited into
    /// the desktop and DXGI will NOT paint it; the captured image would
    /// therefore miss the arrow. In that pathological case the helper may
    /// prefer a GDI freeze (which uses `BitBlt` with `CAPTUREBLT` and
    /// therefore captures the cursor layer too).
    pub fn should_fallback_to_gdi(&self) -> bool {
        requires_gdi_for_cursor(self.cursor_visibility(), self.last_frame_info.as_ref())
    }

    /// Extract a CPU BGRA buffer for `rect` (display-local coordinates,
    /// canonical orientation). The caller is expected to clamp `rect`
    /// against the frozen frame's bounds; this method only validates
    /// non-zero dimensions.
    pub fn read_selection_to_cpu(
        &mut self,
        rect: RectISelection,
    ) -> Result<CpuBgraFrame, HelperError> {
        if rect.width == 0 || rect.height == 0 {
            return Err(HelperError::CaptureFailed(
                "read_selection_to_cpu called with zero-sized rect".into(),
            ));
        }
        self.selection_cpu_readbacks = self.selection_cpu_readbacks.saturating_add(1);

        // Staging texture sized to the selection. This is the only place
        // the GPU path touches CPU memory: a single small region copy.
        let staging = create_staging_texture(&self.device, rect.width, rect.height)?;

        let source: ID3D11Texture2D = self
            .frozen_oriented
            .clone()
            .unwrap_or_else(|| self.frozen_texture.clone());

        let src_box = windows::Win32::Graphics::Direct3D11::D3D11_BOX {
            left: rect.x,
            top: rect.y,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height,
            front: 0,
            back: 1,
        };
        // SAFETY: CopySubresourceRegion copies `src_box` bytes from the
        // frozen texture's subresource 0 into the staging texture's
        // subresource 0 at offset (0,0,0). The bounding box fits because
        // we sized the staging texture to `rect`.
        unsafe {
            self.context
                .CopySubresourceRegion(&staging, 0, 0, 0, 0, &source, 0, Some(&src_box));
        }

        let mut mapped = windows::Win32::Graphics::Direct3D11::D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: Map of a staging texture is documented to succeed for any
        // readable subresource; `mapped.pData` is non-null on success.
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        }
        .map_err(|error| {
            HelperError::CaptureFailed(format!("Map(selection staging) failed: {error}"))
        })?;

        let row_bytes = (rect.width as usize)
            .checked_mul(4)
            .ok_or_else(|| HelperError::CaptureFailed("selection row overflow".into()))?;
        let total_bytes = row_bytes
            .checked_mul(rect.height as usize)
            .ok_or_else(|| HelperError::CaptureFailed("selection total overflow".into()))?;
        if total_bytes > isize::MAX as usize {
            return Err(HelperError::CaptureFailed(
                "selection pixel buffer exceeds isize::MAX".into(),
            ));
        }
        let mut pixels = vec![0u8; total_bytes];
        let src_pitch = mapped.RowPitch as usize;
        // SAFETY: `mapped.pData` is non-null and points to a buffer of
        // `src_pitch * height` bytes. We copy `row_bytes` bytes per row,
        // clamped to the documented minimum of `RowPitch`.
        unsafe {
            for y in 0..rect.height as usize {
                let src = (mapped.pData as *const u8).add(y * src_pitch);
                let dst = pixels.as_mut_ptr().add(y * row_bytes);
                std::ptr::copy_nonoverlapping(src, dst, row_bytes.min(src_pitch));
            }
        }
        unsafe { self.context.Unmap(&staging, 0) };

        Ok(CpuBgraFrame {
            width: rect.width,
            height: rect.height,
            pitch: rect.width * 4,
            pixels,
        })
    }
}

// --- DXGI helpers ----------------------------------------------------------

fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext), HelperError> {
    let feature_levels = [
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
        D3D_FEATURE_LEVEL_9_3,
        D3D_FEATURE_LEVEL_9_2,
        D3D_FEATURE_LEVEL_9_1,
    ];
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    // SAFETY: pointers are writable and the feature-level slice is valid
    // for the entire call. `None` adapter means "use the default GPU".
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE(std::ptr::null_mut()),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&feature_levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .map_err(|error| {
        HelperError::CaptureFailed(format!(
            "D3D11CreateDevice failed: {error} (last error: {})",
            windows::core::Error::from_thread().message()
        ))
    })?;
    let device = device.expect("D3D11CreateDevice succeeded with no device");
    let context = context.expect("D3D11CreateDevice succeeded with no context");
    Ok((device, context))
}

fn create_duplication(
    device: &ID3D11Device,
    display: &DisplayInfo,
) -> Result<IDXGIOutputDuplication, HelperError> {
    let dxgi_device: IDXGIDevice = device.cast().map_err(|error| {
        HelperError::CaptureFailed(format!("ID3D11Device.cast to IDXGIDevice failed: {error}"))
    })?;
    let adapter: IDXGIAdapter = unsafe { dxgi_device.GetParent() }.map_err(|error| {
        HelperError::CaptureFailed(format!("IDXGIDevice::GetParent(adapter) failed: {error}"))
    })?;
    let mut matching_output = None;
    for index in 0..16 {
        let output: IDXGIOutput = match unsafe { adapter.EnumOutputs(index) } {
            Ok(output) => output,
            Err(_) => break,
        };
        let desc = unsafe { output.GetDesc() }.map_err(|error| {
            HelperError::CaptureFailed(format!("IDXGIOutput::GetDesc({index}) failed: {error}"))
        })?;
        if desc.AttachedToDesktop.as_bool()
            && output_bounds_match_display(desc.DesktopCoordinates, display)
        {
            matching_output = Some(output);
            break;
        }
    }
    let output = matching_output.ok_or_else(|| {
        HelperError::CaptureFailed(format!(
            "D3D11 adapter has no output matching primary display at ({}, {}) {}x{}",
            display.bounds.x, display.bounds.y, display.bounds.width, display.bounds.height
        ))
    })?;
    let output1: IDXGIOutput1 = output.cast().map_err(|error| {
        HelperError::CaptureFailed(format!("IDXGIOutput.cast to IDXGIOutput1 failed: {error}"))
    })?;
    unsafe { output1.DuplicateOutput(device) }.map_err(|error| {
        let code = error.code();
        // E_UNSUPPORTED on a session that is not interactive
        // (e.g., a service or a UAC-restricted process) is the most
        // common cause; surface it as a structured CaptureFailed so the
        // app layer can route to GDI.
        if code == DXGI_ERROR_UNSUPPORTED {
            HelperError::CaptureFailed(
                "DXGI DuplicateOutput returned E_UNSUPPORTED (session is not interactive)".into(),
            )
        } else if code == DXGI_ERROR_ACCESS_LOST {
            HelperError::CaptureFailed(
                "DXGI DuplicateOutput returned ACCESS_LOST (display device changed)".into(),
            )
        } else {
            HelperError::CaptureFailed(format!("DXGI DuplicateOutput failed: {error}"))
        }
    })
}

fn output_bounds_match_display(output: RECT, display: &DisplayInfo) -> bool {
    let right = i64::from(display.bounds.x) + i64::from(display.bounds.width);
    let bottom = i64::from(display.bounds.y) + i64::from(display.bounds.height);
    i64::from(output.left) == i64::from(display.bounds.x)
        && i64::from(output.top) == i64::from(display.bounds.y)
        && i64::from(output.right) == right
        && i64::from(output.bottom) == bottom
}

fn create_staging_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<ID3D11Texture2D, HelperError> {
    create_texture(
        device,
        width,
        height,
        D3D11_USAGE_STAGING,
        D3D11_CPU_ACCESS_READ.0 as u32,
        0,
    )
}

fn create_default_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    bind_flags: u32,
) -> Result<ID3D11Texture2D, HelperError> {
    create_texture(device, width, height, D3D11_USAGE_DEFAULT, 0, bind_flags)
}

fn create_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    usage: windows::Win32::Graphics::Direct3D11::D3D11_USAGE,
    cpu_access: u32,
    bind_flags: u32,
) -> Result<ID3D11Texture2D, HelperError> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: usage,
        BindFlags: bind_flags,
        CPUAccessFlags: cpu_access,
        MiscFlags: 0,
    };
    let mut texture: Option<ID3D11Texture2D> = None;
    // SAFETY: `desc` is a valid D3D11_TEXTURE2D_DESC describing a 2D BGRA
    // texture; the call writes the new texture pointer into `texture`.
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }.map_err(|error| {
        HelperError::CaptureFailed(format!(
            "CreateTexture2D failed: {error} (last error: {})",
            windows::core::Error::from_thread().message()
        ))
    })?;
    texture.ok_or_else(|| HelperError::CaptureFailed("CreateTexture2D returned no texture".into()))
}

fn pointer_position_was_visible(frame: &DXGI_OUTDUPL_FRAME_INFO) -> bool {
    frame.PointerPosition.Visible.as_bool()
}

fn requires_gdi_for_cursor(
    cursor: CursorVisibility,
    frame: Option<&DXGI_OUTDUPL_FRAME_INFO>,
) -> bool {
    cursor != CursorVisibility::Hidden
        && frame.is_some_and(|frame| !pointer_position_was_visible(frame))
}

// --- Geometry helpers ------------------------------------------------------

fn physical_dimensions(display: &DisplayInfo) -> (u32, u32) {
    match display.rotation {
        DisplayRotation::Identity | DisplayRotation::Rotate180 => {
            (display.bounds.width, display.bounds.height)
        }
        DisplayRotation::Rotate90 | DisplayRotation::Rotate270 => {
            (display.bounds.height, display.bounds.width)
        }
    }
}

fn rotation_transform(
    physical_width: u32,
    physical_height: u32,
    rotation: DisplayRotation,
) -> [f32; 6] {
    let width = physical_width as f32;
    let height = physical_height as f32;
    match rotation {
        DisplayRotation::Identity => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        DisplayRotation::Rotate90 => [0.0, 1.0, -1.0, 0.0, height, 0.0],
        DisplayRotation::Rotate180 => [-1.0, 0.0, 0.0, -1.0, width, height],
        DisplayRotation::Rotate270 => [0.0, -1.0, 1.0, 0.0, 0.0, width],
    }
}

fn render_rotated_texture(
    device: &ID3D11Device,
    source: &ID3D11Texture2D,
    target: &ID3D11Texture2D,
    physical_width: u32,
    physical_height: u32,
    rotation: DisplayRotation,
) -> Result<(), HelperError> {
    let dxgi_device: IDXGIDevice = device.cast().map_err(|error| {
        HelperError::CaptureFailed(format!(
            "D3D11 device cast to IDXGIDevice for rotation failed: {error}"
        ))
    })?;
    let d2d_device = unsafe { D2D1CreateDevice(&dxgi_device, None) }.map_err(|error| {
        HelperError::CaptureFailed(format!(
            "D2D1CreateDevice for rotated freeze failed: {error}"
        ))
    })?;
    let context = unsafe { d2d_device.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE) }
        .map_err(|error| {
            HelperError::CaptureFailed(format!(
                "CreateDeviceContext for rotated freeze failed: {error}"
            ))
        })?;

    let source_surface: IDXGISurface = source.cast().map_err(|error| {
        HelperError::CaptureFailed(format!(
            "source texture cast to IDXGISurface for rotation failed: {error}"
        ))
    })?;
    let target_surface: IDXGISurface = target.cast().map_err(|error| {
        HelperError::CaptureFailed(format!(
            "target texture cast to IDXGISurface for rotation failed: {error}"
        ))
    })?;
    let pixel_format = D2D::D2D1_PIXEL_FORMAT {
        format: DXGI_FORMAT_B8G8R8A8_UNORM,
        alphaMode: D2D::D2D1_ALPHA_MODE_IGNORE,
    };
    let source_properties = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: pixel_format,
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
        colorContext: core::mem::ManuallyDrop::new(None),
    };
    let target_properties = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: pixel_format,
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
        colorContext: core::mem::ManuallyDrop::new(None),
    };
    let source_bitmap: ID2D1Bitmap1 =
        unsafe { context.CreateBitmapFromDxgiSurface(&source_surface, Some(&source_properties)) }
            .map_err(|error| {
            HelperError::CaptureFailed(format!(
                "CreateBitmapFromDxgiSurface(source) for rotation failed: {error}"
            ))
        })?;
    let target_bitmap: ID2D1Bitmap1 =
        unsafe { context.CreateBitmapFromDxgiSurface(&target_surface, Some(&target_properties)) }
            .map_err(|error| {
            HelperError::CaptureFailed(format!(
                "CreateBitmapFromDxgiSurface(target) for rotation failed: {error}"
            ))
        })?;

    let [m11, m12, m21, m22, m31, m32] =
        rotation_transform(physical_width, physical_height, rotation);
    let transform = Matrix3x2 {
        M11: m11,
        M12: m12,
        M21: m21,
        M22: m22,
        M31: m31,
        M32: m32,
    };
    let source_rect = D2D::D2D_RECT_F {
        left: 0.0,
        top: 0.0,
        right: physical_width as f32,
        bottom: physical_height as f32,
    };
    unsafe {
        context.SetTarget(&target_bitmap);
        context.BeginDraw();
        context.SetTransform(&transform);
        context.DrawBitmap(
            &source_bitmap,
            Some(&source_rect),
            1.0,
            D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
            None,
            None,
        );
    }
    let draw_result = unsafe { context.EndDraw(None, None) }.map_err(|error| {
        HelperError::CaptureFailed(format!("EndDraw for rotated freeze failed: {error}"))
    });
    unsafe { context.SetTarget(None::<&ID2D1Image>) };
    draw_result
}

impl CaptureBackend for DxgiCaptureBackend {
    fn name(&self) -> &'static str {
        "dxgi"
    }

    fn refresh_latest(&mut self, timeout_ms: u32) -> Result<RefreshOutcome, HelperError> {
        // Clamp the hint into the documented 16..=50 ms range so the
        // helper never sleeps more than 50 ms while waiting for a frame.
        let timeout = timeout_ms.clamp(16, 50);
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        let result = unsafe {
            self.duplication
                .AcquireNextFrame(timeout, &mut info, &mut resource)
        };
        match result {
            Ok(()) => {
                let frame_result = (|| {
                    self.last_frame_info = Some(info);
                    if info.LastPresentTime == 0 {
                        return Ok(RefreshOutcome::Unchanged);
                    }

                    let resource = resource.ok_or_else(|| {
                        HelperError::CaptureFailed(
                            "AcquireNextFrame succeeded without a desktop resource".into(),
                        )
                    })?;
                    let acquired: ID3D11Texture2D = resource.cast().map_err(|error| {
                        HelperError::CaptureFailed(format!(
                            "IDXGIResource.cast to ID3D11Texture2D failed: {error}"
                        ))
                    })?;
                    let mut acquired_desc = D3D11_TEXTURE2D_DESC::default();
                    let mut latest_desc = D3D11_TEXTURE2D_DESC::default();
                    unsafe {
                        acquired.GetDesc(&mut acquired_desc);
                        self.latest_texture.GetDesc(&mut latest_desc);
                    }
                    if acquired_desc.Width != latest_desc.Width
                        || acquired_desc.Height != latest_desc.Height
                        || acquired_desc.Format != latest_desc.Format
                        || acquired_desc.SampleDesc.Count != latest_desc.SampleDesc.Count
                    {
                        return Err(HelperError::CaptureFailed(format!(
                            "DXGI acquired texture {}x{} {:?} is incompatible with latest texture {}x{} {:?}",
                            acquired_desc.Width,
                            acquired_desc.Height,
                            acquired_desc.Format,
                            latest_desc.Width,
                            latest_desc.Height,
                            latest_desc.Format
                        )));
                    }

                    // CopyResource(latest_texture ← acquired). Both are
                    // same-device DEFAULT GPU textures with matching geometry.
                    unsafe {
                        self.context.CopyResource(&self.latest_texture, &acquired);
                    }
                    self.latest_copies = self.latest_copies.saturating_add(1);
                    Ok(RefreshOutcome::Updated)
                })();
                let release_result = unsafe { self.duplication.ReleaseFrame() };
                if let Err(error) = release_result {
                    return Err(HelperError::CaptureFailed(format!(
                        "ReleaseFrame failed: {error}"
                    )));
                }
                frame_result
            }
            Err(error) => {
                let code = error.code();
                if code == DXGI_ERROR_WAIT_TIMEOUT {
                    Ok(RefreshOutcome::Unchanged)
                } else if code == DXGI_ERROR_ACCESS_LOST
                    || code == DXGI_ERROR_DEVICE_REMOVED
                    || code == DXGI_ERROR_DEVICE_RESET
                {
                    Ok(RefreshOutcome::Lost)
                } else {
                    Err(HelperError::CaptureFailed(format!(
                        "AcquireNextFrame failed: {error}"
                    )))
                }
            }
        }
    }

    fn recover(&mut self, display: &DisplayInfo) -> Result<(), HelperError> {
        *self = DxgiCaptureBackend::rebuild(self, display)?;
        Ok(())
    }

    fn freeze(&mut self, display: &DisplayInfo) -> Result<FrozenFrame, HelperError> {
        // Trigger at least one refresh so we have a freshest frame in
        // `latest_texture`. The renderer holds the GPU texture for the
        // duration of the overlay, so this MUST be the only place a copy
        // is read back to the CPU — and we explicitly do NOT do that here.
        for _ in 0..5 {
            match self.refresh_latest(50)? {
                RefreshOutcome::Lost => {
                    // Caller is responsible for rebuilding the backend before
                    // the next freeze attempt; surface a structured error so
                    // the app layer can fall back to GDI.
                    return Err(HelperError::CaptureFailed(
                        "DXGI duplication lost; rebuild required".into(),
                    ));
                }
                RefreshOutcome::Updated => break,
                RefreshOutcome::Unchanged if self.latest_copies > 0 => break,
                RefreshOutcome::Unchanged => {}
            }
        }
        if self.latest_copies == 0 {
            return Err(HelperError::CaptureFailed(
                "DXGI did not produce an initial desktop frame within 250 ms".into(),
            ));
        }

        // GPU copy: `frozen_texture ← latest_texture`. No CPU readback.
        // SAFETY: both textures were created from the same device and have
        // matching dimensions; CopyResource is documented to be safe in
        // this configuration.
        unsafe {
            self.context
                .CopyResource(&self.frozen_texture, &self.latest_texture);
        }

        // Allocate (or reuse) the display-oriented frozen texture for
        // non-identity rotations. Identity just reuses `frozen_texture`.
        let (canonical_w, canonical_h) =
            physical_to_canonical(self.physical_width, self.physical_height, display.rotation);
        if matches!(display.rotation, DisplayRotation::Identity) {
            self.frozen_oriented = None;
        } else {
            let oriented = create_default_texture(
                &self.device,
                canonical_w,
                canonical_h,
                (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
            )?;
            render_rotated_texture(
                &self.device,
                &self.frozen_texture,
                &oriented,
                self.physical_width,
                self.physical_height,
                display.rotation,
            )?;
            self.frozen_oriented = Some(oriented);
        }

        self.canonical_width = canonical_w;
        self.canonical_height = canonical_h;
        self.rotation = display.rotation;

        Ok(FrozenFrame::Gpu(GpuFrozenFrame {
            width: canonical_w,
            height: canonical_h,
            rotation: display.rotation,
            frozen: self.frozen_texture.clone(),
            frozen_oriented: self.frozen_oriented.clone(),
            device: self.device.clone(),
            context: self.context.clone(),
        }))
    }

    fn invalidate(&mut self) {
        self.last_frame_info = None;
        self.frozen_oriented = None;
    }

    fn diagnostics(&self) -> CaptureDiagnostics {
        CaptureDiagnostics {
            backend: "dxgi",
            full_frame_cpu_readbacks: self.full_frame_cpu_readbacks,
            selection_cpu_readbacks: self.selection_cpu_readbacks,
            latest_copies: self.latest_copies,
            duplication_rebuilds: self.duplication_rebuilds,
        }
    }

    fn record_selection_readback(&mut self) {
        self.selection_cpu_readbacks = self.selection_cpu_readbacks.saturating_add(1);
    }

    fn should_fallback_to_gdi(&self) -> bool {
        DxgiCaptureBackend::should_fallback_to_gdi(self)
    }
}

// Force the windows crate to keep some symbols linked even when we only use
// them via macros / constants.
#[allow(dead_code)]
const _DXGI_ERROR_REFERENCED: () = {
    let _ = DXGI_ERROR_ACCESS_LOST.0;
    let _ = DXGI_ERROR_DEVICE_REMOVED.0;
    let _ = DXGI_ERROR_DEVICE_RESET.0;
    let _ = DXGI_ERROR_UNSUPPORTED.0;
    let _ = DXGI_ERROR_WAIT_TIMEOUT.0;
};

fn physical_to_canonical(
    physical_w: u32,
    physical_h: u32,
    rotation: DisplayRotation,
) -> (u32, u32) {
    match rotation {
        DisplayRotation::Identity | DisplayRotation::Rotate180 => (physical_w, physical_h),
        DisplayRotation::Rotate90 | DisplayRotation::Rotate270 => (physical_h, physical_w),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::RectI;

    #[test]
    fn physical_dimensions_swaps_for_rotated_displays() {
        let mut display = DisplayInfo {
            bounds: RectI {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            dpi: 96.0,
            rotation: DisplayRotation::Identity,
            is_primary: true,
        };
        assert_eq!(physical_dimensions(&display), (1920, 1080));
        display.rotation = DisplayRotation::Rotate90;
        assert_eq!(physical_dimensions(&display), (1080, 1920));
        display.rotation = DisplayRotation::Rotate270;
        assert_eq!(physical_dimensions(&display), (1080, 1920));
    }

    #[test]
    fn cursor_visibility_does_not_panic_when_get_cursor_info_fails() {
        // We can't construct a DxgiCaptureBackend without a real D3D device
        // in unit tests, but we exercise the helper that depends only on
        // GetCursorInfo: when it fails, the visibility must be Hidden.
        let mut info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        let _ = unsafe { GetCursorInfo(&mut info) };
        // No assertion beyond "did not panic" — a real D3D device is
        // required to construct the backend in integration tests.
    }

    #[test]
    fn pointer_position_visibility_uses_the_documented_visible_field() {
        let mut frame = DXGI_OUTDUPL_FRAME_INFO::default();
        frame.PointerPosition.Position.x = 0;
        frame.PointerPosition.Position.y = 0;
        assert!(!pointer_position_was_visible(&frame));
        frame.PointerPosition.Position.x = 0x8000_0000u32 as i32;
        assert!(
            !pointer_position_was_visible(&frame),
            "pointer coordinates do not encode visibility"
        );
        frame.PointerPosition.Visible = true.into();
        assert!(pointer_position_was_visible(&frame));
    }

    #[test]
    fn rotation_transforms_map_physical_pixels_into_canonical_bounds() {
        assert_eq!(
            rotation_transform(2, 3, DisplayRotation::Identity),
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        );
        assert_eq!(
            rotation_transform(2, 3, DisplayRotation::Rotate90),
            [0.0, 1.0, -1.0, 0.0, 3.0, 0.0]
        );
        assert_eq!(
            rotation_transform(2, 3, DisplayRotation::Rotate180),
            [-1.0, 0.0, 0.0, -1.0, 2.0, 3.0]
        );
        assert_eq!(
            rotation_transform(2, 3, DisplayRotation::Rotate270),
            [0.0, -1.0, 1.0, 0.0, 0.0, 2.0]
        );
    }

    #[test]
    fn gpu_rotation_renders_source_pixels_into_the_oriented_texture() {
        let (device, context) = create_d3d11_device().expect("test D3D11 device");
        let source = create_default_texture(&device, 2, 3, D3D11_BIND_SHADER_RESOURCE.0 as u32)
            .expect("source texture");
        let target = create_default_texture(
            &device,
            3,
            2,
            (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
        )
        .expect("oriented target texture");
        let pixels = [
            1u8, 0, 0, 255, 2, 0, 0, 255, // source row 0
            3, 0, 0, 255, 4, 0, 0, 255, // source row 1
            5, 0, 0, 255, 6, 0, 0, 255, // source row 2
        ];
        unsafe {
            context.UpdateSubresource(
                &source,
                0,
                None,
                pixels.as_ptr().cast(),
                2 * 4,
                pixels.len() as u32,
            );
        }

        render_rotated_texture(&device, &source, &target, 2, 3, DisplayRotation::Rotate90)
            .expect("GPU rotation");

        let staging = create_staging_texture(&device, 3, 2).expect("staging texture");
        unsafe { context.CopyResource(&staging, &target) };
        let mut mapped = Default::default();
        unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
            .expect("map oriented texture");
        let mut blue_values = Vec::with_capacity(6);
        for y in 0..2usize {
            let row = unsafe {
                std::slice::from_raw_parts(
                    (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                    3 * 4,
                )
            };
            blue_values.extend([row[0], row[4], row[8]]);
        }
        unsafe { context.Unmap(&staging, 0) };

        assert_eq!(blue_values, [5, 3, 1, 6, 4, 2]);
    }

    #[test]
    fn cursor_policy_only_falls_back_when_dxgi_omits_a_visible_cursor() {
        let mut frame = DXGI_OUTDUPL_FRAME_INFO::default();
        assert!(!requires_gdi_for_cursor(
            CursorVisibility::Hidden,
            Some(&frame)
        ));
        assert!(requires_gdi_for_cursor(
            CursorVisibility::VisibleInside,
            Some(&frame)
        ));
        assert!(requires_gdi_for_cursor(
            CursorVisibility::VisibleOutside,
            Some(&frame)
        ));

        frame.PointerPosition.Visible = true.into();
        assert!(!requires_gdi_for_cursor(
            CursorVisibility::VisibleInside,
            Some(&frame)
        ));
        assert!(!requires_gdi_for_cursor(
            CursorVisibility::VisibleInside,
            None
        ));
    }

    #[test]
    fn duplication_output_must_match_the_primary_monitor_bounds() {
        let display = DisplayInfo {
            bounds: RectI {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            dpi: 96.0,
            rotation: DisplayRotation::Identity,
            is_primary: true,
        };
        assert!(output_bounds_match_display(
            windows::Win32::Foundation::RECT {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1080,
            },
            &display
        ));
        assert!(!output_bounds_match_display(
            windows::Win32::Foundation::RECT {
                left: 1920,
                top: 0,
                right: 3840,
                bottom: 1080,
            },
            &display
        ));
    }
}
