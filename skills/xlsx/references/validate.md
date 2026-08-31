# 公式验证与重算指南

确保 xlsx 文件中每个公式在交付前可证明正确。打开无可见错误的文件不是通过的文件 — 只有通过两层验证的文件才是通过的文件。

---

## 基础规则

- **未先运行 `formula_check.py` 绝不声明 PASS。** 电子表格的视觉检查不是验证。
- **第 1 层（静态）在每个场景中都强制。** 第 2 层（动态）在 LibreOffice 可用时强制。若不可用，必须在报告中明确说明 — 不可静默跳过。
- **绝不用 openpyxl `data_only=True` 检查公式值。** 以 `data_only=True` 模式打开并保存工作簿会永久用最后缓存值替换所有公式。公式之后无法恢复。
- **只自动修复确定性错误。** 任何需理解业务逻辑的修复必须标记为人工审阅。

---

## 两层验证架构

```
第 1 层 — 静态验证（XML 扫描，无需外部工具）
  │
  ├── 检测：已缓存在 <v> 元素中的全部 7 种 Excel 错误类型
  ├── 检测：指向不存在工作表的跨表引用
  ├── 检测：带 t="e" 属性的公式单元格（错误类型标记）
  └── 工具：formula_check.py + 手动 XML 检查
        │
        ▼（若 LibreOffice 存在）
第 2 层 — 动态验证（LibreOffice 无头重算）
  │
  ├── 通过 LibreOffice Calc 引擎执行所有公式
  ├── 用真实计算结果填充 <v> 缓存值
  ├── 暴露重算前不可见的运行时错误
  └── 后续：对重算后的文件重新运行第 1 层
```

**为何两层？**

openpyxl 和所有 Python xlsx 库将公式字符串（如 `=SUM(B2:B9)`）写入 `<f>` 元素但不求值。新生成的文件每个公式单元格的 `<v>` 缓存元素为空。这意味着：

- 第 1 层只能捕获已编码在 XML 中的错误 — 要么是 `t="e"` 单元格，要么是结构断裂的跨表引用。
- 第 2 层用 LibreOffice 作实际计算引擎，运行每个公式，用真实结果填充 `<v>`，并暴露只能在计算后出现的运行时错误（`#DIV/0!`、`#N/A` 等）。

单独任一层都不够。两者合起来覆盖完整的可纠正面。

---

## 第 1 层 — 静态验证

静态验证无需外部工具。直接操作 xlsx 文件的 ZIP/XML 结构。

### 第 1 步：运行 formula_check.py

**标准（人类可读）输出：**

```bash
python3 SKILL_DIR/scripts/formula_check.py /path/to/file.xlsx
```

**JSON 输出（用于程序化处理）：**

```bash
python3 SKILL_DIR/scripts/formula_check.py /path/to/file.xlsx --json
```

**单表模式（定向检查更快）：**

```bash
python3 SKILL_DIR/scripts/formula_check.py /path/to/file.xlsx --sheet Summary
```

**摘要模式（仅计数，无逐单元格详情）：**

```bash
python3 SKILL_DIR/scripts/formula_check.py /path/to/file.xlsx --summary
```

退出码：
- `0` — 无硬错误（PASS 或 PASS 带启发式警告）
- `1` — 检测到硬错误，或文件无法打开（FAIL）

#### formula_check.py 检查什么

脚本将 xlsx 作为 ZIP 归档打开，不使用任何 Excel 库。它读 `xl/workbook.xml` 枚举工作表名和命名区域，读 `xl/_rels/workbook.xml.rels` 将每个工作表映射到其 XML 文件，然后遍历每个工作表中每个 `<c>` 元素。

它执行五项检查：

1. **错误值检测**：若单元格有 `t="e"`，其 `<v>` 元素含 Excel 错误字符串。记录该单元格的工作表名、单元格引用（如 `C5`）、错误值，以及公式文本（若存在）。

2. **断裂跨表引用检测**：若单元格有 `<f>` 元素，脚本提取公式中引用的所有工作表名（`SheetName!` 和 `'Sheet Name'!` 两种语法）。每个名与 `workbook.xml` 中的工作表列表比较。不匹配即为断裂引用。

3. **未知命名区域检测（启发式）**：公式中既非函数名、非单元格引用、又不在 `workbook.xml` 的 `<definedNames>` 中的标识符，标记为 `unknown_name_ref` 警告。这是启发式 — 可能误报；始终手动验证。

4. **共享公式完整性**：共享公式消费单元格（仅含 `<f t="shared" si="N"/>`）跳过公式计数和跨引用检查，因为它们继承主单元格公式。只检查并计数主单元格（有 `ref="..."` 属性和公式文本）。

5. **畸形错误单元格**：有 `t="e"` 但无 `<v>` 子元素的单元格标记为结构性 XML 问题。

硬错误（退出码 1）：`error_value`、`broken_sheet_ref`、`malformed_error_cell`、`file_error`
软警告（退出码 0）：`unknown_name_ref` — 必须手动验证但单独不阻止交付

#### 阅读 formula_check.py 人类可读输出

干净文件长这样：

```
File   : /tmp/budget_2024.xlsx
Sheets : Summary, Q1, Q2, Q3, Q4, Assumptions
Formulas checked      : 312 distinct formula cells
Shared formula ranges : 4 ranges
Errors found          : 0

PASS — No formula errors detected
```

有错误的文件长这样：

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

每行解读：
- `[FAIL] [Summary!C12] contains #REF! (formula: Q1!A0/Q1!A1)` — 单元格有 `t="e"` 和 `<v>#REF!</v>`。公式引用行 0，Excel 的 1 起始系统中不存在。这是生成引用的差一错误。
- `[FAIL] [Summary!D15] references missing sheet 'Q5'` — 公式含 `Q5!D15`，但工作簿中无名为 `Q5` 的工作表。提供有效工作表列表供比较。
- `[FAIL] [Q1!F8] contains #DIV/0!` — 此单元格的 `<v>` 已是错误值（文件之前被重算过）。公式除以零。
- `[WARN] [Q2!B10] uses unknown name 'GrowthAssumptions'` — 标识符 `GrowthAssumptions` 出现在公式中但不在 `<definedNames>`。可能是拼写错误或意外遗漏的名称。这是启发式警告 — 手动验证。单独警告不阻止交付。

#### 阅读 formula_check.py JSON 输出

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

字段参考：

| 字段 | 含义 |
|-------|---------|
| `type: "error_value"` | 单元格有 `t="e"` — `<v>` 元素中存有 Excel 错误 |
| `type: "broken_sheet_ref"` | 公式引用 workbook.xml 中不存在的工作表名 |
| `type: "unknown_name_ref"` | 公式引用不在 `<definedNames>` 中的标识符（启发式，软警告） |
| `type: "malformed_error_cell"` | 单元格有 `t="e"` 但无 `<v>` 子元素 — 结构性 XML 问题 |
| `type: "file_error"` | 文件无法打开（坏 ZIP、未找到等） |
| `sheet` | 发现错误的工作表 |
| `cell` | A1 表示法的单元格引用 |
| `formula` | `<f>` 元素的完整公式文本（不存在则为 null） |
| `error` | `<v>` 中的错误字符串（`error_value` 类型） |
| `missing_sheet` | 从公式提取的不存在的工作表名 |
| `valid_sheets` | workbook.xml 中实际存在的所有工作表名 |
| `unknown_name` | 未在 `<definedNames>` 中找到的标识符 |
| `defined_names` | workbook.xml 中实际存在的所有命名区域 |
| `shared_formula_ranges` | 共享公式定义计数（顶层 `<f t="shared" ref="...">` 元素） |

### 第 2 步：手动 XML 检查

当 formula_check.py 报告错误时，解包文件检查原始 XML：

```bash
python3 SKILL_DIR/scripts/xlsx_unpack.py /path/to/file.xlsx /tmp/xlsx_inspect/
```

导航到报告工作表的工作表文件。工作表到文件的映射在 `xl/_rels/workbook.xml.rels`。例如，若 `rId1` 映射到 `worksheets/sheet1.xml`，则 sheet1.xml 是 `xl/workbook.xml` 中 `r:id="rId1"` 工作表的文件。

对每个报告的错误单元格，定位 `<c r="CELLREF">` 元素并检查：

**对于 `error_value` 错误：**
```xml
<!-- 错误单元格在 XML 中长这样 -->
<c r="C12" t="e">
  <f>Q1!C10/Q1!C11</f>
  <v>#DIV/0!</v>
</c>
```

问：
- `<f>` 公式语法正确吗？
- 公式中的单元格引用指向存在的行/列吗？
- 若是除法，分母单元格可能为空或零吗？

**对于 `broken_sheet_ref` 错误：**

检查 `xl/workbook.xml` 中的实际工作表列表：

```xml
<sheets>
  <sheet name="Summary" sheetId="1" r:id="rId1"/>
  <sheet name="Q1"      sheetId="2" r:id="rId2"/>
  <sheet name="Q2"      sheetId="3" r:id="rId3"/>
</sheets>
```

工作表名区分大小写。`q1` 和 `Q1` 是不同的工作表。将公式中的名与此处的名精确比较。

### 第 3 步：跨表引用审计（多表工作簿）

对 3 个及以上工作表的工作簿，解包后运行更广的跨引用审计：

```bash
# 提取所有含跨表引用的公式
grep -h "<f>" /tmp/xlsx_inspect/xl/worksheets/*.xml | grep "!"

# 从 workbook.xml 列出所有实际工作表名
grep -o 'name="[^"]*"' /tmp/xlsx_inspect/xl/workbook.xml | grep -v sheetId
```

公式中出现的每个工作表名（`SheetName!` 或 `'Sheet Name'!` 形式）必须出现在工作簿工作表列表中。若任何不匹配，即为断裂引用，即便 formula_check.py 未捕获（共享公式只检查主单元格时可能发生）。

专门检查共享公式，查找 `<f t="shared" ref="...">` 元素：

```xml
<!-- 共享公式：定义在 D2，应用于 D2:D100 -->
<c r="D2"><f t="shared" ref="D2:D100" si="0">Q1!B2*C2</f><v></v></c>

<!-- 共享公式消费单元格：仅有 si，无公式文本 -->
<c r="D3"><f t="shared" si="0"/><v></v></c>
```

formula_check.py 从主单元格（上方 `D2`）读取公式文本。该公式中引用的工作表 `Q1` 适用于整个范围 `D2:D100`。若该工作表断裂，所有 99 行都断裂，即便它们显示为空 `<f>` 元素。

---

## 第 2 层 — 动态验证（LibreOffice 无头）

### 检查 LibreOffice 可用性

```bash
# 检查 macOS（典型安装位置）
which soffice
/Applications/LibreOffice.app/Contents/MacOS/soffice --version

# 检查 Linux
which libreoffice || which soffice
libreoffice --version
```

若两个命令都不返回路径，LibreOffice 未安装。在报告中记录"第 2 层：跳过 — LibreOffice 不可用"并仅以第 1 层结果交付。

### 安装 LibreOffice（若环境允许）

macOS：
```bash
brew install --cask libreoffice
```

Ubuntu/Debian：
```bash
sudo apt-get install -y libreoffice
```

### 运行无头重算

用专用重算脚本。它处理 macOS 和 Linux 的二进制发现，从输入的临时副本工作（保留原始文件），并提供与验证管道兼容的结构化输出和退出码。

```bash
# 先检查 LibreOffice 可用性
python3 SKILL_DIR/scripts/libreoffice_recalc.py --check

# 运行重算（默认超时：60s）
python3 SKILL_DIR/scripts/libreoffice_recalc.py /path/to/input.xlsx /tmp/recalculated.xlsx

# 对大或复杂文件，延长超时
python3 SKILL_DIR/scripts/libreoffice_recalc.py /path/to/input.xlsx /tmp/recalculated.xlsx --timeout 120
```

`libreoffice_recalc.py` 退出码：
- `0` — 重算成功，写出输出文件
- `2` — 未找到 LibreOffice（报告中记为跳过；非硬失败）
- `1` — 找到 LibreOffice 但失败（超时、崩溃、畸形文件）

**脚本内部做什么：**

LibreOffice 的 `--convert-to xlsx` 命令用完整 Calc 引擎和 `--infilter="Calc MS Excel 2007 XML"` 过滤器打开文件，执行每个公式，将计算值写入 `<v>` 缓存元素并保存输出。这是服务器端最接近"在 Excel 中打开并按保存"的等价操作。脚本还传 `--norestore` 防止 LibreOffice 尝试恢复之前的会话，这在自动化环境中可能导致挂起。

**若未安装 LibreOffice：**

macOS：
```bash
brew install --cask libreoffice
```

Ubuntu/Debian：
```bash
sudo apt-get install -y libreoffice
```

**若脚本超时（libreoffice_recalc.py 退出码 1 并显示"timed out"消息）：**

在报告中记录"第 2 层：超时 — LibreOffice 未在 Ns 内完成"。不要循环重试。调查文件是否有循环引用或极大数据范围。

### 重算后重新运行第 1 层

LibreOffice 重算后，`<v>` 元素含真实计算值。之前不可见的错误（因新生成文件 `<v>` 为空）现在显示为带实际错误字符串的 `t="e"` 单元格。

```bash
python3 SKILL_DIR/scripts/formula_check.py /tmp/recalculated.xlsx
```

这第二次第 1 层是权威的运行时错误检查。它发现的任何错误都是必须修复的真实计算失败。

---

## 全部 7 种错误类型 — 原因与修复策略

### #REF! — 无效单元格引用

**含义：** 公式引用不再存在或从未存在的单元格、范围或工作表。

**生成文件中的常见原因：**
- 行/列计算的差一错误（如引用行 0，Excel 的 1 起始系统中不存在）
- 列字母计算错误（如列 64 映射到 `BL` 而非 `BK`）
- 公式引用从未创建或已被重命名的工作表

**XML 签名：**
```xml
<c r="D5" t="e">
  <f>Sheet2!A0</f>
  <v>#REF!</v>
</c>
```

**修复 — 纠正引用：**
```xml
<c r="D5">
  <f>Sheet2!A1</f>
  <v></v>
</c>
```

注意：纠正公式后移除 `t="e"` 并清空 `<v>`。错误类型标记属于缓存状态，而非公式。

**可自动修复？** 仅当能从周围上下文确定正确目标。否则标记人工审阅。

---

### #DIV/0! — 除以零

**含义：** 公式除以零值或空单元格（空单元格在算术上下文中求值为 0）。

**生成文件中的常见原因：**
- 百分比变化公式 `=(B2-B1)/B1` 其中 `B1` 为空或零
- 比率公式 `=Value/Total` 其中合计行尚未填充

**XML 签名：**
```xml
<c r="C8" t="e">
  <f>B8/B7</f>
  <v>#DIV/0!</v>
</c>
```

**修复 — 用 IFERROR 包裹：**
```xml
<c r="C8">
  <f>IFERROR(B8/B7,0)</f>
  <v></v>
</c>
```

替代 — 显式零检查：
```xml
<c r="C8">
  <f>IF(B7=0,0,B8/B7)</f>
  <v></v>
</c>
```

**可自动修复？** 是。用 `IFERROR(...,0)` 包裹对大多数财务公式安全。若业务期望结果应显示为空白而非零，改用 `IFERROR(...,"")`。

---

### #VALUE! — 错误数据类型

**含义：** 公式对错误类型的值执行算术或逻辑操作（如将文本字符串加到数字上）。

**生成文件中的常见原因：**
- 应持数字的单元格写成字符串类型（`t="s"` 或 `t="inlineStr"`）而非数字类型
- 公式引用含文本的单元格（如单位标签"千"）并将其当作数字

**XML 签名：**
```xml
<c r="F3" t="e">
  <f>E3+D3</f>
  <v>#VALUE!</v>
</c>
```

**修复 — 检查源单元格类型是否错误：**

若 `D3` 被错误写成字符串：
```xml
<!-- 错误：数字值存为字符串 -->
<c r="D3" t="inlineStr"><is><t>1000</t></is></c>

<!-- 正确：数字值存为数字（t 属性省略或 "n"） -->
<c r="D3"><v>1000</v></c>
```

或用 `VALUE()` 转换包裹公式：
```xml
<c r="F3">
  <f>VALUE(E3)+VALUE(D3)</f>
  <v></v>
</c>
```

**可自动修复？** 部分。若源单元格类型明显错误（数字存为字符串），修复类型。若原因模糊（单元格本应含文本），标记人工审阅。

---

### #NAME? — 未识别名称

**含义：** 公式含 Excel 不识别的标识符 — 拼错的函数名、未定义的命名区域，或目标 Excel 版本中不可用的函数。

**生成文件中的常见原因：**
- LLM 写函数名时拼错：`SUMIF` 写成 `SUMIFS` 却只提供 3 个参数，或在目标 Excel 2010 的上下文中用 `XLOOKUP`
- 公式引用的命名区域不存在于 `xl/workbook.xml`

**XML 签名：**
```xml
<c r="B2" t="e">
  <f>SUMSQ(A2:A10)</f>
  <v>#NAME?</v>
</c>
```

**修复 — 验证函数名和命名区域：**

检查 `xl/workbook.xml` 中的命名区域：
```xml
<definedNames>
  <definedName name="RevenueRange">Sheet1!$B$2:$B$13</definedName>
</definedNames>
```

若公式引用 `RevenuRange`（拼错），纠正为 `RevenueRange`：
```xml
<c r="B2">
  <f>SUM(RevenueRange)</f>
  <v></v>
</c>
```

**可自动修复？** 仅当正确名称无歧义（如存在单一接近匹配）。否则标记人工审阅 — 函数名修复需理解意图计算。

---

### #N/A — 值不可用

**含义：** 查找函数（VLOOKUP、HLOOKUP、MATCH、INDEX/MATCH、XLOOKUP）搜索的值在查找表中不存在。

**生成文件中的常见原因：**
- 查找键存在于公式但查找表为空或尚未填充
- 键格式不匹配（文本"2024" vs 数字 2024）

**XML 签名：**
```xml
<c r="G5" t="e">
  <f>VLOOKUP(F5,Assumptions!$A$2:$B$20,2,0)</f>
  <v>#N/A</v>
</c>
```

**修复 — 用 IFERROR 包裹以容忍缺失匹配：**
```xml
<c r="G5">
  <f>IFERROR(VLOOKUP(F5,Assumptions!$A$2:$B$20,2,0),0)</f>
  <v></v>
</c>
```

**可自动修复？** 若零默认可接受，添加 `IFERROR` 安全。若查找失败表明数据完整性问题（键应始终存在），不自动修复 — 标记人工审阅。

---

### #NULL! — 空交集

**含义：** 空格运算符（计算两范围交集）应用于两个不相交的范围。

**生成文件中的常见原因：**
- 两个范围引用间意外空格：`=SUM(A1:A5 C1:C5)` 而非 `=SUM(A1:A5,C1:C5)`
- 典型财务模型中罕见；通常表明公式生成错误

**XML 签名：**
```xml
<c r="H10" t="e">
  <f>SUM(A1:A5 C1:C5)</f>
  <v>#NULL!</v>
</c>
```

**修复 — 用逗号（并集）或冒号（范围）替换空格：**
```xml
<!-- 两个独立范围的并集 -->
<c r="H10">
  <f>SUM(A1:A5,C1:C5)</f>
  <v></v>
</c>
```

**可自动修复？** 是。空格运算符在生成公式中几乎从非有意。替换为逗号安全。

---

### #NUM! — 数字错误

**含义：** 公式产生 Excel 无法表示的数字（溢出、下溢）或无实数结果的数学操作（负数平方根、零或负数对数）。

**生成文件中的常见原因：**
- IRR 或 NPV 公式现金流序列无收敛解
- `SQRT()` 应用于可能为负的单元格
- 极大幂运算

**XML 签名：**
```xml
<c r="J15" t="e">
  <f>IRR(B5:B15)</f>
  <v>#NUM!</v>
</c>
```

**修复 — 添加条件守卫：**
```xml
<c r="J15">
  <f>IFERROR(IRR(B5:B15),"")</f>
  <v></v>
</c>
```

对 SQRT：
```xml
<c r="K5">
  <f>IF(A5>=0,SQRT(A5),"")</f>
  <v></v>
</c>
```

**可自动修复？** 部分。用 `IFERROR` 包裹抑制错误显示但不修复底层计算问题。即便应用 IFERROR 包裹后仍标记单元格供人工审阅。

---

## 自动修复 vs 人工审阅决策矩阵

| 错误类型 | 自动修复安全？ | 条件 | 动作 |
|------------|---------------|-----------|--------|
| `#DIV/0!` | 是 | 始终 | 用 `IFERROR(公式,0)` 包裹 |
| `#NULL!` | 是 | 始终 | 用逗号替换空格运算符 |
| `#REF!` | 是 | 仅当上下文能无歧义确定正确目标 | 纠正引用；否则标记 |
| `#NAME?` | 是 | 仅当拼写错误恰好有一个合理纠正 | 修复名称；否则标记 |
| `#N/A` | 条件 | 若零/空白默认业务可接受 | 添加 IFERROR 包裹；记录假设 |
| `#VALUE!` | 条件 | 仅当源单元格类型明显错误 | 修复类型；否则标记 |
| `#NUM!` | 否 | 始终 | 添加 IFERROR 抑制显示，然后标记 |
| 断裂工作表引用 | 是 | 仅当能从 workbook.xml 识别重命名的工作表 | 纠正名称 |
| 业务逻辑错误 | 从不 | 任何情况 | 仅人工审阅 |

**什么算业务逻辑错误（绝不自动修复）：**
- 产生错误数字但无 Excel 错误的公式（如 `=SUM(B2:B8)` 而意图是 `=SUM(B2:B9)`）
- IFERROR 默认值有意义的公式（如用 0、空白还是前期值）
- 任何修复错误需知道公式本应计算什么的公式

---

## 交付标准 — 验证报告

每个验证任务必须产出结构化报告。无论是否发现错误，此报告是交付物。

### 必需报告格式

```markdown
## 公式验证报告

**文件**：/path/to/filename.xlsx
**日期**：YYYY-MM-DD
**检查的工作表**：Sheet1, Sheet2, Sheet3
**扫描公式总数**：N

---

### 第 1 层 — 静态验证

**状态**：PASS / FAIL
**工具**：formula_check.py（直接 XML 扫描）

| 工作表 | 单元格 | 错误类型 | 详情 | 应用的修复 |
|-------|------|-----------|--------|-------------|
| Summary | C12 | #REF! | 公式：Q1!A0 | 纠正为 Q1!A1 |
| Summary | D15 | broken_sheet_ref | 引用缺失工作表 'Q5' | 重命名为 Q4 |

_（若无错误："未检测到错误。"）_

---

### 第 2 层 — 动态验证

**状态**：PASS / FAIL / SKIPPED
**工具**：LibreOffice 无头（版本 X.Y.Z）/ 不可用

_（若 SKIPPED：说明原因 — LibreOffice 未安装、超时等）_

| 工作表 | 单元格 | 错误类型 | 详情 | 应用的修复 |
|-------|------|-----------|--------|-------------|
| Q1 | F8 | #DIV/0! | 公式：C8/C7 | 用 IFERROR 包裹 |

_（若无错误："重算后未检测到运行时错误。"）_

---

### 总结

- **发现错误总数**：N
- **自动修复**：N（列出类型）
- **标记人工审阅**：N（列出单元格和原因）
- **最终状态**：PASS（可交付）/ FAIL（阻止）

### 需人工审阅

| 单元格 | 错误 | 未应用自动修复的原因 |
|------|-------|----------------------------|
| Q2!B15 | #NUM! | IRR 公式 — 业务必须确认现金流输入 |
```

### 最低必需字段

若缺少以下任一项，报告无效（且交付被阻止）：
- 文件路径和日期
- 检查了哪些工作表
- 公式总数
- 第 1 层状态带显式 PASS/FAIL
- 第 2 层状态带显式 PASS/FAIL/SKIPPED 及若 SKIPPED 的原因
- 对每个错误：工作表、单元格、错误类型、处置（修复或标记）
- 最终交付状态

---

## 常见场景

### 场景 1：创建新文件后立即验证

当 `create.md` 工作流产出新 xlsx，在任何交付响应前运行验证。

```bash
# 第 1 步：对新写入文件静态检查
python3 SKILL_DIR/scripts/formula_check.py /path/to/output.xlsx

# 第 2 步：动态检查（若 LibreOffice 可用）
python3 SKILL_DIR/scripts/libreoffice_recalc.py /path/to/output.xlsx /tmp/recalculated.xlsx
python3 SKILL_DIR/scripts/formula_check.py /tmp/recalculated.xlsx
```

新生成文件的预期行为：第 1 层会发现零个 `error_value` 错误（因 `<v>` 元素为空，非错误值）。它会发现工作表名拼错时的断裂跨表引用。第 2 层会填充 `<v>` 并揭示 `#DIV/0!` 等运行时错误。

若第 2 层揭示错误，在源 XML（非重算副本）中修复，重新打包，重新运行两层。

### 场景 2：编辑已有文件后验证

当 `edit.md` 工作流修改已有 xlsx，若编辑是外科手术式的，只验证受影响工作表。若编辑触及共享公式或跨表引用，验证所有工作表。

```bash
# 定向静态检查 — 看特定工作表
# （formula_check.py 检查所有工作表；只检查输出的相关部分）
python3 SKILL_DIR/scripts/formula_check.py /path/to/edited.xlsx --json \
  | python3 -c "
import json, sys
r = json.load(sys.stdin)
for e in r['errors']:
    if e.get('sheet') in ['Summary', 'Q1']:
        print(e)
"
```

修改公式的编辑后始终运行第 2 层，即便第 1 层通过。数据范围的编辑可能导致之前有效的公式产生运行时错误。

### 场景 3：用户提供疑似有公式错误的文件

当用户提交文件并报告错误值或可见错误：

```bash
# 第 1 步：静态扫描 — 找出所有错误单元格
python3 SKILL_DIR/scripts/formula_check.py /path/to/user_file.xlsx --json > /tmp/validation_results.json

# 第 2 步：解包供手动检查
python3 SKILL_DIR/scripts/xlsx_unpack.py /path/to/user_file.xlsx /tmp/xlsx_inspect/

# 第 3 步：动态重算
python3 SKILL_DIR/scripts/libreoffice_recalc.py /path/to/user_file.xlsx /tmp/user_file_recalc.xlsx

# 第 4 步：重新验证重算文件
python3 SKILL_DIR/scripts/formula_check.py /tmp/user_file_recalc.xlsx --json > /tmp/validation_after_recalc.json

# 第 5 步：对比前后
python3 - <<'EOF'
import json
before = json.load(open("/tmp/validation_results.json"))
after  = json.load(open("/tmp/validation_after_recalc.json"))
print(f"重算前：{before['error_count']} 个错误")
print(f"重算后：{after['error_count']} 个错误")
EOF
```

若错误只在重算后出现（原静态扫描中无），则公式语法正确但运行时产生错误结果。这些是需公式级修复的运行时错误，非 XML 结构修复。

若错误在两次扫描中都出现，则在重算前已缓存在 `<v>` — 文件之前被 Excel/LibreOffice 打开过，错误持续存在。

---

## 关键陷阱

**陷阱 1：openpyxl `data_only=True` 销毁公式。**
以 `data_only=True` 打开工作簿读取缓存值而非公式。若随后保存工作簿，所有 `<f>` 元素被永久移除并替换为最后缓存值。验证工作流中绝不使用此模式。

**陷阱 2：空 `<v>` 不等于通过的公式。**
新生成文件所有公式单元格的 `<v>` 元素为空。formula_check.py 不会将这些报告为错误 — 它们尚不是错误。只有在重算后计算值为错误类型时才成为错误。这是第 2 层强制的缘故。

**陷阱 3：共享公式错误影响整个范围。**
若共享公式主单元格有断裂引用，共享范围（`ref="D2:D100"`）中每个单元格都继承该断裂引用。逻辑错误计数可能远大于 formula_check.py 输出中不同错误条目的计数。修复断裂共享公式时，修复主单元格的 `<f t="shared" ref="...">` 元素；消费单元格（`<f t="shared" si="N"/>`）自动继承纠正后的公式。

**陷阱 4：工作表名区分大小写。**
`=q1!B5` 和 `=Q1!B5` 是不同引用。Excel 内部将它们视为相同，但 formula_check.py 的字符串比较区分大小写。若公式用小写工作表名匹配工作簿中的大写工作表，会被标记为断裂引用。修复是与 `workbook.xml` 中的精确大小写匹配。

**陷阱 5：`--convert-to xlsx` 不保证公式保留。**
LibreOffice 的转换偶尔会改变某些公式类型（数组公式、`SORT`、`UNIQUE` 等动态数组函数）。第 2 层后，若重算文件显示与错误修复无关的公式变化，不要直接交付重算文件 — 改用原始文件做定向 XML 修复。
