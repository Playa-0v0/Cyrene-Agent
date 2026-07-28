//! Overlay renderer with a GDI primary path and optional Direct2D upgrade path.
//!
//! T5c guarantees:
//! - Frozen frame is uploaded once and cached; mouse-move repaints reuse it.
//! - First presentation order is paint → `UpdateWindow` → `DwmFlush` before
//!   `overlay-visible` is emitted by the caller.
//! - Direct2D is attempted at construction; if factory creation fails we fall
//!   back to GDI for the whole session. The GDI path still honors the
//!   overlay-visible ordering above.
//!
//! Direct2D bitmap upload/paint is deferred to Task 7's device-context path;
//! when D2D init succeeds we still paint via GDI against the same cached
//! frozen DIB so the first-paint / DwmFlush contract is identical.

use windows::Win32::{
    Foundation::{COLORREF, HWND, RECT},
    Graphics::{
        Direct2D::{
            Common as D2D, D2D1_BITMAP_OPTIONS_CANNOT_DRAW, D2D1_BITMAP_OPTIONS_NONE,
            D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_PROPERTIES1, D2D1_CAP_STYLE_ROUND,
            D2D1_DASH_STYLE_SOLID, D2D1_DRAW_TEXT_OPTIONS_NONE, D2D1_FACTORY_TYPE_SINGLE_THREADED,
            D2D1_FEATURE_LEVEL_DEFAULT, D2D1_INTERPOLATION_MODE_LINEAR, D2D1_LINE_JOIN_ROUND,
            D2D1_RENDER_TARGET_PROPERTIES, D2D1_RENDER_TARGET_TYPE_DEFAULT,
            D2D1_RENDER_TARGET_USAGE_NONE, D2D1_ROUNDED_RECT, D2D1_STROKE_STYLE_PROPERTIES,
            D2D1CreateDevice, D2D1CreateFactory, ID2D1Bitmap1, ID2D1DCRenderTarget, ID2D1Device,
            ID2D1DeviceContext, ID2D1Factory, ID2D1Image, ID2D1RenderTarget, ID2D1SolidColorBrush,
            ID2D1StrokeStyle,
        },
        Direct3D11::{ID3D11Device, ID3D11Texture2D},
        DirectWrite::{
            DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_WEIGHT_NORMAL, DWRITE_MEASURING_MODE_NATURAL, DWriteCreateFactory,
            IDWriteFactory, IDWriteFontCollection, IDWriteTextFormat,
        },
        Dwm::DwmFlush,
        Dxgi::{
            Common::{DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
            DXGI_PRESENT, DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG,
            DXGI_SWAP_EFFECT_FLIP_DISCARD, DXGI_USAGE_RENDER_TARGET_OUTPUT, IDXGIAdapter,
            IDXGIDevice, IDXGISurface, IDXGISwapChain1,
        },
        Gdi::{
            AC_SRC_ALPHA, AC_SRC_OVER, AlphaBlend, BI_RGB, BITMAPINFO, BITMAPINFOHEADER,
            BLENDFUNCTION, BitBlt, CreateCompatibleDC, CreateDIBSection, CreatePen,
            CreateSolidBrush, DIB_RGB_COLORS, DeleteDC, DeleteObject, FillRect, GetDC,
            GetStockObject, HBITMAP, HDC, HGDIOBJ, HPEN, LineTo, MoveToEx, NULL_BRUSH, PS_SOLID,
            Rectangle, ReleaseDC, SRCCOPY, SelectObject, SetBkMode, SetTextColor, TRANSPARENT,
            TextOutW, UpdateWindow,
        },
    },
};
use windows::core::{Interface, w};
use windows_numerics::Vector2;

use crate::{
    error::HelperError,
    geometry::{AnnotationColor, AnnotationTool, Mark, RectI, place_toolbar},
    win::{
        capture::{CpuBgraFrame, GpuFrozenFrame},
        display::DisplayInfo,
        window::{OverlayWindow, TOOLBAR_BUTTON_GAP, TOOLBAR_GAP, TOOLBAR_HEIGHT, TOOLBAR_WIDTH},
    },
};

/// Toolbar layout computed for the current selection, in client coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolbarLayout {
    pub toolbar: RectI,
    pub rectangle: RectI,
    pub arrow: RectI,
    pub undo: RectI,
    pub confirm: RectI,
    pub cancel: RectI,
    pub colors: [RectI; 4],
}

/// Overlay paint backend. Owns a single cached frozen-frame bitmap backed by
/// GDI (`GdiFrameCache`) or by a D2D bitmap from DXGI (`ID2D1Bitmap1`).
///
/// When a GPU frozen frame is received, the renderer creates a D2D device
/// context + swap chain from the same D3D11 device used by the DXGI capture
/// backend, and binds the frozen texture as an `ID2D1Bitmap1` via
/// `CreateBitmapFromDxgiSurface`.  Subsequent repaints (mouse-move) reuse the
/// cached bitmap and never re-upload the frame.
///
/// When `gpu_bitmap` is `None`, the GDI fallback path is used.
pub struct OverlayRenderer {
    gdi_cache: Option<GdiFrameCache>,
    /// D2D device context created from the DXGI capture's D3D11 device. Set
    /// lazily in `init_gpu_resources` and cleared when the swap chain is torn
    /// down.
    d2d_device_context: Option<ID2D1DeviceContext>,
    /// Swap chain created for the overlay HWND. Recreated in `resize`.
    swap_chain: Option<IDXGISwapChain1>,
    /// Cached D2D bitmap from the frozen GPU texture. Created once per
    /// `upload_frozen_gpu`; freed when `clear_frozen` is called.
    gpu_bitmap: Option<ID2D1Bitmap1>,
    /// Size of GPU texture (for swap-chain resize detection).
    gpu_texture_width: u32,
    gpu_texture_height: u32,
    /// True when a Direct2D factory was created successfully at `new()`.
    pub d2d_available: bool,
    /// Incremented each time a frozen frame is uploaded. Stays constant across
    /// mouse-move repaints.
    pub upload_count: u64,
    _d2d_factory: Option<ID2D1Factory>,
    text_format: Option<IDWriteTextFormat>,
}

/// Long-lived GDI cache of the frozen frame. `Drop` restores the previous
/// object and frees the owned DC/bitmap so misuse cannot leak handles.
struct GdiFrameCache {
    width: i32,
    height: i32,
    dib: HBITMAP,
    mem_dc: HDC,
    old_obj: HGDIOBJ,
    composition_dib: HBITMAP,
    composition_dc: HDC,
    composition_old_obj: HGDIOBJ,
}

impl GdiFrameCache {
    fn composition_hdc(&self) -> HDC {
        self.composition_dc
    }
}

impl Drop for GdiFrameCache {
    fn drop(&mut self) {
        // SAFETY: `mem_dc` / `dib` were created as a pair in `create_gdi_frame_cache`
        // and `old_obj` is the object that was selected before the DIB. Restoring
        // first satisfies Win32's rule that a selected bitmap must not be deleted.
        unsafe {
            let _ = SelectObject(self.composition_dc, self.composition_old_obj);
            let _ = DeleteObject(HGDIOBJ(self.composition_dib.0));
            let _ = DeleteDC(self.composition_dc);
            let _ = SelectObject(self.mem_dc, self.old_obj);
            let _ = DeleteObject(HGDIOBJ(self.dib.0));
            let _ = DeleteDC(self.mem_dc);
        }
    }
}

impl OverlayRenderer {
    pub fn new() -> Result<Self, HelperError> {
        // Prefer Direct2D; fall back silently to GDI if the factory cannot be
        // created (headless session, missing d2d1.dll, etc.).
        let d2d_factory = unsafe {
            D2D1CreateFactory::<ID2D1Factory>(D2D1_FACTORY_TYPE_SINGLE_THREADED, None).ok()
        };
        let text_format =
            unsafe { DWriteCreateFactory::<IDWriteFactory>(DWRITE_FACTORY_TYPE_SHARED) }
                .ok()
                .and_then(|factory| unsafe {
                    factory
                        .CreateTextFormat(
                            w!("Segoe UI"),
                            None::<&IDWriteFontCollection>,
                            DWRITE_FONT_WEIGHT_NORMAL,
                            DWRITE_FONT_STYLE_NORMAL,
                            DWRITE_FONT_STRETCH_NORMAL,
                            16.0,
                            w!("zh-CN"),
                        )
                        .ok()
                });
        Ok(Self {
            gdi_cache: None,
            d2d_device_context: None,
            swap_chain: None,
            gpu_bitmap: None,
            gpu_texture_width: 0,
            gpu_texture_height: 0,
            d2d_available: d2d_factory.is_some(),
            upload_count: 0,
            _d2d_factory: d2d_factory,
            text_format,
        })
    }

    /// Initialize GPU resources from a DXGI capture backend's D3D11 device
    /// and the overlay HWND. Creates the D2D device and device context,
    /// and a swap chain for the overlay window. Called once when the first
    /// GPU frozen frame is uploaded.
    pub fn init_gpu_resources(
        &mut self,
        device: &ID3D11Device,
        hwnd: HWND,
        display: &DisplayInfo,
    ) -> Result<(), HelperError> {
        let _d2d_factory = self._d2d_factory.as_ref().ok_or_else(|| {
            HelperError::CaptureFailed("cannot init GPU resources without D2D factory".into())
        })?;

        // Create IDXGIDevice from D3D11 device
        let dxgi_device: IDXGIDevice = device.cast().map_err(|error| {
            HelperError::CaptureFailed(format!("D3D11 device cast to IDXGIDevice failed: {error}"))
        })?;

        // Create ID2D1Device via the global function
        let d2d_device: ID2D1Device =
            unsafe { D2D1CreateDevice(&dxgi_device, None) }.map_err(|error| {
                HelperError::CaptureFailed(format!("D2D1CreateDevice failed: {error}"))
            })?;

        // Create ID2D1DeviceContext
        let d2d_device_context: ID2D1DeviceContext = unsafe {
            d2d_device.CreateDeviceContext(
                windows::Win32::Graphics::Direct2D::D2D1_DEVICE_CONTEXT_OPTIONS_NONE,
            )
        }
        .map_err(|error| {
            HelperError::CaptureFailed(format!("ID2D1Device::CreateDeviceContext failed: {error}"))
        })?;

        // Create swap chain
        let dxgi_adapter: IDXGIAdapter = unsafe { dxgi_device.GetParent() }.map_err(|error| {
            HelperError::CaptureFailed(format!("IDXGIDevice::GetParent failed: {error}"))
        })?;

        let dxgi_factory: windows::Win32::Graphics::Dxgi::IDXGIFactory2 =
            unsafe { dxgi_adapter.GetParent() }.map_err(|error| {
                HelperError::CaptureFailed(format!("IDXGIAdapter::GetParent failed: {error}"))
            })?;

        let swap_desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: display.bounds.width,
            Height: display.bounds.height,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            Stereo: false.into(),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
            AlphaMode: DXGI_ALPHA_MODE_IGNORE,
            Flags: 0,
        };

        let _swap_chain: IDXGISwapChain1 =
            unsafe { dxgi_factory.CreateSwapChainForHwnd(device, hwnd, &swap_desc, None, None) }
                .map_err(|error| {
                    HelperError::CaptureFailed(format!("CreateSwapChainForHwnd failed: {error}"))
                })?;

        self.d2d_device_context = Some(d2d_device_context);
        self.swap_chain = Some(_swap_chain);
        self.gpu_texture_width = display.bounds.width;
        self.gpu_texture_height = display.bounds.height;
        Ok(())
    }

    /// Ensure any size-dependent resources match `display`.
    pub fn resize(&mut self, _hwnd: HWND, display: &DisplayInfo) -> Result<(), HelperError> {
        if let Some(ref swap_chain) = self.swap_chain {
            unsafe {
                swap_chain.ResizeBuffers(
                    0,
                    display.bounds.width,
                    display.bounds.height,
                    DXGI_FORMAT_B8G8R8A8_UNORM,
                    DXGI_SWAP_CHAIN_FLAG(0),
                )
            }
            .map_err(|error| {
                HelperError::CaptureFailed(format!("ResizeBuffers failed: {error}"))
            })?;
        }
        // Clear GDI cache since the display changed; next upload rebuilds.
        self.clear_gdi_cache();
        Ok(())
    }

    /// Upload a GPU frozen frame (D3D11 texture) as an `ID2D1Bitmap1` for
    /// Direct2D painting. The renderer must have GPU resources initialized via
    /// `init_gpu_resources` before this call.
    ///
    /// Takes the display-oriented frozen texture and creates a D2D bitmap via
    /// `CreateBitmapFromDxgiSurface`. Once uploaded, mouse-move repaints only
    /// re-draw the cached bitmap; the texture is not re-read from the GPU.
    pub fn upload_frozen_gpu(
        &mut self,
        frame: &GpuFrozenFrame,
        hwnd: HWND,
        display: &DisplayInfo,
    ) -> Result<(), HelperError> {
        // Initialize GPU resources on first upload.
        if self.d2d_device_context.is_none() {
            self.init_gpu_resources(&frame.device, hwnd, display)?;
        }

        // Use the display-oriented texture if available (non-identity rotation).
        let texture = frame.frozen_oriented.as_ref().unwrap_or(&frame.frozen);

        // Cast ID3D11Texture2D to IDXGISurface
        let surface: IDXGISurface = texture.cast().map_err(|error| {
            HelperError::CaptureFailed(format!(
                "ID3D11Texture2D cast to IDXGISurface failed: {error}"
            ))
        })?;

        let d2d_context = self.d2d_device_context.as_ref().ok_or_else(|| {
            HelperError::CaptureFailed("D2D device context not initialized".into())
        })?;

        let bitmap_props = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D::D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D::D2D1_ALPHA_MODE_IGNORE,
            },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
            colorContext: core::mem::ManuallyDrop::new(None),
        };

        let bitmap: ID2D1Bitmap1 =
            unsafe { d2d_context.CreateBitmapFromDxgiSurface(&surface, Some(&bitmap_props)) }
                .map_err(|error| {
                    HelperError::CaptureFailed(format!(
                        "CreateBitmapFromDxgiSurface failed: {error}"
                    ))
                })?;

        self.gpu_bitmap = Some(bitmap);
        self.gpu_texture_width = frame.width;
        self.gpu_texture_height = frame.height;
        self.upload_count = self.upload_count.saturating_add(1);
        Ok(())
    }

    /// Upload a CPU frozen frame as a GDI DIB cache. Used for GDI capture or
    /// as a fallback when GPU upload fails.
    pub fn upload_frozen(&mut self, frame: &CpuBgraFrame) -> Result<(), HelperError> {
        self.clear_gdi_cache();
        self.gdi_cache = Some(create_gdi_frame_cache(frame)?);
        self.upload_count = self.upload_count.saturating_add(1);
        Ok(())
    }

    pub fn clear_frozen(&mut self) {
        self.clear_gdi_cache();
        self.gpu_bitmap = None;
        if let Some(context) = self.d2d_device_context.as_ref() {
            unsafe { context.SetTarget(None::<&ID2D1Image>) };
        }
        // Do NOT clear d2d_device_context or swap_chain — they persist
        // across uploads. The swap chain will be resized if the display
        // changes.
    }

    /// Drop every resource tied to the current D3D device. A duplication
    /// rebuild creates a fresh D3D11 device, so retaining the old D2D context
    /// would make the next `CreateBitmapFromDxgiSurface` fail with a
    /// cross-device resource error.
    pub fn reset_gpu_resources(&mut self) {
        self.clear_frozen();
        self.d2d_device_context = None;
        self.swap_chain = None;
        self.gpu_texture_width = 0;
        self.gpu_texture_height = 0;
    }

    /// Paint dimmed frozen background, selection border, and optional toolbar.
    ///
    /// Takes shared `&self` so paint never needs exclusive access to the
    /// renderer (WM_PAINT and optional GetDC callers only read the cache).
    ///
    /// When a D2D GPU bitmap is available, paints through the swap chain;
    /// otherwise falls back to GDI.
    pub fn paint(
        &self,
        hwnd: HWND,
        selection: Option<RectI>,
        display: &DisplayInfo,
        toolbar: Option<ToolbarLayout>,
    ) -> Result<(), HelperError> {
        if self.gpu_bitmap.is_some() && self.swap_chain.is_some() {
            self.paint_d2d(
                hwnd,
                selection,
                display,
                toolbar,
                &[],
                None,
                false,
                None,
                AnnotationColor::Red,
            )
        } else {
            self.paint_gdi_fallback(hwnd, selection, display, toolbar)
        }
    }

    /// Paint using a caller-provided HDC (WM_PAINT path).
    pub fn paint_on_hdc(
        &self,
        hdc: HDC,
        hwnd: HWND,
        selection: Option<RectI>,
        display: &DisplayInfo,
        toolbar: Option<ToolbarLayout>,
        marks: &[Mark],
        draft: Option<Mark>,
        show_colors: bool,
        active_tool: Option<AnnotationTool>,
        active_color: AnnotationColor,
    ) -> Result<(), HelperError> {
        if self.gpu_bitmap.is_some() && self.swap_chain.is_some() {
            self.paint_d2d(
                hwnd,
                selection,
                display,
                toolbar,
                marks,
                draft,
                show_colors,
                active_tool,
                active_color,
            )
        } else {
            let paint_hdc = self
                .gdi_cache
                .as_ref()
                .map_or(hdc, GdiFrameCache::composition_hdc);
            paint_gdi_on_hdc(
                paint_hdc,
                self.gdi_cache.as_ref(),
                selection,
                display,
                toolbar,
            )?;
            if let Err(error) = self.draw_overlay_details_d2d_on_hdc(
                paint_hdc,
                display,
                selection,
                toolbar,
                marks,
                draft,
                show_colors,
                active_tool,
                active_color,
            ) {
                eprintln!(
                    "cyrene-screenshot: D2D-on-GDI overlay details failed ({error}), using basic GDI"
                );
                if let Some(layout) = toolbar {
                    draw_toolbar_gdi(paint_hdc, layout)?;
                }
                draw_overlay_details_gdi(
                    paint_hdc,
                    selection,
                    toolbar,
                    marks,
                    draft,
                    show_colors,
                    active_tool,
                    active_color,
                )?;
            }
            if let Some(cache) = self.gdi_cache.as_ref() {
                unsafe {
                    let _ = BitBlt(
                        hdc,
                        0,
                        0,
                        cache.width,
                        cache.height,
                        Some(cache.composition_dc),
                        0,
                        0,
                        SRCCOPY,
                    );
                }
            }
            Ok(())
        }
    }

    /// Paint via Direct2D using the cached GPU bitmap and swap chain.
    #[allow(clippy::too_many_arguments)]
    fn paint_d2d(
        &self,
        _hwnd: HWND,
        selection: Option<RectI>,
        display: &DisplayInfo,
        toolbar: Option<ToolbarLayout>,
        marks: &[Mark],
        draft: Option<Mark>,
        show_colors: bool,
        active_tool: Option<AnnotationTool>,
        active_color: AnnotationColor,
    ) -> Result<(), HelperError> {
        let context = self
            .d2d_device_context
            .as_ref()
            .ok_or_else(|| HelperError::CaptureFailed("D2D context missing in paint_d2d".into()))?;
        let swap_chain = self
            .swap_chain
            .as_ref()
            .ok_or_else(|| HelperError::CaptureFailed("swap chain missing in paint_d2d".into()))?;

        // Get back buffer as D2D bitmap target
        let back_buffer: ID3D11Texture2D = unsafe { swap_chain.GetBuffer::<ID3D11Texture2D>(0) }
            .map_err(|error| HelperError::CaptureFailed(format!("GetBuffer(0) failed: {error}")))?;

        let dxgi_surface: windows::Win32::Graphics::Dxgi::IDXGISurface =
            back_buffer.cast().map_err(|error| {
                HelperError::CaptureFailed(format!(
                    "back buffer cast to IDXGISurface failed: {error}"
                ))
            })?;

        let target_props = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D::D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D::D2D1_ALPHA_MODE_IGNORE,
            },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            colorContext: core::mem::ManuallyDrop::new(None),
        };
        let target_bitmap: ID2D1Bitmap1 =
            unsafe { context.CreateBitmapFromDxgiSurface(&dxgi_surface, Some(&target_props)) }
                .map_err(|error| {
                    HelperError::CaptureFailed(format!(
                        "CreateBitmapFromDxgiSurface for back buffer failed: {error}"
                    ))
                })?;

        let dark_color = D2D::D2D1_COLOR_F {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 0.45,
        };
        let dark_brush = unsafe { context.CreateSolidColorBrush(&dark_color, None) }
            .map_err(HelperError::from)?;
        let border_color = D2D::D2D1_COLOR_F {
            r: 0x3e as f32 / 255.0,
            g: 0xea as f32 / 255.0,
            b: 0x96 as f32 / 255.0,
            a: 1.0,
        };
        let border_brush = unsafe { context.CreateSolidColorBrush(&border_color, None) }
            .map_err(HelperError::from)?;
        // Begin render
        unsafe {
            context.SetTarget(&target_bitmap);
            context.BeginDraw();
            let clear = D2D::D2D1_COLOR_F {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 1.0,
            };
            context.Clear(Some(&clear));
        }

        // Draw the frozen desktop first at full opacity. Dimming is a separate
        // overlay so a selected region can remain at its original brightness.
        let gw = display.bounds.width as f32;
        let gh = display.bounds.height as f32;

        if let Some(ref bitmap) = self.gpu_bitmap {
            // Draw the frozen frame as the background
            let dest = D2D::D2D_RECT_F {
                left: 0.0,
                top: 0.0,
                right: gw,
                bottom: gh,
            };
            unsafe {
                context.DrawBitmap(
                    bitmap,
                    Some(&dest),
                    1.0,
                    D2D1_INTERPOLATION_MODE_LINEAR,
                    None,
                    None,
                );
            }
        }

        for region in dim_regions(display.bounds.width, display.bounds.height, selection) {
            unsafe {
                context.FillRectangle(&d2d_rect(region), &dark_brush);
            }
        }

        if let Some(sel) = selection {
            unsafe {
                context.DrawRectangle(
                    &d2d_rect(sel),
                    &border_brush,
                    2.0,
                    None::<&ID2D1StrokeStyle>,
                );
            }
        }

        self.draw_overlay_details_d2d(
            context,
            selection,
            toolbar,
            marks,
            draft,
            show_colors,
            active_tool,
            active_color,
        )?;

        // End draw and present
        let draw_result = unsafe {
            context
                .EndDraw(None, None)
                .map_err(|error| HelperError::CaptureFailed(format!("EndDraw failed: {error}")))
        };
        unsafe { context.SetTarget(None::<&ID2D1Image>) };
        draw_result?;

        unsafe { swap_chain.Present(1, DXGI_PRESENT(0)) }
            .ok()
            .map_err(|error| {
                HelperError::CaptureFailed(format!("IDXGISwapChain1::Present failed: {error}"))
            })?;

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_overlay_details_d2d(
        &self,
        context: &ID2D1RenderTarget,
        selection: Option<RectI>,
        toolbar: Option<ToolbarLayout>,
        marks: &[Mark],
        draft: Option<Mark>,
        show_colors: bool,
        active_tool: Option<AnnotationTool>,
        active_color: AnnotationColor,
    ) -> Result<(), HelperError> {
        let factory = self._d2d_factory.as_ref().ok_or_else(|| {
            HelperError::CaptureFailed("D2D factory missing while drawing overlay".into())
        })?;
        let round_style = unsafe {
            factory.CreateStrokeStyle(
                &D2D1_STROKE_STYLE_PROPERTIES {
                    startCap: D2D1_CAP_STYLE_ROUND,
                    endCap: D2D1_CAP_STYLE_ROUND,
                    dashCap: D2D1_CAP_STYLE_ROUND,
                    lineJoin: D2D1_LINE_JOIN_ROUND,
                    miterLimit: 10.0,
                    dashStyle: D2D1_DASH_STYLE_SOLID,
                    dashOffset: 0.0,
                },
                None,
            )
        }
        .map_err(HelperError::from)?;
        let selection_brush = d2d_brush(context, 0x3e, 0xea, 0x96, 0xff)?;

        for mark in marks.iter().copied().chain(draft) {
            draw_mark_d2d(context, mark, &round_style)?;
        }

        if let Some(selection) = selection {
            let right = selection.x.saturating_add_unsigned(selection.width);
            let bottom = selection.y.saturating_add_unsigned(selection.height);
            let center_x = selection.x + i32::try_from(selection.width / 2).unwrap_or_default();
            let center_y = selection.y + i32::try_from(selection.height / 2).unwrap_or_default();
            for (x, y) in [
                (selection.x, selection.y),
                (center_x, selection.y),
                (right, selection.y),
                (right, center_y),
                (right, bottom),
                (center_x, bottom),
                (selection.x, bottom),
                (selection.x, center_y),
            ] {
                let handle = D2D::D2D_RECT_F {
                    left: x as f32 - 4.0,
                    top: y as f32 - 4.0,
                    right: x as f32 + 5.0,
                    bottom: y as f32 + 5.0,
                };
                unsafe { context.FillRectangle(&handle, &selection_brush) };
            }

            if let Some(text_format) = self.text_format.as_ref() {
                let label: Vec<u16> = format!("{} x {}", selection.width, selection.height)
                    .encode_utf16()
                    .collect();
                let text_y = if selection.y >= 24 {
                    selection.y as f32 - 24.0
                } else {
                    selection.y as f32 + 6.0
                };
                let text_rect = D2D::D2D_RECT_F {
                    left: selection.x as f32,
                    top: text_y,
                    right: selection.x as f32 + 180.0,
                    bottom: text_y + 22.0,
                };
                let text_brush = d2d_brush(context, 0xff, 0xff, 0xff, 0xff)?;
                unsafe {
                    context.DrawText(
                        &label,
                        text_format,
                        &text_rect,
                        &text_brush,
                        D2D1_DRAW_TEXT_OPTIONS_NONE,
                        DWRITE_MEASURING_MODE_NATURAL,
                    );
                }
            }
        }

        if let Some(layout) = toolbar {
            let toolbar_brush = d2d_brush(context, 0xf7, 0xf7, 0xf7, 0xff)?;
            let toolbar_border = d2d_brush(context, 0xd8, 0xd8, 0xd8, 0xff)?;
            let toolbar_rect = D2D1_ROUNDED_RECT {
                rect: d2d_rect(layout.toolbar),
                radiusX: 8.0,
                radiusY: 8.0,
            };
            unsafe {
                context.FillRoundedRectangle(&toolbar_rect, &toolbar_brush);
                context.DrawRoundedRectangle(
                    &toolbar_rect,
                    &toolbar_border,
                    1.0,
                    None::<&ID2D1StrokeStyle>,
                );
            }

            if let Some(active) = match active_tool {
                Some(AnnotationTool::Rectangle) => Some(layout.rectangle),
                Some(AnnotationTool::Arrow) => Some(layout.arrow),
                None => None,
            } {
                let active_brush = d2d_brush(context, 0xe8, 0xe8, 0xe8, 0xff)?;
                let active_rect = D2D1_ROUNDED_RECT {
                    rect: d2d_rect(inset(active, 4)),
                    radiusX: 6.0,
                    radiusY: 6.0,
                };
                unsafe { context.FillRoundedRectangle(&active_rect, &active_brush) };
            }

            let icon_brush = d2d_brush(context, 0x33, 0x33, 0x33, 0xff)?;
            draw_svg_toolbar_icons_d2d(context, factory, layout, &icon_brush, &round_style)?;

            if show_colors {
                let popover = RectI {
                    x: layout.colors[0].x - 8,
                    y: layout.colors[0].y - 8,
                    width: u32::try_from(
                        layout.colors[3]
                            .x
                            .saturating_add_unsigned(layout.colors[3].width)
                            .saturating_sub(layout.colors[0].x)
                            .saturating_add(16),
                    )
                    .unwrap_or_default(),
                    height: layout.colors[0].height + 16,
                };
                let popover_rect = D2D1_ROUNDED_RECT {
                    rect: d2d_rect(popover),
                    radiusX: 8.0,
                    radiusY: 8.0,
                };
                unsafe { context.FillRoundedRectangle(&popover_rect, &toolbar_brush) };
                for (rect, color) in layout.colors.into_iter().zip([
                    AnnotationColor::Red,
                    AnnotationColor::Yellow,
                    AnnotationColor::Green,
                    AnnotationColor::Blue,
                ]) {
                    let color_brush = d2d_annotation_brush(context, color)?;
                    let swatch = D2D1_ROUNDED_RECT {
                        rect: d2d_rect(inset(rect, 4)),
                        radiusX: 10.0,
                        radiusY: 10.0,
                    };
                    unsafe { context.FillRoundedRectangle(&swatch, &color_brush) };
                    if color == active_color {
                        unsafe {
                            context.DrawRoundedRectangle(
                                &swatch,
                                &icon_brush,
                                2.0,
                                None::<&ID2D1StrokeStyle>,
                            );
                        }
                    }
                }
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_overlay_details_d2d_on_hdc(
        &self,
        hdc: HDC,
        display: &DisplayInfo,
        selection: Option<RectI>,
        toolbar: Option<ToolbarLayout>,
        marks: &[Mark],
        draft: Option<Mark>,
        show_colors: bool,
        active_tool: Option<AnnotationTool>,
        active_color: AnnotationColor,
    ) -> Result<(), HelperError> {
        let factory = self._d2d_factory.as_ref().ok_or_else(|| {
            HelperError::CaptureFailed("D2D factory unavailable for GDI overlay details".into())
        })?;
        let target: ID2D1DCRenderTarget = unsafe {
            factory.CreateDCRenderTarget(&D2D1_RENDER_TARGET_PROPERTIES {
                r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
                pixelFormat: D2D::D2D1_PIXEL_FORMAT {
                    format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    alphaMode: D2D::D2D1_ALPHA_MODE_IGNORE,
                },
                dpiX: 96.0,
                dpiY: 96.0,
                usage: D2D1_RENDER_TARGET_USAGE_NONE,
                minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
            })
        }
        .map_err(HelperError::from)?;
        let bounds = RECT {
            left: 0,
            top: 0,
            right: i32::try_from(display.bounds.width).map_err(|_| {
                HelperError::InvalidDisplay("D2D DC target width does not fit i32".into())
            })?,
            bottom: i32::try_from(display.bounds.height).map_err(|_| {
                HelperError::InvalidDisplay("D2D DC target height does not fit i32".into())
            })?,
        };
        unsafe {
            target.BindDC(hdc, &bounds).map_err(HelperError::from)?;
            target.BeginDraw();
        }
        let draw_result = self.draw_overlay_details_d2d(
            &target,
            selection,
            toolbar,
            marks,
            draft,
            show_colors,
            active_tool,
            active_color,
        );
        let end_result = unsafe { target.EndDraw(None, None) }.map_err(HelperError::from);
        draw_result.and(end_result)
    }

    /// Fallback paint path using GDI (used when no GPU bitmap is set).
    fn paint_gdi_fallback(
        &self,
        hwnd: HWND,
        selection: Option<RectI>,
        display: &DisplayInfo,
        toolbar: Option<ToolbarLayout>,
    ) -> Result<(), HelperError> {
        // SAFETY: `hwnd` is a live overlay window on this UI thread. `GetDC`
        // returns a DC that must be paired with `ReleaseDC` for the same hwnd;
        // we always release it below, including on paint failure.
        let hdc = unsafe { GetDC(Some(hwnd)) };
        if hdc.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        let result = paint_gdi_on_hdc(hdc, self.gdi_cache.as_ref(), selection, display, toolbar);
        let _ = unsafe { ReleaseDC(Some(hwnd), hdc) };
        result
    }

    /// `DwmFlush` so the compositor has presented the first frame before
    /// `overlay-visible` is emitted.
    pub fn flush(&self) -> Result<(), HelperError> {
        // SAFETY: DwmFlush has no parameters; it synchronizes with DWM.
        unsafe { DwmFlush() }.map_err(HelperError::from)
    }

    /// Extract a copy of the cached frozen frame cropped to `rect` (in
    /// display-local coordinates, i.e. origin at top-left of the captured
    /// desktop). The returned [`CpuBgraFrame`] owns its pixel buffer so the
    /// renderer can hand it to the clipboard writer and (optionally) the
    /// encoder thread without aliasing the GDI cache.
    ///
    /// When a GPU frozen frame is available (the D2D bitmap path is active)
    /// and the GDI cache is empty, the selection is read back from the GPU
    /// texture via `GpuFrozenFrame::readback_selection` to avoid a full-frame
    /// CPU copy.
    pub fn extract_selection(
        &self,
        rect: RectI,
        gpu_frame: Option<&GpuFrozenFrame>,
    ) -> Result<CpuBgraFrame, HelperError> {
        if rect.width == 0 || rect.height == 0 {
            return Err(HelperError::CaptureFailed(
                "extract_selection called with zero-sized rect".into(),
            ));
        }

        // GPU path: read back selection from the frozen GPU texture
        if self.gdi_cache.is_none() && self.gpu_bitmap.is_some() {
            if let Some(frame) = gpu_frame {
                return frame.readback_selection(rect);
            }
            return Err(HelperError::CaptureFailed(
                "extract_selection: GPU bitmap set but no GpuFrozenFrame provided".into(),
            ));
        }

        // GDI path (also fallback when gpu_bitmap is present but gdi_cache is set)
        let cache = self.gdi_cache.as_ref().ok_or_else(|| {
            HelperError::CaptureFailed(
                "extract_selection called without an active frozen cache".into(),
            )
        })?;

        // Selection is in display-local coordinates; clamp to the cache
        // dimensions so a malformed selection cannot read past the DIB.
        let cache_w = u32::try_from(cache.width).map_err(|_| {
            HelperError::CaptureFailed(format!(
                "frozen cache width {} does not fit in u32",
                cache.width
            ))
        })?;
        let cache_h = u32::try_from(cache.height).map_err(|_| {
            HelperError::CaptureFailed(format!(
                "frozen cache height {} does not fit in u32",
                cache.height
            ))
        })?;
        if rect.x < 0 || rect.y < 0 {
            return Err(HelperError::CaptureFailed(format!(
                "selection origin ({},{}) must be non-negative",
                rect.x, rect.y
            )));
        }
        if (rect.x as u64) + (rect.width as u64) > cache_w as u64
            || (rect.y as u64) + (rect.height as u64) > cache_h as u64
        {
            return Err(HelperError::CaptureFailed(format!(
                "selection {:?} exceeds cached frozen frame {cache_w}x{cache_h}",
                rect
            )));
        }

        let dst_w = i32::try_from(rect.width).map_err(|_| {
            HelperError::CaptureFailed(format!(
                "selection width {} does not fit in i32",
                rect.width
            ))
        })?;
        let dst_h = i32::try_from(rect.height).map_err(|_| {
            HelperError::CaptureFailed(format!(
                "selection height {} does not fit in i32",
                rect.height
            ))
        })?;

        let row_bytes = (rect.width as usize)
            .checked_mul(4)
            .and_then(|b| b.checked_mul(rect.height as usize))
            .ok_or_else(|| HelperError::CaptureFailed("selection pixel buffer overflow".into()))?;
        if row_bytes > isize::MAX as usize {
            return Err(HelperError::CaptureFailed(format!(
                "selection pixel buffer {row_bytes} exceeds isize::MAX"
            )));
        }
        let mut pixels = vec![0u8; row_bytes];

        // Use the cache's own mem_dc as the source. Acquiring fresh guards
        // for the destination side keeps the cache untouched on failure.
        let screen_dc = ScreenDcGuard::acquire()?;
        let mem_dc = MemoryDcGuard::create(screen_dc.handle())?;
        let dib = BitmapGuard::create_dib_top_down(mem_dc.handle(), dst_w, dst_h)?;
        let previous = unsafe { SelectObject(mem_dc.handle(), HGDIOBJ(dib.bitmap.0)) };
        if previous.0.is_null() || previous.0 as isize == -1 {
            return Err(HelperError::CaptureFailed(format!(
                "SelectObject for selection extraction failed (last error: {})",
                windows::core::Error::from_thread().message()
            )));
        }
        // Declared after `dib`, so it restores the previous bitmap before the
        // destination DIB is deleted on every return path.
        let _selection = SelectionGuard::new(mem_dc.handle(), previous);

        // SAFETY: cache.mem_dc has the frozen DIB selected for its lifetime;
        // mem_dc holds our destination DIB. BitBlt parameters match both
        // sides (selection rect inside the cache; destination size == dst_w
        // × dst_h).
        let blt_ok = unsafe {
            BitBlt(
                mem_dc.handle(),
                0,
                0,
                dst_w,
                dst_h,
                Some(cache.mem_dc),
                rect.x,
                rect.y,
                SRCCOPY,
            )
        };
        if let Err(error) = blt_ok {
            return Err(HelperError::CaptureFailed(format!(
                "BitBlt for selection extraction failed: {error}"
            )));
        }

        // Read the destination pixels out into our owned Vec. The DIB is
        // top-down with biHeight = -dst_h, so rows are stored at increasing
        // addresses; copy with the documented DIB row pitch (width*4).
        let bits = dib.bits();
        unsafe {
            std::ptr::copy_nonoverlapping(bits as *const u8, pixels.as_mut_ptr(), row_bytes);
        }

        Ok(CpuBgraFrame {
            width: rect.width,
            height: rect.height,
            pitch: rect.width * 4,
            pixels,
        })
    }

    fn clear_gdi_cache(&mut self) {
        // Drop runs GdiFrameCache::drop (restore + DeleteObject + DeleteDC).
        self.gdi_cache = None;
    }
}

impl Drop for OverlayRenderer {
    fn drop(&mut self) {
        self.clear_frozen();
        // D2D device context, swap chain, factory are released via COM ref counting.
    }
}

fn d2d_rect(rect: RectI) -> D2D::D2D_RECT_F {
    D2D::D2D_RECT_F {
        left: rect.x as f32,
        top: rect.y as f32,
        right: rect.x.saturating_add_unsigned(rect.width) as f32,
        bottom: rect.y.saturating_add_unsigned(rect.height) as f32,
    }
}

fn d2d_brush(
    context: &ID2D1RenderTarget,
    red: u8,
    green: u8,
    blue: u8,
    alpha: u8,
) -> Result<ID2D1SolidColorBrush, HelperError> {
    unsafe {
        context.CreateSolidColorBrush(
            &D2D::D2D1_COLOR_F {
                r: f32::from(red) / 255.0,
                g: f32::from(green) / 255.0,
                b: f32::from(blue) / 255.0,
                a: f32::from(alpha) / 255.0,
            },
            None,
        )
    }
    .map_err(HelperError::from)
}

fn d2d_annotation_brush(
    context: &ID2D1RenderTarget,
    color: AnnotationColor,
) -> Result<ID2D1SolidColorBrush, HelperError> {
    match color {
        AnnotationColor::Red => d2d_brush(context, 0xff, 0x4d, 0x4f, 0xff),
        AnnotationColor::Yellow => d2d_brush(context, 0xff, 0xd4, 0x3b, 0xff),
        AnnotationColor::Green => d2d_brush(context, 0x3e, 0xea, 0x96, 0xff),
        AnnotationColor::Blue => d2d_brush(context, 0x4c, 0x8d, 0xff, 0xff),
    }
}

fn vector(x: f32, y: f32) -> Vector2 {
    Vector2 { X: x, Y: y }
}

fn draw_mark_d2d(
    context: &ID2D1RenderTarget,
    mark: Mark,
    round_style: &ID2D1StrokeStyle,
) -> Result<(), HelperError> {
    let (start, end, color, arrow) = match mark {
        Mark::Rect { start, end, color } => (start, end, color, false),
        Mark::Arrow { start, end, color } => (start, end, color, true),
    };
    let brush = d2d_annotation_brush(context, color)?;
    unsafe {
        if arrow {
            context.DrawLine(
                vector(start.x as f32, start.y as f32),
                vector(end.x as f32, end.y as f32),
                &brush,
                3.0,
                round_style,
            );
            let dx = f64::from(end.x - start.x);
            let dy = f64::from(end.y - start.y);
            let length = (dx * dx + dy * dy).sqrt().max(1.0);
            let ux = dx / length;
            let uy = dy / length;
            for side in [-1.0, 1.0] {
                context.DrawLine(
                    vector(end.x as f32, end.y as f32),
                    vector(
                        (f64::from(end.x) - ux * 12.0 + (-uy) * 6.0 * side) as f32,
                        (f64::from(end.y) - uy * 12.0 + ux * 6.0 * side) as f32,
                    ),
                    &brush,
                    3.0,
                    round_style,
                );
            }
        } else {
            context.DrawRectangle(
                &D2D::D2D_RECT_F {
                    left: start.x.min(end.x) as f32,
                    top: start.y.min(end.y) as f32,
                    right: start.x.max(end.x) as f32,
                    bottom: start.y.max(end.y) as f32,
                },
                &brush,
                3.0,
                round_style,
            );
        }
    }
    Ok(())
}

fn svg_icon_point(button: RectI, x: f32, y: f32) -> Vector2 {
    let origin_x = button.x as f32 + (button.width as f32 - 24.0) / 2.0;
    let origin_y = button.y as f32 + (button.height as f32 - 24.0) / 2.0;
    vector(origin_x + x * 0.5, origin_y + y * 0.5)
}

fn draw_svg_toolbar_icons_d2d(
    context: &ID2D1RenderTarget,
    factory: &ID2D1Factory,
    layout: ToolbarLayout,
    brush: &ID2D1SolidColorBrush,
    round_style: &ID2D1StrokeStyle,
) -> Result<(), HelperError> {
    unsafe {
        // Rectangle SVG: M42 8 H6 C4.89543 8 4 8.89543 4 10 V38
        // C4 39.1046 4.89543 40 6 40 H42 C43.1046 40 44 39.1046 44 38 V10
        // C44 8.89543 43.1046 8 42 8 Z
        let rectangle = D2D1_ROUNDED_RECT {
            rect: D2D::D2D_RECT_F {
                left: svg_icon_point(layout.rectangle, 4.0, 8.0).X,
                top: svg_icon_point(layout.rectangle, 4.0, 8.0).Y,
                right: svg_icon_point(layout.rectangle, 44.0, 40.0).X,
                bottom: svg_icon_point(layout.rectangle, 44.0, 40.0).Y,
            },
            radiusX: 1.0,
            radiusY: 1.0,
        };
        context.DrawRoundedRectangle(&rectangle, brush, 2.0, round_style);

        // Arrow SVG paths.
        context.DrawLine(
            svg_icon_point(layout.arrow, 19.0, 11.0),
            svg_icon_point(layout.arrow, 37.0, 11.0),
            brush,
            2.0,
            round_style,
        );
        context.DrawLine(
            svg_icon_point(layout.arrow, 37.0, 11.0),
            svg_icon_point(layout.arrow, 37.0, 29.0),
            brush,
            2.0,
            round_style,
        );
        context.DrawLine(
            svg_icon_point(layout.arrow, 11.5439, 36.4559),
            svg_icon_point(layout.arrow, 36.9997, 11.0),
            brush,
            2.0,
            round_style,
        );

        draw_undo_svg_d2d(context, factory, layout.undo, brush, round_style)?;

        // Close SVG paths.
        context.DrawLine(
            svg_icon_point(layout.cancel, 8.0, 8.0),
            svg_icon_point(layout.cancel, 40.0, 40.0),
            brush,
            2.0,
            round_style,
        );
        context.DrawLine(
            svg_icon_point(layout.cancel, 8.0, 40.0),
            svg_icon_point(layout.cancel, 40.0, 8.0),
            brush,
            2.0,
            round_style,
        );

        // Confirm SVG path.
        context.DrawLine(
            svg_icon_point(layout.confirm, 43.0, 11.0),
            svg_icon_point(layout.confirm, 16.875, 37.0),
            brush,
            2.0,
            round_style,
        );
        context.DrawLine(
            svg_icon_point(layout.confirm, 16.875, 37.0),
            svg_icon_point(layout.confirm, 5.0, 25.1818),
            brush,
            2.0,
            round_style,
        );
    }
    Ok(())
}

fn draw_undo_svg_d2d(
    context: &ID2D1RenderTarget,
    factory: &ID2D1Factory,
    button: RectI,
    brush: &ID2D1SolidColorBrush,
    round_style: &ID2D1StrokeStyle,
) -> Result<(), HelperError> {
    let geometry = unsafe { factory.CreatePathGeometry() }.map_err(HelperError::from)?;
    let sink = unsafe { geometry.Open() }.map_err(HelperError::from)?;
    unsafe {
        sink.BeginFigure(
            svg_icon_point(button, 11.2721, 36.7279),
            D2D::D2D1_FIGURE_BEGIN_HOLLOW,
        );
        for (p1, p2, p3) in [
            ((14.5294, 39.9853), (19.0294, 42.0), (24.0, 42.0)),
            ((33.9411, 42.0), (42.0, 33.9411), (42.0, 24.0)),
            ((42.0, 14.0589), (33.9411, 6.0), (24.0, 6.0)),
            ((19.0294, 6.0), (14.5294, 8.01472), (11.2721, 11.2721)),
            ((9.61407, 12.9301), (6.0, 17.0), (6.0, 17.0)),
        ] {
            sink.AddBezier(&D2D::D2D1_BEZIER_SEGMENT {
                point1: svg_icon_point(button, p1.0, p1.1),
                point2: svg_icon_point(button, p2.0, p2.1),
                point3: svg_icon_point(button, p3.0, p3.1),
            });
        }
        sink.EndFigure(D2D::D2D1_FIGURE_END_OPEN);
        sink.BeginFigure(
            svg_icon_point(button, 6.0, 9.0),
            D2D::D2D1_FIGURE_BEGIN_HOLLOW,
        );
        sink.AddLines(&[
            svg_icon_point(button, 6.0, 17.0),
            svg_icon_point(button, 14.0, 17.0),
        ]);
        sink.EndFigure(D2D::D2D1_FIGURE_END_OPEN);
        sink.Close().map_err(HelperError::from)?;
        context.DrawGeometry(&geometry, brush, 2.0, round_style);
    }
    Ok(())
}

pub fn burn_annotations(
    frame: &mut CpuBgraFrame,
    marks: &[Mark],
    selection_origin: crate::geometry::PointI,
) {
    for mark in marks {
        let (start, end, color, arrow) = match *mark {
            Mark::Rect { start, end, color } => (start, end, color, false),
            Mark::Arrow { start, end, color } => (start, end, color, true),
        };
        let start = (
            start.x.saturating_sub(selection_origin.x),
            start.y.saturating_sub(selection_origin.y),
        );
        let end = (
            end.x.saturating_sub(selection_origin.x),
            end.y.saturating_sub(selection_origin.y),
        );
        let bgra = annotation_bgra(color);
        if arrow {
            draw_bgra_line(frame, start, end, bgra, 3);
            let dx = f64::from(end.0 - start.0);
            let dy = f64::from(end.1 - start.1);
            let length = (dx * dx + dy * dy).sqrt().max(1.0);
            let ux = dx / length;
            let uy = dy / length;
            for side in [-1.0, 1.0] {
                let wing = (
                    (f64::from(end.0) - ux * 12.0 + (-uy) * 6.0 * side).round() as i32,
                    (f64::from(end.1) - uy * 12.0 + ux * 6.0 * side).round() as i32,
                );
                draw_bgra_line(frame, end, wing, bgra, 3);
            }
        } else {
            let left = start.0.min(end.0);
            let top = start.1.min(end.1);
            let right = start.0.max(end.0);
            let bottom = start.1.max(end.1);
            draw_bgra_line(frame, (left, top), (right, top), bgra, 3);
            draw_bgra_line(frame, (right, top), (right, bottom), bgra, 3);
            draw_bgra_line(frame, (right, bottom), (left, bottom), bgra, 3);
            draw_bgra_line(frame, (left, bottom), (left, top), bgra, 3);
        }
    }
}

fn draw_bgra_line(
    frame: &mut CpuBgraFrame,
    start: (i32, i32),
    end: (i32, i32),
    color: [u8; 4],
    thickness: i32,
) {
    let radius = thickness.max(1) as f64 / 2.0;
    let padding = radius.ceil() as i32 + 1;
    let left = start.0.min(end.0).saturating_sub(padding);
    let top = start.1.min(end.1).saturating_sub(padding);
    let right = start.0.max(end.0).saturating_add(padding);
    let bottom = start.1.max(end.1).saturating_add(padding);
    let dx = f64::from(end.0 - start.0);
    let dy = f64::from(end.1 - start.1);
    let length_squared = dx * dx + dy * dy;

    for y in top..=bottom {
        for x in left..=right {
            let px = f64::from(x) + 0.5;
            let py = f64::from(y) + 0.5;
            let t = if length_squared <= f64::EPSILON {
                0.0
            } else {
                (((px - f64::from(start.0)) * dx + (py - f64::from(start.1)) * dy) / length_squared)
                    .clamp(0.0, 1.0)
            };
            let closest_x = f64::from(start.0) + t * dx;
            let closest_y = f64::from(start.1) + t * dy;
            let distance = ((px - closest_x).powi(2) + (py - closest_y).powi(2)).sqrt();
            let coverage = (radius + 0.5 - distance).clamp(0.0, 1.0);
            if coverage > 0.0 {
                blend_bgra_pixel(frame, x, y, color, coverage);
            }
        }
    }
}

fn blend_bgra_pixel(frame: &mut CpuBgraFrame, x: i32, y: i32, color: [u8; 4], coverage: f64) {
    if x < 0 || y < 0 || x >= frame.width as i32 || y >= frame.height as i32 {
        return;
    }
    let offset = usize::try_from(y).unwrap_or_default() * frame.pitch as usize
        + usize::try_from(x).unwrap_or_default() * 4;
    if let Some(pixel) = frame.pixels.get_mut(offset..offset + 4) {
        let source_alpha = (f64::from(color[3]) / 255.0) * coverage;
        let inverse = 1.0 - source_alpha;
        for channel in 0..3 {
            pixel[channel] = (f64::from(color[channel]) * source_alpha
                + f64::from(pixel[channel]) * inverse)
                .round() as u8;
        }
        pixel[3] = 0xff;
    }
}

fn annotation_bgra(color: AnnotationColor) -> [u8; 4] {
    match color {
        AnnotationColor::Red => [0x4f, 0x4d, 0xff, 0xff],
        AnnotationColor::Yellow => [0x3b, 0xd4, 0xff, 0xff],
        AnnotationColor::Green => [0x96, 0xea, 0x3e, 0xff],
        AnnotationColor::Blue => [0xff, 0x8d, 0x4c, 0xff],
    }
}

fn dim_regions(width: u32, height: u32, selection: Option<RectI>) -> Vec<RectI> {
    let full = RectI {
        x: 0,
        y: 0,
        width,
        height,
    };
    let Some(selection) = selection.and_then(|selection| {
        let left = i64::from(selection.x).clamp(0, i64::from(width));
        let top = i64::from(selection.y).clamp(0, i64::from(height));
        let right =
            (i64::from(selection.x) + i64::from(selection.width)).clamp(0, i64::from(width));
        let bottom =
            (i64::from(selection.y) + i64::from(selection.height)).clamp(0, i64::from(height));
        (right > left && bottom > top).then_some(RectI {
            x: i32::try_from(left).ok()?,
            y: i32::try_from(top).ok()?,
            width: u32::try_from(right - left).ok()?,
            height: u32::try_from(bottom - top).ok()?,
        })
    }) else {
        return vec![full];
    };

    let right = selection.x.saturating_add_unsigned(selection.width);
    let bottom = selection.y.saturating_add_unsigned(selection.height);
    [
        RectI {
            x: 0,
            y: 0,
            width,
            height: u32::try_from(selection.y).unwrap_or_default(),
        },
        RectI {
            x: 0,
            y: bottom,
            width,
            height: height.saturating_sub(u32::try_from(bottom).unwrap_or(height)),
        },
        RectI {
            x: 0,
            y: selection.y,
            width: u32::try_from(selection.x).unwrap_or_default(),
            height: selection.height,
        },
        RectI {
            x: right,
            y: selection.y,
            width: width.saturating_sub(u32::try_from(right).unwrap_or(width)),
            height: selection.height,
        },
    ]
    .into_iter()
    .filter(|region| region.width > 0 && region.height > 0)
    .collect()
}

/// Compute confirm/cancel toolbar placement for a selection inside `display`.
pub fn compute_toolbar(selection: RectI, display: &DisplayInfo) -> Option<ToolbarLayout> {
    // place_toolbar expects display-relative bounds; selection in the overlay is
    // client-local (origin at display top-left), so shift display bounds to (0,0).
    let local_display = RectI {
        x: 0,
        y: 0,
        width: display.bounds.width,
        height: display.bounds.height,
    };
    let toolbar = place_toolbar(
        selection,
        local_display,
        TOOLBAR_WIDTH,
        TOOLBAR_HEIGHT,
        TOOLBAR_GAP,
    )?;
    let button_width = 40;
    if toolbar.width < button_width * 5 + TOOLBAR_BUTTON_GAP * 4 {
        return None;
    }
    let button = |index: u32| RectI {
        x: toolbar
            .x
            .saturating_add_unsigned(index * (button_width + TOOLBAR_BUTTON_GAP)),
        y: toolbar.y,
        width: button_width,
        height: toolbar.height,
    };
    let rectangle = button(0);
    let arrow = button(1);
    let undo = button(2);
    let cancel = button(3);
    let confirm = button(4);
    let color_size = 28;
    let color_gap = 6;
    let colors_width = color_size * 4 + color_gap * 3;
    let desired_color_x = toolbar.x
        + i32::try_from((toolbar.width.saturating_sub(colors_width)) / 2).unwrap_or_default();
    let color_y = if toolbar.y >= i32::try_from(color_size + color_gap).unwrap_or_default() {
        toolbar.y - i32::try_from(color_size + color_gap).unwrap_or_default()
    } else {
        toolbar
            .y
            .saturating_add_unsigned(toolbar.height + color_gap)
    };
    let colors = std::array::from_fn(|index| RectI {
        x: desired_color_x.saturating_add_unsigned(
            u32::try_from(index).unwrap_or_default() * (color_size + color_gap),
        ),
        y: color_y,
        width: color_size,
        height: color_size,
    });
    Some(ToolbarLayout {
        toolbar,
        rectangle,
        arrow,
        undo,
        confirm,
        cancel,
        colors,
    })
}

/// First-paint helper used by the start sequence after ShowWindow / upload:
/// `InvalidateRect` → `UpdateWindow` (WM_PAINT) → `DwmFlush`.
///
/// Intentionally does **not** take `&mut OverlayRenderer`. `UpdateWindow`
/// re-enters `window_proc` and paints via the attached `NonNull` pointer; holding
/// an overlapping exclusive borrow across that call would be stacked-borrows UB
/// and would double-paint if a GetDC path ran first.
///
/// Preconditions: frozen frame uploaded, renderer attached to `overlay`, window
/// already shown. Selection/toolbar are read from window state inside WM_PAINT.
pub fn present_first_frame(overlay: &OverlayWindow) -> Result<(), HelperError> {
    let hwnd = overlay.hwnd();
    // SAFETY: marks the full client area invalid so UpdateWindow will dispatch
    // a WM_PAINT. The window is shown and the renderer is attached by the caller.
    let _ = unsafe { windows::Win32::Graphics::Gdi::InvalidateRect(Some(hwnd), None, false) };
    // SAFETY: UpdateWindow pumps a synchronous WM_PAINT on this thread. No
    // `&mut OverlayRenderer` is live on this stack frame; WM_PAINT creates the
    // sole paint borrow through the attached NonNull.
    let _ = unsafe { UpdateWindow(hwnd) };
    if let Some(error) = overlay.take_paint_error() {
        return Err(error);
    }
    // SAFETY: DwmFlush has no parameters; synchronizes with the compositor so
    // the first frame is presented before overlay-visible is emitted.
    unsafe { DwmFlush() }.map_err(HelperError::from)?;
    Ok(())
}

// ---- timing helpers (QPC) ---------------------------------------------------

/// Capture `QueryPerformanceCounter` ticks.
///
/// Returns `0` when the counter cannot be read (should not happen on modern
/// Windows; treated the same as a missing sample by [`qpc_elapsed_ms`]).
pub fn qpc_now() -> i64 {
    let mut counter = 0i64;
    // SAFETY: counter points to writable aligned storage.
    let ok = unsafe { windows::Win32::System::Performance::QueryPerformanceCounter(&mut counter) };
    if ok.is_err() {
        return 0;
    }
    counter
}

/// Elapsed whole milliseconds between two QPC samples. Returns 0 on clock
/// regression, missing frequency, or a failed / zero `start` sample.
pub fn qpc_elapsed_ms(start: i64, end: i64) -> u64 {
    if start <= 0 || end <= start {
        return 0;
    }
    let mut freq = 0i64;
    // SAFETY: freq points to writable aligned storage.
    let ok = unsafe { windows::Win32::System::Performance::QueryPerformanceFrequency(&mut freq) };
    if ok.is_err() || freq <= 0 {
        return 0;
    }
    let delta = (end as u128).saturating_sub(start as u128);
    ((delta.saturating_mul(1000)) / (freq as u128)) as u64
}

// ---- GDI RAII guards (private; mirror T5a capture_gdi pattern) --------------
//
// HDC has no `windows_core::Free` impl, so we own each handle in a small guard
// and free it in `Drop`. Guards are not `Send`: GDI handles are tied to the
// thread that acquired them.

/// Owns an HDC acquired via `GetDC(None)` and releases it via `ReleaseDC`.
struct ScreenDcGuard(HDC);

impl ScreenDcGuard {
    fn acquire() -> Result<Self, HelperError> {
        // SAFETY: `GetDC(None)` returns a DC for the entire screen; it must be
        // released with `ReleaseDC(None, hdc)`, which we do in `Drop`.
        let hdc = unsafe { GetDC(None) };
        if hdc.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(Self(hdc))
    }

    fn handle(&self) -> HDC {
        self.0
    }
}

impl Drop for ScreenDcGuard {
    fn drop(&mut self) {
        // SAFETY: `self.0` was acquired via `GetDC(None)` in `acquire`.
        let _ = unsafe { ReleaseDC(None, self.0) };
    }
}

/// Owns an HDC acquired via `CreateCompatibleDC` and deletes it via `DeleteDC`.
struct MemoryDcGuard(HDC);

impl MemoryDcGuard {
    fn create(parent: HDC) -> Result<Self, HelperError> {
        // SAFETY: parent is a valid DC; the returned memory DC must be freed
        // with `DeleteDC`.
        let hdc = unsafe { CreateCompatibleDC(Some(parent)) };
        if hdc.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(Self(hdc))
    }

    fn handle(&self) -> HDC {
        self.0
    }

    /// Disarm Drop and return the owned HDC (for transfer into `GdiFrameCache`).
    fn into_handle(self) -> HDC {
        let hdc = self.0;
        std::mem::forget(self);
        hdc
    }
}

impl Drop for MemoryDcGuard {
    fn drop(&mut self) {
        // SAFETY: `self.0` was acquired via `CreateCompatibleDC`.
        let _ = unsafe { DeleteDC(self.0) };
    }
}

/// Owns an HBITMAP from `CreateDIBSection` and deletes it via `DeleteObject`.
struct BitmapGuard {
    bitmap: HBITMAP,
    /// Non-null only for DIB sections created via `CreateDIBSection`.
    bits: *mut core::ffi::c_void,
}

impl BitmapGuard {
    fn create_dib_top_down(memory_dc: HDC, width: i32, height: i32) -> Result<Self, HelperError> {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [Default::default()],
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: `info` describes a 32-bit top-down DIB; `bits` receives the
        // section pointer. Ownership of the HBITMAP (and its bits) transfers
        // to this guard and is released in `Drop` unless `into_bitmap` is used.
        let dib =
            unsafe { CreateDIBSection(Some(memory_dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) };
        let dib = match dib {
            Ok(dib) if !bits.is_null() => dib,
            Ok(dib) => {
                // Non-null HBITMAP with null bits: free explicitly and error.
                let _ = unsafe { DeleteObject(HGDIOBJ(dib.0)) };
                return Err(HelperError::CaptureFailed(
                    "CreateDIBSection returned a null bits pointer".into(),
                ));
            }
            Err(error) => return Err(error.into()),
        };
        Ok(Self { bitmap: dib, bits })
    }

    fn bits(&self) -> *mut core::ffi::c_void {
        self.bits
    }

    /// Disarm Drop and return the owned HBITMAP (for transfer into `GdiFrameCache`).
    fn into_bitmap(self) -> HBITMAP {
        let bitmap = self.bitmap;
        std::mem::forget(self);
        bitmap
    }
}

impl Drop for BitmapGuard {
    fn drop(&mut self) {
        // SAFETY: `self.bitmap` was acquired via CreateDIBSection and is not
        // currently selected into a DC (SelectionGuard restores first).
        let _ = unsafe { DeleteObject(HGDIOBJ(self.bitmap.0)) };
    }
}

/// Restores the GDI object that was selected before a temporary bitmap.
///
/// Declare after the bitmap guard so reverse drop order restores before
/// `DeleteObject`, including during unwind.
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

    /// Disarm Drop after a successful intentional transfer (caller keeps the
    /// selection live inside `GdiFrameCache`).
    fn disarm(mut self) {
        self.released = true;
    }
}

impl Drop for SelectionGuard {
    fn drop(&mut self) {
        if !self.released {
            // SAFETY: best-effort restore; Drop cannot report failure.
            let _ = unsafe { SelectObject(self.hdc, self.previous) };
        }
    }
}

// ---- GDI helpers ------------------------------------------------------------

fn create_gdi_frame_cache(frame: &CpuBgraFrame) -> Result<GdiFrameCache, HelperError> {
    let width = i32::try_from(frame.width)
        .map_err(|_| HelperError::InvalidDisplay("frame width does not fit i32".into()))?;
    let height = i32::try_from(frame.height)
        .map_err(|_| HelperError::InvalidDisplay("frame height does not fit i32".into()))?;

    // Guards acquire in dependency order; on any `?` they release in reverse.
    let screen_dc = ScreenDcGuard::acquire()?;
    let mem_dc = MemoryDcGuard::create(screen_dc.handle())?;
    let dib = BitmapGuard::create_dib_top_down(mem_dc.handle(), width, height)?;

    // Copy pixels. Pitch may exceed width*4; copy row by row.
    let dst_pitch = (frame.width * 4) as usize;
    let src_pitch = frame.pitch as usize;
    let bits = dib.bits();
    // SAFETY: bits points at biWidth*abs(biHeight)*4 writable bytes owned by
    // the DIB section; we copy at most min(src,dst) bytes per row.
    unsafe {
        for y in 0..frame.height as usize {
            let src = frame.pixels.as_ptr().add(y * src_pitch);
            let dst = (bits as *mut u8).add(y * dst_pitch);
            std::ptr::copy_nonoverlapping(src, dst, dst_pitch.min(src_pitch));
        }
    }

    // SAFETY: select DIB into mem_dc for subsequent BitBlt source use.
    let old_obj = unsafe { SelectObject(mem_dc.handle(), HGDIOBJ(dib.bitmap.0)) };
    if old_obj.0.is_null() || old_obj.0 as isize == -1 {
        return Err(windows::core::Error::from_thread().into());
    }
    // Keep the DIB selected for the lifetime of GdiFrameCache. Disarm the
    // selection guard so Drop does not restore before we transfer ownership;
    // GdiFrameCache::drop restores `old_obj` itself.
    let selection = SelectionGuard::new(mem_dc.handle(), old_obj);
    selection.disarm();

    // Keep a second same-size DIB as the composition target. Background,
    // dimming, SVG details, and annotations are rendered here first; the
    // window receives one final BitBlt and never observes intermediate frames.
    let composition_dc = MemoryDcGuard::create(screen_dc.handle())?;
    let composition_dib = BitmapGuard::create_dib_top_down(composition_dc.handle(), width, height)?;
    let composition_old_obj =
        unsafe { SelectObject(composition_dc.handle(), HGDIOBJ(composition_dib.bitmap.0)) };
    if composition_old_obj.0.is_null() || composition_old_obj.0 as isize == -1 {
        return Err(windows::core::Error::from_thread().into());
    }
    let composition_selection = SelectionGuard::new(composition_dc.handle(), composition_old_obj);
    composition_selection.disarm();

    // Transfer both DC/bitmap pairs into the long-lived cache. Screen DC drops
    // here (ReleaseDC); the guards are disarmed via into_*.
    let mem_dc_handle = mem_dc.into_handle();
    let dib_handle = dib.into_bitmap();
    let composition_dc_handle = composition_dc.into_handle();
    let composition_dib_handle = composition_dib.into_bitmap();
    drop(screen_dc);

    Ok(GdiFrameCache {
        width,
        height,
        dib: dib_handle,
        mem_dc: mem_dc_handle,
        old_obj,
        composition_dib: composition_dib_handle,
        composition_dc: composition_dc_handle,
        composition_old_obj,
    })
}

fn paint_gdi_on_hdc(
    hdc: HDC,
    cache: Option<&GdiFrameCache>,
    selection: Option<RectI>,
    display: &DisplayInfo,
    toolbar: Option<ToolbarLayout>,
) -> Result<(), HelperError> {
    let width = i32::try_from(display.bounds.width)
        .map_err(|_| HelperError::InvalidDisplay("paint width does not fit i32".into()))?;
    let height = i32::try_from(display.bounds.height)
        .map_err(|_| HelperError::InvalidDisplay("paint height does not fit i32".into()))?;
    let bounds = RECT {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };

    if let Some(cache) = cache {
        // SAFETY: cache.mem_dc has the frozen DIB selected for the cache lifetime.
        unsafe {
            let _ = BitBlt(
                hdc,
                0,
                0,
                cache.width,
                cache.height,
                Some(cache.mem_dc),
                0,
                0,
                SRCCOPY,
            );
        }
        // Dim overlay via AlphaBlend of a solid black bitmap.
        alpha_dim(hdc, width, height, selection)?;
        if let Some(sel) = selection {
            // Restore undimmed selection region from the frozen cache.
            unsafe {
                let _ = BitBlt(
                    hdc,
                    sel.x,
                    sel.y,
                    i32::try_from(sel.width).unwrap_or(0),
                    i32::try_from(sel.height).unwrap_or(0),
                    Some(cache.mem_dc),
                    sel.x,
                    sel.y,
                    SRCCOPY,
                );
            }
            draw_selection_border(hdc, sel)?;
        }
    } else {
        // No frozen frame yet: solid dim fill (pre-upload path).
        let brush = unsafe { CreateSolidBrush(COLORREF(0x00303030)) };
        if brush.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        unsafe {
            FillRect(hdc, &bounds, brush);
            let _ = DeleteObject(HGDIOBJ(brush.0));
        }
        if let Some(sel) = selection {
            draw_selection_border(hdc, sel)?;
        }
    }

    let _ = toolbar;
    Ok(())
}

fn alpha_dim(
    hdc: HDC,
    width: i32,
    height: i32,
    selection: Option<RectI>,
) -> Result<(), HelperError> {
    // Create a 1x1 black bitmap and AlphaBlend it stretched. When a selection is
    // present we dim the four surrounding rects so the selection stays bright.
    // RAII guards release every handle if FillRect / AlphaBlend panics.
    let screen_dc = ScreenDcGuard::acquire()?;
    let mem_dc = MemoryDcGuard::create(screen_dc.handle())?;
    let bmp = BitmapGuard::create_dib_top_down(mem_dc.handle(), 1, 1)?;
    // A premultiplied 32-bit BGRA source pixel makes AlphaBlend deterministic
    // across window/screen DC formats. Black RGB with alpha 115 darkens the
    // destination by roughly 45% while preserving the frozen desktop detail.
    unsafe {
        std::ptr::copy_nonoverlapping([0u8, 0, 0, 115].as_ptr(), bmp.bits() as *mut u8, 4);
    }
    // SAFETY: select the 1x1 bitmap into mem_dc; SelectionGuard restores on drop.
    let old = unsafe { SelectObject(mem_dc.handle(), HGDIOBJ(bmp.bitmap.0)) };
    if old.0.is_null() || old.0 as isize == -1 {
        return Err(windows::core::Error::from_thread().into());
    }
    let _selection = SelectionGuard::new(mem_dc.handle(), old);

    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: 0xff,
        AlphaFormat: AC_SRC_ALPHA as u8,
    };

    let dim_rect = |hdc: HDC, x: i32, y: i32, w: i32, h: i32| {
        if w <= 0 || h <= 0 {
            return;
        }
        // SAFETY: mem_dc holds a 1x1 black bitmap; AlphaBlend stretches it.
        let _ = unsafe { AlphaBlend(hdc, x, y, w, h, mem_dc.handle(), 0, 0, 1, 1, blend) };
    };

    for region in dim_regions(
        u32::try_from(width).unwrap_or_default(),
        u32::try_from(height).unwrap_or_default(),
        selection,
    ) {
        dim_rect(
            hdc,
            region.x,
            region.y,
            i32::try_from(region.width).unwrap_or_default(),
            i32::try_from(region.height).unwrap_or_default(),
        );
    }

    // Guards drop in reverse order: selection restores, then bitmap, mem DC,
    // screen DC.
    Ok(())
}

fn draw_selection_border(hdc: HDC, rect: RectI) -> Result<(), HelperError> {
    // SAFETY: GDI pen/brush selection for a simple rectangle outline.
    let pen: HPEN = unsafe { CreatePen(PS_SOLID, 2, COLORREF(0x0096ea3e)) };
    if pen.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    let old_pen = unsafe { SelectObject(hdc, HGDIOBJ(pen.0)) };
    let null_brush = unsafe { GetStockObject(NULL_BRUSH) };
    let old_brush = unsafe { SelectObject(hdc, null_brush) };
    unsafe {
        let _ = Rectangle(
            hdc,
            rect.x,
            rect.y,
            rect.x.saturating_add_unsigned(rect.width),
            rect.y.saturating_add_unsigned(rect.height),
        );
        let _ = SelectObject(hdc, old_brush);
        let _ = SelectObject(hdc, old_pen);
        let _ = DeleteObject(HGDIOBJ(pen.0));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn draw_overlay_details_gdi(
    hdc: HDC,
    selection: Option<RectI>,
    toolbar: Option<ToolbarLayout>,
    marks: &[Mark],
    draft: Option<Mark>,
    show_colors: bool,
    active_tool: Option<AnnotationTool>,
    active_color: AnnotationColor,
) -> Result<(), HelperError> {
    for mark in marks.iter().copied().chain(draft) {
        draw_mark_gdi(hdc, mark)?;
    }
    if let Some(selection) = selection {
        draw_selection_handles_and_size(hdc, selection)?;
    }
    if let Some(layout) = toolbar {
        draw_toolbar_icons_gdi(hdc, layout, active_tool)?;
        if show_colors {
            draw_color_choices_gdi(hdc, layout.colors, active_color)?;
        }
    }
    Ok(())
}

fn draw_mark_gdi(hdc: HDC, mark: Mark) -> Result<(), HelperError> {
    let (start, end, color, arrow) = match mark {
        Mark::Rect { start, end, color } => (start, end, color, false),
        Mark::Arrow { start, end, color } => (start, end, color, true),
    };
    let pen = unsafe { CreatePen(PS_SOLID, 3, annotation_colorref(color)) };
    if pen.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    let old_pen = unsafe { SelectObject(hdc, HGDIOBJ(pen.0)) };
    let null_brush = unsafe { GetStockObject(NULL_BRUSH) };
    let old_brush = unsafe { SelectObject(hdc, null_brush) };
    unsafe {
        if arrow {
            let _ = MoveToEx(hdc, start.x, start.y, None);
            let _ = LineTo(hdc, end.x, end.y);
            let dx = f64::from(end.x - start.x);
            let dy = f64::from(end.y - start.y);
            let length = (dx * dx + dy * dy).sqrt().max(1.0);
            let ux = dx / length;
            let uy = dy / length;
            let wing = 12.0;
            let spread = 6.0;
            for side in [-1.0, 1.0] {
                let wing_x = f64::from(end.x) - ux * wing + (-uy) * spread * side;
                let wing_y = f64::from(end.y) - uy * wing + ux * spread * side;
                let _ = MoveToEx(hdc, end.x, end.y, None);
                let _ = LineTo(hdc, wing_x.round() as i32, wing_y.round() as i32);
            }
        } else {
            let left = start.x.min(end.x);
            let top = start.y.min(end.y);
            let right = start.x.max(end.x);
            let bottom = start.y.max(end.y);
            let _ = Rectangle(hdc, left, top, right, bottom);
        }
        let _ = SelectObject(hdc, old_brush);
        let _ = SelectObject(hdc, old_pen);
        let _ = DeleteObject(HGDIOBJ(pen.0));
    }
    Ok(())
}

fn draw_selection_handles_and_size(hdc: HDC, rect: RectI) -> Result<(), HelperError> {
    let brush = unsafe { CreateSolidBrush(COLORREF(0x0096ea3e)) };
    if brush.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    let right = rect.x.saturating_add_unsigned(rect.width);
    let bottom = rect.y.saturating_add_unsigned(rect.height);
    let center_x = rect.x + i32::try_from(rect.width / 2).unwrap_or_default();
    let center_y = rect.y + i32::try_from(rect.height / 2).unwrap_or_default();
    for (x, y) in [
        (rect.x, rect.y),
        (center_x, rect.y),
        (right, rect.y),
        (right, center_y),
        (right, bottom),
        (center_x, bottom),
        (rect.x, bottom),
        (rect.x, center_y),
    ] {
        let handle = RECT {
            left: x - 4,
            top: y - 4,
            right: x + 5,
            bottom: y + 5,
        };
        unsafe { FillRect(hdc, &handle, brush) };
    }
    unsafe {
        let _ = DeleteObject(HGDIOBJ(brush.0));
        let _ = SetBkMode(hdc, TRANSPARENT);
        let _ = SetTextColor(hdc, COLORREF(0x00ffffff));
    }
    let label = format!("{} x {}", rect.width, rect.height);
    let wide: Vec<u16> = label.encode_utf16().collect();
    let text_y = if rect.y >= 22 {
        rect.y - 22
    } else {
        rect.y + 6
    };
    unsafe {
        let _ = TextOutW(hdc, rect.x, text_y, &wide);
    }
    Ok(())
}

fn draw_toolbar_icons_gdi(
    hdc: HDC,
    layout: ToolbarLayout,
    active_tool: Option<AnnotationTool>,
) -> Result<(), HelperError> {
    if active_tool == Some(AnnotationTool::Rectangle) {
        fill_gdi_rect(hdc, layout.rectangle, 0x00505055);
    } else if active_tool == Some(AnnotationTool::Arrow) {
        fill_gdi_rect(hdc, layout.arrow, 0x00505055);
    }
    let white = COLORREF(0x00ffffff);
    let pen = unsafe { CreatePen(PS_SOLID, 3, white) };
    if pen.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    let old_pen = unsafe { SelectObject(hdc, HGDIOBJ(pen.0)) };
    let null_brush = unsafe { GetStockObject(NULL_BRUSH) };
    let old_brush = unsafe { SelectObject(hdc, null_brush) };
    unsafe {
        let r = inset(layout.rectangle, 11);
        let _ = Rectangle(
            hdc,
            r.x,
            r.y,
            r.x.saturating_add_unsigned(r.width),
            r.y.saturating_add_unsigned(r.height),
        );

        let a = layout.arrow;
        let _ = MoveToEx(hdc, a.x + 10, a.y + 29, None);
        let _ = LineTo(hdc, a.x + 29, a.y + 10);
        let _ = MoveToEx(hdc, a.x + 20, a.y + 10, None);
        let _ = LineTo(hdc, a.x + 29, a.y + 10);
        let _ = LineTo(hdc, a.x + 29, a.y + 19);

        let u = layout.undo;
        let _ = MoveToEx(hdc, u.x + 28, u.y + 12, None);
        let _ = LineTo(hdc, u.x + 14, u.y + 12);
        let _ = LineTo(hdc, u.x + 9, u.y + 18);
        let _ = MoveToEx(hdc, u.x + 14, u.y + 12, None);
        let _ = LineTo(hdc, u.x + 14, u.y + 23);
        let _ = LineTo(hdc, u.x + 27, u.y + 27);

        let _ = SelectObject(hdc, old_brush);
        let _ = SelectObject(hdc, old_pen);
        let _ = DeleteObject(HGDIOBJ(pen.0));
    }
    draw_x_or_check(hdc, layout.cancel, false)?;
    draw_x_or_check(hdc, layout.confirm, true)
}

fn draw_x_or_check(hdc: HDC, rect: RectI, check: bool) -> Result<(), HelperError> {
    let color = if check { 0x0096ea3e } else { 0x005f5aff };
    let pen = unsafe { CreatePen(PS_SOLID, 4, COLORREF(color)) };
    if pen.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    let old = unsafe { SelectObject(hdc, HGDIOBJ(pen.0)) };
    unsafe {
        if check {
            let _ = MoveToEx(hdc, rect.x + 9, rect.y + 21, None);
            let _ = LineTo(hdc, rect.x + 17, rect.y + 29);
            let _ = LineTo(hdc, rect.x + 31, rect.y + 11);
        } else {
            let _ = MoveToEx(hdc, rect.x + 10, rect.y + 10, None);
            let _ = LineTo(hdc, rect.x + 30, rect.y + 30);
            let _ = MoveToEx(hdc, rect.x + 30, rect.y + 10, None);
            let _ = LineTo(hdc, rect.x + 10, rect.y + 30);
        }
        let _ = SelectObject(hdc, old);
        let _ = DeleteObject(HGDIOBJ(pen.0));
    }
    Ok(())
}

fn draw_color_choices_gdi(
    hdc: HDC,
    choices: [RectI; 4],
    active: AnnotationColor,
) -> Result<(), HelperError> {
    let colors = [
        AnnotationColor::Red,
        AnnotationColor::Yellow,
        AnnotationColor::Green,
        AnnotationColor::Blue,
    ];
    for (rect, color) in choices.into_iter().zip(colors) {
        fill_gdi_rect(hdc, rect, annotation_colorref(color).0);
        if color == active {
            let pen = unsafe { CreatePen(PS_SOLID, 2, COLORREF(0x00ffffff)) };
            if pen.is_invalid() {
                return Err(windows::core::Error::from_thread().into());
            }
            let old_pen = unsafe { SelectObject(hdc, HGDIOBJ(pen.0)) };
            let null_brush = unsafe { GetStockObject(NULL_BRUSH) };
            let old_brush = unsafe { SelectObject(hdc, null_brush) };
            unsafe {
                let _ = Rectangle(
                    hdc,
                    rect.x - 2,
                    rect.y - 2,
                    rect.x.saturating_add_unsigned(rect.width) + 2,
                    rect.y.saturating_add_unsigned(rect.height) + 2,
                );
                let _ = SelectObject(hdc, old_brush);
                let _ = SelectObject(hdc, old_pen);
                let _ = DeleteObject(HGDIOBJ(pen.0));
            }
        }
    }
    Ok(())
}

fn annotation_colorref(color: AnnotationColor) -> COLORREF {
    COLORREF(match color {
        AnnotationColor::Red => 0x004f4dff,
        AnnotationColor::Yellow => 0x003bd4ff,
        AnnotationColor::Green => 0x0096ea3e,
        AnnotationColor::Blue => 0x00ff8d4c,
    })
}

fn fill_gdi_rect(hdc: HDC, rect: RectI, color: u32) {
    let brush = unsafe { CreateSolidBrush(COLORREF(color)) };
    if brush.is_invalid() {
        return;
    }
    let raw = RECT {
        left: rect.x,
        top: rect.y,
        right: rect.x.saturating_add_unsigned(rect.width),
        bottom: rect.y.saturating_add_unsigned(rect.height),
    };
    unsafe {
        FillRect(hdc, &raw, brush);
        let _ = DeleteObject(HGDIOBJ(brush.0));
    }
}

fn inset(rect: RectI, amount: u32) -> RectI {
    RectI {
        x: rect.x.saturating_add_unsigned(amount),
        y: rect.y.saturating_add_unsigned(amount),
        width: rect.width.saturating_sub(amount * 2),
        height: rect.height.saturating_sub(amount * 2),
    }
}

fn draw_toolbar_gdi(hdc: HDC, layout: ToolbarLayout) -> Result<(), HelperError> {
    let fill = |hdc: HDC, rect: RectI, color: u32| {
        let brush = unsafe { CreateSolidBrush(COLORREF(color)) };
        if brush.is_invalid() {
            return;
        }
        let r = RECT {
            left: rect.x,
            top: rect.y,
            right: rect.x.saturating_add_unsigned(rect.width),
            bottom: rect.y.saturating_add_unsigned(rect.height),
        };
        unsafe {
            FillRect(hdc, &r, brush);
            let _ = DeleteObject(HGDIOBJ(brush.0));
        }
    };
    fill(hdc, layout.toolbar, 0x00202024);
    Ok(())
}

/// Residual paint entry used when no renderer is attached (should be rare).
pub(crate) fn paint_hdc(
    hdc: HDC,
    selection: Option<RectI>,
    display: &DisplayInfo,
) -> Result<(), HelperError> {
    paint_gdi_on_hdc(hdc, None, selection, display, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_frame(width: u32, height: u32) -> CpuBgraFrame {
        let pitch = width * 4;
        CpuBgraFrame {
            width,
            height,
            pitch,
            pixels: vec![0u8; (pitch * height) as usize],
        }
    }

    #[test]
    fn upload_count_increments_per_upload_and_survives_clear() {
        let mut renderer = OverlayRenderer::new().expect("OverlayRenderer::new");
        assert_eq!(renderer.upload_count, 0);

        let frame = sample_frame(8, 8);
        renderer
            .upload_frozen(&frame)
            .expect("first upload_frozen must succeed under an interactive session");
        assert_eq!(renderer.upload_count, 1);

        renderer
            .upload_frozen(&frame)
            .expect("second upload replaces the cache");
        assert_eq!(renderer.upload_count, 2);

        renderer.clear_frozen();
        // clear drops the GDI cache (Drop path) but does not reset the counter.
        assert_eq!(renderer.upload_count, 2);
        assert!(renderer.gdi_cache.is_none());
    }

    #[test]
    fn gdi_frame_cache_drop_releases_without_panic() {
        let frame = sample_frame(4, 4);
        let cache = create_gdi_frame_cache(&frame).expect("create_gdi_frame_cache");
        // Explicit drop exercises GdiFrameCache::drop (SelectObject + Delete*).
        drop(cache);
    }

    #[test]
    fn gdi_frame_cache_uses_a_separate_composition_surface() {
        let frame = sample_frame(8, 8);
        let cache = create_gdi_frame_cache(&frame).expect("create_gdi_frame_cache");

        assert_ne!(
            cache.mem_dc,
            cache.composition_hdc(),
            "drawing directly into the frozen source would expose intermediate frames"
        );
    }

    #[test]
    fn gdi_selection_extracts_pixels_from_the_frozen_frame() {
        let width = 4;
        let height = 3;
        let pitch = width * 4;
        let mut pixels = Vec::with_capacity((pitch * height) as usize);
        for y in 0..height {
            for x in 0..width {
                pixels.extend_from_slice(&[
                    (10 + x) as u8,
                    (20 + y) as u8,
                    (30 + x + y) as u8,
                    255,
                ]);
            }
        }
        let frame = CpuBgraFrame {
            width,
            height,
            pitch,
            pixels,
        };
        let mut renderer = OverlayRenderer::new().expect("OverlayRenderer::new");
        renderer
            .upload_frozen(&frame)
            .expect("upload_frozen must cache the source pixels");

        let selection = renderer
            .extract_selection(
                RectI {
                    x: 1,
                    y: 1,
                    width: 2,
                    height: 2,
                },
                None,
            )
            .expect("extract_selection must succeed");

        assert_eq!(
            selection.pixels,
            vec![
                11, 21, 32, 255, 12, 21, 33, 255, // source row y=1
                11, 22, 33, 255, 12, 22, 34, 255, // source row y=2
            ],
            "selection pixels must come from the requested frozen-frame rectangle"
        );
    }

    #[test]
    fn toolbar_contains_five_buttons_in_required_order() {
        let display = DisplayInfo {
            bounds: RectI {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
            },
            dpi: 96.0,
            rotation: crate::geometry::DisplayRotation::Identity,
            is_primary: true,
        };
        let layout = compute_toolbar(
            RectI {
                x: 100,
                y: 100,
                width: 400,
                height: 300,
            },
            &display,
        )
        .expect("toolbar");

        assert!(layout.rectangle.x < layout.arrow.x);
        assert!(layout.arrow.x < layout.undo.x);
        assert!(layout.undo.x < layout.cancel.x);
        assert!(layout.cancel.x < layout.confirm.x);
        assert_eq!(layout.colors.len(), 4);
    }

    #[test]
    fn burning_a_mark_changes_pixels_relative_to_the_selection() {
        let mut frame = sample_frame(20, 20);
        burn_annotations(
            &mut frame,
            &[Mark::Rect {
                start: crate::geometry::PointI { x: 12, y: 13 },
                end: crate::geometry::PointI { x: 18, y: 17 },
                color: AnnotationColor::Red,
            }],
            crate::geometry::PointI { x: 10, y: 10 },
        );

        let offset = ((3 * frame.pitch) + 2 * 4) as usize;
        assert_eq!(&frame.pixels[offset..offset + 4], &[0x4f, 0x4d, 0xff, 0xff]);
    }

    #[test]
    fn dim_regions_cover_only_the_area_outside_the_selection() {
        let regions = dim_regions(
            100,
            80,
            Some(RectI {
                x: 20,
                y: 10,
                width: 40,
                height: 30,
            }),
        );

        assert_eq!(
            regions,
            vec![
                RectI {
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 10,
                },
                RectI {
                    x: 0,
                    y: 40,
                    width: 100,
                    height: 40,
                },
                RectI {
                    x: 0,
                    y: 10,
                    width: 20,
                    height: 30,
                },
                RectI {
                    x: 60,
                    y: 10,
                    width: 40,
                    height: 30,
                },
            ]
        );
    }

    #[test]
    fn diagonal_annotations_blend_edge_pixels_for_antialiasing() {
        let mut frame = sample_frame(24, 24);
        burn_annotations(
            &mut frame,
            &[Mark::Arrow {
                start: crate::geometry::PointI { x: 2, y: 3 },
                end: crate::geometry::PointI { x: 20, y: 15 },
                color: AnnotationColor::Red,
            }],
            crate::geometry::PointI { x: 0, y: 0 },
        );

        assert!(
            frame
                .pixels
                .chunks_exact(4)
                .any(|pixel| pixel[2] > 0 && pixel[2] < 0xff),
            "a diagonal edge should contain partially covered pixels"
        );
    }
}
