# OOXML SpreadsheetML 速查表

xlsx 文件 XML 操作的快速参考。

---

## 包结构

```
my_file.xlsx  （ZIP 归档）
├── [Content_Types].xml          ← 声明所有文件的 MIME 类型
├── _rels/
│   └── .rels                    ← 根关系：指向 xl/workbook.xml
└── xl/
    ├── workbook.xml             ← 工作表列表、计算设置
    ├── styles.xml               ← 所有样式定义
    ├── sharedStrings.xml        ← 所有文本字符串（按索引引用）
    ├── _rels/
    │   └── workbook.xml.rels    ← 将 r:id 映射到 worksheet/styles/sharedStrings 文件
    ├── worksheets/
    │   ├── sheet1.xml           ← 工作表 1 数据
    │   ├── sheet2.xml           ← 工作表 2 数据
    │   └── ...
    ├── charts/                  ← 图表 XML（如有）
    ├── pivotTables/             ← 透视表 XML（如有）
    └── theme/
        └── theme1.xml           ← 颜色/字体主题
```

---

## 单元格引用格式

```
A1  → 列 A（1），行 1
B5  → 列 B（2），行 5
AA1 → 列 27，行 1
```

列字母 ↔ 数字转换：
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

## 单元格 XML 参考

### 数据类型

| 类型 | `t` 属性 | XML 示例 | 值 |
|------|---------|-------------|-------|
| 数字 | 省略 | `<c r="B2"><v>1000</v></c>` | 1000 |
| 字符串（共享） | `s` | `<c r="A1" t="s"><v>0</v></c>` | sharedStrings[0] |
| 字符串（内联） | `inlineStr` | `<c r="A1" t="inlineStr"><is><t>Hi</t></is></c>` | "Hi" |
| 布尔 | `b` | `<c r="D1" t="b"><v>1</v></c>` | TRUE |
| 错误 | `e` | `<c r="E1" t="e"><v>#REF!</v></c>` | #REF! |
| 公式 | 省略 | `<c r="B4"><f>SUM(B2:B3)</f><v></v></c>` | 计算结果 |

### 公式类型

```xml
<!-- 基本公式（XML 中无前导 =！） -->
<c r="B4"><f>SUM(B2:B3)</f><v></v></c>

<!-- 跨表 -->
<c r="C1"><f>Assumptions!B5</f><v></v></c>
<c r="C1"><f>'Sheet With Spaces'!B5</f><v></v></c>

<!-- 共享公式：D2:D100 都用 B*C，带相对行偏移 -->
<c r="D2"><f t="shared" ref="D2:D100" si="0">B2*C2</f><v></v></c>
<c r="D3"><f t="shared" si="0"/><v></v></c>

<!-- 数组公式 -->
<c r="E1"><f t="array" ref="E1:E5">SORT(A1:A5)</f><v></v></c>
```

---

## styles.xml 参考

### 间接引用链

```
单元格 s="3"
  ↓
cellXfs[3] → fontId="2", fillId="0", borderId="0", numFmtId="165"
  ↓              ↓             ↓            ↓              ↓
fonts[2]      fills[0]    borders[0]    numFmts: id=165
蓝色          无填充      无边框        "0.0%"
```

### 添加新样式（分步）

1. 在 `<numFmts>` 中：添加 `<numFmt numFmtId="168" formatCode="0.00%"/>`，更新 `count`
2. 在 `<fonts>` 中：添加字体条目，记下其索引
3. 在 `<cellXfs>` 中：追加 `<xf numFmtId="168" fontId="N" .../>`，更新 `count`
4. 新样式索引 = 旧的 `cellXfs count` 值（递增前）
5. 应用到单元格：`<c r="B5" s="NEW_INDEX">...</c>`

### 颜色格式

`AARRGGBB` — Alpha（不透明始终 `00`）+ 红 + 绿 + 蓝

```
000000FF → 蓝
00000000 → 黑
00008000 → 绿（深）
00FF0000 → 红
00FFFF00 → 黄（用于填充）
00FFFFFF → 白
```

### 内置 numFmtId（无需声明）

| ID | 格式 | 显示 |
|----|--------|---------|
| 0 | General | 原样 |
| 1 | 0 | 2024（用于年份！） |
| 2 | 0.00 | 1000.00 |
| 3 | #,##0 | 1,000 |
| 4 | #,##0.00 | 1,000.00 |
| 9 | 0% | 15% |
| 10 | 0.00% | 15.25% |
| 14 | m/d/yyyy | 3/21/2026 |

---

## sharedStrings.xml 参考

```xml
<sst count="3" uniqueCount="3">
  <si><t>Revenue</t></si>      <!-- 索引 0 -->
  <si><t>Cost</t></si>         <!-- 索引 1 -->
  <si><t>Margin</t></si>       <!-- 索引 2 -->
</sst>
```

带前导/尾随空格的文本：
```xml
<si><t xml:space="preserve">  缩进  </t></si>
```

特殊字符：
```xml
<si><t>R&amp;D Expenses</t></si>   <!-- & 必须为 &amp; -->
```

---

## workbook.xml / .rels 同步

workbook.xml 中每个 `<sheet>` 都需要在 workbook.xml.rels 中有匹配的 `<Relationship>`：

```xml
<!-- workbook.xml -->
<!-- 注意：rId 编号取决于 workbook.xml.rels 中已有的 rId。
     最小模板预留 rId1=sheet1, rId2=styles, rId3=sharedStrings。
     向模板添加工作表时，从 rId4 起以避免冲突。
     此处的 rId3 仅为通用示意 — 使用下一个可用 rId。 -->
<sheet name="Summary" sheetId="3" r:id="rId3"/>

<!-- workbook.xml.rels -->
<Relationship Id="rId3"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
  Target="worksheets/sheet3.xml"/>
```

并在 `[Content_Types].xml` 中有匹配的 `<Override>`：
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

<!-- 单行的行高 -->
<row r="1" ht="20" customHeight="1">
  ...
</row>
```

---

## 冻结窗格

在 `<sheetView>` 内：
```xml
<!-- 冻结第 1 行（表头行保持可见） -->
<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>

<!-- 冻结 A 列 -->
<pane xSplit="1" topLeftCell="B1" activePane="topRight" state="frozen"/>

<!-- 同时冻结第 1 行和 A 列 -->
<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>
```

---

## 7 种 Excel 错误类型（交付时必须全部不存在）

| 错误 | 含义 | XML 中检测 |
|-------|---------|---------------|
| `#REF!` | 无效单元格引用 | `<c t="e"><v>#REF!</v></c>` |
| `#DIV/0!` | 除以零 | `<c t="e"><v>#DIV/0!</v></c>` |
| `#VALUE!` | 错误数据类型 | `<c t="e"><v>#VALUE!</v></c>` |
| `#NAME?` | 未知函数/名称 | `<c t="e"><v>#NAME?</v></c>` |
| `#NULL!` | 空交集 | `<c t="e"><v>#NULL!</v></c>` |
| `#NUM!` | 数字超出范围 | `<c t="e"><v>#NUM!</v></c>` |
| `#N/A` | 未找到值 | `<c t="e"><v>#N/A</v></c>` |
