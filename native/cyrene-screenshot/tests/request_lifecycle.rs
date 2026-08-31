use cyrene_screenshot::protocol::CaptureMode;
use cyrene_screenshot::request::{CaptureInteractionState, RequestRegistry};

#[test]
fn capture_released_does_not_finish_file_request() {
    let mut registry = RequestRegistry::default();
    registry
        .accept("r1", CaptureMode::ClipboardAndFile)
        .unwrap();
    registry.capture_released("r1", true, 800, 600).unwrap();

    assert!(registry.is_pending("r1"));

    registry
        .complete(
            "r1",
            Some("00000000-0000-4000-8000-000000000001.png".into()),
        )
        .unwrap();
    assert!(!registry.is_pending("r1"));
}

#[test]
fn capture_released_does_not_finish_clipboard_request() {
    let mut registry = RequestRegistry::default();
    registry.accept("r1", CaptureMode::ClipboardOnly).unwrap();
    registry.capture_released("r1", true, 800, 600).unwrap();

    assert!(registry.is_pending("r1"));

    registry.complete("r1", None).unwrap();
    assert!(!registry.is_pending("r1"));
}

#[test]
fn request_cannot_finish_twice() {
    let mut registry = RequestRegistry::default();
    registry.accept("r1", CaptureMode::ClipboardOnly).unwrap();
    registry.complete("r1", None).unwrap();

    assert_eq!(
        registry.cancel("r1", "late").unwrap_err().code(),
        "request-already-finished"
    );
}

#[test]
fn accept_rejects_pending_request_id() {
    let mut registry = RequestRegistry::default();
    registry
        .accept("pending", CaptureMode::ClipboardOnly)
        .unwrap();
    assert_eq!(
        registry
            .accept("pending", CaptureMode::ClipboardOnly)
            .unwrap_err()
            .code(),
        "request-already-pending"
    );
}

#[test]
fn accept_recycles_finished_request_id() {
    // A finished requestId can be reused for a new request; the registry
    // drops the finished marker before inserting the new pending entry.
    let mut registry = RequestRegistry::default();
    registry
        .accept("recycled", CaptureMode::ClipboardOnly)
        .unwrap();
    registry.complete("recycled", None).unwrap();
    assert!(!registry.is_pending("recycled"));

    registry
        .accept("recycled", CaptureMode::ClipboardAndFile)
        .expect("finished requestId must be reusable");
    assert!(registry.is_pending("recycled"));
}

#[test]
fn unknown_requests_report_request_not_found() {
    let mut registry = RequestRegistry::default();

    assert_eq!(
        registry
            .capture_released("missing", false, 0, 0)
            .unwrap_err()
            .code(),
        "request-not-found"
    );
}

#[test]
fn interaction_states_include_each_lifecycle_phase() {
    assert_eq!(CaptureInteractionState::Idle, CaptureInteractionState::Idle);
    assert_eq!(
        CaptureInteractionState::Freezing,
        CaptureInteractionState::Freezing
    );
    assert_eq!(
        CaptureInteractionState::Selecting,
        CaptureInteractionState::Selecting
    );
    assert_eq!(
        CaptureInteractionState::Selected,
        CaptureInteractionState::Selected
    );
    assert_eq!(
        CaptureInteractionState::Committing,
        CaptureInteractionState::Committing
    );
    assert_eq!(
        CaptureInteractionState::Cancelling,
        CaptureInteractionState::Cancelling
    );
}
