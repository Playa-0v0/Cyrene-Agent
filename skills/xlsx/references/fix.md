# FIX — 修復已有 xlsx 中的損壞公式

這是一項編輯任務。你必須保留所有原始工作表和數據。絕不創建新工作簿。

## 工作流

```bash
# 第 1 步：識別錯誤
python3 SKILL_DIR/scripts/formula_check.py input.xlsx --json

# 第 2 步：解包
python3 SKILL_DIR/scripts/xlsx_unpack.py input.xlsx /tmp/xlsx_work/

# 第 3 步：用 Edit 工具修復工作表 XML 中每個損壞的 <f> 元素
#   （見下方"錯誤→修復"映射）

# 第 4 步：打包並驗證
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
python3 SKILL_DIR/scripts/formula_check.py output.xlsx
```

## 錯誤→修復映射

| 錯誤 | 修復策略 |
|-------|-------------|
| `#DIV/0!` | 包裹：`IFERROR(原公式, "-")` |
| `#NAME?` | 修復拼錯的函數（如 `SUMM` → `SUM`） |
| `#REF!` | 重建斷裂的引用 |
| `#VALUE!` | 修復類型不匹配 |

完整的 Excel 錯誤類型列表和高級診斷，見 `validate.md`。

## 關鍵規則

- 輸出必須包含與輸入相同的工作表。絕不創建新工作簿。
- 只修改損壞的特定 `<f>` 元素 — 其他一切必須不動。
- 打包後，始終運行 `formula_check.py` 確認所有錯誤已解決。
