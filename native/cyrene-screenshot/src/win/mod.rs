//! Windows-specific capture and display backend.
//!
//! This module is the only place in the helper that talks directly to the
//! Win32 graphics APIs for the purpose of freezing the primary display:
//!
//!   * [`display`] establishes DPI awareness and queries the primary monitor.
//!   * [`capture`] defines the [`FrozenFrame`] / [`CaptureBackend`] abstraction
//!     that the rest of the helper consumes.
//!   * [`capture_dxgi`] implements [`CaptureBackend`] using DXGI Desktop
//!     Duplication. This is the **primary** capture path on a healthy
//!     desktop.
//!   * [`capture_gdi`] implements [`CaptureBackend`] using GDI bitblt into a
//!     32-bit top-down DIB. This is the documented fallback when DXGI init
//!     fails or when the cursor is composited into the desktop.
//!
//! The overlay window (with its input state machine), the Direct2D draw path,
//! and the clipboard / encoder wiring live in the remaining `win` modules.

#![cfg(windows)]

pub mod capture;
pub mod capture_dxgi;
pub mod capture_gdi;
pub mod clipboard;
pub mod display;
pub mod encoder;
pub mod renderer;
pub mod window;
