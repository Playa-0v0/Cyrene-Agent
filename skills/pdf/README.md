# Cyrene PDF skill

Windows-first PDF creation, form filling, reformatting, and visual QA with local Python libraries.

## Quick start

```powershell
python scripts/make.py check
python scripts/make.py run --title "Q3 Strategy Review" --type proposal --out .\report.pdf
python scripts/make.py preview --input .\report.pdf --out-dir .\preview
```

The supported pipeline is:

```text
metadata + content → palette.py → pdf_cover.py + render_body.py → merge.py → PDF
                                                                  ↓
                                                        render_preview.py → PNG review images
```

`reportlab` and `pypdf` are required. `pypdfium2` is optional for preview images, and `matplotlib` is optional for charts and formulas. Install missing packages explicitly with `python -m pip install <package>`; the skill does not alter an environment during a document build.

## Routes

| Route | Command | Use |
|---|---|---|
| Create | `python scripts/make.py run ...` | A new, styled PDF from JSON blocks |
| Fill | `python scripts/make.py fill ...` | Existing AcroForm fields |
| Reformat | `python scripts/make.py reformat ...` | Markdown, text, source PDF, or content JSON |
| Preview | `python scripts/make.py preview ...` | Render pages for visual inspection |

See [SKILL.md](SKILL.md) for the full agent-facing workflow and [design/design.md](design/design.md) for the visual system.

## License

MIT
