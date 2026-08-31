#!/usr/bin/env python3
"""Create Windows-friendly XLSX workspaces and locate labels safely."""

from __future__ import annotations

import argparse
import json
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def create_workspace(base_dir: Path | None = None, name: str = "cyrene-xlsx") -> Path:
    root = base_dir or Path(tempfile.gettempdir())
    root.mkdir(parents=True, exist_ok=True)
    path = Path(tempfile.mkdtemp(prefix=f"{name}-", dir=root))
    (path / "unpacked").mkdir()
    return path


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    strings: list[str] = []
    for item in root.findall(f"{{{MAIN_NS}}}si"):
        strings.append("".join(node.text or "" for node in item.iter() if local_name(node.tag) == "t"))
    return strings


def _sheet_paths(archive: zipfile.ZipFile) -> list[tuple[str, str]]:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {
        rel.attrib["Id"]: rel.attrib["Target"]
        for rel in rels.findall(f"{{{PACKAGE_REL_NS}}}Relationship")
    }
    paths: list[tuple[str, str]] = []
    for sheet in workbook.findall(f".//{{{MAIN_NS}}}sheet"):
        relationship_id = sheet.attrib.get(f"{{{REL_NS}}}id")
        target = targets.get(relationship_id or "")
        if target:
            paths.append((sheet.attrib["name"], "xl/" + target.lstrip("/")))
    return paths


def _cell_text(cell: ET.Element, strings: list[str]) -> str:
    cell_type = cell.attrib.get("t")
    if cell_type == "s":
        value = cell.findtext(f"{{{MAIN_NS}}}v", default="")
        return strings[int(value)] if value.isdigit() and int(value) < len(strings) else ""
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.iter() if local_name(node.tag) == "t")
    return cell.findtext(f"{{{MAIN_NS}}}v", default="")


def find_label(workbook_path: Path, label: str) -> list[dict[str, str | int]]:
    needle = label.casefold().strip()
    if not needle:
        raise ValueError("Label must not be empty")
    matches: list[dict[str, str | int]] = []
    with zipfile.ZipFile(workbook_path) as archive:
        strings = _shared_strings(archive)
        for sheet_name, sheet_path in _sheet_paths(archive):
            root = ET.fromstring(archive.read(sheet_path))
            for cell in root.findall(f".//{{{MAIN_NS}}}c"):
                text = _cell_text(cell, strings)
                if needle in text.casefold():
                    reference = cell.attrib.get("r", "")
                    row = int("".join(char for char in reference if char.isdigit()) or "0")
                    matches.append({"sheet": sheet_name, "cell": reference, "row": row, "text": text})
    return matches


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("--base-dir", type=Path)
    create.add_argument("--name", default="cyrene-xlsx")
    locate = commands.add_parser("find-label")
    locate.add_argument("--input", required=True, type=Path)
    locate.add_argument("--label", required=True)
    args = parser.parse_args()
    try:
        if args.command == "create":
            print(json.dumps({"status": "ok", "workspace": str(create_workspace(args.base_dir, args.name))}))
        else:
            print(json.dumps({"status": "ok", "matches": find_label(args.input, args.label)}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
