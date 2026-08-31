//! Capture backend abstraction.
//!
//! [`CaptureBackend`] is the only interface the rest of the helper consumes
//! to obtain a frozen frame of the primary monitor. DXGI Desktop Duplication
//! ([`crate::win::capture_dxgi`]) is the primary path; [`crate::win::capture_gdi::GdiCaptureBackend`]
//! remains the documented fallback when DXGI init fails or when the system
//! reports that the cursor is composited into the desktop.

use crate::{
    error::HelperError,
    geometry::{DisplayRotation, RectI},
    win::display::DisplayInfo,
};

/// BGRA pixels for a frozen frame, captured from GDI or from a Direct3D
/// staging texture that the GPU path copied into a CPU buffer.
///
/// Pitch is the number of bytes per row and may exceed `width * 4` because
/// GDI aligns DIB rows to 4-byte boundaries. All pixel data is laid out in
/// canonical orientation: callers do not need to know the physical rotation
/// of the source display because the rotation has already been normalized
/// by the time a [`CpuBgraFrame`] is produced.
#[derive(Debug, Clone)]
pub struct CpuBgraFrame {
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
    pub pixels: Vec<u8>,
}

/// Opaque handle to a frozen GPU frame produced by the DXGI capture path.
///
/// The DXGI backend keeps the captured frame on the GPU until the user commits
/// the selection (at which point a small `CopySubresourceRegion` + `Map` reads
/// only the selection rectangle). The frozen texture plus its D2D bitmap live
/// for the duration of the active interaction; [`crate::win::renderer::OverlayRenderer`]
/// binds the D2D bitmap so subsequent repaints do not re-upload the frame.
///
/// Concrete COM types are intentionally hidden from this module so the trait
/// surface remains `Send`-friendly for the helper's UI-thread usage.
#[derive(Debug)]
pub struct GpuFrozenFrame {
    pub(crate) width: u32,
    pub(crate) height: u32,
    #[allow(dead_code)]
    pub(crate) rotation: DisplayRotation,
    /// Backing `ID3D11Texture2D` (latest → frozen, identity rotation).
    pub(crate) frozen: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
    /// Display-oriented `ID3D11Texture2D` matching canonical `display.bounds`.
    pub(crate) frozen_oriented: Option<windows::Win32::Graphics::Direct3D11::ID3D11Texture2D>,
    pub(crate) device: windows::Win32::Graphics::Direct3D11::ID3D11Device,
    pub(crate) context: windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
}

impl GpuFrozenFrame {
    /// Read the frozen texture (display-oriented, or identity-orientation) back
    /// to a CPU BGRA buffer. This is used as a fallback when the D2D bitmap
    /// upload fails; it incurs a full-frame CPU readback, so diagnostics should
    /// not assert `full_frame_cpu_readbacks == 0` after this path.
    pub fn readback_to_cpu(&self) -> Result<CpuBgraFrame, HelperError> {
        let w = self.width;
        let h = self.height;
        let row_bytes = (w as usize)
            .checked_mul(4)
            .ok_or_else(|| HelperError::CaptureFailed("readback_to_cpu row overflow".into()))?;
        let total_bytes = row_bytes
            .checked_mul(h as usize)
            .ok_or_else(|| HelperError::CaptureFailed("readback_to_cpu total overflow".into()))?;

        use windows::Win32::Graphics::Direct3D11::{
            D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
        };
        use windows::Win32::Graphics::Dxgi::Common::{
            DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
        };

        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging: Option<windows::Win32::Graphics::Direct3D11::ID3D11Texture2D> = None;
        // SAFETY: `desc` describes a valid staging texture.
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut staging)) }.map_err(
            |error| {
                HelperError::CaptureFailed(format!(
                    "readback_to_cpu CreateTexture2D failed: {error}"
                ))
            },
        )?;
        let staging = staging.ok_or_else(|| {
            HelperError::CaptureFailed("readback_to_cpu CreateTexture2D returned None".into())
        })?;

        // Copy from display-oriented or identity texture
        let source = self.frozen_oriented.as_ref().unwrap_or(&self.frozen);
        // SAFETY: CopyResource copies entire texture; staging is same size.
        unsafe {
            self.context.CopyResource(&staging, source);
        }

        let mut mapped = Default::default();
        // SAFETY: Map on a staging texture with D3D11_MAP_READ is valid.
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        }
        .map_err(|error| {
            HelperError::CaptureFailed(format!("readback_to_cpu Map failed: {error}"))
        })?;

        let src_pitch = mapped.RowPitch as usize;
        let mut pixels = vec![0u8; total_bytes];
        // SAFETY: copy row by row, clamping to the smaller pitch.
        unsafe {
            for y in 0..h as usize {
                let src = (mapped.pData as *const u8).add(y * src_pitch);
                let dst = pixels.as_mut_ptr().add(y * row_bytes);
                std::ptr::copy_nonoverlapping(src, dst, row_bytes.min(src_pitch));
            }
        }
        // SAFETY: Unmap after read is complete.
        unsafe {
            self.context.Unmap(&staging, 0);
        }

        Ok(CpuBgraFrame {
            width: w,
            height: h,
            pitch: w * 4,
            pixels,
        })
    }

    /// Read back a sub-region of the frozen texture (display-oriented if
    /// available) to a CPU BGRA buffer. The returned frame is sized to
    /// `rect` (in canonical display-local coordinates).
    ///
    /// This avoids a full-frame readback by using `CopySubresourceRegion`
    /// to copy only the selection rectangle into a smaller staging texture.
    pub fn readback_selection(
        &self,
        rect: crate::geometry::RectI,
    ) -> Result<CpuBgraFrame, HelperError> {
        use windows::Win32::Graphics::Direct3D11::{
            D3D11_BOX, D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_TEXTURE2D_DESC,
            D3D11_USAGE_STAGING,
        };
        use windows::Win32::Graphics::Dxgi::Common::{
            DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
        };

        if rect.width == 0 || rect.height == 0 {
            return Err(HelperError::CaptureFailed(
                "readback_selection called with zero-sized rect".into(),
            ));
        }

        let sel_w = rect.width;
        let sel_h = rect.height;
        let row_bytes = (sel_w as usize)
            .checked_mul(4)
            .ok_or_else(|| HelperError::CaptureFailed("readback_selection row overflow".into()))?;
        let total_bytes = row_bytes.checked_mul(sel_h as usize).ok_or_else(|| {
            HelperError::CaptureFailed("readback_selection total overflow".into())
        })?;

        let desc = D3D11_TEXTURE2D_DESC {
            Width: sel_w,
            Height: sel_h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging: Option<windows::Win32::Graphics::Direct3D11::ID3D11Texture2D> = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut staging)) }.map_err(
            |error| {
                HelperError::CaptureFailed(format!(
                    "readback_selection CreateTexture2D failed: {error}"
                ))
            },
        )?;
        let staging = staging.ok_or_else(|| {
            HelperError::CaptureFailed("readback_selection CreateTexture2D returned None".into())
        })?;

        let source = self.frozen_oriented.as_ref().unwrap_or(&self.frozen);

        // Copy sub-region using CopySubresourceRegion
        let box_ = D3D11_BOX {
            left: rect.x as u32,
            top: rect.y as u32,
            front: 0,
            right: rect.x as u32 + sel_w,
            bottom: rect.y as u32 + sel_h,
            back: 1,
        };
        unsafe {
            self.context
                .CopySubresourceRegion(&staging, 0, 0, 0, 0, source, 0, Some(&box_));
        }

        let mut mapped = Default::default();
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        }
        .map_err(|error| {
            HelperError::CaptureFailed(format!("readback_selection Map failed: {error}"))
        })?;

        let src_pitch = mapped.RowPitch as usize;
        let mut pixels = vec![0u8; total_bytes];
        unsafe {
            for y in 0..sel_h as usize {
                let src = (mapped.pData as *const u8).add(y * src_pitch);
                let dst = pixels.as_mut_ptr().add(y * row_bytes);
                std::ptr::copy_nonoverlapping(src, dst, row_bytes.min(src_pitch));
            }
        }
        unsafe {
            self.context.Unmap(&staging, 0);
        }

        Ok(CpuBgraFrame {
            width: sel_w,
            height: sel_h,
            pitch: sel_w * 4,
            pixels,
        })
    }
}

/// The result of a successful [`CaptureBackend::freeze`].
#[derive(Debug)]
pub enum FrozenFrame {
    Gpu(GpuFrozenFrame),
    Cpu(CpuBgraFrame),
}

/// Outcome reported by [`CaptureBackend::refresh_latest`].
///
/// `Unchanged` is the only outcome the GDI backend ever reports because
/// GDI is pull-on-demand. The `Updated` and `Lost` variants are produced by
/// capture backends that maintain their own continuous frame buffer (DXGI
/// duplication).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshOutcome {
    Updated,
    Unchanged,
    Lost,
}

/// Counters that prove the GPU capture path is delivering on its promise: no
/// full-screen CPU readback between `Start` and `overlay-visible`, and
/// exactly one selection readback at commit.
///
/// Fields are cumulative monotonic counters exposed on the wire via
/// `Event::OverlayVisible` and `Event::CaptureReleased` so integration tests
/// can assert the documented invariants without a private inspector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDiagnostics {
    /// Stable backend identifier surfaced on the wire (e.g. `"dxgi"`, `"gdi"`).
    pub backend: &'static str,
    /// Total `Map`/`BitBlt` operations that pulled a full display-sized buffer
    /// back to the CPU. DXGI must keep this at zero between `Start` and
    /// `overlay-visible`.
    pub full_frame_cpu_readbacks: u64,
    /// Total `Map`/`BitBlt` operations that pulled the *selection* rectangle
    /// (or smaller) back to the CPU. Both backends increment this at commit.
    pub selection_cpu_readbacks: u64,
    /// Times `AcquireNextFrame` returned `S_OK` (DXGI) or freeze succeeded
    /// (GDI). GDI counts a single 1 here at first freeze.
    pub latest_copies: u64,
    /// Times the DXGI duplication + textures were rebuilt (ACCESS_LOST,
    /// display change, DPI change). Zero on a healthy desktop.
    pub duplication_rebuilds: u64,
}

/// Capture backend capability surface.
///
/// Implementations must be `Send`-safe for the helper's single-threaded use
/// in T5a but should not assume they are `Sync`; the helper UI thread is the
/// only consumer.
pub trait CaptureBackend {
    /// Stable name of this backend; used by [`CaptureDiagnostics::backend`]
    /// and surfaced on the wire.
    fn name(&self) -> &'static str;

    /// Refresh the backend's notion of the latest frame, returning whether
    /// the frame is new, unchanged, or lost. The `timeout_ms` is a hint; the
    /// GDI backend ignores it.
    fn refresh_latest(&mut self, timeout_ms: u32) -> Result<RefreshOutcome, HelperError>;

    /// Rebuild resources whose lifetime is tied to the current display
    /// topology or graphics device. DXGI replaces its duplication and texture
    /// pool; pull-on-demand backends may keep their existing state.
    fn recover(&mut self, _display: &DisplayInfo) -> Result<(), HelperError> {
        Ok(())
    }

    /// Freeze the current frame of the primary display, producing a
    /// [`FrozenFrame`] whose dimensions match `display.bounds` in canonical
    /// orientation. Implementations must already know the physical bounds of
    /// the source desktop; the caller passes `display` so the backend can
    /// apply any rotation transform.
    fn freeze(&mut self, display: &DisplayInfo) -> Result<FrozenFrame, HelperError>;

    /// Invalidate any persistent state held by the backend so the next
    /// freeze produces a fresh capture. T5a backends hold no persistent
    /// state and may treat this as a no-op.
    fn invalidate(&mut self);

    /// Snapshot the backend's running counters. The returned struct is
    /// intentionally `Copy` so callers can read it without disturbing the
    /// backend's internal state.
    fn diagnostics(&self) -> CaptureDiagnostics;

    /// Record that a selection CPU readback has been performed. Callers invoke
    /// this after extracting a selection from the frozen frame, so the
    /// diagnostics counter tracks the readback for verification tests.
    fn record_selection_readback(&mut self);

    /// Whether the just-acquired DXGI frame cannot satisfy the helper's
    /// cursor policy and the current capture session should use GDI instead.
    fn should_fallback_to_gdi(&self) -> bool {
        false
    }
}

/// Convenience: copy of the active frozen frame's canonical bounds. Used by
/// `OverlayApp` to size the D2D bitmap without re-reading `display.bounds`.
pub fn frozen_canonical_bounds(frozen: &FrozenFrame, display_bounds: RectI) -> (u32, u32) {
    let (w, h) = match frozen {
        FrozenFrame::Gpu(gpu) => (gpu.width, gpu.height),
        FrozenFrame::Cpu(cpu) => (cpu.width, cpu.height),
    };
    if w == 0 || h == 0 {
        (display_bounds.width, display_bounds.height)
    } else {
        (w, h)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_outcome_variants_are_distinct() {
        assert_ne!(RefreshOutcome::Updated, RefreshOutcome::Unchanged);
        assert_ne!(RefreshOutcome::Updated, RefreshOutcome::Lost);
        assert_ne!(RefreshOutcome::Unchanged, RefreshOutcome::Lost);
    }

    #[test]
    fn refresh_outcome_is_copy() {
        let value = RefreshOutcome::Unchanged;
        let copy = value;
        assert_eq!(value, copy);
    }

    #[test]
    fn diagnostics_default_is_all_zero() {
        let d = CaptureDiagnostics::default();
        assert_eq!(d.backend, "");
        assert_eq!(d.full_frame_cpu_readbacks, 0);
        assert_eq!(d.selection_cpu_readbacks, 0);
        assert_eq!(d.latest_copies, 0);
        assert_eq!(d.duplication_rebuilds, 0);
    }
}
