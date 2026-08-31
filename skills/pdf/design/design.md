# Design System

The aesthetic layer. Read this before touching any script.
This file answers "what should it look like and why."

---

## The one rule

Every design decision must be **rooted in the document's content and purpose**.
Dark teal + cream is not "professional". Serif + beige is not "elegant".
A color chosen because it fits the content will always outperform a color chosen
because it seems safe.

---

## Palette logic

`palette.py` takes a short content description and outputs `tokens.json`.
Here is the reasoning it applies:

### Mood → base palette

| Content signal | Mood | Background | Accent | Text |
|---|---|---|---|---|
| Research, science, analysis | Authoritative | `#0F1F2E` deep ink | `#00B4A6` teal | `#F0EDE6` warm white |
| Business, strategy, finance | Confident | `#1C1C2B` near-black | `#E8A020` amber | `#F5F2EC` cream |
| Creative, portfolio, design | Expressive | `#1A0A2E` deep violet | `#FF6B6B` coral | `#FAF5FF` lavender white |
| Education, academic paper | Scholarly | `#FAFAF7` warm white | `#2C4A7C` navy | `#1A1A2E` dark |
| Healthcare, wellness | Calm | `#F5F9F8` pale mint | `#2D8B72` forest | `#1E3830` deep green |
| Resume / personal | Clean | `#FFFFFF` white | pick from content | `#111111` near-black |
| General / unknown | Neutral | `#F8F6F1` warm off-white | `#3D3D3D` dark gray | `#1A1A1A` black |
| Formal publications, annual reports | Magazine | `#F2F0EC` warm linen | `#1C3557` deep navy | `#0D1A2B` near-black |
| Premium/dark reports, tech reviews | Darkroom | `#151C27` deep navy | `#4A6FA5` steel blue | `#F0EDE6` warm white |
| Technical docs, developer reports | Terminal | `#0D1117` near-black | `#39D353` neon green | `#E6EDF3` cool white |
| Portfolios, creative, photography | Poster | `#FFFFFF` white | `#0A0A0A` near-black | `#0A0A0A` near-black |

### Accent selection rules

- **One accent color only.** Using two accents splits visual energy.
- Accent appears on: cover geometric elements, section rules, callout left borders,
  table header background, page header rule. Nowhere else.
- Accent must contrast with the cover background by at least 4.5:1 (WCAG AA).
- Do not default to blue. Blue is the most overused accent in AI-generated documents.

### Color pairing anti-patterns (never use these)

| ❌ Avoid | Why |
|---|---|
| Purple gradient on white | The default AI aesthetic — immediately signals "generated" |
| Navy + gold | Overused corporate cliché |
| All-black background | Prints badly, feels aggressive |
| More than 3 colors in the system | Visual noise |
| Accent on body text | Destroys readability |

---

## Typography system

### Font pairing logic

Two typefaces maximum. Always.

| Role | Criteria | Good choices (system-safe) |
|---|---|---|
| Display (cover title, H1) | Distinctive, strong contrast, high weight | Times New Roman, Georgia (serif) |
| Text (body, captions, UI) | Highly readable at 10–11pt | Helvetica, Arial (sans) |

The renderer uses locally available Windows fonts for Chinese production documents.
Body pages fall back to standard PDF fonts only when no local CJK font is available.

Pairs by mood (mapped to locally available display and body fonts):
- Authoritative: `Playfair Display` / `IBM Plex Sans`
- Confident: `Syne` / `Nunito Sans`
- Expressive: `Fraunces` / `Inter`
- Scholarly: `EB Garamond` / `Source Sans 3`
- Clean: `DM Serif Display` / `DM Sans`
- Restrained: `Cormorant Garamond` / `Jost`
- Bold: `Barlow Condensed` / `Barlow`
- Dynamic: `Montserrat` / `Montserrat`
- Classical: `Cormorant` / `Crimson Pro`
- Editorial: `Bebas Neue` / `Libre Franklin`
- Body fallback (always): `Times-Bold` / `Helvetica` (ReportLab system fonts)

### Type scale

All sizes in points. This scale is used by `palette.py` to populate `tokens.json`.

| Token | Size | Leading | Usage |
|---|---|---|---|
| `display` | 54pt | 1.0 | Cover title |
| `h1` | 22pt | 1.3 | Section headings |
| `h2` | 15pt | 1.4 | Subsection headings |
| `h3` | 11.5pt | 1.5 | Sub-subsection |
| `body` | 10.5pt | 1.6 | Main prose |
| `caption` | 8.5pt | 1.4 | Figure/table captions |
| `meta` | 8pt | 1.3 | Header/footer text |

### Spacing system

Margins and rhythm are what separate "looks designed" from "looks printed".

| Token | Value | Notes |
|---|---|---|
| `margin_outer` | 2.8cm | Left/right page margin |
| `margin_top` | 2.8cm | Top page margin |
| `margin_bottom` | 2.5cm | Bottom page margin |
| `section_gap` | 26pt | Space before H1 |
| `para_gap` | 8pt | Space after paragraph |
| `line_gap` | 17pt | Leading for body text |

Never use ReportLab's default margins (too tight). Always set explicitly.

---

## Cover design

The cover is the most important page. It determines whether a reader trusts the document.

### Thirteen cover patterns

`pdf_cover.py` selects one based on `tokens.json["cover_pattern"]`.

**1. `fullbleed`** — used for: `report`, `general`
- Deep background fills 100% of page
- Title: large, left-aligned, upper 60% of page
- Accent: thin horizontal rule + top-right corner strip
- Dot-grid background texture (subtle, 8–10% opacity)
- Footer band: author + date metadata
- Fonts: Playfair Display / IBM Plex Sans

**2. `split`** — used for: `proposal`
- Left 42% panel: solid cover color, title + author
- Right 58%: off-white, dot-grid decoration
- Hard vertical dividing line in accent color
- No gradients — pure flat geometry
- Fonts: Syne / Nunito Sans

**3. `typographic`** — used for: `resume`, `academic`
- White/off-white background
- Name or title as oversized display type (60–80pt), left-aligned
- First word in accent color, remainder in dark
- Thin rule below title block
- Fonts: DM Serif Display / DM Sans (resume) · EB Garamond / Source Sans 3 (academic)

**4. `atmospheric`** — used for: `portfolio`
- Near-black background
- Soft radial glow in accent color (upper-right quadrant)
- Title centered-left, 2 lines max
- Short rule in accent below title
- Dot-grid texture at low opacity
- Fonts: Fraunces / Inter

**5. `minimal`** — used for: `minimal`
- Near-white background, 8px left accent bar is the only color
- Title in very large, light-weight display type (300 weight)
- Hairline rule, author + date as single muted line
- Nothing else — the bar does all the visual work
- Fonts: Cormorant Garamond / Jost

**6. `stripe`** — used for: `stripe`
- Page cut into three horizontal bands: accent / dark / light
- Top band: category label; middle: oversized title in white; bottom: metadata
- Hard edges, no gradients, no textures — newspaper / brand poster aesthetic
- Fonts: Barlow Condensed / Barlow

**7. `diagonal`** — used for: `diagonal`
- SVG polygon cuts page diagonally: dark upper-left, light lower-right
- Accent-colored edge line traces the diagonal cut
- Title on dark area, metadata on light area
- Fonts: Montserrat / Montserrat

**8. `frame`** — used for: `frame`
- White/cream background with an inset rectangular border (1.2px, 28px from edges)
- Accent strips inside top + bottom of frame; small accent corner squares
- Title centered in the frame space, centered alignment, classical weight
- Formal, timeless — annual reports, legal documents, academic papers
- Fonts: Cormorant / Crimson Pro

**9. `editorial`** — used for: `editorial`
- Ghost first-letter of title fills upper-right at 5% opacity — visual texture
- 5px accent top bar; full-width uppercase title in condensed weight
- Title all-caps, very large (80px), flush-left
- Footer rule + author/date metadata
- Fonts: Bebas Neue / Libre Franklin

**10. `magazine`** — used for: `magazine`
- Warm cream/linen background; fully centered, vertical stack layout
- Org/company name in small spaced caps + 2px accent rule beneath (top anchor)
- Large bold serif title (52px) centered; short accent rule under title
- Italic subtitle; optional `cover_image` URL renders as centered hero thumbnail
- Optional `abstract` field: justified text block with bold "Abstract:" label
- Author name in accent color (large, bold); date beneath
- Fonts: Playfair Display / EB Garamond

**11. `darkroom`** — used for: `darkroom`
- Same centered stack layout as `magazine` but deep navy background, white text
- Org name + rules in semi-transparent white; accent rules desaturated
- Hero image (if provided) gets `grayscale(20%) brightness(0.9)` filter
- Fonts: Playfair Display / EB Garamond

**12. `terminal`** — used for: `terminal`
- Near-black background; neon green accent; Space Mono monospace throughout
- Grid overlay: faint horizontal + vertical lines at 48px intervals (7% opacity)
- Status label top-left: green dot + `SYSTEM_REPORT // <date>`
- Title inside a bracket frame (border-left + border-top + pseudo-element corner)
- Subtitle prefixed with `>` in accent color
- Abstract text left; author block right; status bar at bottom (UTF-8 / Ln 1)
- Fonts: Space Mono / Space Mono

**13. `poster`** — used for: `poster`
- White background; thick 52px left sidebar in accent (typically near-black)
- Title: 96px, 900-weight, all-caps, condensed — the dominant visual element
- Subtitle in typewriter font below title; thin 2px rule as separator
- Author + meta in Courier Prime monospace beneath rule
- Optional `cover_image` rendered as 260×340 grayscale thumbnail, right-aligned
- Accent square icon block (lower-right) with white horizontal lines
- Fonts: Barlow Condensed / Courier Prime

### Optional token: `cover_image`

Patterns `magazine`, `darkroom`, and `poster` accept an optional `cover_image`
token containing a local image path.
The renderer reads it directly from disk.
If omitted, the image area is simply skipped (layout adjusts gracefully).

### Cover drawing requirements

- Draw every cover on an A4, zero-margin canvas.
- Measure title width with the active PDF font before wrapping text.
- Keep decorative layers inside the page bounds.
- Draw a solid background beneath every gradient-like decoration.
- Treat local images as optional and leave a balanced placeholder when absent.

### What always kills a cover

- Centered title on white background with a thin horizontal line underneath
- Gradient from one color to another (reads as PowerPoint, not print design)
- Drop shadows on text
- More than one accent color
- Emoji or icon fonts (fail silently on headless Chromium)

---

## Inner page rules

### What "restraint" means in practice

Every design decision should remove something, not add something.
The page is done when there is nothing left to remove.

- Accent color appears on section rules only — not on headings, not on bullets
- No card components (bordered boxes with colored headers)
- No rounded corners on anything except callout boxes (4px max)
- No shadows anywhere
- Tables: header row in accent, alternating row tint, no grid lines except outer box
- Callout boxes: left border in accent (4px), very light tint background, no icon

### Page header / footer

Header: document title (left, 7.5pt, muted) + accent rule (1.5pt, full width below)
Footer: author name (left, 7.5pt, muted) + page number (right, 7.5pt, muted) + light rule above

---

## Quality bar

A PDF passes if a designer would not be embarrassed to hand it to a client.
Concretely:

- Cover has a clear visual identity that is not "generic AI output"
- Body text is readable at arm's length without squinting
- Every page looks like it belongs to the same document
- No element bleeds off the edge or overlaps another
- Page numbers are present and correct
- The accent color appears fewer than 8 times per page on average

---

## Block type reference

All body blocks use the same token system — colors and fonts come from `tokens.json`, never hardcoded.

| Block | Rendering | Design notes |
|---|---|---|
| `h1` | 22pt heading + full-width accent rule below | KeepTogether with rule — heading never orphaned |
| `h2` | 15pt heading, dark text | No rule, no accent — visual hierarchy through size only |
| `h3` | 11.5pt bold, dark text | **No accent color** — accent on body headings violates the one-accent-location rule |
| `body` | 10.5pt justified, 17pt leading | Supports `<b>` `<i>` `<font>` markup |
| `bullet` | Body size with `•` prefix, 14pt indent | Use for unordered lists |
| `numbered` | Body size with `N.` prefix, hanging indent | Counter auto-resets on any non-numbered block — no manual numbering needed |
| `callout` | Accent left-border (4px) + light tint background | Max one callout per section — overuse kills impact |
| `table` | Accent header row, alternating row tint, outer box only | Supports `col_widths` (fractions, e.g. `[0.3, 0.5, 0.2]`) for custom column widths |
| `image` | Scaled to column width, preserving aspect ratio | Use `path` or `src`; always provide a `caption` |
| `figure` | Same as image, but caption auto-prefixed "Figure N:" | Figure counter increments across all `figure`, `chart`, `flowchart` blocks |
| `code` | Courier 8.5pt, accent left-border, light tint background | Supports optional `language` label (rendered above block) |
| `math` | Formula centered, optional right-aligned equation label | LaTeX syntax; matplotlib mathtext renderer |
| `chart` | Bar / line / pie chart rendered via matplotlib | Color palette derived from document accent; figure auto-numbered |
| `flowchart` | Process diagram with labeled arrows | Supports 4 node shapes; back-edges drawn as curved arcs |
| `bibliography` | Numbered reference list with hanging indent | Heading rendered as h2 + accent rule; items as `[N] text` |
| `divider` | Accent-colored 1.2pt rule with padding | Use sparingly — only for major thematic breaks |
| `caption` | 8.5pt muted text, centered | Appears below images/tables via field or explicit block |
| `pagebreak` | Force page break | — |
| `spacer` | Vertical whitespace | `pt` field (default 12) |

### Math formula guidance

**Input syntax:** standard LaTeX math notation — `\frac{}{}`, `\int`, `\sum`, `\alpha`, `^`, `_`, etc.
**Rendering engine:** matplotlib mathtext — pure Python, no LaTeX compiler, no browser required.

| Syntax example | Rendered as |
|---|---|
| `E = mc^2` | Inline expression |
| `\frac{\sqrt{\pi}}{2}` | Fraction |
| `\int_0^\infty e^{-x^2} dx` | Integral |
| `\sum_{i=1}^{n} x_i` | Summation |
| `\alpha + \beta = \gamma` | Greek letters |

**Limitations:** matplotlib mathtext covers most common expressions but not advanced LaTeX environments (`align`, `cases`, `matrix`). Split complex multi-line proofs into multiple `math` blocks.

**Fallback:** if matplotlib is not installed, renders as `expression` in code style. Install it explicitly with `python -m pip install matplotlib` when richer math rendering is required.

**Equation labels:** `"label": "(1)"` — rendered right-aligned beside the formula.

### Chart guidance

**Rendered entirely in Python** — no external chart services, image files, or internet required.

| chart_type | Use case | Required fields |
|---|---|---|
| `bar` | Comparing discrete categories | `labels`, `datasets` |
| `line` | Trends over time or ordered categories | `labels`, `datasets` |
| `pie` | Part-to-whole composition | `labels`, `datasets[0].values` |

- Colors are derived from the document accent for visual consistency — do not set custom colors.
- Multi-series: add multiple objects to `datasets`, each with a `label` and `values` array.
- Figure auto-numbering: set `"figure": true` (default) or `"figure": false` to suppress.

### Flowchart guidance

**Node shapes:**

| shape | Use for |
|---|---|
| `rect` (default) | Process step |
| `diamond` | Decision / condition |
| `oval` or `terminal` | Start / End |
| `parallelogram` | Input / Output |

- Nodes are placed in input order (top to bottom). This controls the layout.
- Forward edges draw straight arrows; back-edges (to earlier nodes) draw curved arcs.
- Keep labels short (3–5 words max) — the diagram is A4-column-width at 78% scale.
- Figure auto-numbering applies same as chart.

### Bibliography guidance

- `id` field is the reference label — use numbers ("1", "2") or alphanumeric ("Smith23").
- Text should be in a consistent citation style (APA, Chicago, etc.) — the renderer does not enforce style.
- The `title` field defaults to "References". Set `"title": ""` to suppress the heading.
- A `bibliography` block always starts with a new section heading + accent rule.

### Image / figure guidance

- Preferred formats: PNG, JPEG
- Scaled down if wider than the text column; never scaled up
- `figure` blocks auto-number; `image` blocks do not — use `figure` for numbered figures
- If the file does not exist at render time, a `[Image not found]` placeholder is substituted

### Code block guidance

- Preserves whitespace exactly — do not indent code in the JSON value
- Optional `language` field renders a small language label above the block (e.g., `"language": "python"`)
- No syntax highlighting (by design) — consistent with restraint principle
- Keep lines under ~90 characters for A4 column width
