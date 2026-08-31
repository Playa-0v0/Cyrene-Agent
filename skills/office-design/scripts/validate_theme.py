from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


REQUIRED: dict[str, tuple[str, ...]] = {
    "colors": ("primary", "secondary", "accent", "background", "surface", "foreground", "muted", "border"),
    "fonts": ("cjk", "latin", "fallback"),
    "spacing": ("base",),
    "roles": ("table_header", "input", "formula", "warning", "success"),
}


def validate_theme(theme: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not theme.get("id"):
        errors.append("id is required")
    for section, keys in REQUIRED.items():
        value = theme.get(section)
        if not isinstance(value, dict):
            errors.append(f"{section} is required")
            continue
        errors.extend(f"{section}.{key} is required" for key in keys if not value.get(key))
    if not theme.get("chart_colors"):
        errors.append("chart_colors is required")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Cyrene Office theme JSON file.")
    parser.add_argument("theme", type=Path)
    args = parser.parse_args()
    try:
        theme = json.loads(args.theme.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "error", "errors": [str(error)]}), file=sys.stderr)
        return 2
    errors = validate_theme(theme)
    print(json.dumps({"status": "ok" if not errors else "error", "errors": errors}, ensure_ascii=False))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
