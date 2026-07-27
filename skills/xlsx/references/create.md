# 從零構建新 xlsx

用 XML 方式創建新的、生產級 xlsx 文件。絕不用 openpyxl 寫入。絕不硬編碼 Python 計算的值 — 每個派生數字必須是活的 Excel 公式。

---

## 何時使用此路徑

用戶需要以下時使用本文檔：
- 一個尚不存在的全新 Excel 文件
- 生成的報告、財務模型或數據表
- 任何"創建/構建/生成/製作"請求

若用戶提供已有文件要修改，改用 `edit.md`。

---

## 不可妥協的規則

碰任何文件前，內化這四條規則：

1. **公式優先**：每個計算值（`SUM`、增長率、比率、小計等）必須寫成 `<f>SUM(B2:B9)</f>`，而非硬編碼 `<v>5000</v>`。硬編碼數字在源數據變化時會過時。只有原始輸入和假設參數可以是硬編碼值。

2. **寫入不用 openpyxl**：整個文件通過直接編輯 XML 構建。Python 僅允許用於讀取/分析（`pandas.read_excel()`）和運行輔助腳本（`xlsx_pack.py`、`formula_check.py`）。

3. **樣式編碼含義**：藍色字體 = 用戶輸入/假設。黑色字體 = 公式結果。綠色字體 = 跨表引用。完整顏色系統和樣式索引表見 `format.md`。

4. **交付前驗證**：運行 `formula_check.py` 並修復所有錯誤後再交給用戶。

---

## 完整創建工作流

### 第 1 步 — 寫前規劃

碰任何 XML 前，先在紙上定義完整結構：

- **工作表**：名稱、順序、用途（如 Assumptions / Model / Summary）
- **每表佈局**：哪些行是表頭、輸入、公式、合計
- **字符串清單**：收集 sharedStrings 中需要的所有文本標籤
- **樣式選擇**：每列需要什麼數字格式（貨幣、%、整數、年份）
- **跨錶鏈接**：哪些表從其他表拉取數據

此規劃步驟避免中途往 sharedStrings 加字符串並重算所有索引的昂貴循環。

---

### 第 2 步 — 複製最小模板

```bash
cp -r SKILL_DIR/templates/minimal_xlsx/ /tmp/xlsx_work/
```

模板給你一個完整、有效的 7 文件 xlsx 骨架：

```
/tmp/xlsx_work/
├── [Content_Types].xml        ← MIME 類型註冊表
├── _rels/
│   └── .rels                  ← 根關係（指向 workbook.xml）
└── xl/
    ├── workbook.xml            ← 工作表列表和計算設置
    ├── styles.xml              ← 13 個預置財務樣式槽
    ├── sharedStrings.xml       ← 文本字符串表（初始為空）
    ├── _rels/
    │   └── workbook.xml.rels  ← 將 rId 映射到文件路徑
    └── worksheets/
        └── sheet1.xml          ← 一個空工作表
```

複製後，重命名工作表並添加內容。不要從零創建文件 — 始終從模板開始。

---

### 第 3 步 — 配置工作表結構

#### 單工作表工作簿

模板已有一個名為 "Sheet1" 的工作表。只需改 `xl/workbook.xml` 中的 `name` 屬性：

```xml
<sheets>
  <sheet name="Revenue Model" sheetId="1" r:id="rId1"/>
</sheets>
```

單工作表工作簿無需改其他文件。

#### 多工作表工作簿

四個文件必須保持同步。按此順序處理：

**重要 — rId 衝突規則**：模板的 `workbook.xml.rels` 中，ID `rId1`、`rId2`、`rId3` 已被佔用：
- `rId1` → `worksheets/sheet1.xml`
- `rId2` → `styles.xml`
- `rId3` → `sharedStrings.xml`

新工作表條目必須從 `rId4` 起向上遞增。

**文件 1/4 — `xl/workbook.xml`**（工作表列表）：

```xml
<sheets>
  <sheet name="Assumptions" sheetId="1" r:id="rId1"/>
  <sheet name="Model"       sheetId="2" r:id="rId4"/>
  <sheet name="Summary"     sheetId="3" r:id="rId5"/>
</sheets>
```

工作表名中的特殊字符：
- `&` → XML 中 `&amp;`：`<sheet name="P&amp;L" .../>`
- 最多 31 字符
- 禁止：`/ \ ? * [ ] :`
- 帶空格的工作表名在公式引用中需單引號：`'Q1 Data'!B5`

**文件 2/4 — `xl/_rels/workbook.xml.rels`**（ID → 文件映射）：

```xml
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
    Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
    Target="styles.xml"/>
  <Relationship Id="rId3"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings"
    Target="sharedStrings.xml"/>
  <Relationship Id="rId4"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
    Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId5"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
    Target="worksheets/sheet3.xml"/>
</Relationships>
```

**文件 3/4 — `[Content_Types].xml`**（MIME 類型聲明）：

```xml
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml"
    ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml"
    ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml"
    ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml"
    ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml"
    ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml"
    ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>
```

**文件 4/4 — 創建新工作表 XML 文件**

將 `sheet1.xml` 複製為 `sheet2.xml` 和 `sheet3.xml`，然後清空 `<sheetData>` 內容：

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet
  xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews>
    <sheetView workbookViewId="0"/>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"
    xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"/>
  <sheetData>
    <!-- 數據行放這裡 -->
  </sheetData>
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>
```

**同步清單** — 每次添加工作表，驗證四者一致：

| 檢查 | 驗證什麼 |
|-------|---------------|
| `workbook.xml` | 存在新的 `<sheet name="..." sheetId="N" r:id="rIdX"/>` |
| `workbook.xml.rels` | 存在新的 `<Relationship Id="rIdX" ... Target="worksheets/sheetN.xml"/>` |
| `[Content_Types].xml` | 存在新的 `<Override PartName="/xl/worksheets/sheetN.xml" .../>` |
| 文件系統 | `xl/worksheets/sheetN.xml` 文件實際存在 |

---

### 第 4 步 — 填充 sharedStrings

所有文本值（表頭、行標籤、類別名、用戶將讀到的任何字符串）必須存儲在 `xl/sharedStrings.xml`。單元格按 0 起始索引引用它們。

**推薦工作流**：先收集所需的所有文本，一次性寫完整表，然後在寫工作表 XML 時填索引。避免中途重算索引。

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
     count="10" uniqueCount="10">
  <si><t>Item</t></si>                  <!-- 索引 0 -->
  <si><t>FY2023A</t></si>               <!-- 索引 1 -->
  <si><t>FY2024E</t></si>               <!-- 索引 2 -->
  <si><t>FY2025E</t></si>               <!-- 索引 3 -->
  <si><t>YoY Growth</t></si>            <!-- 索引 4 -->
  <si><t>Revenue</t></si>               <!-- 索引 5 -->
  <si><t>Cost of Goods Sold</t></si>    <!-- 索引 6 -->
  <si><t>Gross Profit</t></si>          <!-- 索引 7 -->
  <si><t>EBITDA</t></si>                <!-- 索引 8 -->
  <si><t>Net Income</t></si>            <!-- 索引 9 -->
</sst>
```

**屬性規則**：
- `uniqueCount` = `<si>` 元素數（表中唯一字符串數）
- `count` = 整個工作簿中對字符串的單元格引用總數
  （若 "Revenue" 出現在 3 個表中，count 為 `uniqueCount + 2`）
- 對於每個字符串出現一次的新文件，`count == uniqueCount`
- 兩個屬性必須準確 — 錯誤值在某些 Excel 版本中觸發警告

**特殊字符轉義**：

```xml
<si><t>R&amp;D Expenses</t></si>          <!-- & 必須為 &amp; -->
<si><t>Revenue &lt; Target</t></si>        <!-- < 必須為 &lt; -->
<si><t xml:space="preserve">  (備註)  </t></si>  <!-- 保留前導/尾隨空格 -->
```

**輔助腳本**：用 `shared_strings_builder.py` 從純字符串列表生成完整 `sharedStrings.xml`：

```bash
python3 SKILL_DIR/scripts/shared_strings_builder.py \
  "Item" "FY2024" "FY2025" "Revenue" "Gross Profit" \
  > /tmp/xlsx_work/xl/sharedStrings.xml
```

或從每行一個字符串的文件交互式生成：

```bash
python3 SKILL_DIR/scripts/shared_strings_builder.py --file strings.txt \
  > /tmp/xlsx_work/xl/sharedStrings.xml
```

---

### 第 5 步 — 寫工作表數據

編輯每個 `xl/worksheets/sheetN.xml`。用行和單元格替換空的 `<sheetData>`。

#### 單元格 XML 解剖

```
<c r="B5" t="s" s="4">
      ↑     ↑    ↑
   地址  類型  樣式索引（來自 styles.xml 的 cellXfs）

  <v>3</v>
     ↑
  值（t="s" 時：sharedStrings 索引；數字時：數字本身）
```

#### 數據類型參考

| 數據 | `t` 屬性 | XML 示例 | 備註 |
|------|---------|-------------|-------|
| 共享字符串（文本） | `s` | `<c r="A1" t="s" s="4"><v>0</v></c>` | `<v>` = sharedStrings 索引 |
| 數字 | 省略 | `<c r="B2" s="5"><v>1000000</v></c>` | 默認類型，`t` 省略 |
| 百分比（小數存儲） | 省略 | `<c r="C2" s="7"><v>0.125</v></c>` | 12.5% 存為 0.125 |
| 布爾 | `b` | `<c r="D1" t="b"><v>1</v></c>` | 1=TRUE, 0=FALSE |
| 公式 | 省略 | `<c r="B4" s="2"><f>SUM(B2:B3)</f><v></v></c>` | `<v>` 留空 |
| 跨表公式 | 省略 | `<c r="C1" s="3"><f>Assumptions!B2</f><v></v></c>` | 用 s=3（綠） |

#### 完整 sheetData 示例

```xml
<cols>
  <col min="1" max="1" width="26" customWidth="1"/>   <!-- A: 標籤列 -->
  <col min="2" max="5" width="14" customWidth="1"/>   <!-- B-E: 數據列 -->
</cols>
<sheetData>

  <!-- 第 1 行：表頭（樣式 4 = 粗體表頭） -->
  <row r="1" ht="18" customHeight="1">
    <c r="A1" t="s" s="4"><v>0</v></c>   <!-- "Item" -->
    <c r="B1" t="s" s="4"><v>1</v></c>   <!-- "FY2023A" -->
    <c r="C1" t="s" s="4"><v>2</v></c>   <!-- "FY2024E" -->
    <c r="D1" t="s" s="4"><v>3</v></c>   <!-- "FY2025E" -->
    <c r="E1" t="s" s="4"><v>4</v></c>   <!-- "YoY Growth" -->
  </row>

  <!-- 第 2 行：Revenue — 實際值（輸入）+ 公式（計算） -->
  <row r="2">
    <c r="A2" t="s" s="1"><v>5</v></c>    <!-- "Revenue"，藍色輸入標籤 -->
    <c r="B2" s="5"><v>85000000</v></c>   <!-- FY2023A 實際：$85M，貨幣輸入 -->
    <c r="C2" s="6"><f>B2*(1+Assumptions!C3)</f><v></v></c>   <!-- 公式，貨幣 -->
    <c r="D2" s="6"><f>C2*(1+Assumptions!D3)</f><v></v></c>
    <c r="E2" s="8"><f>D2/C2-1</f><v></v></c>   <!-- YoY 增長，百分比公式 -->
  </row>

  <!-- 第 3 行：Gross Profit -->
  <row r="3">
    <c r="A3" t="s" s="2"><v>7</v></c>    <!-- "Gross Profit"，黑色公式標籤 -->
    <c r="B3" s="6"><f>B2*Assumptions!B4</f><v></v></c>
    <c r="C3" s="6"><f>C2*Assumptions!C4</f><v></v></c>
    <c r="D3" s="6"><f>D2*Assumptions!D4</f><v></v></c>
    <c r="E3" s="8"><f>D3/C3-1</f><v></v></c>
  </row>

  <!-- 第 5 行：SUM 合計行 -->
  <row r="5">
    <c r="A5" t="s" s="4"><v>8</v></c>    <!-- "EBITDA" -->
    <c r="B5" s="6"><f>SUM(B2:B4)</f><v></v></c>
    <c r="C5" s="6"><f>SUM(C2:C4)</f><v></v></c>
    <c r="D5" s="6"><f>SUM(D2:D4)</f><v></v></c>
    <c r="E5" s="8"><f>D5/C5-1</f><v></v></c>
  </row>

</sheetData>
```

#### 列寬與凍結窗格

列寬在 `<sheetData>` **之前**，凍結窗格在 `<sheetView>` 內：

```xml
<!-- 在 <sheetViews><sheetView ...> 內 — 凍結表頭行 -->
<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>

<!-- 在 <sheetData> 之前 — 設置列寬 -->
<cols>
  <col min="1" max="1" width="28" customWidth="1"/>
  <col min="2" max="8" width="14" customWidth="1"/>
</cols>
```

---

### 第 6 步 — 應用樣式

模板的 `xl/styles.xml` 有 13 個預置語義樣式槽（索引 0–12）。
**完整樣式索引表、顏色系統及如何添加新樣式，見 `format.md`。**

最常用槽速查：

| `s` | 角色 | 示例 |
|-----|------|---------|
| 4 | 表頭（粗體） | 列/行標題 |
| 5 / 6 | 貨幣輸入（藍）/ 公式（黑） | `$#,##0` |
| 7 / 8 | 百分比輸入 / 公式 | `0.0%` |
| 11 | 年份（無千位分隔） | 2024 而非 2,024 |

設計原則：藍 = 人工設定。黑 = Excel 計算。綠 = 跨表。

若需 13 個預置槽中沒有的樣式，遵循 `format.md` 第 3.2 節的僅追加流程。

---

### 第 7 步 — 公式手冊

#### XML 公式語法提醒

XML 中的公式**無前導 `=`**：

```xml
<!-- Excel UI：=SUM(B2:B9)   →   XML： -->
<c r="B10" s="6"><f>SUM(B2:B9)</f><v></v></c>
```

#### 基本聚合

```xml
<c r="B10" s="6"><f>SUM(B2:B9)</f><v></v></c>
<c r="B11" s="6"><f>AVERAGE(B2:B9)</f><v></v></c>
<c r="B12" s="10"><f>COUNT(B2:B9)</f><v></v></c>
<c r="B13" s="10"><f>COUNTA(A2:A100)</f><v></v></c>
<c r="B14" s="6"><f>MAX(B2:B9)</f><v></v></c>
<c r="B15" s="6"><f>MIN(B2:B9)</f><v></v></c>
```

#### 財務計算

```xml
<!-- YoY 增長率：當期 / 前期 - 1 -->
<c r="E5" s="8"><f>D5/C5-1</f><v></v></c>

<!-- 毛利：營收 × 毛利率 -->
<c r="B6" s="6"><f>B4*B3</f><v></v></c>

<!-- EBITDA 率：EBITDA / 營收 -->
<c r="B9" s="8"><f>B8/B4</f><v></v></c>

<!-- 分母可能為零時抑制 #DIV/0! -->
<c r="E5" s="8"><f>IF(C5=0,0,D5/C5-1)</f><v></v></c>

<!-- NPV 和 IRR（現金流在 B2:B7，折現率在 B1） -->
<c r="C1" s="6"><f>NPV(B1,B3:B7)+B2</f><v></v></c>
<c r="C2" s="8"><f>IRR(B2:B7)</f><v></v></c>
```

#### 跨表引用

```xml
<!-- 名中無空格：無需引號 -->
<c r="B3" s="3"><f>Assumptions!B5</f><v></v></c>

<!-- 工作表名有空格：需單引號 -->
<c r="B3" s="3"><f>'Q1 Data'!B5</f><v></v></c>

<!-- 工作表名含 &（workbook.xml 中 XML 轉義，但公式中：字面 &） -->
<c r="B3" s="3"><f>'R&amp;D'!B5</f><v></v></c>

<!-- 跨表範圍：對另一表中某範圍求 SUM -->
<c r="B10" s="6"><f>SUM(Data!C2:C1000)</f><v></v></c>

<!-- 3D 引用：跨多個表對同一單元格求和 -->
<c r="B5" s="6"><f>SUM(Jan:Dec!B5)</f><v></v></c>
```

跨表公式單元格應用 `s="3"`（綠）以標示數據來源。

#### 共享公式（同一模式沿列重複）

當許多連續單元格共享同一公式結構、僅行號變化時，用共享公式保持 XML 緊湊：

```xml
<!-- D2：定義共享組（si="0", ref="D2:D11"） -->
<c r="D2" s="8"><f t="shared" ref="D2:D11" si="0">C2/B2-1</f><v></v></c>

<!-- D3 到 D11：引用同一組，無需公式文本 -->
<c r="D3" s="8"><f t="shared" si="0"/><v></v></c>
<c r="D4" s="8"><f t="shared" si="0"/><v></v></c>
<c r="D5" s="8"><f t="shared" si="0"/><v></v></c>
<c r="D6" s="8"><f t="shared" si="0"/><v></v></c>
<c r="D7" s="8"><f t="shared" si="0"/><v></v></c>
<c r="D8" s="8"><f t="shared" si="0"/><v></v></c>
<c r="D9" s="8"><f t="shared" si="0"/><v></v></c>
<c r="D10" s="8"><f t="shared" si="0"/><v></v></c>
<c r="D11" s="8"><f t="shared" si="0"/><v></v></c>
```

Excel 自動調整相對引用（D3 計算 `C3/B3-1` 等）。
若有多個共享公式組，分配連續 `si` 值（0、1、2…）。

#### 絕對引用

```xml
<!-- $B$2 在公式複製時鎖定到該單元格 -->
<c r="C5" s="8"><f>B5/$B$2</f><v></v></c>
```

`$` 字符無需 XML 轉義 — 直接寫。

#### 查找公式

```xml
<!-- VLOOKUP：精確匹配（末參 0） -->
<c r="C5" s="6"><f>VLOOKUP(A5,Assumptions!A:C,2,0)</f><v></v></c>

<!-- INDEX/MATCH：更靈活 -->
<c r="C5" s="6"><f>INDEX(B:B,MATCH(A5,A:A,0))</f><v></v></c>

<!-- XLOOKUP（Excel 2019+） -->
<c r="C5" s="6"><f>XLOOKUP(A5,A:A,B:B)</f><v></v></c>
```

---

### 第 8 步 — 打包並驗證

**打包**：

```bash
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ /path/to/output.xlsx
```

`xlsx_pack.py` 會：
1. 檢查根目錄存在 `[Content_Types].xml`
2. 解析每個 `.xml` 和 `.rels` 文件檢查良構性 — 任一失敗則中止
3. 以正確壓縮創建 ZIP 歸檔

**驗證**：

```bash
python3 SKILL_DIR/scripts/formula_check.py /path/to/output.xlsx
```

`formula_check.py` 會：
1. 掃描每個單元格的 `<c t="e">` 條目（緩存錯誤值）— 全部 7 種錯誤類型
2. 從每個 `<f>` 公式提取工作表名引用
3. 驗證每個被引用工作表在 `workbook.xml` 中存在

交付前修復每個報告的錯誤。退出碼 0 = 可安全交付。

---

## 交付前檢查清單

交給用戶前過一遍此清單：

- [ ] `formula_check.py` 報告 0 錯誤
- [ ] 每個計算單元格有 `<f>` — 而非只有帶數字的 `<v>`
- [ ] `sharedStrings.xml` 的 `count` 和 `uniqueCount` 與實際 `<si>` 數一致
- [ ] 每個單元格 `s` 屬性值在 `0` 到 `cellXfs count - 1` 範圍內
- [ ] `workbook.xml` 中每個工作表在 `workbook.xml.rels` 有匹配條目
- [ ] 每個 `worksheets/sheetN.xml` 文件在 `[Content_Types].xml` 有匹配 `<Override>`
- [ ] 年份列用 `s="11"`（格式 `0`，無千位分隔）
- [ ] 跨表引用公式用 `s="3"`（綠色字體）
- [ ] 假設輸入用 `s="1"` 或 `s="5"` 或 `s="7"`（藍色字體）

---

## 常見錯誤與修復

| 錯誤 | 症狀 | 修復 |
|---------|---------|-----|
| 公式有前導 `=` | 單元格顯示 `=SUM(...)` 為文本 | 從 `<f>` 內容移除 `=` |
| sharedStrings `count` 未更新 | Excel 警告或空白單元格 | 數 `<si>` 元素，更新 `count` 和 `uniqueCount` |
| 樣式索引超範圍 | 文件損壞 / Excel 修復 | 確保 `s` < `cellXfs count`；需要時追加新 `<xf>` |
| 新工作表 rId 與 styles/sharedStrings rId 衝突 | 工作表缺失或樣式丟失 | 新工作表用 rId4、rId5…（模板中 rId1-3 已預留） |
| 工作表名含 `&` 未在 XML 轉義 | XML 解析錯誤 | `workbook.xml` name 屬性用 `&amp;` |
| 跨表引用帶空格表名未加引號 | `#REF!` 錯誤 | 用單引號包裹表名：`'Sheet Name'!B5` |
| 跨表引用到不存在的表 | `#REF!` 錯誤 | 檢查 `workbook.xml` 工作表列表 vs 公式 |
| 數字存為文本（`t="s"`） | 左對齊，無法求和 | 從數字單元格移除 `t` 屬性 |
| 年份顯示為 `2,024` | 可讀性問題 | 用 `s="11"`（numFmtId=1，格式 `0`） |
| 硬編碼 Python 結果而非公式 | "死表" — 不更新 | 用 `<f>公式</f><v></v>` 替換 `<v>N</v>` |

---

## 列字母參考

| 列號 | 字母 | 列號 | 字母 | 列號 | 字母 |
|-------|--------|-------|--------|-------|--------|
| 1 | A | 26 | Z | 27 | AA |
| 28 | AB | 52 | AZ | 53 | BA |
| 54 | BB | 78 | BZ | 79 | CA |

Python 轉換（程序化構建公式時用）：

```python
def col_letter(n: int) -> str:
    """將 1 起始列號轉為 Excel 字母（A、B、…、Z、AA、AB…）。"""
    result = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        result = chr(65 + rem) + result
    return result

def col_number(s: str) -> int:
    """將 Excel 列字母轉為 1 起始數字。"""
    n = 0
    for c in s.upper():
        n = n * 26 + (ord(c) - 64)
    return n
```

---

## 典型場景演練

### 場景 A — 三年財務模型（單表）

佈局：第 1-12 行 = Assumptions（藍色輸入）/ 第 14-30 行 = Model（黑色公式）。

```xml
<!-- sharedStrings.xml（節選） -->
<sst count="8" uniqueCount="8">
  <si><t>Metric</t></si>           <!-- 0 -->
  <si><t>FY2023A</t></si>          <!-- 1 -->
  <si><t>FY2024E</t></si>          <!-- 2 -->
  <si><t>FY2025E</t></si>          <!-- 3 -->
  <si><t>Revenue Growth</t></si>   <!-- 4 -->
  <si><t>Gross Margin</t></si>     <!-- 5 -->
  <si><t>Revenue</t></si>          <!-- 6 -->
  <si><t>Gross Profit</t></si>     <!-- 7 -->
</sst>

<!-- sheet1.xml（節選） -->
<sheetData>
  <!-- 表頭 -->
  <row r="1">
    <c r="A1" t="s" s="4"><v>0</v></c>
    <c r="B1" t="s" s="4"><v>1</v></c>
    <c r="C1" t="s" s="4"><v>2</v></c>
    <c r="D1" t="s" s="4"><v>3</v></c>
  </row>
  <!-- 假設（第 2-3 行） -->
  <row r="2">
    <c r="A2" t="s" s="1"><v>4</v></c>    <!-- "Revenue Growth"，藍 -->
    <c r="B2" s="7"><v>0</v></c>          <!-- FY2023A：n/a，0% 佔位 -->
    <c r="C2" s="7"><v>0.12</v></c>       <!-- FY2024E：12.0% 輸入 -->
    <c r="D2" s="7"><v>0.15</v></c>       <!-- FY2025E：15.0% 輸入 -->
  </row>
  <row r="3">
    <c r="A3" t="s" s="1"><v>5</v></c>    <!-- "Gross Margin"，藍 -->
    <c r="B3" s="7"><v>0.45</v></c>
    <c r="C3" s="7"><v>0.46</v></c>
    <c r="D3" s="7"><v>0.47</v></c>
  </row>
  <!-- 模型（第 14-15 行） -->
  <row r="14">
    <c r="A14" t="s" s="2"><v>6</v></c>      <!-- "Revenue"，黑 -->
    <c r="B14" s="5"><v>85000000</v></c>     <!-- 實際，貨幣輸入 -->
    <c r="C14" s="6"><f>B14*(1+C2)</f><v></v></c>
    <c r="D14" s="6"><f>C14*(1+D2)</f><v></v></c>
  </row>
  <row r="15">
    <c r="A15" t="s" s="2"><v>7</v></c>      <!-- "Gross Profit"，黑 -->
    <c r="B15" s="6"><f>B14*B3</f><v></v></c>
    <c r="C15" s="6"><f>C14*C3</f><v></v></c>
    <c r="D15" s="6"><f>D14*D3</f><v></v></c>
  </row>
</sheetData>
```

### 場景 B — 數據 + 彙總（兩表）

`Summary` 表用跨表公式（綠色，`s="3"`）從 `Data` 拉取：

```xml
<!-- Summary/sheet2.xml sheetData 節選 -->
<sheetData>
  <row r="1">
    <c r="A1" t="s" s="4"><v>0</v></c>   <!-- "Metric" -->
    <c r="B1" t="s" s="4"><v>1</v></c>   <!-- "Value" -->
  </row>
  <row r="2">
    <c r="A2" t="s" s="0"><v>2</v></c>   <!-- "Total Revenue" -->
    <c r="B2" s="3"><f>SUM(Data!C2:C10000)</f><v></v></c>
  </row>
  <row r="3">
    <c r="A3" t="s" s="0"><v>3</v></c>   <!-- "Deal Count" -->
    <c r="B3" s="3"><f>COUNTA(Data!A2:A10000)</f><v></v></c>
  </row>
  <row r="4">
    <c r="A4" t="s" s="0"><v>4</v></c>   <!-- "Avg Deal Size" -->
    <c r="B4" s="3"><f>IF(B3=0,0,B2/B3)</f><v></v></c>
  </row>
</sheetData>
```

### 場景 C — 多部門合併

`Consolidated` 表對多個部門工作表的同一單元格求和：

```xml
<!-- Consolidated/sheet4.xml — 跨 Dept_Eng 和 Dept_Mkt 求和 -->
<sheetData>
  <row r="5">
    <c r="A5" t="s" s="2"><v>0</v></c>
    <!-- 工作表名無空格 → 無需引號 -->
    <c r="B5" s="3"><f>Dept_Engineering!B5+Dept_Marketing!B5</f><v></v></c>
  </row>
  <row r="6">
    <c r="A6" t="s" s="2"><v>1</v></c>
    <c r="B6" s="3"><f>SUM(Dept_Engineering!B6,Dept_Marketing!B6)</f><v></v></c>
  </row>
</sheetData>
```

---

## 禁止事項

- 不要用 openpyxl 或任何 Python 庫寫最終 xlsx 文件
- 不要硬編碼任何計算值 — 每個派生數字用 `<f>` 公式
- 不要未先運行 `formula_check.py` 就交付
- 不要將單元格 `s` 屬性設為 >= `cellXfs count` 的值
- 不要修改 `styles.xml` 中已有的 `<xf>` 條目 — 只追加新的
- 不要添加新工作表而不更新所有四個同步點（workbook.xml、workbook.xml.rels、[Content_Types].xml、實際 .xml 文件）
- 不要分配與 rId1、rId2、rId3 重疊的新工作表 rId（模板中預留給 sheet1、styles、sharedStrings）
