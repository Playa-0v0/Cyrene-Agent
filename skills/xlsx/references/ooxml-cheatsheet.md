# OOXML SpreadsheetML 速查表

xlsx 文件 XML 操作的快速參考。

---

## 包結構

```
my_file.xlsx  （ZIP 歸檔）
├── [Content_Types].xml          ← 聲明所有文件的 MIME 類型
├── _rels/
│   └── .rels                    ← 根關係：指向 xl/workbook.xml
└── xl/
    ├── workbook.xml             ← 工作表列表、計算設置
    ├── styles.xml               ← 所有樣式定義
    ├── sharedStrings.xml        ← 所有文本字符串（按索引引用）
    ├── _rels/
    │   └── workbook.xml.rels    ← 將 r:id 映射到 worksheet/styles/sharedStrings 文件
    ├── worksheets/
    │   ├── sheet1.xml           ← 工作表 1 數據
    │   ├── sheet2.xml           ← 工作表 2 數據
    │   └── ...
    ├── charts/                  ← 圖表 XML（如有）
    ├── pivotTables/             ← 透視表 XML（如有）
    └── theme/
        └── theme1.xml           ← 顏色/字體主題
```

---

## 單元格引用格式

```
A1  → 列 A（1），行 1
B5  → 列 B（2），行 5
AA1 → 列 27，行 1
```

列字母 ↔ 數字轉換：
```python
def col_letter(n):  # 1 起始 → 字母
    r = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        r = chr(65 + rem) + r
    return r

def col_number(s):  # 字母 → 1 起始
    n = 0
    for c in s.upper():
        n = n * 26 + (ord(c) - 64)
    return n
```

---

## 單元格 XML 參考

### 數據類型

| 類型 | `t` 屬性 | XML 示例 | 值 |
|------|---------|-------------|-------|
| 數字 | 省略 | `<c r="B2"><v>1000</v></c>` | 1000 |
| 字符串（共享） | `s` | `<c r="A1" t="s"><v>0</v></c>` | sharedStrings[0] |
| 字符串（內聯） | `inlineStr` | `<c r="A1" t="inlineStr"><is><t>Hi</t></is></c>` | "Hi" |
| 布爾 | `b` | `<c r="D1" t="b"><v>1</v></c>` | TRUE |
| 錯誤 | `e` | `<c r="E1" t="e"><v>#REF!</v></c>` | #REF! |
| 公式 | 省略 | `<c r="B4"><f>SUM(B2:B3)</f><v></v></c>` | 計算結果 |

### 公式類型

```xml
<!-- 基本公式（XML 中無前導 =！） -->
<c r="B4"><f>SUM(B2:B3)</f><v></v></c>

<!-- 跨表 -->
<c r="C1"><f>Assumptions!B5</f><v></v></c>
<c r="C1"><f>'Sheet With Spaces'!B5</f><v></v></c>

<!-- 共享公式：D2:D100 都用 B*C，帶相對行偏移 -->
<c r="D2"><f t="shared" ref="D2:D100" si="0">B2*C2</f><v></v></c>
<c r="D3"><f t="shared" si="0"/><v></v></c>

<!-- 數組公式 -->
<c r="E1"><f t="array" ref="E1:E5">SORT(A1:A5)</f><v></v></c>
```

---

## styles.xml 參考

### 間接引用鏈

```
單元格 s="3"
  ↓
cellXfs[3] → fontId="2", fillId="0", borderId="0", numFmtId="165"
  ↓              ↓             ↓            ↓              ↓
fonts[2]      fills[0]    borders[0]    numFmts: id=165
藍色          無填充      無邊框        "0.0%"
```

### 添加新樣式（分步）

1. 在 `<numFmts>` 中：添加 `<numFmt numFmtId="168" formatCode="0.00%"/>`，更新 `count`
2. 在 `<fonts>` 中：添加字體條目，記下其索引
3. 在 `<cellXfs>` 中：追加 `<xf numFmtId="168" fontId="N" .../>`，更新 `count`
4. 新樣式索引 = 舊的 `cellXfs count` 值（遞增前）
5. 應用到單元格：`<c r="B5" s="NEW_INDEX">...</c>`

### 顏色格式

`AARRGGBB` — Alpha（不透明始終 `00`）+ 紅 + 綠 + 藍

```
000000FF → 藍
00000000 → 黑
00008000 → 綠（深）
00FF0000 → 紅
00FFFF00 → 黃（用於填充）
00FFFFFF → 白
```

### 內置 numFmtId（無需聲明）

| ID | 格式 | 顯示 |
|----|--------|---------|
| 0 | General | 原樣 |
| 1 | 0 | 2024（用於年份！） |
| 2 | 0.00 | 1000.00 |
| 3 | #,##0 | 1,000 |
| 4 | #,##0.00 | 1,000.00 |
| 9 | 0% | 15% |
| 10 | 0.00% | 15.25% |
| 14 | m/d/yyyy | 3/21/2026 |

---

## sharedStrings.xml 參考

```xml
<sst count="3" uniqueCount="3">
  <si><t>Revenue</t></si>      <!-- 索引 0 -->
  <si><t>Cost</t></si>         <!-- 索引 1 -->
  <si><t>Margin</t></si>       <!-- 索引 2 -->
</sst>
```

帶前導/尾隨空格的文本：
```xml
<si><t xml:space="preserve">  縮進  </t></si>
```

特殊字符：
```xml
<si><t>R&amp;D Expenses</t></si>   <!-- & 必須為 &amp; -->
```

---

## workbook.xml / .rels 同步

workbook.xml 中每個 `<sheet>` 都需要在 workbook.xml.rels 中有匹配的 `<Relationship>`：

```xml
<!-- workbook.xml -->
<!-- 注意：rId 編號取決於 workbook.xml.rels 中已有的 rId。
     最小模板預留 rId1=sheet1, rId2=styles, rId3=sharedStrings。
     向模板添加工作表時，從 rId4 起以避免衝突。
     此處的 rId3 僅為通用示意 — 使用下一個可用 rId。 -->
<sheet name="Summary" sheetId="3" r:id="rId3"/>

<!-- workbook.xml.rels -->
<Relationship Id="rId3"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
  Target="worksheets/sheet3.xml"/>
```

並在 `[Content_Types].xml` 中有匹配的 `<Override>`：
```xml
<Override PartName="/xl/worksheets/sheet3.xml"
  ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
```

---

## 列/行尺寸

```xml
<!-- 在 <sheetData> 之前 -->
<cols>
  <col min="1" max="1" width="28" customWidth="1"/>   <!-- A: 28 字符 -->
  <col min="2" max="6" width="14" customWidth="1"/>   <!-- B-F: 14 字符 -->
</cols>

<!-- 單行的行高 -->
<row r="1" ht="20" customHeight="1">
  ...
</row>
```

---

## 凍結窗格

在 `<sheetView>` 內：
```xml
<!-- 凍結第 1 行（表頭行保持可見） -->
<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>

<!-- 凍結 A 列 -->
<pane xSplit="1" topLeftCell="B1" activePane="topRight" state="frozen"/>

<!-- 同時凍結第 1 行和 A 列 -->
<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>
```

---

## 7 種 Excel 錯誤類型（交付時必須全部不存在）

| 錯誤 | 含義 | XML 中檢測 |
|-------|---------|---------------|
| `#REF!` | 無效單元格引用 | `<c t="e"><v>#REF!</v></c>` |
| `#DIV/0!` | 除以零 | `<c t="e"><v>#DIV/0!</v></c>` |
| `#VALUE!` | 錯誤數據類型 | `<c t="e"><v>#VALUE!</v></c>` |
| `#NAME?` | 未知函數/名稱 | `<c t="e"><v>#NAME?</v></c>` |
| `#NULL!` | 空交集 | `<c t="e"><v>#NULL!</v></c>` |
| `#NUM!` | 數字超出範圍 | `<c t="e"><v>#NUM!</v></c>` |
| `#N/A` | 未找到值 | `<c t="e"><v>#N/A</v></c>` |
