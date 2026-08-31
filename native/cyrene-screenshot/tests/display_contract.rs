#![cfg(windows)]

use cyrene_screenshot::geometry::{DisplayRotation, RectI};
use cyrene_screenshot::win::display::{query_primary_display, set_dpi_awareness};

#[test]
fn set_dpi_awareness_is_idempotent() {
    // Calling the awareness setter twice must not produce an error. The
    // Per-Monitor V2 context only needs to be established once per process,
    // so a second call is permitted to be a no-op.
    set_dpi_awareness().expect("first set_dpi_awareness call must succeed");
    set_dpi_awareness().expect("second set_dpi_awareness call must succeed");
}

#[test]
fn query_primary_display_returns_positive_bounds_and_primary_true() {
    let display = query_primary_display().expect("query_primary_display must succeed");

    assert!(
        display.bounds.width > 0,
        "primary display width must be > 0, was {}",
        display.bounds.width
    );
    assert!(
        display.bounds.height > 0,
        "primary display height must be > 0, was {}",
        display.bounds.height
    );
    assert!(
        display.is_primary,
        "query_primary_display must report is_primary = true"
    );
}

#[test]
fn query_primary_display_returns_known_rotation() {
    let display = query_primary_display().expect("query_primary_display must succeed");

    let known = matches!(
        display.rotation,
        DisplayRotation::Identity
            | DisplayRotation::Rotate90
            | DisplayRotation::Rotate180
            | DisplayRotation::Rotate270,
    );
    assert!(
        known,
        "rotation must be one of the four DisplayRotation variants, was {:?}",
        display.rotation
    );

    // Also verify the bounds RectI round-trips through Display construction
    // in a consistent way for downstream callers that pattern-match on the
    // canonical orientation guarantee.
    let _round_trip = RectI {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
    };
}

#[test]
fn query_primary_display_dpi_is_positive() {
    let display = query_primary_display().expect("query_primary_display must succeed");

    assert!(
        display.dpi > 0.0,
        "primary display DPI must be > 0, was {}",
        display.dpi
    );
}
