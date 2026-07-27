# 已有 xlsx 的最小侵入式編輯

對已有 xlsx 文件做精確、外科手術式的改動，同時保留一切你不碰的內容：樣式、宏、透視表、圖表、迷你圖、命名區域、數據驗證、條件格式及所有其他嵌入內容。

---

## 1. 何時使用此路徑

只要任務涉及**修改已有 xlsx 文件**，就用編輯（解包 → XML 編輯 → 打包）路徑：

- 模板填充 — 用值或公式填充指定輸入單元格
- 數據更新 — 替換活文件中過時的數字、文本或日期
- 內容修正 — 修復錯誤值、損壞公式或拼錯的標籤
- 向已有表添加新數據行
- 重命名工作表
- 對特定單元格應用新樣式

不要用此路徑從零創建全新工作簿。那種情況見 `create.md`。

---

## 2. 為何已有文件禁止 openpyxl 往返

openpyxl `load_workbook()` 後 `workbook.save()` 對任何含高級功能的文件是**破壞性操作**。該庫靜默丟棄它不理解的內容：

| 功能 | openpyxl 行為 | 後果 |
|---------|-------------------|-------------|
| VBA 宏（`vbaProject.bin`） | 完全丟棄 | 所有自動化丟失；文件存為 `.xlsx` 而非 `.xlsm` |
| 透視表（`xl/pivotTables/`） | 丟棄 | 交互分析被毀 |
| 切片器 | 丟棄 | 篩選 UI 丟失 |
| 迷你圖（`<sparklineGroups>`） | 丟棄 | 單元格內迷你圖消失 |
| 圖表格式細節 | 部分丟失 | 系列顏色、自定義座標軸可能還原 |
| 打印區域/分頁符 | 有時丟失 | 打印佈局改變 |
| 自定義 XML 部件 | 丟棄 | 第三方數據綁定斷裂 |
| 主題鏈接顏色 | 可能去主題化 | 顏色轉為絕對值，破壞主題切換 |

即便在無這些功能的"純"文件上，openpyxl 也可能規範化 Excel 依賴的 XML 空白、改變命名空間聲明或重置 `calcMode` 標誌。

**規則是絕對的：絕不以重新保存為目的用 openpyxl 打開已有文件。**

XML 直接編輯方式安全，因為它操作原始字節。你只改你碰的節點。其他一切與原始文件字節等效。

---

## 3. 標準操作流程

### 第 1 步 — 解包

```bash
python3 SKILL_DIR/scripts/xlsx_unpack.py input.xlsx /tmp/xlsx_work/
```

腳本解壓 xlsx，美化打印每個 XML 和 `.rels` 文件，並打印關鍵文件的分類清單，若檢測到高風險內容（VBA、透視表、圖表）則發出警告。

繼續前仔細閱讀打印輸出。若腳本報告 `xl/vbaProject.bin` 或 `xl/pivotTables/`，遵循第 7 節的約束。

### 第 2 步 — 偵察

碰任何東西前先摸清結構。

**識別工作表名及其 XML 文件：**

```
xl/workbook.xml  →  <sheet name="Revenue" sheetId="1" r:id="rId1"/>
xl/_rels/workbook.xml.rels  →  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
```

名為 "Revenue" 的工作表位於 `xl/worksheets/sheet1.xml`。編輯工作表前始終先解析此映射。

**理解共享字符串表：**

```bash
# 統計 xl/sharedStrings.xml 中的現有條目
grep -c "<si>" /tmp/xlsx_work/xl/sharedStrings.xml
```

每個文本單元格用對此表的 0 起始索引。追加前先知道當前數量。

**理解樣式表：**

```bash
# 統計現有 cellXfs 條目
grep -c "<xf " /tmp/xlsx_work/xl/styles.xml
```

新樣式槽追加在現有之後。第一個新槽的索引 = 當前數量。

**掃描目標工作表中的高風險 XML 區域：**

編輯前在目標 `sheet*.xml` 中查找這些元素：

- `<mergeCell>` — 合併單元格範圍；行/列插入會移動這些
- `<conditionalFormatting>` — 條件範圍；行/列插入會移動這些
- `<dataValidations>` — 驗證範圍；行/列插入會移動這些
- `<tableParts>` — 表定義；表內插行需更新 `<tableColumn>`
- `<sparklineGroups>` — 迷你圖；原樣保留不修改

### 第 3 步 — 將意圖映射為最小 XML 改動

寫一個字前，先產出一份書面清單，列出確切哪些 XML 節點變化。這防止範圍蔓延。

| 用戶意圖 | 要改的文件 | 要改的節點 |
|-------------|----------------|-----------------|
| 改單元格數值 | `xl/worksheets/sheetN.xml` | 目標 `<c>` 內的 `<v>` |
| 改單元格文本 | `xl/sharedStrings.xml`（追加）+ `xl/worksheets/sheetN.xml` | 新 `<si>`，更新單元格 `<v>` 索引 |
| 改單元格公式 | `xl/worksheets/sheetN.xml` | 目標 `<c>` 內的 `<f>` 文本 |
| 底部添加新數據行 | `xl/worksheets/sheetN.xml` + 可能 `xl/sharedStrings.xml` | 追加 `<row>` 元素 |
| 對單元格應用新樣式 | `xl/styles.xml` + `xl/worksheets/sheetN.xml` | 在 `<cellXfs>` 追加 `<xf>`，更新 `<c>` 的 `s` 屬性 |
| 重命名工作表 | `xl/workbook.xml` | `<sheet>` 元素的 `name` 屬性 |
| 重命名工作表（含跨表公式） | `xl/workbook.xml` + 所有 `xl/worksheets/*.xml` | `name` 屬性 + 引用舊名的 `<f>` 文本 |

### 第 4 步 — 執行改動

用 Edit 工具。最小化編輯。絕不重寫整個文件。

每種操作類型的精確 XML 模式見第 4 節。

### 第 5 步 — 級聯檢查

任何移動行或列位置的改動後，審計所有受影響 XML 區域。見第 5 節。

### 第 6 步 — 打包並驗證

```bash
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
python3 SKILL_DIR/scripts/formula_check.py output.xlsx
```

打包腳本在創建 ZIP 前驗證 XML 良構性。修復任何報告的解析錯誤再打包。打包後運行 `formula_check.py` 確認未引入公式錯誤。

---

## 4. 常見編輯的精確 XML 模式

### 4.1 改變數字單元格值

在工作表 XML 中找到 `<c r="B5">` 元素，替換 `<v>` 文本。

**之前：**
```xml
<c r="B5">
  <v>1000</v>
</c>
```

**之後（新值 1500）：**
```xml
<c r="B5">
  <v>1500</v>
</c>
```

規則：
- 除非顯式改樣式，否則不添加或移除 `s` 屬性（樣式）。
- 不添加 `t` 屬性 — 數字省略 `t` 或用 `t="n"`。
- 不改 `r` 屬性（單元格引用）。

---

### 4.2 改變文本單元格值

文本單元格按索引（`t="s"`）引用共享字符串表。你無法就地編輯字符串而不影響每個用同一索引的其他單元格。安全做法是追加新條目。

**之前 — 共享字符串文件（`xl/sharedStrings.xml`）：**
```xml
<sst count="4" uniqueCount="4">
  <si><t>Revenue</t></si>
  <si><t>Cost</t></si>
  <si><t>Margin</t></si>
  <si><t>Old Label</t></si>
</sst>
```

**之後 — 追加新字符串，遞增計數：**
```xml
<sst count="5" uniqueCount="5">
  <si><t>Revenue</t></si>
  <si><t>Cost</t></si>
  <si><t>Margin</t></si>
  <si><t>Old Label</t></si>
  <si><t>New Label</t></si>
</sst>
```

新字符串在索引 4（0 起始）。

**之前 — 工作表 XML 中的單元格：**
```xml
<c r="A7" t="s">
  <v>3</v>
</c>
```

**之後 — 指向新索引：**
```xml
<c r="A7" t="s">
  <v>4</v>
</c>
```

規則：
- 絕不修改或刪除已有 `<si>` 條目。只追加。
- `count` 和 `uniqueCount` 必須一起遞增。
- 若新字符串含 `&`、`<` 或 `>`，轉義：`&amp;`、`&lt;`、`&gt;`。
- 若字符串有前導或尾隨空格，給 `<t>` 加 `xml:space="preserve"`：
  ```xml
  <si><t xml:space="preserve">  縮進文本  </t></si>
  ```

---

### 4.3 改變公式

公式存儲在 `<f>` 元素中，**無前導 `=`**（與 Excel UI 中輸入不同）。

**之前：**
```xml
<c r="C10">
  <f>SUM(C2:C9)</f>
  <v>4800</v>
</c>
```

**之後（擴展範圍）：**
```xml
<c r="C10">
  <f>SUM(C2:C11)</f>
  <v></v>
</c>
```

規則：
- 改公式時將 `<v>` 清為空字符串。緩存值現已過時。
- 不給公式單元格加 `t="s"` 或任何類型屬性。`t` 屬性缺席或用結果類型值，而非公式標記。
- 跨表引用用 `SheetName!CellRef`。若工作表名含空格，用單引號包裹：`'Q1 Data'!B5`。
- `<f>` 文本不得包含前導 `=`。

**之前（將硬編碼值轉為活公式）：**
```xml
<c r="D15">
  <v>95000</v>
</c>
```

**之後：**
```xml
<c r="D15">
  <f>SUM(D2:D14)</f>
  <v></v>
</c>
```

---

### 4.4 添加新數據行

在 `<sheetData>` 內最後一個 `<row>` 元素後追加。OOXML 中行號 1 起始且必須連續。

**之前（末行是第 10 行）：**
```xml
  <row r="10">
    <c r="A10" t="s"><v>3</v></c>
    <c r="B10"><v>2023</v></c>
    <c r="C10"><v>88000</v></c>
    <c r="D10"><f>C10*1.1</f><v></v></c>
  </row>
</sheetData>
```

**之後（追加新行 11）：**
```xml
  <row r="10">
    <c r="A10" t="s"><v>3</v></c>
    <c r="B10"><v>2023</v></c>
    <c r="C10"><v>88000</v></c>
    <c r="D10"><f>C10*1.1</f><v></v></c>
  </row>
  <row r="11">
    <c r="A11" t="s"><v>4</v></c>
    <c r="B11"><v>2024</v></c>
    <c r="C11"><v>96000</v></c>
    <c r="D11"><f>C11*1.1</f><v></v></c>
  </row>
</sheetData>
```

規則：
- 行內每個 `<c>` 必須將 `r` 設為正確單元格地址（如 `A11`）。
- 文本單元格需 `t="s"` 和 sharedStrings 索引在 `<v>` 中。數字單元格省略 `t`。
- 公式單元格用 `<f>` 和空 `<v>`。
- 若要匹配樣式，從上方行復制 `s` 屬性。不要憑空發明 `styles.xml` 中不存在的樣式索引。
- 若工作表含 `<dimension>` 元素（如 `<dimension ref="A1:D10"/>`），更新以包含新行：`<dimension ref="A1:D11"/>`。
- 若工作表含引用表的 `<tableparts>`，更新對應 `xl/tables/tableN.xml` 中表的 `ref` 屬性。

---

### 4.5 添加新列

向每個已有 `<row>` 追加新 `<c>` 元素，若存在則更新 `<cols>` 部分。

**之前（行有 A–C 列）：**
```xml
<cols>
  <col min="1" max="3" width="14" customWidth="1"/>
</cols>
<sheetData>
  <row r="1">
    <c r="A1" t="s"><v>0</v></c>
    <c r="B1" t="s"><v>1</v></c>
    <c r="C1" t="s"><v>2</v></c>
  </row>
  <row r="2">
    <c r="A2"><v>100</v></c>
    <c r="B2"><v>200</v></c>
    <c r="C2"><v>300</v></c>
  </row>
</sheetData>
```

**之後（添加 D 列）：**
```xml
<cols>
  <col min="1" max="3" width="14" customWidth="1"/>
  <col min="4" max="4" width="14" customWidth="1"/>
</cols>
<sheetData>
  <row r="1">
    <c r="A1" t="s"><v>0</v></c>
    <c r="B1" t="s"><v>1</v></c>
    <c r="C1" t="s"><v>2</v></c>
    <c r="D1" t="s"><v>5</v></c>
  </row>
  <row r="2">
    <c r="A2"><v>100</v></c>
    <c r="B2"><v>200</v></c>
    <c r="C2"><v>300</v></c>
    <c r="D2"><f>A2+B2+C2</f><v></v></c>
  </row>
</sheetData>
```

規則：
- 在末尾（最後一列之後）添加列是安全的 — 無現有公式引用移動。
- 在中間插入列會使所有列右移，需與插行相同的級聯更新（見第 5 節）。
- 若存在則更新 `<dimension>` 元素。

---

### 4.6 修改或添加樣式

樣式用多級間接引用鏈。完整鏈見 `ooxml-cheatsheet.md`。關鍵規則：**只追加新條目，絕不修改已有**。

**場景：** 添加一個尚不存在的藍色字體樣式（用於硬編碼輸入單元格）。

**第 1 步 — 檢查 `xl/styles.xml` 中是否已有匹配字體：**
```xml
<!-- 在 <fonts> 中查找已有藍色字體 -->
<font>
  <color rgb="000000FF"/>
  <!-- 其他屬性 -->
</font>
```

若找到，記下其索引（`<fonts>` 列表中 0 起始位置）。若未找到，追加。

**第 2 步 — 需要時追加新字體：**

之前：
```xml
<fonts count="3">
  <font>...</font>   <!-- 索引 0 -->
  <font>...</font>   <!-- 索引 1 -->
  <font>...</font>   <!-- 索引 2 -->
</fonts>
```

之後：
```xml
<fonts count="4">
  <font>...</font>   <!-- 索引 0 -->
  <font>...</font>   <!-- 索引 1 -->
  <font>...</font>   <!-- 索引 2 -->
  <font>
    <b/>
    <sz val="11"/>
    <color rgb="000000FF"/>
    <name val="Calibri"/>
  </font>             <!-- 索引 3（新） -->
</fonts>
```

**第 3 步 — 在 `<cellXfs>` 追加新 `<xf>`：**

之前：
```xml
<cellXfs count="5">
  <xf .../>   <!-- 索引 0 -->
  <xf .../>   <!-- 索引 1 -->
  <xf .../>   <!-- 索引 2 -->
  <xf .../>   <!-- 索引 3 -->
  <xf .../>   <!-- 索引 4 -->
</cellXfs>
```

之後：
```xml
<cellXfs count="6">
  <xf .../>   <!-- 索引 0 -->
  <xf .../>   <!-- 索引 1 -->
  <xf .../>   <!-- 索引 2 -->
  <xf .../>   <!-- 索引 3 -->
  <xf .../>   <!-- 索引 4 -->
  <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0"
      applyFont="1"/>   <!-- 索引 5（新） -->
</cellXfs>
```

**第 4 步 — 應用到目標單元格：**

之前：
```xml
<c r="B3">
  <v>0.08</v>
</c>
```

之後：
```xml
<c r="B3" s="5">
  <v>0.08</v>
</c>
```

規則：
- 絕不刪除或重排 `<fonts>`、`<fills>`、`<borders>`、`<cellXfs>` 中已有條目。
- 追加時始終更新 `count` 屬性。
- 新 `cellXfs` 索引 = 追加前的舊 `count` 值（0 起始：若 count 為 5，新索引為 5）。
- 自定義 `numFmt` ID 必須 164 以上。ID 0–163 是內置的，不得重新聲明。
- 若期望樣式已存在於文件中（類似單元格上），複用其 `s` 索引而非創建重複。

---

### 4.7 重命名工作表

**只需改 `xl/workbook.xml`** — 除非跨表公式引用舊名。

**之前（`xl/workbook.xml`）：**
```xml
<sheet name="Sheet1" sheetId="1" r:id="rId1"/>
```

**之後：**
```xml
<sheet name="Revenue" sheetId="1" r:id="rId1"/>
```

**若任何工作表中任何公式引用舊名，也更新那些：**

之前（`xl/worksheets/sheet2.xml`）：
```xml
<c r="B5"><f>Sheet1!C10</f><v></v></c>
```

之後：
```xml
<c r="B5"><f>Revenue!C10</f><v></v></c>
```

若新名含空格：
```xml
<c r="B5"><f>'Q1 Revenue'!C10</f><v></v></c>
```

掃描所有工作表 XML 文件查找舊名：
```bash
grep -r "Sheet1!" /tmp/xlsx_work/xl/worksheets/
```

規則：
- `.rels` 文件和 `[Content_Types].xml` 無需改 — 它們引用 XML 文件路徑，而非工作表名。
- `sheetId` 不得改；它是穩定內部標識符。
- 公式引用中工作表名區分大小寫。

---

## 5. 高風險操作 — 級聯效應

### 5.1 中間插入行

在位置 N 插入行會使 N 及以下所有行下移。每個 XML 文件中對這些行的引用都必須更新。

**要檢查和更新的文件：**

| XML 區域 | 更新什麼 | 示例移動 |
|------------|---------------|---------------|
| 工作表 `<row r="...">` 屬性 | 遞增 >= N 的所有行行號 | `r="7"` → `r="8"` |
| 這些行內所有 `<c r="...">` | 遞增單元格地址中的行號 | `r="A7"` → `r="A8"` |
| 任何工作表中所有 `<f>` 公式文本 | 移動 >= N 的絕對行引用 | `B7` → `B8` |
| `<mergeCell ref="...">` | 移動起始和結束行 | `A7:C7` → `A8:C8` |
| `<conditionalFormatting sqref="...">` | 移動範圍 | `A5:D20` → `A5:D21` |
| `<dataValidations sqref="...">` | 移動範圍 | `B6:B50` → `B7:B51` |
| `xl/charts/chartN.xml` 數據源範圍 | 移動系列範圍 | `Sheet1!$B$5:$B$20` → `Sheet1!$B$6:$B$21` |
| `xl/pivotTables/*.xml` 源範圍 | 移動源數據範圍 | 極謹慎處理 — 見第 7 節 |
| `<dimension ref="...">` | 擴展以包含新範圍 | `A1:D20` → `A1:D21` |
| `xl/tables/tableN.xml` `ref` 屬性 | 擴展表邊界 | `A1:D20` → `A1:D21` |

**不要在大或公式密集的文件中手動插行。** 改用專用移動腳本：

```bash
# 在第 5 行插 1 行：第 5 行及以下全部下移 1
python3 SKILL_DIR/scripts/xlsx_shift_rows.py /tmp/xlsx_work/ insert 5 1

# 刪除第 8 行：第 9 行及以上全部上移 1
python3 SKILL_DIR/scripts/xlsx_shift_rows.py /tmp/xlsx_work/ delete 8 1
```

腳本一次更新：`<row r="...">` 屬性、`<c r="...">` 單元格地址、跨每個工作表的所有 `<f>` 公式文本、`<mergeCell>` 範圍、`<conditionalFormatting sqref="...">`、`<dataValidation sqref="...">`、`<dimension ref="...">`、`xl/tables/` 中表 `ref` 屬性、`xl/charts/` 中圖表系列範圍、`xl/pivotCaches/` 中透視緩存源範圍。

**運行移動腳本後，始終重新打包並驗證：**
```bash
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
python3 SKILL_DIR/scripts/formula_check.py output.xlsx
```

**腳本不更新（手動審查）：**
- `xl/workbook.xml` `<definedNames>` 中的命名區域 — 若引用移動行則檢查更新。
- 公式中的結構化表引用（`Table[@Column]`）。
- `xl/externalLinks/` 中的外部工作簿鏈接。

### 5.2 中間插入列

與插行相同的級聯邏輯，但針對列。公式中的列引用（`B`、`$C` 等）及合併單元格範圍、條件格式範圍、圖表數據源都需更新。

列字母移動更難安全自動化。儘量選擇**在末尾追加列**。

### 5.3 刪除行或列

刪除比插入更危險，因為任何引用被刪行/列的公式會變 `#REF!`。刪除前：

1. 搜索所有 `<f>` 元素對被刪範圍的引用。
2. 若任何公式引用被刪行/列中的單元格，不要刪除 — 改為清除該行數據或諮詢用戶。
3. 刪除後，將刪除點之後的行/列引用向下/向左移動。

---

## 6. 模板填充 — 識別並填充輸入單元格

模板將某些單元格指定為輸入區。識別它們的常見模式：

### 6.1 模板如何標示輸入區

| 信號 | XML 表現 | 找什麼 |
|--------|-------------------|-----------------|
| 藍色字體 | `s` 屬性指向 `fontId` → `<color rgb="000000FF"/>` 的 `cellXfs` 條目 | 檢查 `styles.xml` 解碼 `s` 值 |
| 黃色填充（高亮） | `s` → `fillId` → `<fill><patternFill><fgColor rgb="00FFFF00"/>` | |
| 空 `<v>` 元素 | `<c r="B5"><v></v></c>` 或單元格在 `<row>` 中完全缺席 | 單元格尚無值 |
| 單元格附近批註/註釋 | `xl/comments1.xml` 中 `ref="B5"` | 批註常標註輸入字段 |
| 命名區域 | `xl/workbook.xml` `<definedName>` 元素 | 模板可能定義 `InputRevenue` 等 |

### 6.2 填充模板單元格

不改 `s` 屬性。除非必須從空改到有類型，否則不改 `t` 屬性。只改 `<v>` 或加 `<f>`。

**之前（空輸入單元格，樣式保留）：**
```xml
<c r="C5" s="3">
  <v></v>
</c>
```

**之後（填數字，樣式不變）：**
```xml
<c r="C5" s="3">
  <v>125000</v>
</c>
```

**之後（填文本 — 需先有共享字符串條目）：**
```xml
<!-- 1. 追加到 sharedStrings.xml：<si><t>North Region</t></si> 在索引 7 -->
<c r="C5" t="s" s="3">
  <v>7</v>
</c>
```

**之後（填公式，保留樣式）：**
```xml
<c r="C5" s="3">
  <f>Assumptions!D12</f>
  <v></v>
</c>
```

### 6.3 不在 Excel 中打開文件而定位輸入區

解包後，解碼可疑輸入單元格上的樣式索引以確定是否有模板的輸入顏色：

1. 記下單元格的 `s` 值（如 `s="4"`）。
2. 在 `xl/styles.xml` 中找 `<cellXfs>`，看第 5 個條目（索引 4）。
3. 記下其 `fontId`（如 `fontId="2"`）。
4. 在 `<fonts>` 中看第 3 個條目（索引 2），檢查是否有 `<color rgb="000000FF"/>`（藍）或其他輸入標記。

若模板用命名區域作輸入字段，從 `xl/workbook.xml` 讀取：
```xml
<definedNames>
  <definedName name="InputGrowthRate">Assumptions!$B$5</definedName>
  <definedName name="InputDiscountRate">Assumptions!$B$6</definedName>
</definedNames>
```

直接填充目標單元格（`Assumptions!B5`、`Assumptions!B6`）。

### 6.4 模板填充規則

- 只填充模板指定為輸入的單元格。不填充公式驅動的單元格。
- 填充時不應用新樣式。模板的格式是交付物。
- 不在模板數據區內添加或刪除行，除非模板顯式有"在此追加"區。
- 填充後，驗證未引入公式錯誤：某些模板有輸入驗證公式，若輸入錯誤數據類型會產生 `#VALUE!`。

---

## 7. 絕不可修改的文件

### 7.1 絕對不可碰清單

| 文件/位置 | 原因 |
|-----------------|-----|
| `xl/vbaProject.bin` | 二進制 VBA 字節碼。任何字節修改都會損壞宏工程。改一位都使宏無法加載。 |
| `xl/pivotCaches/pivotCacheDefinition*.xml` | 緩存定義將透視表綁定到源數據。編輯它而不更新對應 `pivotTable*.xml` 會損壞透視表。 |
| `xl/pivotTables/*.xml` | 透視表 XML 與緩存定義及 Excel 加載時重建的內部狀態緊密耦合。不要編輯。若你移動了行且透視的源範圍現在指向錯誤數據，只更新緩存定義中的 `<cacheSource>` 範圍，和透視表中的 `ref` 屬性 — 不做其他改動。 |
| `xl/slicers/*.xml` | 切片器連接到特定緩存 ID 和透視字段。破壞這些連接會靜默損壞文件。 |
| `xl/connections.xml` | 外部數據連接。編輯破壞實時數據刷新。 |
| `xl/externalLinks/` | 外部工作簿鏈接。其中的二進制 `.bin` 文件不得修改。 |

### 7.2 有條件安全的文件（只更新特定屬性）

| 文件 | 可更新 | 要保留不動 |
|------|--------------------|--------------------|
| `xl/charts/chartN.xml` | 行/列移動後的數據系列範圍引用（`<numRef><f>`） | 圖表類型、格式、佈局 |
| `xl/tables/tableN.xml` | 添加行後 `<table>` 的 `ref` 屬性 | 列定義、樣式信息 |
| `xl/pivotCaches/pivotCacheDefinition*.xml` | 移動源數據後 `<cacheSource><worksheetSource>` 的 `ref` 屬性 | 所有其他內容 |

---

## 8. 每次編輯後驗證

絕不跳過驗證。公式中一個字符的改動都可能引起級聯錯誤。

```bash
# 打包
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx

# 靜態公式驗證（始終運行）
python3 SKILL_DIR/scripts/formula_check.py output.xlsx

# 動態驗證（若 LibreOffice 可用）
python3 SKILL_DIR/scripts/libreoffice_recalc.py output.xlsx /tmp/recalc.xlsx
python3 SKILL_DIR/scripts/formula_check.py /tmp/recalc.xlsx
```

若 `formula_check.py` 報告任何錯誤：
1. 再次解包輸出文件（它是打包版本）。
2. 在工作表 XML 中定位報告的單元格。
3. 修復 `<f>` 元素。
4. 重新打包並重新驗證。

`formula_check.py` 報告零錯誤前不要交付文件。

---

## 9. 絕對規則總結

| 規則 | 理由 |
|------|-----------|
| 絕不對已有文件用 openpyxl `load_workbook` + `save` | 往返破壞透視表、VBA、迷你圖、切片器 |
| 絕不刪除或重排 sharedStrings 中已有 `<si>` 條目 | 破壞每個引用該索引的單元格 |
| 絕不刪除或重排 `<cellXfs>` 中已有 `<xf>` 條目 | 破壞每個用該樣式索引的單元格 |
| 絕不修改 `vbaProject.bin` | 二進制文件；任何改動損壞 VBA |
| 重命名工作表時絕不改 `sheetId` | 內部 ID 穩定；改它破壞關係 |
| 絕不跳過編輯後驗證 | 留下未檢測的斷裂引用 |
| 絕不編輯超出所需的 XML 節點 | 額外改動有引入微妙損壞的風險 |
| 改公式時將 `<v>` 清為空字符串 | 防止過時緩存值誤導下游消費者 |
| sharedStrings 僅追加 | 現有索引必須保持有效 |
| 樣式集合僅追加 | 現有樣式索引必須保持有效 |
