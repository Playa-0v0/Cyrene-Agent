//! Native Win32 overlay window and input state machine.

use std::{cell::RefCell, ptr::NonNull};

use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::{
            Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
            Gdi::{BeginPaint, EndPaint, InvalidateRect, PAINTSTRUCT},
        },
        UI::{
            Input::KeyboardAndMouse::{
                GetKeyState, ReleaseCapture, SetCapture, SetFocus, VK_CONTROL, VK_ESCAPE,
                VK_RETURN, VK_Z,
            },
            WindowsAndMessaging::{
                CREATESTRUCTW, CS_DBLCLKS, CreateWindowExW, DefWindowProcW, DestroyWindow,
                GW_HWNDNEXT, GWLP_USERDATA, GetClassNameW, GetClientRect, GetWindow,
                GetWindowLongPtrW, GetWindowRect, IDC_CROSS, IsIconic, IsWindowVisible,
                LoadCursorW, RegisterClassW, SW_HIDE, SW_SHOW, SWP_NOACTIVATE, SWP_NOOWNERZORDER,
                SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, ShowWindow, UnregisterClassW,
                WM_CAPTURECHANGED, WM_COMMAND, WM_CREATE, WM_DESTROY, WM_DISPLAYCHANGE,
                WM_DPICHANGED, WM_KEYDOWN, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
                WM_MOUSEMOVE, WM_NCDESTROY, WM_PAINT, WM_RBUTTONDOWN, WNDCLASSW, WS_EX_TOOLWINDOW,
                WS_EX_TOPMOST, WS_POPUP,
            },
        },
    },
    core::{Error as WindowsError, PCWSTR, w},
};

use crate::{
    error::HelperError,
    geometry::{
        AnnotationColor, AnnotationState, AnnotationTool, Mark, PointI, RectI, SelectionHandle,
        hit_test_selection_handle, localize_window_rect, resize_selection,
    },
    win::{
        display::DisplayInfo,
        renderer::{OverlayRenderer, ToolbarLayout, compute_toolbar},
    },
};

const WINDOW_CLASS: PCWSTR = w!("CyreneScreenshotOverlayWindow");

/// Confirm button id reserved for `WM_COMMAND`.
pub const CMD_CONFIRM: usize = 1;
/// Cancel button id reserved for `WM_COMMAND`.
pub const CMD_CANCEL: usize = 2;

pub const TOOLBAR_WIDTH: u32 = 232;
pub const TOOLBAR_HEIGHT: u32 = 40;
pub const TOOLBAR_GAP: u32 = 8;
pub const TOOLBAR_BUTTON_GAP: u32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayAction {
    Selected,
    Commit,
    Cancel,
    /// Display topology or DPI changed while the overlay was active.
    DisplayChanged,
}

#[derive(Debug, Clone, Copy)]
enum InputState {
    Idle,
    Selecting {
        anchor: POINT,
        candidate: Option<RectI>,
    },
    Resizing {
        handle: SelectionHandle,
        original: RectI,
    },
    Drawing {
        start: PointI,
    },
    Selected,
}

struct WindowState {
    display_bounds: RectI,
    display_dpi: f32,
    selection: Option<RectI>,
    toolbar: Option<ToolbarLayout>,
    annotations: AnnotationState,
    draft: Option<Mark>,
    show_colors: bool,
    input: InputState,
    action: Option<OverlayAction>,
    /// Synchronous WM_PAINT failure captured for `present_first_frame`.
    /// Storing text avoids requiring the Win32/COM error types to be Clone.
    paint_error: Option<String>,
    /// Non-owning pointer to the active [`OverlayRenderer`]. Set by
    /// [`OverlayWindow::attach_renderer`] for the duration of a capture and
    /// cleared on hide. Used by WM_PAINT / mouse-move repaints so the frozen
    /// frame cache is reused without re-upload.
    renderer: Option<NonNull<OverlayRenderer>>,
}

pub struct OverlayWindow {
    hwnd: HWND,
    state: NonNull<RefCell<WindowState>>,
}

impl OverlayWindow {
    pub fn create(display: &DisplayInfo) -> Result<Self, HelperError> {
        let cursor = unsafe { LoadCursorW(None, IDC_CROSS) }?;
        let window_class = WNDCLASSW {
            style: CS_DBLCLKS,
            lpfnWndProc: Some(window_proc),
            hCursor: cursor,
            lpszClassName: WINDOW_CLASS,
            ..Default::default()
        };
        if unsafe { RegisterClassW(&window_class) } == 0 {
            let error = WindowsError::from_thread();
            if error.code().0 != 0x8007_0582u32 as i32 {
                return Err(error.into());
            }
        }

        let state = Box::new(RefCell::new(WindowState {
            display_bounds: display.bounds,
            display_dpi: display.dpi,
            selection: None,
            toolbar: None,
            annotations: AnnotationState::default(),
            draft: None,
            show_colors: false,
            input: InputState::Idle,
            action: None,
            paint_error: None,
            renderer: None,
        }));
        let state = NonNull::new(Box::into_raw(state)).expect("Box pointer is never null");
        let bounds = display.bounds;
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                WINDOW_CLASS,
                w!(""),
                WS_POPUP,
                bounds.x,
                bounds.y,
                i32::try_from(bounds.width).map_err(|_| {
                    HelperError::InvalidDisplay("overlay width does not fit in i32".into())
                })?,
                i32::try_from(bounds.height).map_err(|_| {
                    HelperError::InvalidDisplay("overlay height does not fit in i32".into())
                })?,
                None,
                None,
                None,
                Some(state.as_ptr().cast()),
            )
        };
        match hwnd {
            Ok(hwnd) => Ok(Self { hwnd, state }),
            Err(error) => {
                unsafe { drop(Box::from_raw(state.as_ptr())) };
                let _ = unsafe { UnregisterClassW(WINDOW_CLASS, None) };
                Err(error.into())
            }
        }
    }

    /// Bind a live [`OverlayRenderer`] for paint callbacks. The pointer must
    /// remain valid until [`Self::detach_renderer`] or [`Self::hide`].
    pub fn attach_renderer(&self, renderer: &mut OverlayRenderer) {
        let mut state = unsafe { self.state.as_ref() }.borrow_mut();
        state.paint_error = None;
        state.renderer = NonNull::new(renderer as *mut OverlayRenderer);
    }

    pub fn detach_renderer(&self) {
        unsafe { self.state.as_ref() }.borrow_mut().renderer = None;
    }

    pub fn show(&self, display: &DisplayInfo) -> Result<(), HelperError> {
        self.set_fullscreen_bounds(display)?;
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_SHOW);
            let _ = SetForegroundWindow(self.hwnd);
            let _ = SetFocus(Some(self.hwnd));
        }
        Ok(())
    }

    pub fn hide(&self) -> Result<(), HelperError> {
        let _ = unsafe { ShowWindow(self.hwnd, SW_HIDE) };
        let mut state = unsafe { self.state.as_ref() }.borrow_mut();
        state.selection = None;
        state.toolbar = None;
        state.annotations = AnnotationState::default();
        state.draft = None;
        state.show_colors = false;
        state.input = InputState::Idle;
        state.action = None;
        state.paint_error = None;
        state.renderer = None;
        Ok(())
    }

    pub fn set_fullscreen_bounds(&self, display: &DisplayInfo) -> Result<(), HelperError> {
        let width = i32::try_from(display.bounds.width)
            .map_err(|_| HelperError::InvalidDisplay("overlay width does not fit in i32".into()))?;
        let height = i32::try_from(display.bounds.height).map_err(|_| {
            HelperError::InvalidDisplay("overlay height does not fit in i32".into())
        })?;
        unsafe {
            SetWindowPos(
                self.hwnd,
                Some(HWND_TOPMOST),
                display.bounds.x,
                display.bounds.y,
                width,
                height,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            )?;
        }
        let mut state = unsafe { self.state.as_ref() }.borrow_mut();
        state.display_bounds = display.bounds;
        state.display_dpi = display.dpi;
        Ok(())
    }

    pub fn is_visible(&self) -> bool {
        unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(self.hwnd).as_bool() }
    }

    pub fn take_action(&self) -> Option<OverlayAction> {
        unsafe { self.state.as_ref() }.borrow_mut().action.take()
    }

    pub fn take_paint_error(&self) -> Option<HelperError> {
        unsafe { self.state.as_ref() }
            .borrow_mut()
            .paint_error
            .take()
            .map(HelperError::CaptureFailed)
    }

    pub fn selection(&self) -> Option<RectI> {
        unsafe { self.state.as_ref() }.borrow().selection
    }

    pub fn toolbar(&self) -> Option<ToolbarLayout> {
        unsafe { self.state.as_ref() }.borrow().toolbar
    }

    pub fn annotations(&self) -> Vec<Mark> {
        unsafe { self.state.as_ref() }
            .borrow()
            .annotations
            .marks()
            .to_vec()
    }

    pub fn hwnd(&self) -> HWND {
        self.hwnd
    }
}

impl Drop for OverlayWindow {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.hwnd) };
        unsafe { drop(Box::from_raw(self.state.as_ptr())) };
        let _ = unsafe { UnregisterClassW(WINDOW_CLASS, None) };
    }
}

const HWND_TOPMOST: HWND = HWND(-1isize as *mut _);

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_CREATE {
        let create = unsafe { &*(lparam.0 as *const CREATESTRUCTW) };
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize) };
        return LRESULT(0);
    }

    let raw = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut RefCell<WindowState>;
    if raw.is_null() {
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }

    match message {
        WM_LBUTTONDOWN => {
            let point = clamp_client_point(hwnd, point_from_lparam(lparam));
            let mut state = unsafe { &*raw }.borrow_mut();
            if matches!(state.input, InputState::Selected)
                && let Some(toolbar) = state.toolbar
            {
                if contains(toolbar.rectangle, point) {
                    state.annotations.tool = Some(AnnotationTool::Rectangle);
                    state.show_colors = true;
                    let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
                    return LRESULT(0);
                }
                if contains(toolbar.arrow, point) {
                    state.annotations.tool = Some(AnnotationTool::Arrow);
                    state.show_colors = true;
                    let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
                    return LRESULT(0);
                }
                if contains(toolbar.undo, point) {
                    state.annotations.undo();
                    let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
                    return LRESULT(0);
                }
                if contains(toolbar.confirm, point) {
                    state.action = Some(OverlayAction::Commit);
                    return LRESULT(0);
                }
                if contains(toolbar.cancel, point) {
                    state.action = Some(OverlayAction::Cancel);
                    return LRESULT(0);
                }
                if state.show_colors
                    && let Some(index) = toolbar
                        .colors
                        .iter()
                        .position(|rect| contains(*rect, point))
                {
                    state.annotations.color = annotation_color(index);
                    state.show_colors = false;
                    let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
                    return LRESULT(0);
                }
            }
            if matches!(state.input, InputState::Selected)
                && let Some(selection) = state.selection
            {
                let point_i = PointI {
                    x: point.x,
                    y: point.y,
                };
                if let Some(handle) = hit_test_selection_handle(selection, point_i, 10) {
                    state.annotations.clear();
                    state.draft = None;
                    state.show_colors = false;
                    state.toolbar = None;
                    state.input = InputState::Resizing {
                        handle,
                        original: selection,
                    };
                    drop(state);
                    unsafe { SetCapture(hwnd) };
                    return LRESULT(0);
                }
                if state.annotations.tool.is_some() && contains(selection, point) {
                    state.draft = make_mark(
                        state.annotations.tool,
                        point_i,
                        point_i,
                        state.annotations.color,
                    );
                    state.input = InputState::Drawing { start: point_i };
                    drop(state);
                    unsafe { SetCapture(hwnd) };
                    return LRESULT(0);
                }
            }
            let candidate = find_top_level_window_at_point(hwnd, point, state.display_bounds);
            state.annotations.clear();
            state.draft = None;
            state.show_colors = false;
            state.toolbar = None;
            state.input = InputState::Selecting {
                anchor: point,
                candidate,
            };
            drop(state);
            unsafe { SetCapture(hwnd) };
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let point = clamp_client_point(hwnd, point_from_lparam(lparam));
            let mut state = unsafe { &*raw }.borrow_mut();
            let input = state.input;
            let previous_selection = state.selection;
            let previous_toolbar = state.toolbar;
            let previous_draft = state.draft;
            match state.input {
                InputState::Idle => {
                    state.selection =
                        find_top_level_window_at_point(hwnd, point, state.display_bounds);
                }
                InputState::Selecting { anchor, candidate } => {
                    state.selection = if drag_distance(anchor, point) >= 4 {
                        normalized_rect(anchor, point)
                    } else {
                        candidate
                    };
                    state.toolbar = None;
                }
                InputState::Resizing { handle, original } => {
                    let bounds = RectI {
                        x: 0,
                        y: 0,
                        width: state.display_bounds.width,
                        height: state.display_bounds.height,
                    };
                    if let Some(selection) = resize_selection(
                        original,
                        handle,
                        PointI {
                            x: point.x,
                            y: point.y,
                        },
                        bounds,
                        4,
                    ) {
                        state.selection = Some(selection);
                    }
                }
                InputState::Drawing { start } => {
                    if let Some(selection) = state.selection {
                        let end = clamp_point_to_rect(
                            PointI {
                                x: point.x,
                                y: point.y,
                            },
                            selection,
                        );
                        state.draft =
                            make_mark(state.annotations.tool, start, end, state.annotations.color);
                    }
                }
                InputState::Selected => {}
            }
            let visual_changed = state.selection != previous_selection
                || state.toolbar != previous_toolbar
                || state.draft != previous_draft;
            let dirty_region = if matches!(input, InputState::Drawing { .. }) {
                draft_repaint_region(
                    previous_draft,
                    state.draft,
                    RectI {
                        x: 0,
                        y: 0,
                        width: state.display_bounds.width,
                        height: state.display_bounds.height,
                    },
                    16,
                )
            } else {
                None
            };
            let repaint = mouse_move_requires_repaint(&input, visual_changed);
            drop(state);
            if repaint {
                if let Some(region) = dirty_region {
                    let dirty = RECT {
                        left: region.x,
                        top: region.y,
                        right: region.x.saturating_add_unsigned(region.width),
                        bottom: region.y.saturating_add_unsigned(region.height),
                    };
                    let _ = unsafe { InvalidateRect(Some(hwnd), Some(&dirty), false) };
                } else {
                    let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
                }
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let selected = {
                let mut state = unsafe { &*raw }.borrow_mut();
                let mut selected = false;
                let point = clamp_client_point(hwnd, point_from_lparam(lparam));
                match state.input {
                    InputState::Selecting { anchor, candidate } => {
                        let selection = if drag_distance(anchor, point) >= 4 {
                            normalized_rect(anchor, point)
                        } else {
                            candidate
                        }
                        .filter(|rect| rect.width >= 4 && rect.height >= 4);
                        state.selection = selection;
                        if let Some(sel) = selection {
                            state.toolbar = toolbar_for_state(&state, sel);
                            state.input = InputState::Selected;
                            state.action = Some(OverlayAction::Selected);
                            selected = true;
                        } else {
                            state.toolbar = None;
                            state.input = InputState::Idle;
                        }
                    }
                    InputState::Resizing { .. } => {
                        if let Some(sel) = state.selection {
                            state.toolbar = toolbar_for_state(&state, sel);
                            state.input = InputState::Selected;
                            state.action = Some(OverlayAction::Selected);
                            selected = true;
                        }
                    }
                    InputState::Drawing { .. } => {
                        if let Some(mark) = state.draft.take()
                            && mark_size(mark) >= 4
                        {
                            state.annotations.push(mark);
                        }
                        state.input = InputState::Selected;
                        selected = true;
                    }
                    InputState::Idle | InputState::Selected => {}
                }
                selected
            };
            let _ = unsafe { ReleaseCapture() };
            if selected {
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            }
            LRESULT(0)
        }
        WM_RBUTTONDOWN => {
            let point = clamp_client_point(hwnd, point_from_lparam(lparam));
            let mut state = unsafe { &*raw }.borrow_mut();
            if state
                .toolbar
                .is_some_and(|toolbar| contains(toolbar.undo, point))
            {
                state.annotations.clear();
                state.draft = None;
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            }
            LRESULT(0)
        }
        WM_LBUTTONDBLCLK => {
            let mut state = unsafe { &*raw }.borrow_mut();
            if state
                .selection
                .is_some_and(|rect| contains(rect, point_from_lparam(lparam)))
            {
                state.action = Some(OverlayAction::Commit);
            }
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 == VK_ESCAPE.0 as usize => {
            unsafe { &*raw }.borrow_mut().action = Some(OverlayAction::Cancel);
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 == VK_RETURN.0 as usize => {
            let mut state = unsafe { &*raw }.borrow_mut();
            if state.selection.is_some() {
                state.action = Some(OverlayAction::Commit);
            }
            LRESULT(0)
        }
        WM_KEYDOWN
            if wparam.0 == VK_Z.0 as usize && unsafe { GetKeyState(VK_CONTROL.0 as i32) } < 0 =>
        {
            let mut state = unsafe { &*raw }.borrow_mut();
            state.annotations.undo();
            state.draft = None;
            let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            LRESULT(0)
        }
        WM_COMMAND => {
            let command = wparam.0 & 0xffff;
            let mut state = unsafe { &*raw }.borrow_mut();
            if command == CMD_CONFIRM && state.selection.is_some() {
                state.action = Some(OverlayAction::Commit);
            } else if command == CMD_CANCEL {
                state.action = Some(OverlayAction::Cancel);
            }
            LRESULT(0)
        }
        WM_DISPLAYCHANGE | WM_DPICHANGED => {
            // Surface when the overlay is visible so an active capture aborts.
            // The app layer only acts if `active` is Some, so a broadcast while
            // the window is hidden is a no-op after take_action.
            if unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd).as_bool() } {
                unsafe { &*raw }.borrow_mut().action = Some(OverlayAction::DisplayChanged);
            }
            LRESULT(0)
        }
        WM_CAPTURECHANGED => {
            let mut state = unsafe { &*raw }.borrow_mut();
            if matches!(
                state.input,
                InputState::Selecting { .. }
                    | InputState::Resizing { .. }
                    | InputState::Drawing { .. }
            ) {
                state.input = InputState::Idle;
                state.draft = None;
            }
            LRESULT(0)
        }
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let hdc = unsafe { BeginPaint(hwnd, &mut paint) };
            {
                let mut state = unsafe { &*raw }.borrow_mut();
                let display = DisplayInfo {
                    bounds: state.display_bounds,
                    dpi: state.display_dpi,
                    rotation: crate::geometry::DisplayRotation::Identity,
                    is_primary: true,
                };
                if let Some(renderer_ptr) = state.renderer {
                    // SAFETY: attach_renderer guarantees the renderer outlives
                    // the attached period; hide/detach clear this pointer first.
                    // Shared borrow only: paint_on_hdc reads the frozen cache and
                    // does not mutate OverlayRenderer, so this is safe even if a
                    // caller briefly holds &OverlayRenderer on the same thread
                    // (present_first_frame intentionally holds none across UpdateWindow).
                    let renderer = unsafe { &*renderer_ptr.as_ptr() };
                    if let Err(error) = renderer.paint_on_hdc(
                        hdc,
                        hwnd,
                        state.selection,
                        &display,
                        state.toolbar,
                        state.annotations.marks(),
                        state.draft,
                        state.show_colors,
                        state.annotations.tool,
                        state.annotations.color,
                    ) {
                        eprintln!("cyrene-screenshot: overlay paint failed: {error}");
                        state.paint_error = Some(error.to_string());
                    }
                } else {
                    let _ = crate::win::renderer::paint_hdc(hdc, state.selection, &display);
                }
            }
            let _ = unsafe { EndPaint(hwnd, &paint) };
            LRESULT(0)
        }
        WM_NCDESTROY | WM_DESTROY => {
            unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) };
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

fn point_from_lparam(lparam: LPARAM) -> POINT {
    POINT {
        x: (lparam.0 as u16) as i16 as i32,
        y: ((lparam.0 as u32 >> 16) as u16) as i16 as i32,
    }
}

fn clamp_client_point(hwnd: HWND, point: POINT) -> POINT {
    let mut client = RECT::default();
    let _ = unsafe { GetClientRect(hwnd, &mut client) };
    POINT {
        x: point.x.clamp(client.left, client.right),
        y: point.y.clamp(client.top, client.bottom),
    }
}

fn normalized_rect(a: POINT, b: POINT) -> Option<RectI> {
    let left = a.x.min(b.x);
    let top = a.y.min(b.y);
    let width = u32::try_from((i64::from(a.x) - i64::from(b.x)).abs()).ok()?;
    let height = u32::try_from((i64::from(a.y) - i64::from(b.y)).abs()).ok()?;
    Some(RectI {
        x: left,
        y: top,
        width,
        height,
    })
}

fn contains(rect: RectI, point: POINT) -> bool {
    i64::from(point.x) >= i64::from(rect.x)
        && i64::from(point.y) >= i64::from(rect.y)
        && i64::from(point.x) < i64::from(rect.x) + i64::from(rect.width)
        && i64::from(point.y) < i64::from(rect.y) + i64::from(rect.height)
}

fn toolbar_for_state(state: &WindowState, selection: RectI) -> Option<ToolbarLayout> {
    compute_toolbar(
        selection,
        &DisplayInfo {
            bounds: state.display_bounds,
            dpi: state.display_dpi,
            rotation: crate::geometry::DisplayRotation::Identity,
            is_primary: true,
        },
    )
}

fn annotation_color(index: usize) -> AnnotationColor {
    match index {
        1 => AnnotationColor::Yellow,
        2 => AnnotationColor::Green,
        3 => AnnotationColor::Blue,
        _ => AnnotationColor::Red,
    }
}

fn make_mark(
    tool: Option<AnnotationTool>,
    start: PointI,
    end: PointI,
    color: AnnotationColor,
) -> Option<Mark> {
    match tool {
        Some(AnnotationTool::Rectangle) => Some(Mark::Rect { start, end, color }),
        Some(AnnotationTool::Arrow) => Some(Mark::Arrow { start, end, color }),
        None => None,
    }
}

fn mark_size(mark: Mark) -> i32 {
    let (start, end) = match mark {
        Mark::Rect { start, end, .. } | Mark::Arrow { start, end, .. } => (start, end),
    };
    (start.x - end.x).abs().max((start.y - end.y).abs())
}

fn clamp_point_to_rect(point: PointI, rect: RectI) -> PointI {
    PointI {
        x: point
            .x
            .clamp(rect.x, rect.x.saturating_add_unsigned(rect.width)),
        y: point
            .y
            .clamp(rect.y, rect.y.saturating_add_unsigned(rect.height)),
    }
}

fn drag_distance(a: POINT, b: POINT) -> i32 {
    (a.x - b.x).abs().max((a.y - b.y).abs())
}

fn mouse_move_requires_repaint(input: &InputState, visual_changed: bool) -> bool {
    match input {
        InputState::Idle | InputState::Selected => visual_changed,
        InputState::Drawing { .. } => visual_changed,
        InputState::Selecting { .. } | InputState::Resizing { .. } => true,
    }
}

fn draft_repaint_region(
    previous: Option<Mark>,
    current: Option<Mark>,
    bounds: RectI,
    padding: i32,
) -> Option<RectI> {
    let mut marks = previous.into_iter().chain(current);
    let first = marks.next()?;
    let (mut left, mut top, mut right, mut bottom) = mark_bounds(first);
    for mark in marks {
        let (mark_left, mark_top, mark_right, mark_bottom) = mark_bounds(mark);
        left = left.min(mark_left);
        top = top.min(mark_top);
        right = right.max(mark_right);
        bottom = bottom.max(mark_bottom);
    }
    let bounds_right = bounds.x.saturating_add_unsigned(bounds.width);
    let bounds_bottom = bounds.y.saturating_add_unsigned(bounds.height);
    left = left.saturating_sub(padding).clamp(bounds.x, bounds_right);
    top = top.saturating_sub(padding).clamp(bounds.y, bounds_bottom);
    right = right.saturating_add(padding).clamp(bounds.x, bounds_right);
    bottom = bottom
        .saturating_add(padding)
        .clamp(bounds.y, bounds_bottom);
    (right > left && bottom > top).then_some(RectI {
        x: left,
        y: top,
        width: u32::try_from(right - left).ok()?,
        height: u32::try_from(bottom - top).ok()?,
    })
}

fn mark_bounds(mark: Mark) -> (i32, i32, i32, i32) {
    let (start, end) = match mark {
        Mark::Rect { start, end, .. } | Mark::Arrow { start, end, .. } => (start, end),
    };
    (
        start.x.min(end.x),
        start.y.min(end.y),
        start.x.max(end.x),
        start.y.max(end.y),
    )
}

fn find_top_level_window_at_point(
    overlay: HWND,
    client_point: POINT,
    display_bounds: RectI,
) -> Option<RectI> {
    let screen_point = PointI {
        x: client_point.x.checked_add(display_bounds.x)?,
        y: client_point.y.checked_add(display_bounds.y)?,
    };
    let mut candidate = unsafe { GetWindow(overlay, GW_HWNDNEXT) }.ok()?;
    loop {
        if unsafe { IsWindowVisible(candidate).as_bool() }
            && !unsafe { IsIconic(candidate).as_bool() }
            && !is_shell_window(candidate)
            && !is_cloaked(candidate)
            && let Some(rect) = visible_window_rect(candidate)
            && point_in_screen_rect(rect, screen_point)
        {
            return localize_window_rect(rect, display_bounds);
        }
        candidate = match unsafe { GetWindow(candidate, GW_HWNDNEXT) } {
            Ok(next) => next,
            Err(_) => return None,
        };
    }
}

fn visible_window_rect(hwnd: HWND) -> Option<RectI> {
    let mut rect = RECT::default();
    let dwm_result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut rect as *mut RECT).cast(),
            u32::try_from(std::mem::size_of::<RECT>()).ok()?,
        )
    };
    if dwm_result.is_err() {
        unsafe { GetWindowRect(hwnd, &mut rect) }.ok()?;
    }
    let width = u32::try_from(i64::from(rect.right) - i64::from(rect.left)).ok()?;
    let height = u32::try_from(i64::from(rect.bottom) - i64::from(rect.top)).ok()?;
    (width > 0 && height > 0).then_some(RectI {
        x: rect.left,
        y: rect.top,
        width,
        height,
    })
}

fn point_in_screen_rect(rect: RectI, point: PointI) -> bool {
    i64::from(point.x) >= i64::from(rect.x)
        && i64::from(point.y) >= i64::from(rect.y)
        && i64::from(point.x) < i64::from(rect.x) + i64::from(rect.width)
        && i64::from(point.y) < i64::from(rect.y) + i64::from(rect.height)
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&mut cloaked as *mut u32).cast(),
            u32::try_from(std::mem::size_of::<u32>()).unwrap_or(4),
        )
    }
    .is_ok()
        && cloaked != 0
}

fn is_shell_window(hwnd: HWND) -> bool {
    let mut buffer = [0u16; 64];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    if length <= 0 {
        return false;
    }
    matches!(
        String::from_utf16_lossy(&buffer[..length as usize]).as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_mouse_move_without_visual_change_does_not_request_repaint() {
        assert!(!mouse_move_requires_repaint(&InputState::Selected, false));
    }

    #[test]
    fn drawing_repaint_region_covers_previous_and_current_marks_only() {
        let previous = Mark::Rect {
            start: PointI { x: 30, y: 30 },
            end: PointI { x: 40, y: 40 },
            color: AnnotationColor::Red,
        };
        let current = Mark::Arrow {
            start: PointI { x: 30, y: 30 },
            end: PointI { x: 60, y: 50 },
            color: AnnotationColor::Red,
        };

        assert_eq!(
            draft_repaint_region(
                Some(previous),
                Some(current),
                RectI {
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 80,
                },
                16,
            ),
            Some(RectI {
                x: 14,
                y: 14,
                width: 62,
                height: 52,
            })
        );
    }
}
