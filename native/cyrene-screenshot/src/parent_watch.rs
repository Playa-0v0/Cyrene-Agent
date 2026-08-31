use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    thread,
};

use windows::Win32::{
    Foundation::{HANDLE, WAIT_OBJECT_0},
    System::Threading::{INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
};

use crate::{WM_APP_SHUTDOWN, ipc::MessageTarget};

pub fn start(parent_pid: u32, target: MessageTarget) {
    // Open synchronously so a ready event is never published before the watcher
    // owns a live-parent handle.
    let handle = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, parent_pid) } {
        Ok(handle) => handle,
        Err(error) => {
            eprintln!("parent watcher could not open PID {parent_pid}: {error}");
            return;
        }
    };
    // SAFETY: OpenProcess returned a newly owned HANDLE. OwnedHandle closes it
    // exactly once when the detached watcher ends or the process terminates.
    let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };

    thread::Builder::new()
        .name("cyrene-parent-watch".into())
        .spawn(move || {
            let raw_handle = HANDLE(handle.as_raw_handle());
            // SAFETY: raw_handle remains valid because handle stays owned by this
            // closure for the entire wait.
            let wait_result = unsafe { WaitForSingleObject(raw_handle, INFINITE) };
            if wait_result == WAIT_OBJECT_0 {
                let _ = target.post(WM_APP_SHUTDOWN);
            } else {
                eprintln!("parent watcher wait failed with result {wait_result:?}");
            }
        })
        .expect("failed to start parent watcher");
}
