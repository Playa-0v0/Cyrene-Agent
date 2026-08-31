---
name: pdf
description: Create, inspect, fill, reformat, and visually verify PDFs on Windows with local Python rendering. Use whenever a PDF must preserve deliberate layout, including Chinese text, tables, charts, covers, or form fields.
license: MIT
metadata:
  version: "2.0"
  category: document-generation
---

# Windows-native PDF workflow

Use this workflow for PDF creation, form filling, reformatting, and visual review. It uses local Python libraries only; do not select a browser-rendering route.

Before CREATE or REFORMAT, read `design/design.md`. For a reusable cross-document palette, inspect `../office-design/assets/themes/` and pass `--theme` where a matching theme exists.

## Start here

```powershell
python scripts/make.py check
python scripts/make.py demo --out .\demo.pdf
python scripts/make.py preview --input .\demo.pdf --out-dir .\preview
```

`check` reports the exact local packages. Install only missing required packages with `python -m pip install reportlab pypdf`. `pypdfium2` enables PNG previews; `matplotlib` enables richer chart and formula blocks.

## CREATE

```powershell
python scripts/make.py run `
  --title "Q3 策略回顾" --type proposal `
  --author "策略团队" --date "2026 年 8 月" `
  --theme business --content .\content.json --out .\report.pdf
```

The renderer keeps the selected palette, typography, spacing, cover, and body in one token set. Use a local image path for `--cover-image`; remote images are not fetched during rendering.

Supported document types are `report`, `proposal`, `resume`, `portfolio`, `academic`, `general`, `minimal`, `stripe`, `diagonal`, `frame`, `editorial`, `magazine`, `darkroom`, `terminal`, and `poster`.

| Type | Cover pattern | Intended tone |
|---|---|---|
| `report` | `fullbleed` | authoritative |
| `proposal` | `split` | confident |
| `resume` / `academic` | `typographic` | clean / scholarly |
| `portfolio` | `atmospheric` | expressive |
| `minimal`, `stripe`, `diagonal`, `frame` | named pattern | restrained to classical |
| `editorial`, `magazine`, `darkroom`, `terminal`, `poster` | named pattern | publishing to technical |

## Content blocks

Pass an array of blocks in UTF-8 JSON. Use `h1`, `h2`, `h3`, `body`, `bullet`, `numbered`, `callout`, `table`, `image`, `figure`, `code`, `math`, `chart`, `flowchart`, `bibliography`, `divider`, `caption`, `pagebreak`, or `spacer`.

```json
[
  {"type": "h1", "text": "执行摘要"},
  {"type": "body", "text": "正文支持 <b>加粗</b> 和 <i>斜体</i>。"},
  {"type": "table", "headers": ["项目", "状态"], "rows": [["迁移", "完成"]]},
  {"type": "callout", "text": "封面和正文共享同一组设计令牌。"}
]
```

## FILL

Inspect fields before writing values so that names and valid choices are exact.

```powershell
python scripts/make.py fill --input .\form.pdf --inspect
python scripts/make.py fill --input .\form.pdf --out .\filled.pdf --values '{"FirstName":"Jane","Agree":"true"}'
```

## REFORMAT

Reformat Markdown, text, PDF, or content JSON through the same token and rendering path.

```powershell
python scripts/make.py reformat `
  --input .\source.md --title "年度报告" --type report `
  --theme formal-cn --out .\output.pdf
```

Review extracted PDF text before production use: PDF source extraction is necessarily best-effort.

## Visual verification

Always render pages after a layout-sensitive change, then inspect the resulting PNG files for clipped text, missing CJK glyphs, overlap, and table splits.

```powershell
python scripts/make.py preview --input .\report.pdf --out-dir .\preview
```

## Implementation map

`make.py` is the supported command entry point. `palette.py` builds document tokens; `pdf_cover.py` draws the cover; `render_body.py` lays out inner pages; `merge.py` performs final assembly; `render_preview.py` creates review images. `make.sh` remains a narrow compatibility shim.
