import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
MAKE = SCRIPTS / "make.py"
PDF_SKILL = Path(__file__).resolve().parents[1]


class MakeCliTests(unittest.TestCase):
    def run_make(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(MAKE), *args],
            cwd=SCRIPTS,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_check_requires_only_python_packages(self):
        result = self.run_make("check")

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "ok")
        self.assertNotIn("playwright", result.stdout.lower())
        self.assertNotIn("node", result.stdout.lower())

    def test_run_creates_a_multi_page_pdf_with_chinese_title(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "windows-native.pdf"
            result = self.run_make(
                "run",
                "--title", "中文季度报告",
                "--type", "report",
                "--author", "Cyrene 团队",
                "--out", str(output),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["status"], "ok")
            self.assertTrue(output.exists())
            self.assertGreaterEqual(len(PdfReader(output).pages), 2)

    def test_reformat_uses_the_source_content(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.md"
            output = Path(directory) / "reformatted.pdf"
            source.write_text("# Windows 内容\n\n这是被重排的正文。", encoding="utf-8")
            result = self.run_make(
                "reformat",
                "--input", str(source),
                "--title", "重排报告",
                "--out", str(output),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.exists())
            self.assertGreaterEqual(len(PdfReader(output).pages), 2)

    def test_public_pdf_workflow_has_no_browser_renderer(self):
        public_files = [PDF_SKILL / "SKILL.md", PDF_SKILL / "README.md"]
        public_text = "\n".join(path.read_text(encoding="utf-8").lower() for path in public_files)

        self.assertIn("python scripts/make.py", public_text)
        self.assertNotIn("playwright", public_text)
        self.assertNotIn("render_cover.js", public_text)
        self.assertNotIn("bash scripts/make.sh", public_text)


if __name__ == "__main__":
    unittest.main()
