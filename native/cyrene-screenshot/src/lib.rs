pub mod app;
pub mod cli;
pub mod error;
pub mod geometry;
pub mod ipc;
pub mod parent_watch;
pub mod protocol;
pub mod request;
pub mod win;

pub const WM_APP_COMMAND: u32 = windows::Win32::UI::WindowsAndMessaging::WM_APP + 1;
pub const WM_APP_SHUTDOWN: u32 = windows::Win32::UI::WindowsAndMessaging::WM_APP + 2;
