from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pdf_cover import render_cover


def main() -> int:
    parser = argparse.ArgumentParser(description="Render a MiniMax PDF cover without a browser.")
    parser.add_argument("--tokens", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--subtitle", default="")
    args = parser.parse_args()
    try:
        tokens = json.loads(args.tokens.read_text(encoding="utf-8"))
        if args.subtitle:
            tokens["subtitle"] = args.subtitle
        report = render_cover(tokens, args.out)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"status": "ok", **report}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
