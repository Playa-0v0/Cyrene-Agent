use cyrene_screenshot::cli::parse_arguments;
use cyrene_screenshot::protocol::{
    CaptureMode, Command, Event, MAX_NDJSON_LINE_BYTES, parse_command_line,
};
use std::path::PathBuf;

#[test]
fn parses_clipboard_only_start() {
    let command = parse_command_line(
        r#"{"type":"start","requestId":"2b8da7c8-7900-4db2-8de2-7cdbd920d0d7","mode":"clipboard-only"}"#,
    )
    .unwrap();
    assert_eq!(
        command,
        Command::Start {
            request_id: "2b8da7c8-7900-4db2-8de2-7cdbd920d0d7".into(),
            mode: CaptureMode::ClipboardOnly,
        }
    );
}

#[test]
fn rejects_business_source_field_instead_of_mode() {
    let error =
        parse_command_line(r#"{"type":"start","requestId":"x","source":"hotkey"}"#).unwrap_err();
    assert_eq!(error.code(), "invalid-command");
}

#[test]
fn rejects_business_source_field_alongside_a_valid_mode() {
    let error = parse_command_line(
        r#"{"type":"start","requestId":"x","mode":"clipboard-only","source":"hotkey"}"#,
    )
    .unwrap_err();
    assert_eq!(error.code(), "invalid-command");
}

#[test]
fn rejects_oversized_line() {
    let line = "x".repeat(MAX_NDJSON_LINE_BYTES + 1);
    assert_eq!(
        parse_command_line(&line).unwrap_err().code(),
        "line-too-long"
    );
}

#[test]
fn parses_required_cli_arguments() {
    let options = parse_arguments([
        "--output-dir",
        r"C:\Temp\cyrene-screenshots",
        "--protocol-version",
        "1",
        "--parent-pid",
        "1",
    ])
    .unwrap();

    assert_eq!(
        options.output_dir,
        PathBuf::from(r"C:\Temp\cyrene-screenshots")
    );
    assert_eq!(options.protocol_version, 1);
    assert_eq!(options.parent_pid, 1);
}

#[test]
fn rejects_relative_output_directory() {
    let error = parse_arguments([
        "--output-dir",
        r"screenshots",
        "--protocol-version",
        "1",
        "--parent-pid",
        "1",
    ])
    .unwrap_err();

    assert_eq!(error.code(), "invalid-arguments");
}

#[test]
fn completed_event_reports_only_whether_annotations_exist() {
    let event = Event::Completed {
        request_id: "r1".into(),
        file_name: None,
        width: 10,
        height: 20,
        mime: "image/png",
        clipboard_written: true,
        has_annotations: true,
    };
    let json = serde_json::to_value(event).unwrap();

    assert_eq!(json["hasAnnotations"], true);
    assert!(json.get("annotations").is_none());
}
