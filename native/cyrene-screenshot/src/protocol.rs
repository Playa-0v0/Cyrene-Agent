use crate::error::ProtocolError;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_NDJSON_LINE_BYTES: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureMode {
    ClipboardOnly,
    ClipboardAndFile,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields, tag = "type", rename_all = "kebab-case")]
pub enum Command {
    Start {
        #[serde(rename = "requestId")]
        request_id: String,
        mode: CaptureMode,
    },
    Cancel {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InteractionStateEvent {
    Selecting,
    Selected,
    Committing,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    Ready {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
    Accepted {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    OverlayVisible {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "freezeDurationMs")]
        freeze_duration_ms: u64,
        diagnostics: crate::win::capture::CaptureDiagnostics,
    },
    InteractionState {
        #[serde(rename = "requestId")]
        request_id: String,
        state: InteractionStateEvent,
    },
    CaptureReleased {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "clipboardWritten")]
        clipboard_written: bool,
        width: u32,
        height: u32,
        diagnostics: crate::win::capture::CaptureDiagnostics,
    },
    Completed {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "fileName")]
        file_name: Option<String>,
        width: u32,
        height: u32,
        mime: &'static str,
        #[serde(rename = "clipboardWritten")]
        clipboard_written: bool,
        #[serde(rename = "hasAnnotations")]
        has_annotations: bool,
    },
    Cancelled {
        #[serde(rename = "requestId")]
        request_id: String,
        reason: String,
    },
    Error {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        code: String,
        message: String,
        recoverable: bool,
    },
}

pub fn parse_command_line(line: &str) -> Result<Command, ProtocolError> {
    if line.len() > MAX_NDJSON_LINE_BYTES {
        return Err(ProtocolError::LineTooLong);
    }

    Ok(serde_json::from_str(line)?)
}
