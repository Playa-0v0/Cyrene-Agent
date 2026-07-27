---
name: minimax-xlsx
description: "打開、創建、讀取、分析、編輯或驗證 Excel/電子表格文件（.xlsx、.xlsm、.csv、.tsv）。當用戶要求創建、構建、修改、分析、讀取、驗證或格式化任何 Excel 電子表格、財務模型、數據透視表或表格數據文件時使用。涵蓋：從零創建新的 xlsx、讀取和分析已有文件、零格式丟失地編輯已有 xlsx、公式重算與驗證，以及應用專業財務格式化標準。觸發詞：'spreadsheet'、'Excel'、'.xlsx'、'.csv'、'pivot table'、'financial model'、'formula'，或任何要求以 Excel 格式輸出表格數據的請求。"
license: MIT
metadata:
  version: "1.0"
  category: productivity
  sources:
    - ECMA-376 Office Open XML File Formats
    - Microsoft Open XML SDK documentation
---

# MiniMax XLSX Skill

直接處理請求。**禁止**生成子 agent。始終將輸出文件寫入用戶請求的路徑。

## ⚠️ 先判斷：是否需要本 Skill

在開始任何操作前，先判斷任務複雜度：

- **簡單表格生成**（數據整理、換算導出、清單列表）→ **直接用 `write_excel` 工具**，不要繼續讀本 Skill。
  `write_excel` 已內置美觀樣式（表頭加粗、邊框、斑馬紋、列寬自適應、凍結首行）和支持自定義顏色。

  如果用戶要求"美觀""好看"等模糊風格，先讀 `styles/catalog.md`（樣式目錄），
  從中選 2-4 個風格作為選項，用 `ask_user_choice` 彈卡片讓用戶選擇。
  **第一個選項固定是 `default`（默認深藍）**，後面由你根據任務場景自選。
  用戶選完後將風格名傳給 `write_excel` 的 `style` 參數即可。
  用戶也可以在卡片裡自定義輸入，你把顏色描述翻譯成 ARGB hex 傳給 `colors` 參數。

- **需要以下任一才繼續本 Skill**：
  - Excel 公式（`SUM`、`VLOOKUP`、跨表引用等）
  - 編輯已有 xlsx 文件（保留原有格式/宏/透視表）
  - 財務格式化標準（藍/黑/綠顏色編碼）
  - 公式驗證與重算

## 腳本路徑

本 Skill 的腳本在 `SKILL_DIR/scripts/` 下，模板在 `SKILL_DIR/templates/` 下。
`SKILL_DIR` 的實際路徑在 invoke_skill 返回的清單中已標註，或可通過以下命令快速定位：
```bash
python3 -c "import os,glob; print([p for p in glob.glob(os.path.expanduser('~/Desktop/**/xlsx_pack.py'),recursive=True)][:1])"
```
**不要**花多輪搜索路徑——拿到路徑後立即開始執行。

## 任務路由

| 任務 | 方法 | 指南 |
|------|--------|-------|
| **READ** — 分析已有數據 | `xlsx_reader.py` + pandas | `references/read-analyze.md` |
| **CREATE** — 從零創建新 xlsx | XML 模板 | `references/create.md` + `references/format.md` |
| **EDIT** — 修改已有 xlsx | XML 解包→編輯→打包 | `references/edit.md`（如需樣式參見 `format.md`） |
| **FIX** — 修復已有 xlsx 中損壞的公式 | XML 解包→修復 `<f>` 節點→打包 | `references/fix.md` |
| **VALIDATE** — 檢查公式 | `formula_check.py` | `references/validate.md` |

### 執行紀律（必須遵守）

1. **只讀完成任務所需的最少 reference**——讀完能執行就立即開始，不要把所有文檔都讀一遍。
2. **同一 reference 文件不要重複讀取**（系統會攔截重複讀取）。
3. **不要用 list_dir 遍歷 templates/scripts 目錄**——路徑上文已給出，直接用。
4. **信息足夠後立即執行**——不要繼續研究格式文檔。
5. **若預計輪數緊張，優先輸出可交付版本**而非繼續優化格式。

## READ — 分析數據（先閱讀 `references/read-analyze.md`）

先使用 `xlsx_reader.py` 進行結構發現，然後用 pandas 進行自定義分析。**禁止**修改源文件。

**格式化規則**：當用戶指定小數位數（如"保留 2 位小數"）時，將該格式應用於**所有**數值——對每個數字使用 `f'{v:.2f}'`。在要求 `12875.00` 的情況下，**禁止**輸出 `12875`。

**聚合規則**：始終直接從 DataFrame 列計算總和/均值/計數——例如 `df['Revenue'].sum()`。**禁止**在聚合前重新派生列值。

## CREATE — XML 模板（閱讀 `references/create.md` + `references/format.md`）

複製 `templates/minimal_xlsx/` → 直接編輯 XML → 使用 `xlsx_pack.py` 打包。每個派生值必須為 Excel 公式（`<f>SUM(B2:B9)</f>`），**禁止**硬編碼數字。按照 `format.md` 應用字體顏色。

**注意**：僅當需要 Excel 公式時才走此路徑。簡單數據表格用 `write_excel` 工具即可。

## EDIT — XML 直接編輯（先閱讀 `references/edit.md`）

**關鍵 — 編輯完整性規則：**
1. **禁止為編輯任務創建新的 `Workbook()`。**始終加載原始文件。
2. 輸出**必須**包含與輸入**相同的工作表**（相同名稱、相同數據）。
3. 僅修改任務要求修改的特定單元格——其他所有內容必須保持原樣。
4. **保存 output.xlsx 後，必須驗證**：使用 `xlsx_reader.py` 或 `pandas` 打開並確認原始工作表名稱和原始數據樣本仍然存在。如果驗證失敗，說明你寫入了錯誤的文件——在交付前修復。

**禁止**在已有文件上使用 openpyxl 往返操作（會損壞 VBA、數據透視表、迷你圖）。正確做法：解包 → 使用輔助腳本 → 重新打包。

**"填充單元格" / "向已有單元格添加公式" = EDIT 任務。**如果輸入文件已存在，並且被告知要填充、更新或向特定單元格添加公式，**必須**使用 XML 編輯路徑。**禁止**創建新的 `Workbook()`。示例 — 用跨工作表 SUM 公式填充 B3：
```bash
python3 SKILL_DIR/scripts/xlsx_unpack.py input.xlsx /tmp/xlsx_work/
# 通過 xl/workbook.xml → xl/_rels/workbook.xml.rels 找到目標工作表的 XML
# 然後使用 Edit 工具在目標 <c> 元素內添加 <f>：
#   <c r="B3"><f>SUM('Sales Data'!D2:D13)</f><v></v></c>
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
```

**添加列**（公式、numfmt、樣式自動從相鄰列複製）：
```bash
python3 SKILL_DIR/scripts/xlsx_unpack.py input.xlsx /tmp/xlsx_work/
python3 SKILL_DIR/scripts/xlsx_add_column.py /tmp/xlsx_work/ --col G \
    --sheet "Sheet1" --header "% of Total" \
    --formula '=F{row}/$F$10' --formula-rows 2:9 \
    --total-row 10 --total-formula '=SUM(G2:G9)' --numfmt '0.0%' \
    --border-row 10 --border-style medium
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
```
`--border-row` 標誌對該行中的**所有**單元格（不僅僅是新列）應用上邊框。當任務要求在合計行使用會計樣式邊框時使用。

**插入行**（下移已有行、更新 SUM 公式、修復循環引用）：
```bash
python3 SKILL_DIR/scripts/xlsx_unpack.py input.xlsx /tmp/xlsx_work/
# 重要：通過在工作表 XML 中搜索標籤文本來找到正確的 --at 行，
# 而不是使用提示中的行號。
# 提示可能寫 "row 5 (Office Rent)" 但 Office Rent 實際可能位於第 4 行。
# 始終首先通過文本標籤定位行。
python3 SKILL_DIR/scripts/xlsx_insert_row.py /tmp/xlsx_work/ --at 5 \
    --sheet "Budget FY2025" --text A=Utilities \
    --values B=3000 C=3000 D=3500 E=3500 \
    --formula 'F=SUM(B{row}:E{row})' --copy-style-from 4
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
```
**行查找規則**：當任務說"在行 N（標籤）之後"時，始終通過在工作表 XML 中搜索"標籤"來找到該行（`grep -n "Label" /tmp/xlsx_work/xl/worksheets/sheet*.xml` 或檢查 sharedStrings.xml）。使用實際行號 + 1 作為 `--at`。**禁止**單獨調用 `xlsx_shift_rows.py`——`xlsx_insert_row.py` 內部已調用它。

**應用整行邊框**（例如在 TOTAL 行上加會計線）：
運行輔助腳本後，對目標行中的**所有**單元格應用邊框，而不僅僅是新添加的單元格。在 `xl/styles.xml` 中，追加帶有所需樣式的新 `<border>`，然後在 `<cellXfs>` 中追加一個新的 `<xf>`，該 `<xf>` 克隆每個單元格的已有 `<xf>` 但設置新的 `borderId`。通過 `s` 屬性將新樣式索引應用於該行中的每個 `<c>`：
```xml
<!-- 在 xl/styles.xml 中，追加到 <borders>： -->
<border>
  <left/><right/><top style="medium"/><bottom/><diagonal/>
</border>
<!-- 然後在 <cellXfs> 中為每個已有樣式追加一個帶有新 borderId 的 xf 克隆 -->
```
**關鍵規則**：當任務說"向第 N 行添加邊框"時，遍歷 A 列到最後一列的**所有**單元格，而不僅僅是新添加的單元格。

**手動 XML 編輯**（用於輔助腳本無法覆蓋的情況）：
```bash
python3 SKILL_DIR/scripts/xlsx_unpack.py input.xlsx /tmp/xlsx_work/
# ... 使用 Edit 工具編輯 XML ...
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
```

## FIX — 修復損壞的公式（先閱讀 `references/fix.md`）

這是一個 EDIT 任務。解包 → 修復損壞的 `<f>` 節點 → 打包。保留所有原始工作表和數據。

## VALIDATE — 檢查公式（先閱讀 `references/validate.md`）

運行 `formula_check.py` 進行靜態驗證。可用時使用 `libreoffice_recalc.py` 進行動態重算。

## 財務顏色標準

| 單元格角色 | 字體顏色 | Hex 代碼 |
|-----------|-----------|----------|
| 硬編碼輸入/假設 | 藍色 | `0000FF` |
| 公式/計算結果 | 黑色 | `000000` |
| 跨工作表引用公式 | 綠色 | `00B050` |

## 關鍵規則

1. **先判斷複雜度**：簡單表格用 `write_excel`，需要公式/編輯才用本 Skill
2. **公式優先**：每個計算單元格**必須**使用 Excel 公式，**禁止**硬編碼數字
3. **CREATE → XML 模板**：複製最小模板，直接編輯 XML，使用 `xlsx_pack.py` 打包
4. **EDIT → XML**：**禁止** openpyxl 往返操作。使用解包/編輯/打包腳本
5. **始終生成輸出文件** — 這是最高優先級
6. **交付前驗證**：`formula_check.py` 退出碼 0 = 安全

## 實用腳本

```bash
python3 SKILL_DIR/scripts/xlsx_reader.py input.xlsx                 # 結構發現
python3 SKILL_DIR/scripts/formula_check.py file.xlsx --json         # 公式驗證
python3 SKILL_DIR/scripts/formula_check.py file.xlsx --report      # 標準化報告
python3 SKILL_DIR/scripts/xlsx_unpack.py in.xlsx /tmp/work/         # 解包用於 XML 編輯
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/work/ out.xlsx          # 編輯後重新打包
python3 SKILL_DIR/scripts/xlsx_shift_rows.py /tmp/work/ insert 5 1  # 下移行以插入
python3 SKILL_DIR/scripts/xlsx_add_column.py /tmp/work/ --col G ... # 添加帶公式的列
python3 SKILL_DIR/scripts/xlsx_insert_row.py /tmp/work/ --at 6 ...  # 插入帶數據的行
```
