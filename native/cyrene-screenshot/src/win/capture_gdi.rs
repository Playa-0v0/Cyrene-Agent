//! GDI implementation of [`CaptureBackend`].
//!
//! This is the only capture backend wired up in T5a. It captures the
//! primary monitor by:
//!
//!   1. Allocating a 32-bit top-down DIB section via [`CreateDIBSection`]
//!      whose dimensions match the monitor's physical bounds in canonical
//!      orientation.
//!   2. `BitBlt` from the desktop DC into the DIB's memory DC using
//!      `SRCCOPY | CAPTUREBLT`.
//!   3. Reading the bitmap bits out of the DIB section as a BGRA buffer.
//!   4. Rotating the buffer so its width/height match `display.bounds` in
//!      the canonical orientation regardless of the OS-reported rotation.
//!
//! GDI is pull-on-demand: there is no persistent framebuffer to refresh, so
//! [`refresh_latest`](CaptureBackend::refresh_latest) returns
//! [`RefreshOutcome::Unchanged`] in T5a.
//!
//! All GDI handles (`screen_dc`, `memory_dc`, `dib_section`) are owned by
//! RAII guards and released deterministically when the guards drop. The
//! guards are acquired in dependency order (screen → memory → dib) and
//! released in reverse order, so a panic in any intermediate step still
//! releases every earlier handle.

use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleDC, CreateDIBSection,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, HBITMAP, HDC, HGDIOBJ, ReleaseDC, SRCCOPY,
    SelectObject,
};

use crate::{
    error::HelperError,
    geometry::DisplayRotation,
    win::{
        capture::{CaptureBackend, CaptureDiagnostics, CpuBgraFrame, FrozenFrame, RefreshOutcome},
        display::DisplayInfo,
    },
};

/// GDI-backed capture of the primary monitor.
///
/// Holds no long-lived state in T5a — every freeze allocates a fresh DC and
/// DIB section. The constructor validates the process can obtain the
/// desktop DC, surfacing a structured error early when GDI is unavailable.
///
/// Construction is fallible (`Result`) because GDI may legitimately be
/// unavailable (non-interactive session, headless service, etc.). Callers
/// must handle the error path explicitly; there is intentionally no
/// `Default` impl because panicking in production is the wrong behavior.
#[derive(Debug)]
pub struct GdiCaptureBackend {
    full_frame_cpu_readbacks: u64,
    selection_cpu_readbacks: u64,
    latest_copies: u64,
}

impl GdiCaptureBackend {
    /// Create a fresh backend. The GDI backend currently holds no long-lived
    /// state, so this is a cheap constructor that only validates the
    /// process can obtain the desktop DC (e.g., it is running in an
    /// interactive session) by allocating a throwaway DC.
    pub fn new() -> Result<Self, HelperError> {
        // We probe the desktop DC and immediately release it. The point is
        // to surface a deterministic HelperError::CaptureFailed when GDI is
        // unavailable (e.g., the process is running in a session that does
        // not have an interactive desktop) rather than failing on first
        // freeze().
        let probe = ScreenDcGuard::acquire()?;
        drop(probe);
        Ok(Self {
            full_frame_cpu_readbacks: 0,
            selection_cpu_readbacks: 0,
            latest_copies: 0,
        })
    }
}

impl CaptureBackend for GdiCaptureBackend {
    fn name(&self) -> &'static str {
        "gdi"
    }

    fn refresh_latest(&mut self, _timeout_ms: u32) -> Result<RefreshOutcome, HelperError> {
        // GDI is pull-on-demand: there is no producer-consumer pipeline to
        // pump, so a refresh is always observed as "no change".
        Ok(RefreshOutcome::Unchanged)
    }

    fn freeze(&mut self, display: &DisplayInfo) -> Result<FrozenFrame, HelperError> {
        let captured = capture_primary_bgra(display)?;
        let (width, height, pitch, pixels) = rotate_to_canonical(captured, display.rotation)?;
        // One full-frame CPU readback per freeze.
        self.full_frame_cpu_readbacks = self.full_frame_cpu_readbacks.saturating_add(1);
        self.latest_copies = self.latest_copies.saturating_add(1);
        Ok(FrozenFrame::Cpu(CpuBgraFrame {
            width,
            height,
            pitch,
            pixels,
        }))
    }

    fn invalidate(&mut self) {
        // No persistent state to drop; nothing to do.
    }

    fn diagnostics(&self) -> CaptureDiagnostics {
        CaptureDiagnostics {
            backend: "gdi",
            full_frame_cpu_readbacks: self.full_frame_cpu_readbacks,
            selection_cpu_readbacks: self.selection_cpu_readbacks,
            latest_copies: self.latest_copies,
            duplication_rebuilds: 0,
        }
    }

    fn record_selection_readback(&mut self) {
        self.selection_cpu_readbacks = self.selection_cpu_readbacks.saturating_add(1);
    }
}

// ---- GDI handle RAII guards ------------------------------------------------
//
// HDC has no `windows_core::Free` impl, so we roll three small guards that
// own one handle each and free it in `Drop`. Guards are not `Send`: GDI
// handles are tied to the thread that acquired them, and the helper's UI
// thread is the only consumer in T5a.

/// Owns an HDC acquired via `GetDC(None)` and releases it via `ReleaseDC`.
struct ScreenDcGuard(HDC);

impl ScreenDcGuard {
    fn acquire() -> Result<Self, HelperError> {
        // SAFETY: `GetDC(None)` is documented to return a DC for the entire
        // screen. It takes no preconditions beyond the process holding a
        // station / desktop, which is already guaranteed by the caller's
        // success in `query_primary_display`. The returned HDC must be
        // released with `ReleaseDC(None, hdc)`; we do that in `Drop`.
        let hdc = unsafe { GetDC(None) };
        if hdc.is_invalid() {
            return Err(HelperError::CaptureFailed(format!(
                "GetDC returned an invalid handle (last error: {})",
                windows::core::Error::from_thread().message()
            )));
        }
        Ok(Self(hdc))
    }
}

impl Drop for ScreenDcGuard {
    fn drop(&mut self) {
        // SAFETY: `self.0` was acquired via `GetDC(None)` in `acquire`; the
        // matching `ReleaseDC(None, hdc)` is the only valid way to dispose
        // of it. We ignore the BOOL return because a ReleaseDC failure
        // indicates the handle is already in a bad state — there is no
        // recovery action to take.
        let _ = unsafe { ReleaseDC(None, self.0) };
    }
}

/// Owns an HDC acquired via `CreateCompatibleDC` and deletes it via `DeleteDC`.
struct MemoryDcGuard(HDC);

impl MemoryDcGuard {
    fn create(parent: HDC) -> Result<Self, HelperError> {
        // SAFETY: `CreateCompatibleDC` returns an HDC compatible with the
        // provided source DC. We pass the desktop DC so the new memory DC
        // matches the screen's pixel format. The handle must be freed with
        // `DeleteDC`; we do that in `Drop`.
        let hdc = unsafe { CreateCompatibleDC(Some(parent)) };
        if hdc.is_invalid() {
            return Err(HelperError::CaptureFailed(format!(
                "CreateCompatibleDC returned an invalid handle (last error: {})",
                windows::core::Error::from_thread().message()
            )));
        }
        Ok(Self(hdc))
    }

    fn handle(&self) -> HDC {
        self.0
    }
}

impl Drop for MemoryDcGuard {
    fn drop(&mut self) {
        // SAFETY: `self.0` was acquired via `CreateCompatibleDC` and must
        // be disposed with `DeleteDC`. Calling `DeleteDC` on an HDC
        // returned by `CreateCompatibleDC` is the documented contract.
        let _ = unsafe { DeleteDC(self.0) };
    }
}

/// Owns an HBITMAP acquired via `CreateDIBSection` and deletes it via
/// `DeleteObject`. A `SelectionGuard` declared after this guard restores the
/// memory DC before this guard can drop, preserving Win32's rule that selected
/// bitmaps must not be deleted.
struct DibGuard {
    bitmap: HBITMAP,
    bits: *mut core::ffi::c_void,
}

impl DibGuard {
    fn create_top_down(
        memory_dc: HDC,
        width_i32: i32,
        height_i32: i32,
    ) -> Result<Self, HelperError> {
        // BITMAPINFO contains a single RGBQUAD slot for the color table;
        // for 32-bit BI_RGB images the color table is unused, so we only
        // need the header.
        let bitmap_info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width_i32,
                // Negative biHeight => top-down DIB (origin at top-left).
                biHeight: -height_i32,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [windows::Win32::Graphics::Gdi::RGBQUAD::default(); 1],
        };

        let mut bits: *mut core::ffi::c_void = core::ptr::null_mut();
        // SAFETY: `bitmap_info` is a valid BITMAPINFO describing a 32-bit
        // top-down BGRA DIB. `CreateDIBSection` writes the pointer to the
        // pixel storage into `bits` and returns the HBITMAP whose lifetime
        // owns that storage. We hold the HBITMAP for the full duration the
        // bits are read; both are released together in `Drop`.
        let result = unsafe {
            CreateDIBSection(
                Some(memory_dc),
                &bitmap_info,
                DIB_RGB_COLORS,
                &mut bits,
                None,
                0,
            )
        };
        let dib_section = result.map_err(|error| {
            HelperError::CaptureFailed(format!(
                "CreateDIBSection failed: {error} (last error: {})",
                windows::core::Error::from_thread().message()
            ))
        })?;

        // I2: even on success `CreateDIBSection` can hand back a non-null
        // HBITMAP whose bits pointer is null (e.g., when memory
        // allocation for the pixel buffer failed but the DIB header was
        // allocated). Treating that as success would yield a zero-filled
        // frame; instead surface a CaptureFailed so the caller sees the
        // error.
        if bits.is_null() {
            // SAFETY: `dib_section` was returned by `CreateDIBSection` and
            // is a real, non-invalid HBITMAP. We delete it explicitly
            // because we cannot hand it to `DibGuard` (whose `Drop` would
            // also delete it), avoiding a double-free.
            let _ = unsafe { DeleteObject(HGDIOBJ(dib_section.0)) };
            return Err(HelperError::CaptureFailed(
                "CreateDIBSection returned a null bits pointer".into(),
            ));
        }

        Ok(Self {
            bitmap: dib_section,
            bits,
        })
    }

    fn bits(&self) -> *mut core::ffi::c_void {
        self.bits
    }
}

impl Drop for DibGuard {
    fn drop(&mut self) {
        // SAFETY: `self.bitmap` was acquired via `CreateDIBSection`. When it
        // was selected, the later-declared `SelectionGuard` restored the
        // previous object before this guard could drop.
        let _ = unsafe { DeleteObject(HGDIOBJ(self.bitmap.0)) };
    }
}

/// Restores the GDI object that was selected before the capture DIB.
///
/// This guard must be declared after `DibGuard`: reverse drop order then
/// guarantees restoration completes before `DeleteObject` runs, including
/// during unwinding from `BitBlt`, allocation, or pixel-copy failures.
struct SelectionGuard {
    hdc: HDC,
    previous: HGDIOBJ,
    released: bool,
}

impl SelectionGuard {
    fn new(hdc: HDC, previous: HGDIOBJ) -> Self {
        Self {
            hdc,
            previous,
            released: false,
        }
    }

    fn release(mut self) -> Result<(), HelperError> {
        // SAFETY: `hdc` remains owned by the surrounding `MemoryDcGuard`, and
        // `previous` is exactly the object returned when the DIB was selected.
        // Propagating restoration failure prevents reporting capture success;
        // Drop retries best-effort before the later-declared DIB guard deletes
        // the bitmap.
        let restored = unsafe { SelectObject(self.hdc, self.previous) };
        if restored.0.is_null() || restored.0 as isize == -1 {
            return Err(HelperError::CaptureFailed(format!(
                "failed to restore previous GDI object (last error: {})",
                windows::core::Error::from_thread().message()
            )));
        }
        self.released = true;
        Ok(())
    }
}

impl Drop for SelectionGuard {
    fn drop(&mut self) {
        if !self.released {
            // SAFETY: the same lifetime invariants as `release` hold. This is
            // best-effort because Drop cannot report an error; even an invalid
            // synthetic handle is accepted by Win32 without a Rust crash. The
            // attempt finishes before `DibGuard::drop` due to declaration order.
            let _ = unsafe { SelectObject(self.hdc, self.previous) };
        }
    }
}

/// Validate that the BGRA pixel buffer for `(width, height)` fits in
/// `isize::MAX` so the subsequent `Vec<u8>` allocation cannot panic on a
/// 64-bit target. Returns the total byte count on success.
fn validate_capture_dimensions(width: u32, height: u32) -> Result<usize, HelperError> {
    let width_usize = usize::try_from(width).map_err(|_| {
        HelperError::InvalidDisplay(format!(
            "capture width {width} does not fit in usize on this platform"
        ))
    })?;
    let height_usize = usize::try_from(height).map_err(|_| {
        HelperError::InvalidDisplay(format!(
            "capture height {height} does not fit in usize on this platform"
        ))
    })?;
    let row_bytes = width_usize.checked_mul(4).ok_or_else(|| {
        HelperError::InvalidDisplay(format!(
            "capture row bytes overflow for width {width} (width*4 > usize::MAX)"
        ))
    })?;
    let total_bytes = row_bytes.checked_mul(height_usize).ok_or_else(|| {
        HelperError::InvalidDisplay(format!(
            "capture pixel buffer overflow for {width}x{height} (4*w*h > usize::MAX)"
        ))
    })?;
    if total_bytes > isize::MAX as usize {
        return Err(HelperError::InvalidDisplay(format!(
            "capture pixel buffer {total_bytes} exceeds isize::MAX for {width}x{height}"
        )));
    }
    Ok(total_bytes)
}

/// Raw BGRA capture in the *physical* (possibly rotated) source orientation
/// reported by GDI. The rotation step in `freeze` adapts this to canonical
/// orientation before returning.
struct RawBgraCapture {
    width: u32,
    height: u32,
    #[allow(dead_code)]
    pitch: u32,
    pixels: Vec<u8>,
}

fn capture_primary_bgra(display: &DisplayInfo) -> Result<RawBgraCapture, HelperError> {
    let source_width = display.bounds.width;
    let source_height = display.bounds.height;
    if source_width == 0 || source_height == 0 {
        return Err(HelperError::InvalidDisplay(
            "primary display has zero width or height".into(),
        ));
    }
    // i32 conversions fail only for resolutions above 2^31 - 1 pixels which
    // would physically never fit on a single monitor.
    let width_i32 = i32::try_from(source_width).map_err(|_| {
        HelperError::InvalidDisplay(format!("width {source_width} does not fit in i32"))
    })?;
    let height_i32 = i32::try_from(source_height).map_err(|_| {
        HelperError::InvalidDisplay(format!("height {source_height} does not fit in i32"))
    })?;

    // Validate the byte arithmetic BEFORE touching any GDI handles so an
    // over-sized (hostile or corrupt) DisplayInfo never opens a screen DC
    // that we would then leak when the pixel allocation panics.
    let total_bytes = validate_capture_dimensions(source_width, source_height)?;

    // Acquire guards in dependency order. Drop order is reverse, so on any
    // `?` error the screen DC, memory DC, and DIB section are all released
    // automatically.
    let screen_dc = ScreenDcGuard::acquire()?;
    let memory_dc = MemoryDcGuard::create(screen_dc.0)?;
    let dib_section = DibGuard::create_top_down(memory_dc.handle(), width_i32, height_i32)?;

    // I1: SelectObject returns `HGDI_ERROR` (== `HGDIOBJ(-1)`) on failure.
    // Treat that as CaptureFailed and let the guards clean up.
    // SAFETY: `memory_dc` is a valid HDC, `dib_section.bitmap` is a valid
    // HBITMAP. SelectObject is documented to accept any HGDIOBJ; we
    // capture the previous object so we can restore it before deleting
    // the DIB (the Win32 rule: do not delete a selected bitmap).
    let previous = unsafe { SelectObject(memory_dc.handle(), HGDIOBJ(dib_section.bitmap.0)) };
    if previous.0.is_null() || previous.0 as isize == -1 {
        return Err(HelperError::CaptureFailed(format!(
            "SelectObject failed (last error: {})",
            windows::core::Error::from_thread().message()
        )));
    }
    // Declaration order is load-bearing: `_selection` drops before
    // `dib_section`, restoring the previous object before DeleteObject even
    // if any operation below returns early or panics.
    let selection = SelectionGuard::new(memory_dc.handle(), previous);

    // BitBlt with CAPTUREBLT to also include layered windows' content. The
    // system cursor is not drawn into the captured desktop.
    // SAFETY: `memory_dc` is a valid HDC with the DIB section selected;
    // `screen_dc` is a valid HDC for the desktop. The width/height bounds
    // match the DIB section dimensions (validated above), so BitBlt will
    // not read or write past the allocated buffers.
    let blt_ok = unsafe {
        BitBlt(
            memory_dc.handle(),
            0,
            0,
            width_i32,
            height_i32,
            Some(screen_dc.0),
            0,
            0,
            SRCCOPY | CAPTUREBLT,
        )
    };
    if let Err(error) = blt_ok {
        return Err(HelperError::CaptureFailed(format!(
            "BitBlt failed: {error} (last error: {})",
            windows::core::Error::from_thread().message()
        )));
    }

    // Copy the bits out of the DIB section. CreateDIBSection guarantees
    // that rows are tightly packed to width * 4 bytes because we used a
    // negative biHeight (top-down), so the pitch equals width * 4.
    let mut pixels = vec![0u8; total_bytes];
    // `create_top_down` rejects a null bits pointer, so no redundant null
    // branch is needed here.
    let bits = dib_section.bits();
    // SAFETY: `bits` points to a freshly-allocated DIB section whose
    // ownership remains with `dib_section`; we read exactly the documented
    // number of bytes (width * 4 * height == total_bytes, which fits in
    // isize::MAX per `validate_capture_dimensions`).
    unsafe {
        core::ptr::copy_nonoverlapping(bits as *const u8, pixels.as_mut_ptr(), total_bytes);
    }

    // Restore explicitly so restoration failure becomes a structured capture
    // error. On error, SelectionGuard::drop retries best-effort before the DIB
    // guard drops.
    selection.release()?;

    Ok(RawBgraCapture {
        width: source_width,
        height: source_height,
        pitch: source_width * 4,
        pixels,
    })
}

fn rotate_to_canonical(
    raw: RawBgraCapture,
    rotation: DisplayRotation,
) -> Result<(u32, u32, u32, Vec<u8>), HelperError> {
    let source_width = raw.width;
    let source_height = raw.height;
    let target_width: u32;
    let target_height: u32;

    match rotation {
        DisplayRotation::Identity => {
            target_width = source_width;
            target_height = source_height;
        }
        DisplayRotation::Rotate90 | DisplayRotation::Rotate270 => {
            // Canonical orientation: the visible bounds always read with
            // width along the long axis. The display rect reported by
            // GetMonitorInfoW is already in the canonical frame, but the
            // GDI buffer is in the physical frame, so width/height may
            // swap during rotation. We keep the bit-for-bit orientation
            // here by swapping dimensions when a 90/270 rotation is
            // requested.
            target_width = source_height;
            target_height = source_width;
        }
        DisplayRotation::Rotate180 => {
            target_width = source_width;
            target_height = source_height;
        }
    }

    let new_pitch = target_width.checked_mul(4).ok_or_else(|| {
        HelperError::CaptureFailed(format!("pitch overflow for rotated width {target_width}"))
    })?;

    // Validate the source pixel buffer length matches the expected
    // pre-rotation size. This catches hostile or corrupt RawBgraCapture
    // inputs that would otherwise cause out-of-bounds reads inside the
    // rotation helpers.
    let expected_source_bytes = (source_width as usize)
        .checked_mul(4)
        .and_then(|row| row.checked_mul(source_height as usize))
        .ok_or_else(|| {
            HelperError::CaptureFailed(format!(
                "raw capture pixel buffer size overflows usize for {source_width}x{source_height}"
            ))
        })?;
    if raw.pixels.len() != expected_source_bytes {
        return Err(HelperError::CaptureFailed(format!(
            "raw capture pixel buffer length {} does not match expected {} for {source_width}x{source_height}",
            raw.pixels.len(),
            expected_source_bytes
        )));
    }

    // Validate the destination pixel buffer size fits in isize::MAX
    // before allocating it.
    let _ = validate_capture_dimensions(target_width, target_height)?;

    let pixels = match rotation {
        DisplayRotation::Identity => raw.pixels,
        DisplayRotation::Rotate180 => rotate_180(&raw.pixels, source_width, source_height),
        DisplayRotation::Rotate90 => rotate_clockwise(
            &raw.pixels,
            source_width,
            source_height,
            target_width,
            target_height,
        ),
        DisplayRotation::Rotate270 => rotate_counter_clockwise(
            &raw.pixels,
            source_width,
            source_height,
            target_width,
            target_height,
        ),
    };

    Ok((target_width, target_height, new_pitch, pixels))
}

fn rotate_180(pixels: &[u8], width: u32, height: u32) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let row_bytes = w * 4;
    let mut out = vec![0u8; row_bytes * h];
    // Iterate rows from bottom to top, reversing each row's bytes to
    // match a 180-degree rotation (rightmost pixel becomes leftmost in
    // the bottom row, etc.).
    for y in 0..h {
        let src_offset = (h - 1 - y) * row_bytes;
        let dst_offset = y * row_bytes;
        let src_row = &pixels[src_offset..src_offset + row_bytes];
        let dst_row = &mut out[dst_offset..dst_offset + row_bytes];
        // Reverse 4-byte BGRA pixels within the row.
        for x in 0..w {
            let src_pixel = src_row[x * 4..(x + 1) * 4].to_vec();
            dst_row[(w - 1 - x) * 4..(w - x) * 4].copy_from_slice(&src_pixel);
        }
    }
    out
}

fn rotate_clockwise(
    pixels: &[u8],
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
) -> Vec<u8> {
    // 90° clockwise: `(x_d, y_d) = (H-1-y_s, x_s)` — i.e. the destination's
    // x-axis is the source's row (flipped) and its y-axis is the source's
    // column. Inverting gives `result[y_d, x_d] = source[x_s=H-1-x_d... wait,
    // y_s=H-1-x_d, x_s=y_d]`. For a 90° rotation we must have
    // `target_width == source_height` and `target_height == source_width`.
    //
    // Working indices (all computed as `usize` first to avoid overflow):
    //   src_col = y_dst (which has range [0, src_w))
    //   src_row = src_h - 1 - x_dst (which has range [0, src_h))
    let src_w = source_width as usize;
    let src_h = source_height as usize;
    let dst_w = target_width as usize;
    let dst_h = target_height as usize;
    debug_assert_eq!(
        src_h, dst_w,
        "CW rotation requires target_width == source_height"
    );
    debug_assert_eq!(
        src_w, dst_h,
        "CW rotation requires target_height == source_width"
    );
    let mut out = vec![0u8; dst_w * 4 * dst_h];
    let src_row_bytes = src_w * 4;
    let dst_row_bytes = dst_w * 4;
    for dst_y in 0..dst_h {
        for dst_x in 0..dst_w {
            let src_row = src_h - 1 - dst_x;
            let src_col = dst_y;
            let src_offset = src_row * src_row_bytes + src_col * 4;
            let dst_offset = dst_y * dst_row_bytes + dst_x * 4;
            out[dst_offset..dst_offset + 4].copy_from_slice(&pixels[src_offset..src_offset + 4]);
        }
    }
    out
}

fn rotate_counter_clockwise(
    pixels: &[u8],
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
) -> Vec<u8> {
    // 270° clockwise (= 90° counter-clockwise): inverse of CW. The mapping
    // is `(x_d, y_d) = (y_s, W-1-x_s)`, so `result[y_d, x_d] =
    // source[x_s=x_d... y_s=W-1-y_d]`. Same axis-swap invariants as CW:
    // `target_width == source_height`, `target_height == source_width`.
    let src_w = source_width as usize;
    let src_h = source_height as usize;
    let dst_w = target_width as usize;
    let dst_h = target_height as usize;
    debug_assert_eq!(
        src_w, dst_h,
        "CCW rotation requires target_height == source_width"
    );
    debug_assert_eq!(
        src_h, dst_w,
        "CCW rotation requires target_width == source_height"
    );
    let mut out = vec![0u8; dst_w * 4 * dst_h];
    let src_row_bytes = src_w * 4;
    let dst_row_bytes = dst_w * 4;
    for dst_y in 0..dst_h {
        for dst_x in 0..dst_w {
            let src_row = dst_x;
            let src_col = src_w - 1 - dst_y;
            let src_offset = src_row * src_row_bytes + src_col * 4;
            let dst_offset = dst_y * dst_row_bytes + dst_x * 4;
            out[dst_offset..dst_offset + 4].copy_from_slice(&pixels[src_offset..src_offset + 4]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_bgra(width: u32, height: u32, byte: u8) -> Vec<u8> {
        vec![byte; (width as usize) * 4 * (height as usize)]
    }

    #[test]
    fn selection_guard_drop_is_best_effort_for_invalid_previous_object() {
        let guard =
            SelectionGuard::new(HDC::default(), HGDIOBJ((-1isize) as *mut core::ffi::c_void));
        drop(guard);
    }

    #[test]
    fn rotate_180_reverses_rows_and_columns() {
        // Build a 2x2 BGRA image. Layout (top-down, row-major):
        //   row 0:  [A=(0,0)]  [B=(1,0)]
        //   row 1:  [C=(0,1)]  [D=(1,1)]
        let mut pixels = vec![0u8; 2 * 4 * 2];
        pixels[0..4].copy_from_slice(&[1, 2, 3, 4]); // A at (0,0)
        pixels[4..8].copy_from_slice(&[5, 6, 7, 8]); // B at (1,0)
        pixels[8..12].copy_from_slice(&[9, 10, 11, 12]); // C at (0,1)
        pixels[12..16].copy_from_slice(&[13, 14, 15, 16]); // D at (1,1)

        let rotated = rotate_180(&pixels, 2, 2);
        // After 180°: D goes to top-left, C to top-right, B to bottom-left, A to bottom-right.
        assert_eq!(&rotated[0..4], &[13, 14, 15, 16]);
        assert_eq!(&rotated[4..8], &[9, 10, 11, 12]);
        assert_eq!(&rotated[8..12], &[5, 6, 7, 8]);
        assert_eq!(&rotated[12..16], &[1, 2, 3, 4]);
    }

    #[test]
    fn rotate_clockwise_swaps_dimensions_and_rotates_pixel() {
        // Source layout (W=2, H=2):
        //   [TL]=(col=0,row=0)  [TR]=(col=1,row=0)
        //   [BL]=(col=0,row=1)  [BR]=(col=1,row=1)
        // 90° CW swaps x/y and flips: the destination's first row is the
        // source's first column read bottom-to-top.
        let mut pixels = vec![0u8; 2 * 4 * 2];
        pixels[0..4].copy_from_slice(&[1, 2, 3, 4]); // TL = (col=0,row=0)
        pixels[4..8].copy_from_slice(&[5, 6, 7, 8]); // TR = (col=1,row=0)
        pixels[8..12].copy_from_slice(&[9, 10, 11, 12]); // BL = (col=0,row=1)
        pixels[12..16].copy_from_slice(&[13, 14, 15, 16]); // BR = (col=1,row=1)

        let rotated = rotate_clockwise(&pixels, 2, 2, 2, 2);
        // After 90° CW the visual layout is:
        //   [BL] [TL]   → pixels[0..4]=BL, [4..8]=TL
        //   [BR] [TR]   → pixels[8..12]=BR, [12..16]=TR
        assert_eq!(&rotated[0..4], &[9, 10, 11, 12]); // BL moves to result (0,0)
        assert_eq!(&rotated[4..8], &[1, 2, 3, 4]); // TL moves to result (0,1)
        assert_eq!(&rotated[8..12], &[13, 14, 15, 16]); // BR moves to result (1,0)
        assert_eq!(&rotated[12..16], &[5, 6, 7, 8]); // TR moves to result (1,1)
    }

    #[test]
    fn rotate_counter_clockwise_swaps_dimensions_and_rotates_pixel() {
        // Source layout (W=2, H=2):
        //   [TL]=(0,0)  [TR]=(1,0)
        //   [BL]=(0,1)  [BR]=(1,1)
        // 270° CW (= 90° CCW):
        //   [TR] [BR]   → pixels[0..4]=TR, [4..8]=BR
        //   [TL] [BL]   → pixels[8..12]=TL, [12..16]=BL
        let mut pixels = vec![0u8; 2 * 4 * 2];
        pixels[0..4].copy_from_slice(&[1, 2, 3, 4]); // TL = (col=0,row=0)
        pixels[4..8].copy_from_slice(&[5, 6, 7, 8]); // TR = (col=1,row=0)
        pixels[8..12].copy_from_slice(&[9, 10, 11, 12]); // BL = (col=0,row=1)
        pixels[12..16].copy_from_slice(&[13, 14, 15, 16]); // BR = (col=1,row=1)

        let rotated = rotate_counter_clockwise(&pixels, 2, 2, 2, 2);
        assert_eq!(&rotated[0..4], &[5, 6, 7, 8]); // TR moves to result (0,0)
        assert_eq!(&rotated[4..8], &[13, 14, 15, 16]); // BR moves to result (0,1)
        assert_eq!(&rotated[8..12], &[1, 2, 3, 4]); // TL moves to result (1,0)
        assert_eq!(&rotated[12..16], &[9, 10, 11, 12]); // BL moves to result (1,1)
    }

    #[test]
    fn rotate_clockwise_into_wider_target_uses_swap_dimensions() {
        // 2x4 source (W=2, H=4) rotates into 4x2 target (W'=4, H'=2). Place
        // four distinct pixels on the source diagonal and verify their
        // positions in the target.
        //
        // For 90° CW: src_col = dst_y (valid range [0, src_w)); src_row =
        // src_h - 1 - dst_x. For dst (4x2), dst_x ∈ [0, 2), dst_y ∈ [0, 4).
        //   result(0,0) = source(y_d=0=col, x_d=0=reverse row 3)
        //     → reads source(row=3, col=0)
        //   result(0,1) = source(row=2, col=0)
        //   result(1,0) = source(row=3, col=1)
        //   result(1,1) = source(row=2, col=1)
        let mut pixels = vec![0u8; 2 * 4 * 4];
        let place = |buf: &mut [u8], col: usize, row: usize, value: [u8; 4]| {
            buf[row * 2 * 4 + col * 4..row * 2 * 4 + (col + 1) * 4].copy_from_slice(&value);
        };
        place(&mut pixels, 0, 0, [10, 0, 0, 255]);
        place(&mut pixels, 1, 0, [20, 0, 0, 255]);
        place(&mut pixels, 0, 1, [11, 0, 0, 255]);
        place(&mut pixels, 1, 1, [21, 0, 0, 255]);
        place(&mut pixels, 0, 2, [12, 0, 0, 255]);
        place(&mut pixels, 1, 2, [22, 0, 0, 255]);
        place(&mut pixels, 0, 3, [13, 0, 0, 255]);
        place(&mut pixels, 1, 3, [23, 0, 0, 255]);

        let rotated = rotate_clockwise(&pixels, 2, 4, 4, 2);
        assert_eq!(rotated.len(), 4 * 4 * 2);
        // dst row 0: reads src rows in reverse order at col 0 (the source's
        // single column is dst's row axis). For dst_x in [0, 4):
        //   src_row = src_h - 1 - dst_x ∈ {3, 2, 1, 0} at col 0.
        // Src col 0 contains the "1x" pixels (10, 11, 12, 13 by row).
        assert_eq!(&rotated[0..4], &[13, 0, 0, 255]);
        assert_eq!(&rotated[4..8], &[12, 0, 0, 255]);
        assert_eq!(&rotated[8..12], &[11, 0, 0, 255]);
        assert_eq!(&rotated[12..16], &[10, 0, 0, 255]);
        // dst row 1: same indexing but src_col = dst_y = 1 → reads src col 1.
        assert_eq!(&rotated[16..20], &[23, 0, 0, 255]);
        assert_eq!(&rotated[20..24], &[22, 0, 0, 255]);
        assert_eq!(&rotated[24..28], &[21, 0, 0, 255]);
        assert_eq!(&rotated[28..32], &[20, 0, 0, 255]);
    }

    #[test]
    fn solid_bgra_helper_is_well_formed() {
        let pixels = solid_bgra(3, 2, 0xAB);
        assert_eq!(pixels.len(), 3 * 4 * 2);
        assert!(pixels.iter().all(|byte| *byte == 0xAB));
    }

    #[test]
    fn validate_capture_dimensions_rejects_overflow() {
        // i32::MAX * i32::MAX pixels at 4 bytes each is ~1.84e19 bytes —
        // larger than isize::MAX on any supported platform, so a `vec![0u8;
        // total]` allocation would panic. The validator must surface this as
        // an InvalidDisplay error instead of leaking the panic through the
        // caller (the panic path would in turn leak the desktop DC).
        let err = validate_capture_dimensions(i32::MAX as u32, i32::MAX as u32)
            .expect_err("i32::MAX x i32::MAX must overflow the pixel buffer");
        assert!(
            matches!(err, HelperError::InvalidDisplay(_)),
            "overflow must surface as InvalidDisplay, got {err:?}"
        );
    }

    #[test]
    fn validate_capture_dimensions_accepts_a_normal_1080p_monitor() {
        // 1920x1080 fits comfortably in usize (1920 * 4 * 1080 = ~8MB) and
        // must not be rejected.
        validate_capture_dimensions(1920, 1080).expect("1920x1080 must pass dimension validation");
    }

    #[test]
    fn rotate_to_canonical_rejects_mismatched_pixel_length() {
        // A RawBgraCapture claiming 4x4 but holding only 3 bytes must be
        // rejected up-front (otherwise the rotation helpers would panic on
        // out-of-bounds indexing). rotate_to_canonical is the test seam.
        let bogus = RawBgraCapture {
            width: 4,
            height: 4,
            pitch: 16,
            pixels: vec![1, 2, 3],
        };
        let err = rotate_to_canonical(bogus, DisplayRotation::Identity)
            .expect_err("mismatched pixel length must be rejected");
        assert!(
            matches!(err, HelperError::CaptureFailed(_)),
            "mismatched length must surface as CaptureFailed, got {err:?}"
        );
    }
}
