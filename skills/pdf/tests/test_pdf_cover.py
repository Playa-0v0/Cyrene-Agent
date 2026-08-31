from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from pypdf import PdfReader
from reportlab.pdfbase.pdfmetrics import stringWidth


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from palette import PALETTES, build_tokens
from pdf_cover import SUPPORTED_PATTERNS, render_cover, resolve_font_paths, wrap_text  # type: ignore[import-not-found]


PALETTES_PATTERN_NAMES = {palette["cover_pattern"] for palette in PALETTES.values()}


def tokens_for(pattern: str) -> dict[str, object]:
    tokens = build_tokens("2026 年策略评审", "report", "策略团队", "2026 年 8 月")
    tokens.update({"cover_pattern": pattern, "subtitle": "Windows 原生渲染", "abstract": "用于验证中英文标题、字体回退和封面布局。"})
    return tokens


class CoverUnitTests(unittest.TestCase):
    def test_supports_every_legacy_cover_pattern(self) -> None:
        self.assertTrue(PALETTES_PATTERN_NAMES <= SUPPORTED_PATTERNS)

    def test_wrap_text_uses_measured_width(self) -> None:
        lines = wrap_text("alpha beta gamma", 40, "Helvetica", 12)
        self.assertGreater(len(lines), 1)
        self.assertTrue(all(stringWidth(line, "Helvetica", 12) <= 40 for line in lines))

    def test_font_lookup_skips_missing_windows_fonts(self) -> None:
        with TemporaryDirectory() as directory:
            self.assertEqual(resolve_font_paths(platform="win32", windows_dir=Path(directory)), {})


class CoverArtifactTests(unittest.TestCase):
    def test_render_cover_writes_one_page_pdf(self) -> None:
        with TemporaryDirectory() as directory:
            output = Path(directory) / "cover.pdf"
            report = render_cover(tokens_for("terminal"), output)
            self.assertEqual(report["pages"], 1)
            self.assertTrue(output.exists())
            self.assertEqual(len(PdfReader(output).pages), 1)

    def test_every_legacy_pattern_writes_one_page_pdf(self) -> None:
        with TemporaryDirectory() as directory:
            output_dir = Path(directory)
            for pattern in sorted(PALETTES_PATTERN_NAMES):
                output = output_dir / f"{pattern}.pdf"
                render_cover(tokens_for(pattern), output)
                self.assertEqual(len(PdfReader(output).pages), 1, pattern)


if __name__ == "__main__":
    unittest.main()
