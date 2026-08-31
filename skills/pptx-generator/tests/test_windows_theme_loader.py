import json
import subprocess
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
LOADER = SKILL_DIR / "scripts" / "theme-loader.js"


class WindowsThemeLoaderTests(unittest.TestCase):
    def test_shared_business_theme_maps_to_pptx_contract(self):
        result = subprocess.run(
            ["node", "-e", f"const m=require({json.dumps(str(LOADER))}); console.log(JSON.stringify(m.loadTheme('business')));"],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        theme = json.loads(result.stdout)
        self.assertEqual(set(theme), {"primary", "secondary", "accent", "light", "bg"})
        self.assertTrue(all(len(value) == 6 for value in theme.values()))

    def test_pptx_workflow_uses_the_shared_theme_loader(self):
        text = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("theme-loader.js", text)
        self.assertIn("Microsoft YaHei", text)


if __name__ == "__main__":
    unittest.main()
