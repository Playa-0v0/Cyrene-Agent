# 已有 xlsx 的最小侵入式编辑

对已有 xlsx 文件做精确、外科手术式的改动，同时保留一切你不碰的内容：样式、宏、透视表、图表、迷你图、命名区域、数据验证、条件格式及所有其他嵌入内容。

---

## 1. 何时使用此路径

只要任务涉及**修改已有 xlsx 文件**，就用编辑（解包 → XML 编辑 → 打包）路径：

- 模板填充 — 用值或公式填充指定输入单元格
- 数据更新 — 替换活文件中过时的数字、文本或日期
- 内容修正 — 修复错误值、损坏公式或拼错的标签
- 向已有表添加新数据行
- 重命名工作表
- 对特定单元格应用新样式

不要用此路径从零创建全新工作簿。那种情况见 `create.md`。

---

## 2. 为何已有文件禁止 openpyxl 往返

openpyxl `load_workbook()` 后 `workbook.save()` 对任何含高级功能的文件是**破坏性操作**。该库静默丢弃它不理解的内容：

| 功能 | openpyxl 行为 | 后果 |
|---------|-------------------|-------------|
| VBA 宏（`vbaProject.bin`） | 完全丢弃 | 所有自动化丢失；文件存为 `.xlsx` 而非 `.xlsm` |
| 透视表（`xl/pivotTables/`） | 丢弃 | 交互分析被毁 |
| 切片器 | 丢弃 | 筛选 UI 丢失 |
| 迷你图（`<sparklineGroups>`） | 丢弃 | 单元格内迷你图消失 |
| 图表格式细节 | 部分丢失 | 系列颜色、自定义坐标轴可能还原 |
| 打印区域/分页符 | 有时丢失 | 打印布局改变 |
| 自定义 XML 部件 | 丢弃 | 第三方数据绑定断裂 |
| 主题链接颜色 | 可能去主题化 | 颜色转为绝对值，破坏主题切换 |

即便在无这些功能的"纯"文件上，openpyxl 也可能规范化 Excel 依赖的 XML 空白、改变命名空间声明或重置 `calcMode` 标志。

**规则是绝对的：绝不以重新保存为目的用 openpyxl 打开已有文件。**

XML 直接编辑方式安全，因为它操作原始字节。你只改你碰的节点。其他一切与原始文件字节等效。

---

## 3. 标准操作流程

### 第 1 步 — 解包

```bash
python3 SKILL_DIR/scripts/xlsx_unpack.py input.xlsx /tmp/xlsx_work/
```

脚本解压 xlsx，美化打印每个 XML 和 `.rels` 文件，并打印关键文件的分类清单，若检测到高风险内容（VBA、透视表、图表）则发出警告。

继续前仔细阅读打印输出。若脚本报告 `xl/vbaProject.bin` 或 `xl/pivotTables/`，遵循第 7 节的约束。

### 第 2 步 — 侦察

碰任何东西前先摸清结构。

**识别工作表名及其 XML 文件：**

```
xl/workbook.xml  →  <sheet name="Revenue" sheetId="1" r:id="rId1"/>
xl/_rels/workbook.xml.rels  →  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
```

名为 "Revenue" 的工作表位于 `xl/worksheets/sheet1.xml`。编辑工作表前始终先解析此映射。

**理解共享字符串表：**

```bash
# 统计 xl/sharedStrings.xml 中的现有条目
grep -c "<si>" /tmp/xlsx_work/xl/sharedStrings.xml
```

每个文本单元格用对此表的 0 起始索引。追加前先知道当前数量。

**理解样式表：**

```bash
# 统计现有 cellXfs 条目
grep -c "<xf " /tmp/xlsx_work/xl/styles.xml
```

新样式槽追加在现有之后。第一个新槽的索引 = 当前数量。

**扫描目标工作表中的高风险 XML 区域：**

编辑前在目标 `sheet*.xml` 中查找这些元素：

- `<mergeCell>` — 合并单元格范围；行/列插入会移动这些
- `<conditionalFormatting>` — 条件范围；行/列插入会移动这些
- `<dataValidations>` — 验证范围；行/列插入会移动这些
- `<tableParts>` — 表定义；表内插行需更新 `<tableColumn>`
- `<sparklineGroups>` — 迷你图；原样保留不修改

### 第 3 步 — 将意图映射为最小 XML 改动

写一个字前，先产出一份书面清单，列出确切哪些 XML 节点变化。这防止范围蔓延。

| 用户意图 | 要改的文件 | 要改的节点 |
|-------------|----------------|-----------------|
| 改单元格数值 | `xl/worksheets/sheetN.xml` | 目标 `<c>` 内的 `<v>` |
| 改单元格文本 | `xl/sharedStrings.xml`（追加）+ `xl/worksheets/sheetN.xml` | 新 `<si>`，更新单元格 `<v>` 索引 |
| 改单元格公式 | `xl/worksheets/sheetN.xml` | 目标 `<c>` 内的 `<f>` 文本 |
| 底部添加新数据行 | `xl/worksheets/sheetN.xml` + 可能 `xl/sharedStrings.xml` | 追加 `<row>` 元素 |
| 对单元格应用新样式 | `xl/styles.xml` + `xl/worksheets/sheetN.xml` | 在 `<cellXfs>` 追加 `<xf>`，更新 `<c>` 的 `s` 属性 |
| 重命名工作表 | `xl/workbook.xml` | `<sheet>` 元素的 `name` 属性 |
| 重命名工作表（含跨表公式） | `xl/workbook.xml` + 所有 `xl/worksheets/*.xml` | `name` 属性 + 引用旧名的 `<f>` 文本 |

### 第 4 步 — 执行改动

用 Edit 工具。最小化编辑。绝不重写整个文件。

每种操作类型的精确 XML 模式见第 4 节。

### 第 5 步 — 级联检查

任何移动行或列位置的改动后，审计所有受影响 XML 区域。见第 5 节。

### 第 6 步 — 打包并验证

```bash
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
python3 SKILL_DIR/scripts/formula_check.py output.xlsx
```

打包脚本在创建 ZIP 前验证 XML 良构性。修复任何报告的解析错误再打包。打包后运行 `formula_check.py` 确认未引入公式错误。

---

## 4. 常见编辑的精确 XML 模式

### 4.1 改变数字单元格值

在工作表 XML 中找到 `<c r="B5">` 元素，替换 `<v>` 文本。

**之前：**
```xml
<c r="B5">
  <v>1000</v>
</c>
```

**之后（新值 1500）：**
```xml
<c r="B5">
  <v>1500</v>
</c>
```

规则：
- 除非显式改样式，否则不添加或移除 `s` 属性（样式）。
- 不添加 `t` 属性 — 数字省略 `t` 或用 `t="n"`。
- 不改 `r` 属性（单元格引用）。

---

### 4.2 改变文本单元格值

文本单元格按索引（`t="s"`）引用共享字符串表。你无法就地编辑字符串而不影响每个用同一索引的其他单元格。安全做法是追加新条目。

**之前 — 共享字符串文件（`xl/sharedStrings.xml`）：**
```xml
<sst count="4" uniqueCount="4">
  <si><t>Revenue</t></si>
  <si><t>Cost</t></si>
  <si><t>Margin</t></si>
  <si><t>Old Label</t></si>
</sst>
```

**之后 — 追加新字符串，递增计数：**
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

**之前 — 工作表 XML 中的单元格：**
```xml
<c r="A7" t="s">
  <v>3</v>
</c>
```

**之后 — 指向新索引：**
```xml
<c r="A7" t="s">
  <v>4</v>
</c>
```

规则：
- 绝不修改或删除已有 `<si>` 条目。只追加。
- `count` 和 `uniqueCount` 必须一起递增。
- 若新字符串含 `&`、`<` 或 `>`，转义：`&amp;`、`&lt;`、`&gt;`。
- 若字符串有前导或尾随空格，给 `<t>` 加 `xml:space="preserve"`：
  ```xml
  <si><t xml:space="preserve">  缩进文本  </t></si>
  ```

---

### 4.3 改变公式

公式存储在 `<f>` 元素中，**无前导 `=`**（与 Excel UI 中输入不同）。

**之前：**
```xml
<c r="C10">
  <f>SUM(C2:C9)</f>
  <v>4800</v>
</c>
```

**之后（扩展范围）：**
```xml
<c r="C10">
  <f>SUM(C2:C11)</f>
  <v></v>
</c>
```

规则：
- 改公式时将 `<v>` 清为空字符串。缓存值现已过时。
- 不给公式单元格加 `t="s"` 或任何类型属性。`t` 属性缺席或用结果类型值，而非公式标记。
- 跨表引用用 `SheetName!CellRef`。若工作表名含空格，用单引号包裹：`'Q1 Data'!B5`。
- `<f>` 文本不得包含前导 `=`。

**之前（将硬编码值转为活公式）：**
```xml
<c r="D15">
  <v>95000</v>
</c>
```

**之后：**
```xml
<c r="D15">
  <f>SUM(D2:D14)</f>
  <v></v>
</c>
```

---

### 4.4 添加新数据行

在 `<sheetData>` 内最后一个 `<row>` 元素后追加。OOXML 中行号 1 起始且必须连续。

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

**之后（追加新行 11）：**
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

规则：
- 行内每个 `<c>` 必须将 `r` 设为正确单元格地址（如 `A11`）。
- 文本单元格需 `t="s"` 和 sharedStrings 索引在 `<v>` 中。数字单元格省略 `t`。
- 公式单元格用 `<f>` 和空 `<v>`。
- 若要匹配样式，从上方行复制 `s` 属性。不要凭空发明 `styles.xml` 中不存在的样式索引。
- 若工作表含 `<dimension>` 元素（如 `<dimension ref="A1:D10"/>`），更新以包含新行：`<dimension ref="A1:D11"/>`。
- 若工作表含引用表的 `<tableparts>`，更新对应 `xl/tables/tableN.xml` 中表的 `ref` 属性。

---

### 4.5 添加新列

向每个已有 `<row>` 追加新 `<c>` 元素，若存在则更新 `<cols>` 部分。

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

**之后（添加 D 列）：**
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

规则：
- 在末尾（最后一列之后）添加列是安全的 — 无现有公式引用移动。
- 在中间插入列会使所有列右移，需与插行相同的级联更新（见第 5 节）。
- 若存在则更新 `<dimension>` 元素。

---

### 4.6 修改或添加样式

样式用多级间接引用链。完整链见 `ooxml-cheatsheet.md`。关键规则：**只追加新条目，绝不修改已有**。

**场景：** 添加一个尚不存在的蓝色字体样式（用于硬编码输入单元格）。

**第 1 步 — 检查 `xl/styles.xml` 中是否已有匹配字体：**
```xml
<!-- 在 <fonts> 中查找已有蓝色字体 -->
<font>
  <color rgb="000000FF"/>
  <!-- 其他属性 -->
</font>
```

若找到，记下其索引（`<fonts>` 列表中 0 起始位置）。若未找到，追加。

**第 2 步 — 需要时追加新字体：**

之前：
```xml
<fonts count="3">
  <font>...</font>   <!-- 索引 0 -->
  <font>...</font>   <!-- 索引 1 -->
  <font>...</font>   <!-- 索引 2 -->
</fonts>
```

之后：
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

之后：
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

**第 4 步 — 应用到目标单元格：**

之前：
```xml
<c r="B3">
  <v>0.08</v>
</c>
```

之后：
```xml
<c r="B3" s="5">
  <v>0.08</v>
</c>
```

规则：
- 绝不删除或重排 `<fonts>`、`<fills>`、`<borders>`、`<cellXfs>` 中已有条目。
- 追加时始终更新 `count` 属性。
- 新 `cellXfs` 索引 = 追加前的旧 `count` 值（0 起始：若 count 为 5，新索引为 5）。
- 自定义 `numFmt` ID 必须 164 以上。ID 0–163 是内置的，不得重新声明。
- 若期望样式已存在于文件中（类似单元格上），复用其 `s` 索引而非创建重复。

---

### 4.7 重命名工作表

**只需改 `xl/workbook.xml`** — 除非跨表公式引用旧名。

**之前（`xl/workbook.xml`）：**
```xml
<sheet name="Sheet1" sheetId="1" r:id="rId1"/>
```

**之后：**
```xml
<sheet name="Revenue" sheetId="1" r:id="rId1"/>
```

**若任何工作表中任何公式引用旧名，也更新那些：**

之前（`xl/worksheets/sheet2.xml`）：
```xml
<c r="B5"><f>Sheet1!C10</f><v></v></c>
```

之后：
```xml
<c r="B5"><f>Revenue!C10</f><v></v></c>
```

若新名含空格：
```xml
<c r="B5"><f>'Q1 Revenue'!C10</f><v></v></c>
```

扫描所有工作表 XML 文件查找旧名：
```bash
grep -r "Sheet1!" /tmp/xlsx_work/xl/worksheets/
```

规则：
- `.rels` 文件和 `[Content_Types].xml` 无需改 — 它们引用 XML 文件路径，而非工作表名。
- `sheetId` 不得改；它是稳定内部标识符。
- 公式引用中工作表名区分大小写。

---

## 5. 高风险操作 — 级联效应

### 5.1 中间插入行

在位置 N 插入行会使 N 及以下所有行下移。每个 XML 文件中对这些行的引用都必须更新。

**要检查和更新的文件：**

| XML 区域 | 更新什么 | 示例移动 |
|------------|---------------|---------------|
| 工作表 `<row r="...">` 属性 | 递增 >= N 的所有行行号 | `r="7"` → `r="8"` |
| 这些行内所有 `<c r="...">` | 递增单元格地址中的行号 | `r="A7"` → `r="A8"` |
| 任何工作表中所有 `<f>` 公式文本 | 移动 >= N 的绝对行引用 | `B7` → `B8` |
| `<mergeCell ref="...">` | 移动起始和结束行 | `A7:C7` → `A8:C8` |
| `<conditionalFormatting sqref="...">` | 移动范围 | `A5:D20` → `A5:D21` |
| `<dataValidations sqref="...">` | 移动范围 | `B6:B50` → `B7:B51` |
| `xl/charts/chartN.xml` 数据源范围 | 移动系列范围 | `Sheet1!$B$5:$B$20` → `Sheet1!$B$6:$B$21` |
| `xl/pivotTables/*.xml` 源范围 | 移动源数据范围 | 极谨慎处理 — 见第 7 节 |
| `<dimension ref="...">` | 扩展以包含新范围 | `A1:D20` → `A1:D21` |
| `xl/tables/tableN.xml` `ref` 属性 | 扩展表边界 | `A1:D20` → `A1:D21` |

**不要在大或公式密集的文件中手动插行。** 改用专用移动脚本：

```bash
# 在第 5 行插 1 行：第 5 行及以下全部下移 1
python3 SKILL_DIR/scripts/xlsx_shift_rows.py /tmp/xlsx_work/ insert 5 1

# 删除第 8 行：第 9 行及以上全部上移 1
python3 SKILL_DIR/scripts/xlsx_shift_rows.py /tmp/xlsx_work/ delete 8 1
```

脚本一次更新：`<row r="...">` 属性、`<c r="...">` 单元格地址、跨每个工作表的所有 `<f>` 公式文本、`<mergeCell>` 范围、`<conditionalFormatting sqref="...">`、`<dataValidation sqref="...">`、`<dimension ref="...">`、`xl/tables/` 中表 `ref` 属性、`xl/charts/` 中图表系列范围、`xl/pivotCaches/` 中透视缓存源范围。

**运行移动脚本后，始终重新打包并验证：**
```bash
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
python3 SKILL_DIR/scripts/formula_check.py output.xlsx
```

**脚本不更新（手动审查）：**
- `xl/workbook.xml` `<definedNames>` 中的命名区域 — 若引用移动行则检查更新。
- 公式中的结构化表引用（`Table[@Column]`）。
- `xl/externalLinks/` 中的外部工作簿链接。

### 5.2 中间插入列

与插行相同的级联逻辑，但针对列。公式中的列引用（`B`、`$C` 等）及合并单元格范围、条件格式范围、图表数据源都需更新。

列字母移动更难安全自动化。尽量选择**在末尾追加列**。

### 5.3 删除行或列

删除比插入更危险，因为任何引用被删行/列的公式会变 `#REF!`。删除前：

1. 搜索所有 `<f>` 元素对被删范围的引用。
2. 若任何公式引用被删行/列中的单元格，不要删除 — 改为清除该行数据或咨询用户。
3. 删除后，将删除点之后的行/列引用向下/向左移动。

---

## 6. 模板填充 — 识别并填充输入单元格

模板将某些单元格指定为输入区。识别它们的常见模式：

### 6.1 模板如何标示输入区

| 信号 | XML 表现 | 找什么 |
|--------|-------------------|-----------------|
| 蓝色字体 | `s` 属性指向 `fontId` → `<color rgb="000000FF"/>` 的 `cellXfs` 条目 | 检查 `styles.xml` 解码 `s` 值 |
| 黄色填充（高亮） | `s` → `fillId` → `<fill><patternFill><fgColor rgb="00FFFF00"/>` | |
| 空 `<v>` 元素 | `<c r="B5"><v></v></c>` 或单元格在 `<row>` 中完全缺席 | 单元格尚无值 |
| 单元格附近批注/注释 | `xl/comments1.xml` 中 `ref="B5"` | 批注常标注输入字段 |
| 命名区域 | `xl/workbook.xml` `<definedName>` 元素 | 模板可能定义 `InputRevenue` 等 |

### 6.2 填充模板单元格

不改 `s` 属性。除非必须从空改到有类型，否则不改 `t` 属性。只改 `<v>` 或加 `<f>`。

**之前（空输入单元格，样式保留）：**
```xml
<c r="C5" s="3">
  <v></v>
</c>
```

**之后（填数字，样式不变）：**
```xml
<c r="C5" s="3">
  <v>125000</v>
</c>
```

**之后（填文本 — 需先有共享字符串条目）：**
```xml
<!-- 1. 追加到 sharedStrings.xml：<si><t>North Region</t></si> 在索引 7 -->
<c r="C5" t="s" s="3">
  <v>7</v>
</c>
```

**之后（填公式，保留样式）：**
```xml
<c r="C5" s="3">
  <f>Assumptions!D12</f>
  <v></v>
</c>
```

### 6.3 不在 Excel 中打开文件而定位输入区

解包后，解码可疑输入单元格上的样式索引以确定是否有模板的输入颜色：

1. 记下单元格的 `s` 值（如 `s="4"`）。
2. 在 `xl/styles.xml` 中找 `<cellXfs>`，看第 5 个条目（索引 4）。
3. 记下其 `fontId`（如 `fontId="2"`）。
4. 在 `<fonts>` 中看第 3 个条目（索引 2），检查是否有 `<color rgb="000000FF"/>`（蓝）或其他输入标记。

若模板用命名区域作输入字段，从 `xl/workbook.xml` 读取：
```xml
<definedNames>
  <definedName name="InputGrowthRate">Assumptions!$B$5</definedName>
  <definedName name="InputDiscountRate">Assumptions!$B$6</definedName>
</definedNames>
```

直接填充目标单元格（`Assumptions!B5`、`Assumptions!B6`）。

### 6.4 模板填充规则

- 只填充模板指定为输入的单元格。不填充公式驱动的单元格。
- 填充时不应用新样式。模板的格式是交付物。
- 不在模板数据区内添加或删除行，除非模板显式有"在此追加"区。
- 填充后，验证未引入公式错误：某些模板有输入验证公式，若输入错误数据类型会产生 `#VALUE!`。

---

## 7. 绝不可修改的文件

### 7.1 绝对不可碰清单

| 文件/位置 | 原因 |
|-----------------|-----|
| `xl/vbaProject.bin` | 二进制 VBA 字节码。任何字节修改都会损坏宏工程。改一位都使宏无法加载。 |
| `xl/pivotCaches/pivotCacheDefinition*.xml` | 缓存定义将透视表绑定到源数据。编辑它而不更新对应 `pivotTable*.xml` 会损坏透视表。 |
| `xl/pivotTables/*.xml` | 透视表 XML 与缓存定义及 Excel 加载时重建的内部状态紧密耦合。不要编辑。若你移动了行且透视的源范围现在指向错误数据，只更新缓存定义中的 `<cacheSource>` 范围，和透视表中的 `ref` 属性 — 不做其他改动。 |
| `xl/slicers/*.xml` | 切片器连接到特定缓存 ID 和透视字段。破坏这些连接会静默损坏文件。 |
| `xl/connections.xml` | 外部数据连接。编辑破坏实时数据刷新。 |
| `xl/externalLinks/` | 外部工作簿链接。其中的二进制 `.bin` 文件不得修改。 |

### 7.2 有条件安全的文件（只更新特定属性）

| 文件 | 可更新 | 要保留不动 |
|------|--------------------|--------------------|
| `xl/charts/chartN.xml` | 行/列移动后的数据系列范围引用（`<numRef><f>`） | 图表类型、格式、布局 |
| `xl/tables/tableN.xml` | 添加行后 `<table>` 的 `ref` 属性 | 列定义、样式信息 |
| `xl/pivotCaches/pivotCacheDefinition*.xml` | 移动源数据后 `<cacheSource><worksheetSource>` 的 `ref` 属性 | 所有其他内容 |

---

## 8. 每次编辑后验证

绝不跳过验证。公式中一个字符的改动都可能引起级联错误。

```bash
# 打包
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx

# 静态公式验证（始终运行）
python3 SKILL_DIR/scripts/formula_check.py output.xlsx

# 动态验证（若 LibreOffice 可用）
python3 SKILL_DIR/scripts/libreoffice_recalc.py output.xlsx /tmp/recalc.xlsx
python3 SKILL_DIR/scripts/formula_check.py /tmp/recalc.xlsx
```

若 `formula_check.py` 报告任何错误：
1. 再次解包输出文件（它是打包版本）。
2. 在工作表 XML 中定位报告的单元格。
3. 修复 `<f>` 元素。
4. 重新打包并重新验证。

`formula_check.py` 报告零错误前不要交付文件。

---

## 9. 绝对规则总结

| 规则 | 理由 |
|------|-----------|
| 绝不对已有文件用 openpyxl `load_workbook` + `save` | 往返破坏透视表、VBA、迷你图、切片器 |
| 绝不删除或重排 sharedStrings 中已有 `<si>` 条目 | 破坏每个引用该索引的单元格 |
| 绝不删除或重排 `<cellXfs>` 中已有 `<xf>` 条目 | 破坏每个用该样式索引的单元格 |
| 绝不修改 `vbaProject.bin` | 二进制文件；任何改动损坏 VBA |
| 重命名工作表时绝不改 `sheetId` | 内部 ID 稳定；改它破坏关系 |
| 绝不跳过编辑后验证 | 留下未检测的断裂引用 |
| 绝不编辑超出所需的 XML 节点 | 额外改动有引入微妙损坏的风险 |
| 改公式时将 `<v>` 清为空字符串 | 防止过时缓存值误导下游消费者 |
| sharedStrings 仅追加 | 现有索引必须保持有效 |
| 样式集合仅追加 | 现有样式索引必须保持有效 |
