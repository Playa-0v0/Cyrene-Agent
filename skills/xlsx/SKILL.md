---
name: xlsx
description: Create, read, edit, recalculate, and verify Excel workbooks on Windows while preserving formulas and existing workbook structure.
license: MIT
metadata:
  version: "2.0"
  category: productivity
---

# Windows-native XLSX workflow

Use existing XML helpers for formula work or edits of existing `.xlsx` files. Do not make a new workbook when the task is to edit an existing one: unpack, make the smallest XML change, pack, then validate.

For a simple data-only table, use the platform's normal workbook writer instead. This skill is for formulas, formatting-sensitive edits, macros, pivot preservation, and formula validation.

## Workspace and discovery

Create an isolated workspace under the Windows temporary directory, not beside the source file.

```powershell
python scripts/xlsx_workspace.py create --base-dir $env:TEMP
python scripts/xlsx_reader.py .\input.xlsx
python scripts/xlsx_workspace.py find-label --input .\input.xlsx --label "Office Rent"
```

`find-label` returns the actual worksheet, cell, and row. Use it before inserting a row from an instruction such as “insert after Office Rent”; do not trust a prompt-provided row number.

## Edit existing workbooks

```powershell
$work = Join-Path $env:TEMP 'cyrene-xlsx-work'
python scripts/xlsx_unpack.py .\input.xlsx $work
python scripts/xlsx_add_column.py $work --sheet "Budget FY2026" --col G --header "% of Total" --formula '=F{row}/$F$10' --formula-rows 2:9 --total-row 10 --total-formula '=SUM(G2:G9)' --numfmt '0.0%'
python scripts/xlsx_pack.py $work .\output.xlsx
python scripts/formula_check.py .\output.xlsx --report
```

Use a unique directory returned by `xlsx_workspace.py create` for concurrent tasks. Keep it until validation has passed, then remove only that known workspace.

## Create formula workbooks

Read `references/create.md` and `references/format.md`, copy `templates/minimal_xlsx/` to the temporary workspace, edit the XML, then pack it. Every calculated value must be an Excel formula, never a precomputed hard-coded number.

## Visual system

Read `../office-design/assets/themes/` before choosing colors. Map the selected theme deliberately: `primary` for major headers, `accent` for focus, `surface` for table fills, `muted` for secondary text, and `warning`/`success` only for semantic states. Retain the workbook’s existing styling for edits unless the user asked for a visual redesign.

Financial convention: hard-coded inputs are blue (`0000FF`), formulas black (`000000`), and cross-sheet formulas green (`00B050`).

## Validate and recalculate

```powershell
python scripts/formula_check.py .\output.xlsx --json
python scripts/libreoffice_recalc.py .\output.xlsx .\output-recalculated.xlsx --timeout 90
python scripts/formula_check.py .\output-recalculated.xlsx --report
```

`formula_check.py` is required before delivery. LibreOffice is optional for dynamic recalculation; when it is installed, the helper locates standard Windows installation paths automatically.

## Rules

1. Preserve all original worksheets, names, values, macros, and unrelated XML parts during edits.
2. Use XML unpack/edit/pack for existing workbooks; do not round-trip them through `openpyxl`.
3. Confirm the expected sheet names and a source data sample after repacking.
4. Use `find-label` to locate labeled rows rather than a text-search command tied to a particular shell.
5. Never overwrite the input file; write and validate an explicit output file.
