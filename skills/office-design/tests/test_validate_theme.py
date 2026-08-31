from __future__ import annotations

import sys
import unittest
from copy import deepcopy
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from validate_theme import validate_theme  # type: ignore[import-not-found]


def complete_theme() -> dict[str, object]:
    return {
        "id": "test",
        "colors": {
            "primary": "#1B2A38",
            "secondary": "#3B6D8A",
            "accent": "#3B6D8A",
            "background": "#FAFAF8",
            "surface": "#FFFFFF",
            "foreground": "#2C2C30",
            "muted": "#7A7A84",
            "border": "#D9DEE3",
        },
        "fonts": {
            "cjk": ["Microsoft YaHei"],
            "latin": ["Aptos"],
            "fallback": ["Helvetica"],
        },
        "spacing": {"base": 8},
        "roles": {
            "table_header": "primary",
            "input": "#0000FF",
            "formula": "#000000",
            "warning": "#C2410C",
            "success": "#15803D",
        },
        "chart_colors": ["#3B6D8A", "#4E6070", "#7A7A84"],
    }


class ValidateThemeTests(unittest.TestCase):
    def test_accepts_complete_theme(self) -> None:
        self.assertEqual(validate_theme(complete_theme()), [])

    def test_reports_missing_semantic_color(self) -> None:
        theme = deepcopy(complete_theme())
        del theme["colors"]["accent"]  # type: ignore[index]
        self.assertIn("colors.accent is required", validate_theme(theme))

    def test_reports_empty_chart_palette(self) -> None:
        theme = deepcopy(complete_theme())
        theme["chart_colors"] = []
        self.assertIn("chart_colors is required", validate_theme(theme))


if __name__ == "__main__":
    unittest.main()
