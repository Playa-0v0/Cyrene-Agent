import importlib.util
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from xlsx_workspace import find_label


class WindowsWorkflowTests(unittest.TestCase):
    def create_workbook(self, path: Path) -> None:
        files = {
            "xl/workbook.xml": """<?xml version='1.0'?><workbook xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><sheets><sheet name='Budget' sheetId='1' r:id='rId1'/></sheets></workbook>""",
            "xl/_rels/workbook.xml.rels": """<?xml version='1.0'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet1.xml'/></Relationships>""",
            "xl/sharedStrings.xml": """<?xml version='1.0'?><sst xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><si><t>Office Rent</t></si></sst>""",
            "xl/worksheets/sheet1.xml": """<?xml version='1.0'?><worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData><row r='4'><c r='A4' t='s'><v>0</v></c></row></sheetData></worksheet>""",
        }
        with zipfile.ZipFile(path, "w") as archive:
            for name, text in files.items():
                archive.writestr(name, text)

    def test_find_label_returns_the_real_sheet_and_row(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "budget.xlsx"
            self.create_workbook(workbook)

            matches = find_label(workbook, "office rent")

            self.assertEqual(matches, [{"sheet": "Budget", "cell": "A4", "row": 4, "text": "Office Rent"}])

    def test_workflow_documentation_is_windows_first(self):
        text = (SCRIPTS.parent / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("python scripts/xlsx_workspace.py", text)
        self.assertIn("$env:TEMP", text)
        self.assertNotIn("/tmp/", text)
        self.assertNotIn("grep -n", text)


if __name__ == "__main__":
    unittest.main()
