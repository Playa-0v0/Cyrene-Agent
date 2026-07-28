use std::collections::{HashMap, HashSet};

use crate::protocol::CaptureMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureInteractionState {
    Idle,
    Freezing,
    Selecting,
    Selected,
    Committing,
    Cancelling,
}

#[derive(Debug, thiserror::Error)]
pub enum RequestError {
    #[error("request is already pending: {0}")]
    AlreadyPending(String),
    #[error("request is already finished: {0}")]
    AlreadyFinished(String),
    #[error("request was not found: {0}")]
    NotFound(String),
}

impl RequestError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::AlreadyPending(_) => "request-already-pending",
            Self::AlreadyFinished(_) => "request-already-finished",
            Self::NotFound(_) => "request-not-found",
        }
    }
}

#[derive(Debug)]
struct PendingRequest {
    _mode: CaptureMode,
    capture_release: Option<CaptureRelease>,
}

#[derive(Debug)]
#[allow(dead_code)]
struct CaptureRelease {
    clipboard_written: bool,
    width: u32,
    height: u32,
}

#[derive(Debug, Default)]
pub struct RequestRegistry {
    pending: HashMap<String, PendingRequest>,
    finished: HashSet<String>,
}

impl RequestRegistry {
    pub fn accept(&mut self, request_id: &str, mode: CaptureMode) -> Result<(), RequestError> {
        if self.pending.contains_key(request_id) {
            return Err(RequestError::AlreadyPending(request_id.into()));
        }
        // A finished requestId can be reused for a new request. Drop the
        // finished marker so the new `pending` insert does not collide
        // with the prior lifetime in the same hashset.
        self.finished.remove(request_id);

        self.pending.insert(
            request_id.into(),
            PendingRequest {
                _mode: mode,
                capture_release: None,
            },
        );
        Ok(())
    }

    pub fn capture_released(
        &mut self,
        request_id: &str,
        clipboard_written: bool,
        width: u32,
        height: u32,
    ) -> Result<(), RequestError> {
        let request = self.pending_mut(request_id)?;
        request.capture_release = Some(CaptureRelease {
            clipboard_written,
            width,
            height,
        });
        Ok(())
    }

    pub fn complete(
        &mut self,
        request_id: &str,
        _file_name: Option<String>,
    ) -> Result<(), RequestError> {
        self.finish(request_id)
    }

    pub fn cancel(&mut self, request_id: &str, _reason: &str) -> Result<(), RequestError> {
        self.finish(request_id)
    }

    pub fn is_pending(&self, request_id: &str) -> bool {
        self.pending.contains_key(request_id)
    }

    fn pending_mut(&mut self, request_id: &str) -> Result<&mut PendingRequest, RequestError> {
        match self.pending.get_mut(request_id) {
            Some(request) => Ok(request),
            None if self.finished.contains(request_id) => {
                Err(RequestError::AlreadyFinished(request_id.into()))
            }
            None => Err(RequestError::NotFound(request_id.into())),
        }
    }

    fn finish(&mut self, request_id: &str) -> Result<(), RequestError> {
        if self.pending.remove(request_id).is_some() {
            self.finished.insert(request_id.into());
            return Ok(());
        }
        if self.finished.contains(request_id) {
            return Err(RequestError::AlreadyFinished(request_id.into()));
        }

        Err(RequestError::NotFound(request_id.into()))
    }
}
