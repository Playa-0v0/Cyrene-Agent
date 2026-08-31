from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Callable

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFError, TTFont
from reportlab.pdfgen.canvas import Canvas


PAGE_WIDTH, PAGE_HEIGHT = A4
SUPPORTED_PATTERNS = frozenset(
    {
        "fullbleed",
        "split",
        "typographic",
        "atmospheric",
        "minimal",
        "stripe",
        "diagonal",
        "frame",
        "editorial",
        "magazine",
        "darkroom",
        "terminal",
        "poster",
    }
)


def resolve_font_paths(platform: str | None = None, windows_dir: Path | None = None) -> dict[str, Path]:
    """Return available Windows font files without requiring an installed Office suite."""
    target = platform or sys.platform
    if not target.startswith("win"):
        return {}
    fonts_dir = windows_dir or Path(os.environ.get("WINDIR", r"C:\\Windows")) / "Fonts"
    candidates = {
        "cjk": ("msyh.ttc", "msyh.ttf", "simhei.ttf", "simsun.ttc", "simsun.ttf"),
        "display": ("georgiab.ttf", "timesbd.ttf", "arialbd.ttf"),
        "body": ("arial.ttf", "calibri.ttf", "aptos.ttf"),
    }
    resolved: dict[str, Path] = {}
    for role, names in candidates.items():
        for name in names:
            candidate = fonts_dir / name
            if candidate.is_file():
                resolved[role] = candidate
                break
    return resolved


def register_fonts(tokens: dict[str, Any]) -> dict[str, str]:
    """Register local fonts when ReportLab can load them; always return safe names."""
    registered = {
        "display": str(tokens.get("font_display_rl") or "Times-Bold"),
        "body": str(tokens.get("font_body_rl") or "Helvetica"),
        "bold": str(tokens.get("font_body_b_rl") or "Helvetica-Bold"),
    }
    for role, path in resolve_font_paths().items():
        name = f"CyreneCover{role.title()}"
        try:
            if name not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont(name, str(path), subfontIndex=0))
            if role == "cjk":
                registered["display"] = name
                registered["body"] = name
                registered["bold"] = name
            elif role == "display":
                registered["display"] = name
            elif role == "body":
                registered["body"] = name
        except (OSError, TTFError, ValueError):
            continue
    return registered


def _as_color(value: str, fallback: str) -> colors.Color:
    try:
        return colors.HexColor(value or fallback)
    except (TypeError, ValueError):
        return colors.HexColor(fallback)


def _token_color(tokens: dict[str, Any], key: str, fallback: str) -> colors.Color:
    return _as_color(str(tokens.get(key, fallback)), fallback)


def wrap_text(text: str, max_width: float, font_name: str, font_size: float) -> list[str]:
    """Wrap text against ReportLab's actual glyph metrics, including unspaced CJK text."""
    text = str(text or "").strip()
    if not text:
        return []
    if pdfmetrics.stringWidth(text, font_name, font_size) <= max_width:
        return [text]

    lines: list[str] = []
    line = ""
    words = text.split(" ")
    for index, word in enumerate(words):
        candidate = f"{line} {word}".strip() if line else word
        if pdfmetrics.stringWidth(candidate, font_name, font_size) <= max_width:
            line = candidate
            continue
        if line:
            lines.append(line)
            line = ""
        for character in word:
            candidate = f"{line}{character}"
            if line and pdfmetrics.stringWidth(candidate, font_name, font_size) > max_width:
                lines.append(line)
                line = character
            else:
                line = candidate
        if index < len(words) - 1 and line:
            with_space = f"{line} "
            if pdfmetrics.stringWidth(with_space, font_name, font_size) <= max_width:
                line = with_space
    if line.strip():
        lines.append(line.strip())
    return lines


def _draw_lines(
    canvas: Canvas,
    text: str,
    x: float,
    y: float,
    width: float,
    font: str,
    size: float,
    color: colors.Color,
    leading: float | None = None,
    max_lines: int = 4,
    align: str = "left",
) -> float:
    lines = wrap_text(text, width, font, size)[:max_lines]
    step = leading or size * 1.15
    canvas.setFont(font, size)
    canvas.setFillColor(color)
    for line in lines:
        if align == "center":
            canvas.drawCentredString(x + width / 2, y, line)
        elif align == "right":
            canvas.drawRightString(x + width, y, line)
        else:
            canvas.drawString(x, y, line)
        y -= step
    return y


def _draw_dot_grid(canvas: Canvas, x: float, y: float, width: float, height: float, color: colors.Color) -> None:
    canvas.saveState()
    canvas.setFillColor(color)
    canvas.setFillAlpha(0.20)
    gap = 20
    for row in range(int(height // gap) + 1):
        for column in range(int(width // gap) + 1):
            canvas.circle(x + column * gap, y + row * gap, 0.65, fill=1, stroke=0)
    canvas.restoreState()


def _draw_image_or_placeholder(canvas: Canvas, tokens: dict[str, Any], x: float, y: float, width: float, height: float) -> None:
    image_value = str(tokens.get("cover_image") or "")
    image_path = Path(image_value)
    if image_value and image_path.is_file():
        try:
            image = ImageReader(str(image_path))
            source_width, source_height = image.getSize()
            scale = max(width / source_width, height / source_height)
            draw_width, draw_height = source_width * scale, source_height * scale
            canvas.saveState()
            clip = canvas.beginPath()
            clip.rect(x, y, width, height)
            canvas.clipPath(clip, stroke=0, fill=0)
            canvas.drawImage(image, x + (width - draw_width) / 2, y + (height - draw_height) / 2, draw_width, draw_height)
            canvas.restoreState()
            return
        except (OSError, ValueError):
            pass
    canvas.setFillColor(_token_color(tokens, "accent_lt", "#E6EFF5"))
    canvas.rect(x, y, width, height, fill=1, stroke=0)
    canvas.setStrokeColor(_token_color(tokens, "accent", "#3B6D8A"))
    canvas.setDash(4, 4)
    canvas.rect(x, y, width, height, fill=0, stroke=1)
    canvas.setDash()


def _meta(canvas: Canvas, tokens: dict[str, Any], x: float, y: float, width: float, font: str, color: colors.Color, align: str = "left") -> None:
    entries = [entry for entry in (str(tokens.get("author") or ""), str(tokens.get("date") or "")) if entry]
    if not entries:
        return
    _draw_lines(canvas, "  /  ".join(entries), x, y, width, font, 8.5, color, 11, 1, align)


def _title(canvas: Canvas, tokens: dict[str, Any], x: float, y: float, width: float, fonts: dict[str, str], color: colors.Color, size: float = 42, align: str = "left") -> float:
    return _draw_lines(canvas, str(tokens.get("title") or "Untitled Document"), x, y, width, fonts["display"], size, color, size * 1.05, 4, align)


def _subtitle(canvas: Canvas, tokens: dict[str, Any], x: float, y: float, width: float, fonts: dict[str, str], color: colors.Color, align: str = "left") -> float:
    subtitle = str(tokens.get("subtitle") or tokens.get("abstract") or "")
    if not subtitle:
        return y
    return _draw_lines(canvas, subtitle, x, y, width, fonts["body"], 11, color, 16, 3, align)


def _fullbleed(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#1B2A38")
    light = _token_color(tokens, "text_light", "#EDE9E2")
    accent = _token_color(tokens, "accent", "#3B6D8A")
    canvas.setFillColor(background)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    _draw_dot_grid(canvas, PAGE_WIDTH * 0.55, 0, PAGE_WIDTH * 0.45, PAGE_HEIGHT, light)
    y = _title(canvas, tokens, 58, PAGE_HEIGHT - 220, PAGE_WIDTH * 0.70, fonts, light, 46)
    canvas.setFillColor(accent)
    canvas.rect(58, y - 16, 92, 5, fill=1, stroke=0)
    _subtitle(canvas, tokens, 58, y - 54, PAGE_WIDTH * 0.60, fonts, light)
    _meta(canvas, tokens, 58, 58, PAGE_WIDTH - 116, fonts["body"], light)


def _split(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#22272E")
    surface = _token_color(tokens, "page_bg", "#FAFAF7")
    light = _token_color(tokens, "text_light", "#EDE9E2")
    accent = _token_color(tokens, "accent", "#4E6070")
    split = PAGE_WIDTH * 0.62
    canvas.setFillColor(surface)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    canvas.setFillColor(background)
    canvas.rect(0, 0, split, PAGE_HEIGHT, fill=1, stroke=0)
    _draw_dot_grid(canvas, split + 24, 90, PAGE_WIDTH - split - 48, PAGE_HEIGHT - 180, accent)
    y = _title(canvas, tokens, 52, PAGE_HEIGHT - 200, split - 96, fonts, light, 42)
    _subtitle(canvas, tokens, 52, y - 26, split - 96, fonts, light)
    canvas.setFillColor(accent)
    canvas.rect(split - 6, 0, 6, PAGE_HEIGHT, fill=1, stroke=0)
    _meta(canvas, tokens, 52, 58, split - 104, fonts["body"], light)


def _typographic(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#FFFFFF")
    dark = _token_color(tokens, "dark", "#111111")
    accent = _token_color(tokens, "accent", "#1C3557")
    canvas.setFillColor(background)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    title = str(tokens.get("title") or "Untitled Document")
    first, _, remainder = title.partition(" ")
    _draw_lines(canvas, first, 54, PAGE_HEIGHT - 210, PAGE_WIDTH - 108, fonts["display"], 64, accent, 66, 1)
    y = _draw_lines(canvas, remainder or first, 58, PAGE_HEIGHT - 305, PAGE_WIDTH - 116, fonts["display"], 31, dark, 36, 3)
    _subtitle(canvas, tokens, 58, y - 28, PAGE_WIDTH - 116, fonts, _token_color(tokens, "muted", "#888888"))
    _meta(canvas, tokens, 58, 58, PAGE_WIDTH - 116, fonts["body"], dark)


def _atmospheric(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#191C20")
    accent = _token_color(tokens, "accent", "#6A7A88")
    light = _token_color(tokens, "text_light", "#EDE9E4")
    canvas.setFillColor(background)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    canvas.saveState()
    canvas.setFillColor(accent)
    canvas.setFillAlpha(0.15)
    for radius in (220, 160, 100):
        canvas.circle(PAGE_WIDTH - 80, PAGE_HEIGHT - 100, radius, fill=1, stroke=0)
    canvas.restoreState()
    _draw_dot_grid(canvas, 42, 42, PAGE_WIDTH - 84, PAGE_HEIGHT - 84, light)
    y = _title(canvas, tokens, 58, PAGE_HEIGHT - 280, PAGE_WIDTH - 116, fonts, light, 44)
    _subtitle(canvas, tokens, 58, y - 34, PAGE_WIDTH * 0.65, fonts, light)
    _meta(canvas, tokens, 58, 58, PAGE_WIDTH - 116, fonts["body"], light)


def _minimal(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#F7F6F4")
    dark = _token_color(tokens, "dark", "#111111")
    accent = _token_color(tokens, "accent", "#4A4A4A")
    canvas.setFillColor(background)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    canvas.setFillColor(accent)
    canvas.rect(0, PAGE_HEIGHT - 14, PAGE_WIDTH, 14, fill=1, stroke=0)
    y = _title(canvas, tokens, 66, PAGE_HEIGHT - 260, PAGE_WIDTH - 132, fonts, dark, 42)
    _subtitle(canvas, tokens, 66, y - 24, PAGE_WIDTH - 132, fonts, _token_color(tokens, "muted", "#999999"))
    _meta(canvas, tokens, 66, 58, PAGE_WIDTH - 132, fonts["body"], dark)


def _stripe(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#1E222A")
    accent = _token_color(tokens, "accent", "#4A5568")
    light = _token_color(tokens, "text_light", "#FFFFFF")
    canvas.setFillColor(background)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    for index, alpha in enumerate((0.45, 0.72, 1.0)):
        canvas.saveState()
        canvas.setFillColor(accent)
        canvas.setFillAlpha(alpha)
        canvas.rect(0, PAGE_HEIGHT - 110 - index * 58, PAGE_WIDTH, 34, fill=1, stroke=0)
        canvas.restoreState()
    y = _title(canvas, tokens, 58, PAGE_HEIGHT - 360, PAGE_WIDTH - 116, fonts, light, 45)
    _subtitle(canvas, tokens, 58, y - 26, PAGE_WIDTH * 0.68, fonts, light)
    _meta(canvas, tokens, 58, 58, PAGE_WIDTH - 116, fonts["body"], light)


def _diagonal(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#1A2535")
    accent = _token_color(tokens, "accent", "#3D5A72")
    light = _token_color(tokens, "text_light", "#EEF0F5")
    canvas.setFillColor(background)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    canvas.setFillColor(accent)
    shape = canvas.beginPath()
    shape.moveTo(PAGE_WIDTH * 0.52, 0)
    shape.lineTo(PAGE_WIDTH, 0)
    shape.lineTo(PAGE_WIDTH, PAGE_HEIGHT)
    shape.lineTo(PAGE_WIDTH * 0.78, PAGE_HEIGHT)
    shape.close()
    canvas.drawPath(shape, fill=1, stroke=0)
    y = _title(canvas, tokens, 54, PAGE_HEIGHT - 220, PAGE_WIDTH * 0.67, fonts, light, 44)
    _subtitle(canvas, tokens, 54, y - 26, PAGE_WIDTH * 0.55, fonts, light)
    _meta(canvas, tokens, 54, 58, PAGE_WIDTH - 108, fonts["body"], light)


def _frame(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#F5F2EC")
    dark = _token_color(tokens, "dark", "#2A1E14")
    accent = _token_color(tokens, "accent", "#5C4A38")
    canvas.setFillColor(background)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    canvas.setStrokeColor(accent)
    canvas.setLineWidth(3)
    canvas.rect(28, 28, PAGE_WIDTH - 56, PAGE_HEIGHT - 56, fill=0, stroke=1)
    canvas.setLineWidth(0.8)
    canvas.rect(43, 43, PAGE_WIDTH - 86, PAGE_HEIGHT - 86, fill=0, stroke=1)
    y = _title(canvas, tokens, 78, PAGE_HEIGHT - 300, PAGE_WIDTH - 156, fonts, dark, 41, "center")
    _subtitle(canvas, tokens, 78, y - 25, PAGE_WIDTH - 156, fonts, _token_color(tokens, "muted", "#9A8A78"), "center")
    _meta(canvas, tokens, 78, 66, PAGE_WIDTH - 156, fonts["body"], dark, "center")


def _editorial(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#FFFFFF")
    dark = _token_color(tokens, "dark", "#0A0A0A")
    accent = _token_color(tokens, "accent", "#7A2B36")
    canvas.setFillColor(background)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    title = str(tokens.get("title") or "Untitled Document")
    canvas.saveState()
    canvas.setFillColor(accent)
    canvas.setFillAlpha(0.08)
    canvas.setFont(fonts["display"], 260)
    canvas.drawString(42, PAGE_HEIGHT - 325, title[:1].upper())
    canvas.restoreState()
    canvas.setFillColor(accent)
    canvas.rect(58, PAGE_HEIGHT - 160, 115, 8, fill=1, stroke=0)
    y = _title(canvas, tokens, 58, PAGE_HEIGHT - 240, PAGE_WIDTH - 116, fonts, dark, 43)
    _subtitle(canvas, tokens, 58, y - 26, PAGE_WIDTH * 0.64, fonts, _token_color(tokens, "muted", "#777777"))
    _meta(canvas, tokens, 58, 58, PAGE_WIDTH - 116, fonts["body"], dark)


def _magazine(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#F0EEE9")
    dark = _token_color(tokens, "dark", "#0D1A2B")
    accent = _token_color(tokens, "accent", "#1C3557")
    canvas.setFillColor(background)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    canvas.setFillColor(accent)
    canvas.setFont(fonts["body"], 9)
    canvas.drawCentredString(PAGE_WIDTH / 2, PAGE_HEIGHT - 64, "CYRENE EDITION")
    _draw_image_or_placeholder(canvas, tokens, 72, 230, PAGE_WIDTH - 144, 250)
    y = _title(canvas, tokens, 64, 175, PAGE_WIDTH - 128, fonts, dark, 35, "center")
    _subtitle(canvas, tokens, 70, y - 14, PAGE_WIDTH - 140, fonts, _token_color(tokens, "muted", "#888888"), "center")
    _meta(canvas, tokens, 70, 58, PAGE_WIDTH - 140, fonts["body"], dark, "center")


def _darkroom(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#151C27")
    light = _token_color(tokens, "text_light", "#EDE9E2")
    accent = _token_color(tokens, "accent", "#3D5A7A")
    canvas.setFillColor(background)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    _draw_image_or_placeholder(canvas, tokens, 72, 268, PAGE_WIDTH - 144, 250)
    canvas.saveState()
    canvas.setFillColor(background)
    canvas.setFillAlpha(0.24)
    canvas.rect(72, 268, PAGE_WIDTH - 144, 250, fill=1, stroke=0)
    canvas.restoreState()
    y = _title(canvas, tokens, 60, 210, PAGE_WIDTH - 120, fonts, light, 36, "center")
    canvas.setFillColor(accent)
    canvas.rect(PAGE_WIDTH / 2 - 42, y - 16, 84, 4, fill=1, stroke=0)
    _subtitle(canvas, tokens, 70, y - 44, PAGE_WIDTH - 140, fonts, light, "center")
    _meta(canvas, tokens, 70, 58, PAGE_WIDTH - 140, fonts["body"], light, "center")


def _terminal(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#0D1117")
    accent = _token_color(tokens, "accent", "#3D7A5C")
    light = _token_color(tokens, "text_light", "#E6EDF3")
    canvas.setFillColor(background)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    canvas.saveState()
    canvas.setStrokeColor(accent)
    canvas.setStrokeAlpha(0.20)
    canvas.setLineWidth(0.4)
    for x in range(0, int(PAGE_WIDTH), 28):
        canvas.line(x, 0, x, PAGE_HEIGHT)
    for y in range(0, int(PAGE_HEIGHT), 28):
        canvas.line(0, y, PAGE_WIDTH, y)
    canvas.restoreState()
    canvas.setFillColor(accent)
    canvas.setFont("Courier", 11)
    canvas.drawString(52, PAGE_HEIGHT - 100, "> cyrene.pdf --render")
    y = _title(canvas, tokens, 52, PAGE_HEIGHT - 220, PAGE_WIDTH - 104, {**fonts, "display": "Courier-Bold"}, light, 36)
    _subtitle(canvas, tokens, 52, y - 22, PAGE_WIDTH - 104, {**fonts, "body": "Courier"}, accent)
    _meta(canvas, tokens, 52, 58, PAGE_WIDTH - 104, "Courier", light)


def _poster(canvas: Canvas, tokens: dict[str, Any], fonts: dict[str, str]) -> None:
    background = _token_color(tokens, "cover_bg", "#FFFFFF")
    dark = _token_color(tokens, "dark", "#0A0A0A")
    canvas.setFillColor(background)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    canvas.setFillColor(dark)
    canvas.rect(0, 0, 64, PAGE_HEIGHT, fill=1, stroke=0)
    canvas.saveState()
    canvas.translate(28, 82)
    canvas.rotate(90)
    canvas.setFillColor(background)
    canvas.setFont("Courier-Bold", 10)
    canvas.drawString(0, 0, "CYRENE / PRINT SERIES")
    canvas.restoreState()
    y = _title(canvas, tokens, 94, PAGE_HEIGHT - 210, PAGE_WIDTH - 140, fonts, dark, 50)
    _subtitle(canvas, tokens, 96, y - 20, PAGE_WIDTH - 150, fonts, _token_color(tokens, "muted", "#888888"))
    _meta(canvas, tokens, 96, 58, PAGE_WIDTH - 150, fonts["body"], dark)


_PATTERN_DRAWERS: dict[str, Callable[[Canvas, dict[str, Any], dict[str, str]], None]] = {
    "fullbleed": _fullbleed,
    "split": _split,
    "typographic": _typographic,
    "atmospheric": _atmospheric,
    "minimal": _minimal,
    "stripe": _stripe,
    "diagonal": _diagonal,
    "frame": _frame,
    "editorial": _editorial,
    "magazine": _magazine,
    "darkroom": _darkroom,
    "terminal": _terminal,
    "poster": _poster,
}


def render_cover(tokens: dict[str, Any], output_path: Path) -> dict[str, object]:
    pattern = str(tokens.get("cover_pattern") or "fullbleed")
    if pattern not in SUPPORTED_PATTERNS:
        raise ValueError(f"Unsupported cover pattern: {pattern}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fonts = register_fonts(tokens)
    canvas = Canvas(str(output_path), pagesize=A4)
    _PATTERN_DRAWERS[pattern](canvas, tokens, fonts)
    canvas.showPage()
    canvas.save()
    return {"output": str(output_path), "pages": 1, "pattern": pattern, "fonts": fonts}
