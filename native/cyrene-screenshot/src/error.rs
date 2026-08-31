#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("invalid arguments: {0}")]
    InvalidArguments(String),
    #[error("unsupported protocol version {provided}; expected {expected}")]
    ProtocolVersionMismatch { provided: u32, expected: u32 },
    #[error("not-implemented: graphical capture initialization")]
    NotImplemented,
    #[error("Windows API failed: {0}")]
    Windows(#[from] windows::core::Error),
    #[error("I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("runtime failed: {0}")]
    Runtime(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidArguments(_) => "invalid-arguments",
            Self::ProtocolVersionMismatch { .. } => "protocol-version-mismatch",
            Self::NotImplemented => "not-implemented",
            Self::Windows(_) => "windows-api-failed",
            Self::Io(_) => "io-failed",
            Self::Runtime(_) => "runtime-failed",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("NDJSON line exceeds 65536 bytes")]
    LineTooLong,
    #[error("invalid command: {0}")]
    InvalidCommand(#[from] serde_json::Error),
}

impl ProtocolError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::LineTooLong => "line-too-long",
            Self::InvalidCommand(_) => "invalid-command",
        }
    }
}

/// Errors that arise while the helper is actively serving a screenshot
/// request: display query, capture backend, geometry transforms, and the
/// underlying Windows APIs. These are distinct from `AppError`/`ProtocolError`
/// (which describe runtime/process-level failures and the IPC protocol).
#[derive(Debug, thiserror::Error)]
pub enum HelperError {
    #[error("display query failed: {0}")]
    DisplayQueryFailed(String),
    #[error("capture failed: {0}")]
    CaptureFailed(String),
    #[error("invalid display configuration: {0}")]
    InvalidDisplay(String),
    #[error("encode failed: {0}")]
    EncodeFailed(String),
    #[error("Windows API failed: {0}")]
    Windows(#[from] windows::core::Error),
}

impl HelperError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DisplayQueryFailed(_) => "display-query-failed",
            Self::CaptureFailed(_) => "capture-failed",
            Self::InvalidDisplay(_) => "invalid-display",
            Self::EncodeFailed(_) => "encode-failed",
            Self::Windows(_) => "windows-api-failed",
        }
    }
}

impl From<HelperError> for AppError {
    fn from(error: HelperError) -> Self {
        AppError::Runtime(error.to_string())
    }
}

// `HelperError` is bridged into `AppError` via `From<HelperError> for AppError`
// below so request handlers can convert capture / display failures through
// the `?` operator. The two hierarchies remain intentionally separate:
// `HelperError` is request-scoped (a single freeze / display query) while
// `AppError` is process-scoped. Bridging them via `Runtime` keeps the wire
// error codes (`display-query-failed`, `capture-failed`, ...) visible in
// `HelperError::code()` and `AppError::code()` separately for layered
// diagnostics without introducing a new variant on the locked protocol
// surface.
