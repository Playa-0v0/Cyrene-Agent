use cyrene_screenshot::geometry::{
    AnnotationColor, AnnotationState, DisplayRotation, Mark, PointI, RectI, SelectionHandle,
    hit_test_selection_handle, localize_window_rect, place_toolbar, resize_selection,
    rotate_rect_to_display,
};

#[test]
fn identity_rotation_preserves_an_in_bounds_rectangle() {
    let rotated = rotate_rect_to_display(
        RectI {
            x: 10,
            y: 5,
            width: 20,
            height: 30,
        },
        100,
        60,
        DisplayRotation::Identity,
    );

    assert_eq!(
        rotated,
        Some(RectI {
            x: 10,
            y: 5,
            width: 20,
            height: 30,
        })
    );
}

#[test]
fn right_angle_rotations_swap_texture_dimensions() {
    let rect = RectI {
        x: 10,
        y: 5,
        width: 20,
        height: 30,
    };

    assert_eq!(
        rotate_rect_to_display(rect, 100, 60, DisplayRotation::Rotate90),
        Some(RectI {
            x: 25,
            y: 10,
            width: 30,
            height: 20,
        })
    );
    assert_eq!(
        rotate_rect_to_display(rect, 100, 60, DisplayRotation::Rotate270),
        Some(RectI {
            x: 5,
            y: 70,
            width: 30,
            height: 20,
        })
    );
}

#[test]
fn rotation_clamps_negative_input_to_display_bounds() {
    let rotated = rotate_rect_to_display(
        RectI {
            x: -5,
            y: -10,
            width: 20,
            height: 20,
        },
        100,
        50,
        DisplayRotation::Rotate90,
    );

    assert_eq!(
        rotated,
        Some(RectI {
            x: 40,
            y: 0,
            width: 10,
            height: 15,
        })
    );
}

#[test]
fn rotation_rejects_clamped_selections_smaller_than_four_pixels() {
    assert_eq!(
        rotate_rect_to_display(
            RectI {
                x: 98,
                y: 10,
                width: 10,
                height: 10,
            },
            100,
            60,
            DisplayRotation::Rotate180,
        ),
        None
    );
}

#[test]
fn toolbar_moves_above_when_below_does_not_fit() {
    let toolbar = place_toolbar(
        RectI {
            x: 20,
            y: 70,
            width: 30,
            height: 20,
        },
        RectI {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        },
        40,
        10,
        5,
    );

    assert_eq!(
        toolbar,
        Some(RectI {
            x: 15,
            y: 55,
            width: 40,
            height: 10,
        })
    );
}

#[test]
fn toolbar_moves_inside_when_neither_outside_position_fits() {
    let toolbar = place_toolbar(
        RectI {
            x: 20,
            y: 10,
            width: 40,
            height: 80,
        },
        RectI {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        },
        60,
        10,
        5,
    );

    assert_eq!(
        toolbar,
        Some(RectI {
            x: 10,
            y: 80,
            width: 60,
            height: 10,
        })
    );
}

#[test]
fn toolbar_rejects_empty_or_too_small_displays() {
    assert_eq!(
        place_toolbar(
            RectI {
                x: 0,
                y: 0,
                width: 20,
                height: 20,
            },
            RectI {
                x: 0,
                y: 0,
                width: 0,
                height: 20,
            },
            10,
            10,
            2,
        ),
        None
    );
    assert_eq!(
        place_toolbar(
            RectI {
                x: 0,
                y: 0,
                width: 20,
                height: 20,
            },
            RectI {
                x: 0,
                y: 0,
                width: 20,
                height: 20,
            },
            21,
            10,
            2,
        ),
        None
    );
}

#[test]
fn window_rect_is_clamped_and_localized_to_the_active_display() {
    assert_eq!(
        localize_window_rect(
            RectI {
                x: 80,
                y: 40,
                width: 80,
                height: 80,
            },
            RectI {
                x: 100,
                y: 50,
                width: 200,
                height: 100,
            },
        ),
        Some(RectI {
            x: 0,
            y: 0,
            width: 60,
            height: 70,
        }),
    );
}

#[test]
fn selection_handle_hit_test_covers_corners_and_edges() {
    let selection = RectI {
        x: 100,
        y: 80,
        width: 200,
        height: 120,
    };

    assert_eq!(
        hit_test_selection_handle(selection, PointI { x: 100, y: 80 }, 8),
        Some(SelectionHandle::TopLeft),
    );
    assert_eq!(
        hit_test_selection_handle(selection, PointI { x: 200, y: 200 }, 8),
        Some(SelectionHandle::Bottom),
    );
    assert_eq!(
        hit_test_selection_handle(selection, PointI { x: 210, y: 150 }, 8),
        None,
    );
}

#[test]
fn annotation_history_undoes_one_mark_and_clear_removes_all() {
    let mut annotations = AnnotationState::default();
    annotations.push(Mark::Rect {
        start: PointI { x: 10, y: 10 },
        end: PointI { x: 40, y: 30 },
        color: AnnotationColor::Red,
    });
    annotations.push(Mark::Arrow {
        start: PointI { x: 20, y: 40 },
        end: PointI { x: 80, y: 10 },
        color: AnnotationColor::Yellow,
    });

    assert!(matches!(annotations.undo(), Some(Mark::Arrow { .. })));
    assert_eq!(annotations.len(), 1);
    annotations.clear();
    assert!(annotations.is_empty());
}

#[test]
fn resizing_a_corner_updates_both_selection_edges() {
    assert_eq!(
        resize_selection(
            RectI {
                x: 100,
                y: 80,
                width: 200,
                height: 120,
            },
            SelectionHandle::TopLeft,
            PointI { x: 80, y: 60 },
            RectI {
                x: 0,
                y: 0,
                width: 400,
                height: 300,
            },
            4,
        ),
        Some(RectI {
            x: 80,
            y: 60,
            width: 220,
            height: 140,
        }),
    );
}
