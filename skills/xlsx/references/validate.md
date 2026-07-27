# 公式驗證與重算指南

確保 xlsx 文件中每個公式在交付前可證明正確。打開無可見錯誤的文件不是通過的文件 — 只有通過兩層驗證的文件才是通過的文件。

---

## 基礎規則

- **未先運行 `formula_check.py` 絕不聲明 PASS。** 電子表格的視覺檢查不是驗證。
- **第 1 層（靜態）在每個場景中都強制。** 第 2 層（動態）在 LibreOffice 可用時強制。若不可用，必須在報告中明確說明 — 不可靜默跳過。
- **絕不用 openpyxl `data_only=True` 檢查公式值。** 以 `data_only=True` 模式打開並保存工作簿會永久用最後緩存值替換所有公式。公式之後無法恢復。
- **只自動修復確定性錯誤。** 任何需理解業務邏輯的修復必須標記為人工審閱。

---

## 兩層驗證架構

```
第 1 層 — 靜態驗證（XML 掃描，無需外部工具）
  │
  ├── 檢測：已緩存在 <v> 元素中的全部 7 種 Excel 錯誤類型
  ├── 檢測：指向不存在工作表的跨表引用
  ├── 檢測：帶 t="e" 屬性的公式單元格（錯誤類型標記）
  └── 工具：formula_check.py + 手動 XML 檢查
        │
        ▼（若 LibreOffice 存在）
第 2 層 — 動態驗證（LibreOffice 無頭重算）
  │
  ├── 通過 LibreOffice Calc 引擎執行所有公式
  ├── 用真實計算結果填充 <v> 緩存值
  ├── 暴露重算前不可見的運行時錯誤
  └── 後續：對重算後的文件重新運行第 1 層
```

**為何兩層？**

openpyxl 和所有 Python xlsx 庫將公式字符串（如 `=SUM(B2:B9)`）寫入 `<f>` 元素但不求值。新生成的文件每個公式單元格的 `<v>` 緩存元素為空。這意味著：

- 第 1 層只能捕獲已編碼在 XML 中的錯誤 — 要麼是 `t="e"` 單元格，要麼是結構斷裂的跨表引用。
- 第 2 層用 LibreOffice 作實際計算引擎，運行每個公式，用真實結果填充 `<v>`，並暴露只能在計算後出現的運行時錯誤（`#DIV/0!`、`#N/A` 等）。

單獨任一層都不夠。兩者合起來覆蓋完整的可糾正面。

---

## 第 1 層 — 靜態驗證

靜態驗證無需外部工具。直接操作 xlsx 文件的 ZIP/XML 結構。

### 第 1 步：運行 formula_check.py

**標準（人類可讀）輸出：**

```bash
python3 SKILL_DIR/scripts/formula_check.py /path/to/file.xlsx
```

**JSON 輸出（用於程序化處理）：**

```bash
python3 SKILL_DIR/scripts/formula_check.py /path/to/file.xlsx --json
```

**單表模式（定向檢查更快）：**

```bash
python3 SKILL_DIR/scripts/formula_check.py /path/to/file.xlsx --sheet Summary
```

**摘要模式（僅計數，無逐單元格詳情）：**

```bash
python3 SKILL_DIR/scripts/formula_check.py /path/to/file.xlsx --summary
```

退出碼：
- `0` — 無硬錯誤（PASS 或 PASS 帶啟發式警告）
- `1` — 檢測到硬錯誤，或文件無法打開（FAIL）

#### formula_check.py 檢查什麼

腳本將 xlsx 作為 ZIP 歸檔打開，不使用任何 Excel 庫。它讀 `xl/workbook.xml` 枚舉工作表名和命名區域，讀 `xl/_rels/workbook.xml.rels` 將每個工作表映射到其 XML 文件，然後遍歷每個工作表中每個 `<c>` 元素。

它執行五項檢查：

1. **錯誤值檢測**：若單元格有 `t="e"`，其 `<v>` 元素含 Excel 錯誤字符串。記錄該單元格的工作表名、單元格引用（如 `C5`）、錯誤值，以及公式文本（若存在）。

2. **斷裂跨表引用檢測**：若單元格有 `<f>` 元素，腳本提取公式中引用的所有工作表名（`SheetName!` 和 `'Sheet Name'!` 兩種語法）。每個名與 `workbook.xml` 中的工作表列表比較。不匹配即為斷裂引用。

3. **未知命名區域檢測（啟發式）**：公式中既非函數名、非單元格引用、又不在 `workbook.xml` 的 `<definedNames>` 中的標識符，標記為 `unknown_name_ref` 警告。這是啟發式 — 可能誤報；始終手動驗證。

4. **共享公式完整性**：共享公式消費單元格（僅含 `<f t="shared" si="N"/>`）跳過公式計數和跨引用檢查，因為它們繼承主單元格公式。只檢查並計數主單元格（有 `ref="..."` 屬性和公式文本）。

5. **畸形錯誤單元格**：有 `t="e"` 但無 `<v>` 子元素的單元格標記為結構性 XML 問題。

硬錯誤（退出碼 1）：`error_value`、`broken_sheet_ref`、`malformed_error_cell`、`file_error`
軟警告（退出碼 0）：`unknown_name_ref` — 必須手動驗證但單獨不阻止交付

#### 閱讀 formula_check.py 人類可讀輸出

乾淨文件長這樣：

```
File   : /tmp/budget_2024.xlsx
Sheets : Summary, Q1, Q2, Q3, Q4, Assumptions
Formulas checked      : 312 distinct formula cells
Shared formula ranges : 4 ranges
Errors found          : 0

PASS — No formula errors detected
```

有錯誤的文件長這樣：

```
File   : /tmp/budget_2024.xlsx
Sheets : Summary, Q1, Q2, Q3, Q4, Assumptions
Formulas checked      : 312 distinct formula cells
Shared formula ranges : 4 ranges
Errors found          : 4

── Error Details ──
  [FAIL] [Summary!C12] contains #REF! (formula: Q1!A0/Q1!A1)
  [FAIL] [Summary!D15] references missing sheet 'Q5'
         Formula: Q5!D15
         Valid sheets: ['Assumptions', 'Q1', 'Q2', 'Q3', 'Q4', 'Summary']
  [FAIL] [Q1!F8] contains #DIV/0!
  [WARN] [Q2!B10] uses unknown name 'GrowthAssumptions' (heuristic — verify manually)
         Formula: SUM(GrowthAssumptions)
         Defined names: ['RevenueRange', 'CostRange']

FAIL — 3 error(s) must be fixed before delivery
WARN — 1 heuristic warning(s) require manual review
```

每行解讀：
- `[FAIL] [Summary!C12] contains #REF! (formula: Q1!A0/Q1!A1)` — 單元格有 `t="e"` 和 `<v>#REF!</v>`。公式引用行 0，Excel 的 1 起始系統中不存在。這是生成引用的差一錯誤。
- `[FAIL] [Summary!D15] references missing sheet 'Q5'` — 公式含 `Q5!D15`，但工作簿中無名為 `Q5` 的工作表。提供有效工作表列表供比較。
- `[FAIL] [Q1!F8] contains #DIV/0!` — 此單元格的 `<v>` 已是錯誤值（文件之前被重算過）。公式除以零。
- `[WARN] [Q2!B10] uses unknown name 'GrowthAssumptions'` — 標識符 `GrowthAssumptions` 出現在公式中但不在 `<definedNames>`。可能是拼寫錯誤或意外遺漏的名稱。這是啟發式警告 — 手動驗證。單獨警告不阻止交付。

#### 閱讀 formula_check.py JSON 輸出

```json
{
  "file": "/tmp/budget_2024.xlsx",
  "sheets_checked": ["Summary", "Q1", "Q2", "Q3", "Q4", "Assumptions"],
  "formula_count": 312,
  "shared_formula_ranges": 4,
  "error_count": 4,
  "errors": [
    {
      "type": "error_value",
      "error": "#REF!",
      "sheet": "Summary",
      "cell": "C12",
      "formula": "Q1!A0/Q1!A1"
    },
    {
      "type": "broken_sheet_ref",
      "sheet": "Summary",
      "cell": "D15",
      "formula": "Q5!D15",
      "missing_sheet": "Q5",
      "valid_sheets": ["Assumptions", "Q1", "Q2", "Q3", "Q4", "Summary"]
    },
    {
      "type": "error_value",
      "error": "#DIV/0!",
      "sheet": "Q1",
      "cell": "F8",
      "formula": null
    },
    {
      "type": "unknown_name_ref",
      "sheet": "Q2",
      "cell": "B10",
      "formula": "SUM(GrowthAssumptions)",
      "unknown_name": "GrowthAssumptions",
      "defined_names": ["RevenueRange", "CostRange"],
      "note": "Heuristic check — verify manually if this is a false positive"
    }
  ]
}
```

字段參考：

| 字段 | 含義 |
|-------|---------|
| `type: "error_value"` | 單元格有 `t="e"` — `<v>` 元素中存有 Excel 錯誤 |
| `type: "broken_sheet_ref"` | 公式引用 workbook.xml 中不存在的工作表名 |
| `type: "unknown_name_ref"` | 公式引用不在 `<definedNames>` 中的標識符（啟發式，軟警告） |
| `type: "malformed_error_cell"` | 單元格有 `t="e"` 但無 `<v>` 子元素 — 結構性 XML 問題 |
| `type: "file_error"` | 文件無法打開（壞 ZIP、未找到等） |
| `sheet` | 發現錯誤的工作表 |
| `cell` | A1 表示法的單元格引用 |
| `formula` | `<f>` 元素的完整公式文本（不存在則為 null） |
| `error` | `<v>` 中的錯誤字符串（`error_value` 類型） |
| `missing_sheet` | 從公式提取的不存在的工作表名 |
| `valid_sheets` | workbook.xml 中實際存在的所有工作表名 |
| `unknown_name` | 未在 `<definedNames>` 中找到的標識符 |
| `defined_names` | workbook.xml 中實際存在的所有命名區域 |
| `shared_formula_ranges` | 共享公式定義計數（頂層 `<f t="shared" ref="...">` 元素） |

### 第 2 步：手動 XML 檢查

當 formula_check.py 報告錯誤時，解包文件檢查原始 XML：

```bash
python3 SKILL_DIR/scripts/xlsx_unpack.py /path/to/file.xlsx /tmp/xlsx_inspect/
```

導航到報告工作表的工作表文件。工作表到文件的映射在 `xl/_rels/workbook.xml.rels`。例如，若 `rId1` 映射到 `worksheets/sheet1.xml`，則 sheet1.xml 是 `xl/workbook.xml` 中 `r:id="rId1"` 工作表的文件。

對每個報告的錯誤單元格，定位 `<c r="CELLREF">` 元素並檢查：

**對於 `error_value` 錯誤：**
```xml
<!-- 錯誤單元格在 XML 中長這樣 -->
<c r="C12" t="e">
  <f>Q1!C10/Q1!C11</f>
  <v>#DIV/0!</v>
</c>
```

問：
- `<f>` 公式語法正確嗎？
- 公式中的單元格引用指向存在的行/列嗎？
- 若是除法，分母單元格可能為空或零嗎？

**對於 `broken_sheet_ref` 錯誤：**

檢查 `xl/workbook.xml` 中的實際工作表列表：

```xml
<sheets>
  <sheet name="Summary" sheetId="1" r:id="rId1"/>
  <sheet name="Q1"      sheetId="2" r:id="rId2"/>
  <sheet name="Q2"      sheetId="3" r:id="rId3"/>
</sheets>
```

工作表名區分大小寫。`q1` 和 `Q1` 是不同的工作表。將公式中的名與此處的名精確比較。

### 第 3 步：跨表引用審計（多表工作簿）

對 3 個及以上工作表的工作簿，解包後運行更廣的跨引用審計：

```bash
# 提取所有含跨表引用的公式
grep -h "<f>" /tmp/xlsx_inspect/xl/worksheets/*.xml | grep "!"

# 從 workbook.xml 列出所有實際工作表名
grep -o 'name="[^"]*"' /tmp/xlsx_inspect/xl/workbook.xml | grep -v sheetId
```

公式中出現的每個工作表名（`SheetName!` 或 `'Sheet Name'!` 形式）必須出現在工作簿工作表列表中。若任何不匹配，即為斷裂引用，即便 formula_check.py 未捕獲（共享公式只檢查主單元格時可能發生）。

專門檢查共享公式，查找 `<f t="shared" ref="...">` 元素：

```xml
<!-- 共享公式：定義在 D2，應用於 D2:D100 -->
<c r="D2"><f t="shared" ref="D2:D100" si="0">Q1!B2*C2</f><v></v></c>

<!-- 共享公式消費單元格：僅有 si，無公式文本 -->
<c r="D3"><f t="shared" si="0"/><v></v></c>
```

formula_check.py 從主單元格（上方 `D2`）讀取公式文本。該公式中引用的工作表 `Q1` 適用於整個範圍 `D2:D100`。若該工作表斷裂，所有 99 行都斷裂，即便它們顯示為空 `<f>` 元素。

---

## 第 2 層 — 動態驗證（LibreOffice 無頭）

### 檢查 LibreOffice 可用性

```bash
# 檢查 macOS（典型安裝位置）
which soffice
/Applications/LibreOffice.app/Contents/MacOS/soffice --version

# 檢查 Linux
which libreoffice || which soffice
libreoffice --version
```

若兩個命令都不返回路徑，LibreOffice 未安裝。在報告中記錄"第 2 層：跳過 — LibreOffice 不可用"並僅以第 1 層結果交付。

### 安裝 LibreOffice（若環境允許）

macOS：
```bash
brew install --cask libreoffice
```

Ubuntu/Debian：
```bash
sudo apt-get install -y libreoffice
```

### 運行無頭重算

用專用重算腳本。它處理 macOS 和 Linux 的二進制發現，從輸入的臨時副本工作（保留原始文件），並提供與驗證管道兼容的結構化輸出和退出碼。

```bash
# 先檢查 LibreOffice 可用性
python3 SKILL_DIR/scripts/libreoffice_recalc.py --check

# 運行重算（默認超時：60s）
python3 SKILL_DIR/scripts/libreoffice_recalc.py /path/to/input.xlsx /tmp/recalculated.xlsx

# 對大或複雜文件，延長超時
python3 SKILL_DIR/scripts/libreoffice_recalc.py /path/to/input.xlsx /tmp/recalculated.xlsx --timeout 120
```

`libreoffice_recalc.py` 退出碼：
- `0` — 重算成功，寫出輸出文件
- `2` — 未找到 LibreOffice（報告中記為跳過；非硬失敗）
- `1` — 找到 LibreOffice 但失敗（超時、崩潰、畸形文件）

**腳本內部做什麼：**

LibreOffice 的 `--convert-to xlsx` 命令用完整 Calc 引擎和 `--infilter="Calc MS Excel 2007 XML"` 過濾器打開文件，執行每個公式，將計算值寫入 `<v>` 緩存元素並保存輸出。這是服務器端最接近"在 Excel 中打開並按保存"的等價操作。腳本還傳 `--norestore` 防止 LibreOffice 嘗試恢復之前的會話，這在自動化環境中可能導致掛起。

**若未安裝 LibreOffice：**

macOS：
```bash
brew install --cask libreoffice
```

Ubuntu/Debian：
```bash
sudo apt-get install -y libreoffice
```

**若腳本超時（libreoffice_recalc.py 退出碼 1 並顯示"timed out"消息）：**

在報告中記錄"第 2 層：超時 — LibreOffice 未在 Ns 內完成"。不要循環重試。調查文件是否有循環引用或極大數據範圍。

### 重算後重新運行第 1 層

LibreOffice 重算後，`<v>` 元素含真實計算值。之前不可見的錯誤（因新生成文件 `<v>` 為空）現在顯示為帶實際錯誤字符串的 `t="e"` 單元格。

```bash
python3 SKILL_DIR/scripts/formula_check.py /tmp/recalculated.xlsx
```

這第二次第 1 層是權威的運行時錯誤檢查。它發現的任何錯誤都是必須修復的真實計算失敗。

---

## 全部 7 種錯誤類型 — 原因與修復策略

### #REF! — 無效單元格引用

**含義：** 公式引用不再存在或從未存在的單元格、範圍或工作表。

**生成文件中的常見原因：**
- 行/列計算的差一錯誤（如引用行 0，Excel 的 1 起始系統中不存在）
- 列字母計算錯誤（如列 64 映射到 `BL` 而非 `BK`）
- 公式引用從未創建或已被重命名的工作表

**XML 簽名：**
```xml
<c r="D5" t="e">
  <f>Sheet2!A0</f>
  <v>#REF!</v>
</c>
```

**修復 — 糾正引用：**
```xml
<c r="D5">
  <f>Sheet2!A1</f>
  <v></v>
</c>
```

注意：糾正公式後移除 `t="e"` 並清空 `<v>`。錯誤類型標記屬於緩存狀態，而非公式。

**可自動修復？** 僅當能從周圍上下文確定正確目標。否則標記人工審閱。

---

### #DIV/0! — 除以零

**含義：** 公式除以零值或空單元格（空單元格在算術上下文中求值為 0）。

**生成文件中的常見原因：**
- 百分比變化公式 `=(B2-B1)/B1` 其中 `B1` 為空或零
- 比率公式 `=Value/Total` 其中合計行尚未填充

**XML 簽名：**
```xml
<c r="C8" t="e">
  <f>B8/B7</f>
  <v>#DIV/0!</v>
</c>
```

**修復 — 用 IFERROR 包裹：**
```xml
<c r="C8">
  <f>IFERROR(B8/B7,0)</f>
  <v></v>
</c>
```

替代 — 顯式零檢查：
```xml
<c r="C8">
  <f>IF(B7=0,0,B8/B7)</f>
  <v></v>
</c>
```

**可自動修復？** 是。用 `IFERROR(...,0)` 包裹對大多數財務公式安全。若業務期望結果應顯示為空白而非零，改用 `IFERROR(...,"")`。

---

### #VALUE! — 錯誤數據類型

**含義：** 公式對錯誤類型的值執行算術或邏輯操作（如將文本字符串加到數字上）。

**生成文件中的常見原因：**
- 應持數字的單元格寫成字符串類型（`t="s"` 或 `t="inlineStr"`）而非數字類型
- 公式引用含文本的單元格（如單位標籤"千"）並將其當作數字

**XML 簽名：**
```xml
<c r="F3" t="e">
  <f>E3+D3</f>
  <v>#VALUE!</v>
</c>
```

**修復 — 檢查源單元格類型是否錯誤：**

若 `D3` 被錯誤寫成字符串：
```xml
<!-- 錯誤：數字值存為字符串 -->
<c r="D3" t="inlineStr"><is><t>1000</t></is></c>

<!-- 正確：數字值存為數字（t 屬性省略或 "n"） -->
<c r="D3"><v>1000</v></c>
```

或用 `VALUE()` 轉換包裹公式：
```xml
<c r="F3">
  <f>VALUE(E3)+VALUE(D3)</f>
  <v></v>
</c>
```

**可自動修復？** 部分。若源單元格類型明顯錯誤（數字存為字符串），修復類型。若原因模糊（單元格本應含文本），標記人工審閱。

---

### #NAME? — 未識別名稱

**含義：** 公式含 Excel 不識別的標識符 — 拼錯的函數名、未定義的命名區域，或目標 Excel 版本中不可用的函數。

**生成文件中的常見原因：**
- LLM 寫函數名時拼錯：`SUMIF` 寫成 `SUMIFS` 卻只提供 3 個參數，或在目標 Excel 2010 的上下文中用 `XLOOKUP`
- 公式引用的命名區域不存在於 `xl/workbook.xml`

**XML 簽名：**
```xml
<c r="B2" t="e">
  <f>SUMSQ(A2:A10)</f>
  <v>#NAME?</v>
</c>
```

**修復 — 驗證函數名和命名區域：**

檢查 `xl/workbook.xml` 中的命名區域：
```xml
<definedNames>
  <definedName name="RevenueRange">Sheet1!$B$2:$B$13</definedName>
</definedNames>
```

若公式引用 `RevenuRange`（拼錯），糾正為 `RevenueRange`：
```xml
<c r="B2">
  <f>SUM(RevenueRange)</f>
  <v></v>
</c>
```

**可自動修復？** 僅當正確名稱無歧義（如存在單一接近匹配）。否則標記人工審閱 — 函數名修復需理解意圖計算。

---

### #N/A — 值不可用

**含義：** 查找函數（VLOOKUP、HLOOKUP、MATCH、INDEX/MATCH、XLOOKUP）搜索的值在查找表中不存在。

**生成文件中的常見原因：**
- 查找鍵存在於公式但查找表為空或尚未填充
- 鍵格式不匹配（文本"2024" vs 數字 2024）

**XML 簽名：**
```xml
<c r="G5" t="e">
  <f>VLOOKUP(F5,Assumptions!$A$2:$B$20,2,0)</f>
  <v>#N/A</v>
</c>
```

**修復 — 用 IFERROR 包裹以容忍缺失匹配：**
```xml
<c r="G5">
  <f>IFERROR(VLOOKUP(F5,Assumptions!$A$2:$B$20,2,0),0)</f>
  <v></v>
</c>
```

**可自動修復？** 若零默認可接受，添加 `IFERROR` 安全。若查找失敗表明數據完整性問題（鍵應始終存在），不自動修復 — 標記人工審閱。

---

### #NULL! — 空交集

**含義：** 空格運算符（計算兩範圍交集）應用於兩個不相交的範圍。

**生成文件中的常見原因：**
- 兩個範圍引用間意外空格：`=SUM(A1:A5 C1:C5)` 而非 `=SUM(A1:A5,C1:C5)`
- 典型財務模型中罕見；通常表明公式生成錯誤

**XML 簽名：**
```xml
<c r="H10" t="e">
  <f>SUM(A1:A5 C1:C5)</f>
  <v>#NULL!</v>
</c>
```

**修復 — 用逗號（並集）或冒號（範圍）替換空格：**
```xml
<!-- 兩個獨立範圍的並集 -->
<c r="H10">
  <f>SUM(A1:A5,C1:C5)</f>
  <v></v>
</c>
```

**可自動修復？** 是。空格運算符在生成公式中幾乎從非有意。替換為逗號安全。

---

### #NUM! — 數字錯誤

**含義：** 公式產生 Excel 無法表示的數字（溢出、下溢）或無實數結果的數學操作（負數平方根、零或負數對數）。

**生成文件中的常見原因：**
- IRR 或 NPV 公式現金流序列無收斂解
- `SQRT()` 應用於可能為負的單元格
- 極大冪運算

**XML 簽名：**
```xml
<c r="J15" t="e">
  <f>IRR(B5:B15)</f>
  <v>#NUM!</v>
</c>
```

**修復 — 添加條件守衛：**
```xml
<c r="J15">
  <f>IFERROR(IRR(B5:B15),"")</f>
  <v></v>
</c>
```

對 SQRT：
```xml
<c r="K5">
  <f>IF(A5>=0,SQRT(A5),"")</f>
  <v></v>
</c>
```

**可自動修復？** 部分。用 `IFERROR` 包裹抑制錯誤顯示但不修復底層計算問題。即便應用 IFERROR 包裹後仍標記單元格供人工審閱。

---

## 自動修復 vs 人工審閱決策矩陣

| 錯誤類型 | 自動修復安全？ | 條件 | 動作 |
|------------|---------------|-----------|--------|
| `#DIV/0!` | 是 | 始終 | 用 `IFERROR(公式,0)` 包裹 |
| `#NULL!` | 是 | 始終 | 用逗號替換空格運算符 |
| `#REF!` | 是 | 僅當上下文能無歧義確定正確目標 | 糾正引用；否則標記 |
| `#NAME?` | 是 | 僅當拼寫錯誤恰好有一個合理糾正 | 修復名稱；否則標記 |
| `#N/A` | 條件 | 若零/空白默認業務可接受 | 添加 IFERROR 包裹；記錄假設 |
| `#VALUE!` | 條件 | 僅當源單元格類型明顯錯誤 | 修復類型；否則標記 |
| `#NUM!` | 否 | 始終 | 添加 IFERROR 抑制顯示，然後標記 |
| 斷裂工作表引用 | 是 | 僅當能從 workbook.xml 識別重命名的工作表 | 糾正名稱 |
| 業務邏輯錯誤 | 從不 | 任何情況 | 僅人工審閱 |

**什麼算業務邏輯錯誤（絕不自動修復）：**
- 產生錯誤數字但無 Excel 錯誤的公式（如 `=SUM(B2:B8)` 而意圖是 `=SUM(B2:B9)`）
- IFERROR 默認值有意義的公式（如用 0、空白還是前期值）
- 任何修復錯誤需知道公式本應計算什麼的公式

---

## 交付標準 — 驗證報告

每個驗證任務必須產出結構化報告。無論是否發現錯誤，此報告是交付物。

### 必需報告格式

```markdown
## 公式驗證報告

**文件**：/path/to/filename.xlsx
**日期**：YYYY-MM-DD
**檢查的工作表**：Sheet1, Sheet2, Sheet3
**掃描公式總數**：N

---

### 第 1 層 — 靜態驗證

**狀態**：PASS / FAIL
**工具**：formula_check.py（直接 XML 掃描）

| 工作表 | 單元格 | 錯誤類型 | 詳情 | 應用的修復 |
|-------|------|-----------|--------|-------------|
| Summary | C12 | #REF! | 公式：Q1!A0 | 糾正為 Q1!A1 |
| Summary | D15 | broken_sheet_ref | 引用缺失工作表 'Q5' | 重命名為 Q4 |

_（若無錯誤："未檢測到錯誤。"）_

---

### 第 2 層 — 動態驗證

**狀態**：PASS / FAIL / SKIPPED
**工具**：LibreOffice 無頭（版本 X.Y.Z）/ 不可用

_（若 SKIPPED：說明原因 — LibreOffice 未安裝、超時等）_

| 工作表 | 單元格 | 錯誤類型 | 詳情 | 應用的修復 |
|-------|------|-----------|--------|-------------|
| Q1 | F8 | #DIV/0! | 公式：C8/C7 | 用 IFERROR 包裹 |

_（若無錯誤："重算後未檢測到運行時錯誤。"）_

---

### 總結

- **發現錯誤總數**：N
- **自動修復**：N（列出類型）
- **標記人工審閱**：N（列出單元格和原因）
- **最終狀態**：PASS（可交付）/ FAIL（阻止）

### 需人工審閱

| 單元格 | 錯誤 | 未應用自動修復的原因 |
|------|-------|----------------------------|
| Q2!B15 | #NUM! | IRR 公式 — 業務必須確認現金流輸入 |
```

### 最低必需字段

若缺少以下任一項，報告無效（且交付被阻止）：
- 文件路徑和日期
- 檢查了哪些工作表
- 公式總數
- 第 1 層狀態帶顯式 PASS/FAIL
- 第 2 層狀態帶顯式 PASS/FAIL/SKIPPED 及若 SKIPPED 的原因
- 對每個錯誤：工作表、單元格、錯誤類型、處置（修復或標記）
- 最終交付狀態

---

## 常見場景

### 場景 1：創建新文件後立即驗證

當 `create.md` 工作流產出新 xlsx，在任何交付響應前運行驗證。

```bash
# 第 1 步：對新寫入文件靜態檢查
python3 SKILL_DIR/scripts/formula_check.py /path/to/output.xlsx

# 第 2 步：動態檢查（若 LibreOffice 可用）
python3 SKILL_DIR/scripts/libreoffice_recalc.py /path/to/output.xlsx /tmp/recalculated.xlsx
python3 SKILL_DIR/scripts/formula_check.py /tmp/recalculated.xlsx
```

新生成文件的預期行為：第 1 層會發現零個 `error_value` 錯誤（因 `<v>` 元素為空，非錯誤值）。它會發現工作表名拼錯時的斷裂跨表引用。第 2 層會填充 `<v>` 並揭示 `#DIV/0!` 等運行時錯誤。

若第 2 層揭示錯誤，在源 XML（非重算副本）中修復，重新打包，重新運行兩層。

### 場景 2：編輯已有文件後驗證

當 `edit.md` 工作流修改已有 xlsx，若編輯是外科手術式的，只驗證受影響工作表。若編輯觸及共享公式或跨表引用，驗證所有工作表。

```bash
# 定向靜態檢查 — 看特定工作表
# （formula_check.py 檢查所有工作表；只檢查輸出的相關部分）
python3 SKILL_DIR/scripts/formula_check.py /path/to/edited.xlsx --json \
  | python3 -c "
import json, sys
r = json.load(sys.stdin)
for e in r['errors']:
    if e.get('sheet') in ['Summary', 'Q1']:
        print(e)
"
```

修改公式的編輯後始終運行第 2 層，即便第 1 層通過。數據範圍的編輯可能導致之前有效的公式產生運行時錯誤。

### 場景 3：用戶提供疑似有公式錯誤的文件

當用戶提交文件並報告錯誤值或可見錯誤：

```bash
# 第 1 步：靜態掃描 — 找出所有錯誤單元格
python3 SKILL_DIR/scripts/formula_check.py /path/to/user_file.xlsx --json > /tmp/validation_results.json

# 第 2 步：解包供手動檢查
python3 SKILL_DIR/scripts/xlsx_unpack.py /path/to/user_file.xlsx /tmp/xlsx_inspect/

# 第 3 步：動態重算
python3 SKILL_DIR/scripts/libreoffice_recalc.py /path/to/user_file.xlsx /tmp/user_file_recalc.xlsx

# 第 4 步：重新驗證重算文件
python3 SKILL_DIR/scripts/formula_check.py /tmp/user_file_recalc.xlsx --json > /tmp/validation_after_recalc.json

# 第 5 步：對比前後
python3 - <<'EOF'
import json
before = json.load(open("/tmp/validation_results.json"))
after  = json.load(open("/tmp/validation_after_recalc.json"))
print(f"重算前：{before['error_count']} 個錯誤")
print(f"重算後：{after['error_count']} 個錯誤")
EOF
```

若錯誤只在重算後出現（原靜態掃描中無），則公式語法正確但運行時產生錯誤結果。這些是需公式級修復的運行時錯誤，非 XML 結構修復。

若錯誤在兩次掃描中都出現，則在重算前已緩存在 `<v>` — 文件之前被 Excel/LibreOffice 打開過，錯誤持續存在。

---

## 關鍵陷阱

**陷阱 1：openpyxl `data_only=True` 銷燬公式。**
以 `data_only=True` 打開工作簿讀取緩存值而非公式。若隨後保存工作簿，所有 `<f>` 元素被永久移除並替換為最後緩存值。驗證工作流中絕不使用此模式。

**陷阱 2：空 `<v>` 不等於通過的公式。**
新生成文件所有公式單元格的 `<v>` 元素為空。formula_check.py 不會將這些報告為錯誤 — 它們尚不是錯誤。只有在重算後計算值為錯誤類型時才成為錯誤。這是第 2 層強制的緣故。

**陷阱 3：共享公式錯誤影響整個範圍。**
若共享公式主單元格有斷裂引用，共享範圍（`ref="D2:D100"`）中每個單元格都繼承該斷裂引用。邏輯錯誤計數可能遠大於 formula_check.py 輸出中不同錯誤條目的計數。修復斷裂共享公式時，修復主單元格的 `<f t="shared" ref="...">` 元素；消費單元格（`<f t="shared" si="N"/>`）自動繼承糾正後的公式。

**陷阱 4：工作表名區分大小寫。**
`=q1!B5` 和 `=Q1!B5` 是不同引用。Excel 內部將它們視為相同，但 formula_check.py 的字符串比較區分大小寫。若公式用小寫工作表名匹配工作簿中的大寫工作表，會被標記為斷裂引用。修復是與 `workbook.xml` 中的精確大小寫匹配。

**陷阱 5：`--convert-to xlsx` 不保證公式保留。**
LibreOffice 的轉換偶爾會改變某些公式類型（數組公式、`SORT`、`UNIQUE` 等動態數組函數）。第 2 層後，若重算文件顯示與錯誤修復無關的公式變化，不要直接交付重算文件 — 改用原始文件做定向 XML 修復。
