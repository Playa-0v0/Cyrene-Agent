import json
import subprocess
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


class WindowsScriptTests(unittest.TestCase):
    def test_environment_check_has_a_machine_readable_windows_mode(self):
        result = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPTS / "env_check.ps1"), "-Json", "-SkipBuild"],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertIn(report["status"], {"READY", "NOT READY"})
        self.assertIn("dotnet", report["checks"])

    def test_windows_preview_script_is_present(self):
        script = SCRIPTS / "docx_preview.ps1"
        self.assertTrue(script.exists())
        self.assertIn("LibreOffice", script.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
