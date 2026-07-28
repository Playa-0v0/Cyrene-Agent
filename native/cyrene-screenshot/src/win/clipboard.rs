//! `CF_DIBV5` clipboard writer for the selected capture rectangle.
//!
//! The helper publishes the user's frozen-frame selection to the Windows
//! clipboard as a `CF_DIBV5` (Device Independent Bitmap, version 5). Paint,
//! browsers, chat clients and most rich-text editors accept this format
//! directly, so a `clipboard-only` commit lands in the OS clipboard without
//! touching the encoder or the PNG output directory.
//!
//! Wire format (per MSDN):
//!   * A `BITMAPV5HEADER` describing a bottom-up 32 bpp BGRA bitmap with
//!     `BI_BITFIELDS` channel masks (`0x00FF0000` red, `0x0000FF00` green,
//!     `0x000000FF` blue) and the sRGB color space. The header is followed
//!     immediately by tightly packed rows (pitch = width * 4).
//!   * Rows are stored bottom-up so that a paint program reading from the
//!     bottom of the buffer gets the topmost row first. We negate the
//!     selection height in the header for that reason.
//!
//! Failure recovery:
//!   * If `OpenClipboard` fails (another process owns the clipboard) we
//!     return an error and the caller logs `clipboardWritten: false`.
//!   * `GlobalAlloc` failure unwinds via `HGLOBALGuard` so the handle is
//!     freed deterministically (the system owns an allocated handle only
//!     after `SetClipboardData` succeeds).
//!   * Any write/encoding error between `EmptyClipboard` and a successful
//!     `SetClipboardData` releases the HGLOBAL with `GlobalFree` (via
//!     `HGLOBALGuard`'s drop) and returns an error.

use windows::{
    Win32::{
        Foundation::{HGLOBAL, HWND},
        Graphics::Gdi::{BI_BITFIELDS, BITMAPV5HEADER, CIEXYZTRIPLE},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock},
            Ole::CF_DIBV5,
        },
    },
    core::Free,
};

use crate::{error::HelperError, win::capture::CpuBgraFrame};

/// `bV5CSType` value for the sRGB color space (little-endian "sRGB").
#[allow(non_upper_case_globals)]
const LCS_sRGB: u32 = 0x7352_4742;

/// RAII guard for an `HGLOBAL` returned by `GlobalAlloc`. On drop, frees the
/// handle unless ownership was transferred to the clipboard via
/// `SetClipboardData` (in which case the caller calls `disarm` first).
///
/// We use `windows_core::Free` for the cleanup path so we get the same
/// behavior as the windows crate's other Free impls.
struct HGLOBALGuard {
    handle: HGLOBAL,
    armed: bool,
}

impl HGLOBALGuard {
    fn new(handle: HGLOBAL) -> Self {
        Self {
            handle,
            armed: true,
        }
    }

    fn disarm(mut self) -> HGLOBAL {
        self.armed = false;
        self.handle
    }
}

impl Drop for HGLOBALGuard {
    fn drop(&mut self) {
        if self.armed {
            // SAFETY: handle was acquired via GlobalAlloc and never passed to
            // SetClipboardData (otherwise disarm would have been called).
            // The windows crate's `Free` impl calls GlobalFree; we use it to
            // get the same well-tested cleanup path used elsewhere in the
            // helper's GDI guards.
            unsafe {
                self.handle.free();
            }
        }
    }
}

/// RAII guard for the OpenClipboard handle. On drop, calls CloseClipboard
/// so a panic in any intermediate step still leaves the clipboard in a
/// consistent state for other processes.
struct OpenClipboardGuard;

impl Drop for OpenClipboardGuard {
    fn drop(&mut self) {
        // SAFETY: OpenClipboard was called on this thread; CloseClipboard is
        // the documented pair. A failing CloseClipboard indicates another
        // thread already closed the clipboard, which we can safely ignore.
        let _ = unsafe { CloseClipboard() };
    }
}

/// Write the supplied CPU BGRA frame to the Windows clipboard as
/// `CF_DIBV5`.
///
/// `hwnd` is the optional owner of the clipboard while the helper holds it.
/// Passing the overlay window keeps the clipboard associated with the
/// helper process even when the user clicks away before pasting.
///
/// On success, the returned `Ok(())` indicates the helper owns the
/// HGLOBAL passed to the system; the clipboard owns the buffer until the
/// user copies something else. On failure, no clipboard data is left
/// published (any intermediate state has been rolled back).
pub fn write_cf_dibv5(hwnd: HWND, frame: &CpuBgraFrame) -> Result<(), HelperError> {
    if frame.width == 0 || frame.height == 0 {
        return Err(HelperError::CaptureFailed(
            "cannot write an empty frame to the clipboard".into(),
        ));
    }
    // A pitch below `width * 4` would mean the source rows are shorter than
    // BGRA, guaranteeing a row copy past the buffer end. Pitch may exceed
    // `width * 4` when callers (e.g., GPU captures) align rows to 4-byte
    // boundaries, so we only reject the under-sized case.
    let min_row_bytes = frame.width.checked_mul(4).ok_or_else(|| {
        HelperError::CaptureFailed(format!(
            "clipboard row bytes overflow for width {}",
            frame.width
        ))
    })?;
    if frame.pitch < min_row_bytes {
        return Err(HelperError::CaptureFailed(format!(
            "clipboard frame pitch {} is below width*4={}",
            frame.pitch, min_row_bytes
        )));
    }

    // OpenClipboard returns Err if another process currently owns the
    // clipboard; the caller maps this to `clipboardWritten: false` and
    // continues the commit.
    // SAFETY: Passing Some(hwnd) ties the clipboard ownership to our window
    // so subsequent SetClipboardData calls succeed without races from
    // competing processes during the commit.
    unsafe { OpenClipboard(Some(hwnd)) }
        .map_err(|error| HelperError::CaptureFailed(format!("OpenClipboard failed: {error}")))?;
    let _open = OpenClipboardGuard;

    // SAFETY: We just opened the clipboard on this thread; EmptyClipboard is
    // the documented next step and clears any prior CF_DIBV5 contents.
    unsafe { EmptyClipboard() }
        .map_err(|error| HelperError::CaptureFailed(format!("EmptyClipboard failed: {error}")))?;

    // Total buffer = sizeof(BITMAPV5HEADER) + width*4*height pixels.
    let width_u32 = frame.width;
    let height_u32 = frame.height;
    let width_i32 = i32::try_from(width_u32).map_err(|_| {
        HelperError::CaptureFailed(format!("clipboard width {width_u32} does not fit in i32"))
    })?;
    let height_i32 = i32::try_from(height_u32).map_err(|_| {
        HelperError::CaptureFailed(format!("clipboard height {height_u32} does not fit in i32"))
    })?;

    let row_bytes_u32 = width_u32.checked_mul(4).ok_or_else(|| {
        HelperError::CaptureFailed(format!(
            "clipboard row bytes overflow for width {width_u32}"
        ))
    })?;
    let pixel_bytes_u32 = row_bytes_u32.checked_mul(height_u32).ok_or_else(|| {
        HelperError::CaptureFailed(format!(
            "clipboard pixel buffer overflow for {width_u32}x{height_u32}"
        ))
    })?;
    let header_size = u32::try_from(std::mem::size_of::<BITMAPV5HEADER>())
        .map_err(|_| HelperError::CaptureFailed("BITMAPV5HEADER size overflow".into()))?;
    let total_bytes_u32 = header_size.checked_add(pixel_bytes_u32).ok_or_else(|| {
        HelperError::CaptureFailed(format!(
            "clipboard total bytes overflow ({header_size} + {pixel_bytes_u32})"
        ))
    })?;
    let total_bytes = usize::try_from(total_bytes_u32).map_err(|_| {
        HelperError::CaptureFailed(format!(
            "clipboard total bytes {total_bytes_u32} does not fit in usize"
        ))
    })?;

    // SAFETY: GMEM_MOVEABLE returns a handle to a relocatable block. The
    // returned HGLOBAL is owned by this function and only escapes via
    // SetClipboardData; until then the HGLOBALGuard tracks ownership.
    let hg = unsafe { GlobalAlloc(GMEM_MOVEABLE, total_bytes) }
        .map_err(|error| HelperError::CaptureFailed(format!("GlobalAlloc failed: {error}")))?;
    let hg_guard = HGLOBALGuard::new(hg);

    // SAFETY: GlobalLock pins the block in memory and returns a writable
    // pointer. We own the only lock for this handle; the lock is released
    // before SetClipboardData as documented.
    let ptr = unsafe { GlobalLock(hg) };
    if ptr.is_null() {
        return Err(HelperError::CaptureFailed(
            "GlobalLock returned a null pointer".into(),
        ));
    }

    let header = BITMAPV5HEADER {
        bV5Size: header_size,
        bV5Width: width_i32,
        // Negative height => bottom-up row order, matching the GDI DIB
        // convention used by the renderer cache.
        bV5Height: -height_i32,
        bV5Planes: 1,
        bV5BitCount: 32,
        bV5Compression: BI_BITFIELDS,
        bV5SizeImage: pixel_bytes_u32,
        bV5XPelsPerMeter: 0,
        bV5YPelsPerMeter: 0,
        bV5ClrUsed: 0,
        bV5ClrImportant: 0,
        bV5RedMask: 0x00FF_0000,
        bV5GreenMask: 0x0000_FF00,
        bV5BlueMask: 0x0000_00FF,
        bV5AlphaMask: 0xFF00_0000,
        bV5CSType: LCS_sRGB,
        bV5Endpoints: CIEXYZTRIPLE::default(),
        bV5GammaRed: 0,
        bV5GammaGreen: 0,
        bV5GammaBlue: 0,
        bV5Intent: 0,
        bV5ProfileData: 0,
        bV5ProfileSize: 0,
        bV5Reserved: 0,
    };

    // SAFETY: ptr points at a writable `total_bytes` block; we copy the
    // header then BGRA pixels (bottom-up). row_bytes equals width*4.
    unsafe {
        let header_ptr = ptr as *mut BITMAPV5HEADER;
        std::ptr::write(header_ptr, header);

        let dst_base = (ptr as *mut u8).add(header_size as usize);
        let row_bytes = row_bytes_u32 as usize;
        let src_pitch = frame.pitch as usize;
        for y in 0..height_u32 as usize {
            // Bottom-up: row 0 of the DIB holds the bottom row of the image.
            let src_y = height_u32 as usize - 1 - y;
            let src = frame.pixels.as_ptr().add(src_y * src_pitch);
            let dst = dst_base.add(y * row_bytes);
            std::ptr::copy_nonoverlapping(src, dst, row_bytes.min(src_pitch));
        }
    }

    // SAFETY: The pointer was obtained from GlobalLock on the same handle;
    // releasing the lock before SetClipboardData is the documented sequence.
    unsafe {
        let _ = GlobalUnlock(hg);
    }

    // Hand ownership to the clipboard. After a successful SetClipboardData
    // the system owns the HGLOBAL and our guard must be disarmed so Drop
    // does not free it. A failure path here would indicate the clipboard
    // was taken from us mid-write; in that case HGLOBALGuard::drop frees
    // the buffer so no leak is left behind.
    // SAFETY: hg is a valid, populated GMEM_MOVEABLE block. The handle is
    // reinterpreted as HANDLE because the windows crate's signature uses
    // HANDLE for cross-API compatibility; both are thin pointer-sized
    // wrappers around the same underlying kernel handle.
    let transferred = unsafe {
        SetClipboardData(
            CF_DIBV5.0 as u32,
            Some(windows::Win32::Foundation::HANDLE(hg.0)),
        )
    }
    .map_err(|error| HelperError::CaptureFailed(format!("SetClipboardData failed: {error}")))?;
    if transferred.is_invalid() {
        return Err(HelperError::CaptureFailed(
            "SetClipboardData returned an invalid handle".into(),
        ));
    }

    // Ownership has transferred; disarm the guard so drop is a no-op.
    let _disarmed = hg_guard.disarm();

    Ok(())
}
