#!/usr/bin/env python3
"""Render PDF pages to PNG images with pypdfium2 when it is available."""

from __future__ import annotations

import importlib.util
from pathlib import Path


def render_pages(input_path: Path, output_dir: Path, dpi: int = 144) -> dict:
    if not input_path.exists():
        raise FileNotFoundError(f"PDF not found: {input_path}")
    if importlib.util.find_spec("pypdfium2") is None:
        raise RuntimeError("Preview needs pypdfium2. Install it with: python -m pip install pypdfium2")

    import pypdfium2 as pdfium

    output_dir.mkdir(parents=True, exist_ok=True)
    document = pdfium.PdfDocument(str(input_path))
    pages: list[str] = []
    for number in range(len(document)):
        bitmap = document[number].render(scale=dpi / 72)
        destination = output_dir / f"page-{number + 1:03d}.png"
        bitmap.to_pil().save(destination)
        pages.append(str(destination))
    return {"status": "ok", "input": str(input_path), "out_dir": str(output_dir), "pages": pages}
