//! Display query and DPI awareness helpers.
//!
//! Establishes Per-Monitor V2 DPI awareness before any window is created,
//! then exposes a single [`query_primary_display`] entry point that the
//! capture backend consumes. Multi-monitor capture is intentionally out of
//! scope for Cyrene; the helper always freezes the primary monitor.

use windows::Win32::{
    Foundation::{HWND, POINT},
    Graphics::Gdi::{
        DEVMODEW, DMDO_90, DMDO_180, DMDO_270, EDS_ROTATEDMODE, ENUM_CURRENT_SETTINGS,
        EnumDisplaySettingsExW, GetDC, GetDeviceCaps, GetMonitorInfoW, HDC, LOGPIXELSX,
        MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint, ReleaseDC,
    },
    System::Threading::GetCurrentProcess,
    UI::HiDpi::{
        AreDpiAwarenessContextsEqual, DPI_AWARENESS_CONTEXT,
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiAwarenessContextForProcess,
        SetProcessDpiAwarenessContext,
    },
};

use crate::{
    error::HelperError,
    geometry::{DisplayRotation, RectI},
};

/// Physical bounds, DPI, rotation, and primary-monitor flag for the display
/// the helper should freeze. Width/height are the raw physical dimensions of
/// the rotation-aware native mode reported by Windows; callers that work in
/// the canonical orientation must consult [`DisplayRotation`] to translate
/// selection rectangles.
#[derive(Debug, Clone)]
pub struct DisplayInfo {
    pub bounds: RectI,
    pub dpi: f32,
    pub rotation: DisplayRotation,
    pub is_primary: bool,
}

/// Establish Per-Monitor V2 DPI awareness on the current process.
///
/// MUST be called before any window (helper runtime window, overlay, or
/// tool-window) is created. The setter is idempotent: a second call after the
/// process is already Per-Monitor V2 aware returns `Ok(())` without disturbing
/// the existing context. This is what allows [`set_dpi_awareness`] to be
/// invoked both from `main`/`app::run` and from individual tests.
pub fn set_dpi_awareness() -> Result<(), HelperError> {
    // SAFETY: FFI call with no preconditions; the value is a documented
    // constant published by the Windows SDK.
    let result =
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if let Err(error) = result {
        // Idempotency: if the process is already Per-Monitor V2 aware (either
        // because we set it earlier in this run, or because the host already
        // configured it for us), treat a second call as success.
        let context = current_process_awareness_context();
        // SAFETY: `AreDpiAwarenessContextsEqual` is a pure FFI comparison
        // between two DPI_AWARENESS_CONTEXT values; both arguments are valid
        // because `current_process_awareness_context()` returns the value
        // previously returned by the system for our process, and the
        // `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` is a documented SDK
        // constant. The function takes no pointers and writes to no memory.
        let already_v2 = unsafe {
            AreDpiAwarenessContextsEqual(context, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
                .as_bool()
        };
        if already_v2 {
            return Ok(());
        }
        return Err(error.into());
    }
    Ok(())
}

#[inline]
fn current_process_awareness_context() -> DPI_AWARENESS_CONTEXT {
    // SAFETY: FFI call with no preconditions; retrieves the current process's
    // DPI awareness context. GetCurrentProcess() returns a pseudo-handle that
    // does not need to be closed.
    unsafe { GetDpiAwarenessContextForProcess(GetCurrentProcess()) }
}

/// Query the primary monitor's physical bounds, DPI, rotation, and primary
/// flag.
///
/// Resolution order:
///   1. Bounds and primary flag come from [`GetMonitorInfoW`] on the primary
///      monitor — `rcMonitor` is the rotation-aware native mode rectangle that
///      matches what a same-positioned GDI bitblt would observe.
///   2. DPI is read from `GetDeviceCaps(LOGPIXELSX)` on the desktop window
///      context, which honors Per-Monitor V2 awareness.
///   3. Rotation is read from `EnumDisplaySettingsExW(ENUM_CURRENT_SETTINGS)`
///      with `EDS_ROTATEDMODE` so the OS-reported rotated display orientation
///      is used. Falls back to identity when the orientation bit is
///      unsupported.
pub fn query_primary_display() -> Result<DisplayInfo, HelperError> {
    // Anchor the primary monitor by passing (0,0) which always lies inside
    // the desktop origin and asking the system for the default (primary)
    // monitor.
    // SAFETY: POINT is a plain value struct; `MonitorFromPoint` does not
    // touch any pointer.
    let monitor = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
    if monitor.is_invalid() {
        return Err(HelperError::DisplayQueryFailed(
            "MonitorFromPoint returned an invalid handle".into(),
        ));
    }

    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is a writable MONITORINFO with a valid `cbSize` and
    // `monitor` is a real HMONITOR returned by `MonitorFromPoint`.
    let info_ok = unsafe { GetMonitorInfoW(monitor, &mut info) };
    if !info_ok.as_bool() {
        return Err(HelperError::DisplayQueryFailed(format!(
            "GetMonitorInfoW returned 0 (last error: {})",
            windows::core::Error::from_thread().message()
        )));
    }

    let rect = info.rcMonitor;
    let bounds = RectI {
        x: rect.left,
        y: rect.top,
        width: u32::try_from(rect.right - rect.left).map_err(|_| {
            HelperError::InvalidDisplay(format!(
                "monitor bounds width was negative (left={}, right={})",
                rect.left, rect.right
            ))
        })?,
        height: u32::try_from(rect.bottom - rect.top).map_err(|_| {
            HelperError::InvalidDisplay(format!(
                "monitor bounds height was negative (top={}, bottom={})",
                rect.top, rect.bottom
            ))
        })?,
    };

    let dpi = dpi_from_desktop()?;
    let rotation = current_rotation()?;
    let is_primary = (info.dwFlags & MONITORINFO_PRIMARY) != 0;

    Ok(DisplayInfo {
        bounds,
        dpi,
        rotation,
        is_primary,
    })
}

const MONITORINFO_PRIMARY: u32 = 1;

fn dpi_from_desktop() -> Result<f32, HelperError> {
    // We read system DPI via `GetDeviceCaps` on the desktop window context.
    // This honors the process DPI awareness set up by `set_dpi_awareness`.
    // A per-monitor DC could be obtained via `CreateDCW("DISPLAY", ...)`, but
    // that is heavier than what T5a needs — for the helper's single-monitor
    // scope, the desktop DC's logical DPI matches the primary monitor.
    // SAFETY: `GetDC(None)` requests a DC for the desktop window; lifetime is
    // bounded to this scope and we release it before returning.
    let hdc: HDC = unsafe { GetDC(None) };
    if hdc.is_invalid() {
        return Err(HelperError::DisplayQueryFailed(format!(
            "GetDC returned an invalid handle (last error: {})",
            windows::core::Error::from_thread().message()
        )));
    }
    // SAFETY: `GetDeviceCaps` is a pure query against an HDC. We hold the
    // desktop DC acquired above; the call neither frees nor invalidates
    // it, so the same HDC remains valid for the matching `ReleaseDC`
    // below. The capability index (`LOGPIXELSX`) is a documented constant.
    let dpi_x = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSX) };
    // SAFETY: We obtained the DC via GetDC(None) and must release it to avoid
    // leaking the desktop DC. Passing the same hwnd is correct.
    let _ = unsafe { ReleaseDC(Some(HWND(std::ptr::null_mut())), hdc) };
    if dpi_x <= 0 {
        return Err(HelperError::DisplayQueryFailed(format!(
            "GetDeviceCaps(LOGPIXELSX) returned a non-positive value: {dpi_x}"
        )));
    }
    Ok(dpi_x as f32)
}

fn current_rotation() -> Result<DisplayRotation, HelperError> {
    let mut dev_mode = DEVMODEW {
        dmSize: std::mem::size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };
    // SAFETY: `dev_mode` has a valid `dmSize`; we pass NULL device name
    // (meaning "primary display device") and request ENUM_CURRENT_SETTINGS
    // with EDS_ROTATEDMODE so the OS-reported rotated orientation is used.
    let ok = unsafe {
        EnumDisplaySettingsExW(None, ENUM_CURRENT_SETTINGS, &mut dev_mode, EDS_ROTATEDMODE)
    };
    if !ok.as_bool() {
        return Err(HelperError::DisplayQueryFailed(format!(
            "EnumDisplaySettingsExW returned 0 (last error: {})",
            windows::core::Error::from_thread().message()
        )));
    }
    // SAFETY: `Anonymous1` is a union. Reading the `Anonymous2` variant is the
    // documented access path for `dmDisplayOrientation` in DEVMODEW; the
    // member is readable for any valid DEVMODEW returned by EnumDisplay*.
    let orientation = unsafe { dev_mode.Anonymous1.Anonymous2.dmDisplayOrientation };
    Ok(orientation_from_devmode(orientation))
}

#[inline]
fn orientation_from_devmode(
    orientation: windows::Win32::Graphics::Gdi::DEVMODE_DISPLAY_ORIENTATION,
) -> DisplayRotation {
    // DMDO_DEFAULT is reported as 0 (Identity). The DMDO_* values describe how
    // the panel's native pixels are oriented w.r.t. the desktop — at 90/270
    // the rotation happens AFTER rendering, so the GDI bitblt produces
    // pixels in the rotated orientation and the capture backend must
    // pre-rotate them into the canonical frame.
    if orientation == DMDO_90 {
        DisplayRotation::Rotate90
    } else if orientation == DMDO_180 {
        DisplayRotation::Rotate180
    } else if orientation == DMDO_270 {
        DisplayRotation::Rotate270
    } else {
        DisplayRotation::Identity
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Gdi::{DMDO_90, DMDO_180, DMDO_270, DMDO_DEFAULT};

    #[test]
    fn orientation_default_is_identity() {
        assert_eq!(
            orientation_from_devmode(DMDO_DEFAULT),
            DisplayRotation::Identity
        );
    }

    #[test]
    fn orientation_known_constants_map_to_canonical_rotations() {
        assert_eq!(orientation_from_devmode(DMDO_90), DisplayRotation::Rotate90);
        assert_eq!(
            orientation_from_devmode(DMDO_180),
            DisplayRotation::Rotate180
        );
        assert_eq!(
            orientation_from_devmode(DMDO_270),
            DisplayRotation::Rotate270
        );
    }

    #[test]
    fn set_dpi_awareness_is_idempotent_in_process() {
        set_dpi_awareness().expect("first call must succeed");
        set_dpi_awareness().expect("second call must succeed");
    }
}
