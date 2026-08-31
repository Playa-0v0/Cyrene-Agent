---
name: docx

license: MIT
metadata:
  version: 1.0.0
  category: document-processing
  author: Minimax
  sources:
    - ECMA-376 Office Open XML File Formats
    - GB/T 9704-2012 公文版面布局标准
    - IEEE / ACM / APA / MLA / Chicago / Turabian 风格指南
    - Springer LNCS / Nature / HBR 文档模板
description: >
  使用 OpenXML SDK (.NET) 进行专业的 DOCX 文档创建、编辑和格式化。 三种管道：(A) 从零创建新文档，(B)
  在已有文档中填充/编辑内容， (C) 应用模板格式化并通过 XSD 验证门控检查。 当用户需要生成、修改或格式化 Word 文档时，必须使用此
  skill—— 包括他们说"写一份报告"、"起草建议书"、"制作合同"、 "填写此表单"、"按此模板重新排版"，或任何最终输出为 .docx 文件的任务。
  即使用户未明确提及 "docx"，如果任务暗示生成可打印/正式文档，也应使用此 skill。
---

# minimax-docx

通过 CLI 工具或基于 OpenXML SDK (.NET) 的直接 C# 脚本创建、编辑和格式化 DOCX 文档。

## ⚠️ 先判断：是否需要本 Skill

在开始任何操作前，先判断任务复杂度：

- **简单文档生成**（报告、总结、方案、请假条等纯文本段落）→ **直接用 `write_word` 工具**，不要继续读本 Skill。
  `write_word` 已内置美观样式（标题颜色/字号、正文行距/字体/颜色）和支持多种预设风格。
  用户说"美观""好看"时，读 `styles/catalog.md` 选 2-4 个风格，用 `ask_user_choice` 弹卡片让用户选。
  **第一个选项固定是 `default`（默认商务）**。用户选完传 `style` 参数给 `write_word` 即可。

- **需要以下任一才继续本 Skill**：
  - 页眉/页脚、目录、图片插入
  - 复杂表格、多节布局
  - 编辑已有 docx 文件（保留格式/批注/修订）
  - 应用模板格式化 + XSD 验证门控

### 执行纪律（必须遵守）

1. **只读完成任务所需的最少 reference**——读完能执行就立即开始。
2. **同一 reference 文件不要重复读取**（系统会拦截重复读取）。
3. **不要花多轮搜索脚本路径**——`scripts/` 路径在 `SKILL_DIR` 下，用一行命令定位。
4. **信息足够后立即执行**——不要继续研究文档。
5. **若预计轮数紧张，优先输出可交付版本**而非继续优化排版。

## 环境准备

**首次使用：** `powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -Minimal`（需要完整可选预览能力时去掉 `-Minimal`）。

**会话中首次操作：** `powershell -ExecutionPolicy Bypass -File scripts/env_check.ps1 -Json` — 如果返回 `NOT READY` 则不得继续。（同一会话内的后续操作可跳过此步骤。）

## 快速入门：直接 C# 路径

当任务需要结构化文档操作（自定义样式、复杂表格、多节布局、页眉/页脚、目录、图片）时，直接编写 C# 而不是纠结于 CLI 限制。使用此脚手架：

```csharp
// 文件：scripts/dotnet/task.csx（或 Console 项目中的新 .cs 文件）
// dotnet run --project scripts/dotnet/MiniMaxAIDocx.Cli -- run-script task.csx
#r "nuget: DocumentFormat.OpenXml, 3.2.0"

using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

using var doc = WordprocessingDocument.Create("output.docx", WordprocessingDocumentType.Document);
var mainPart = doc.AddMainDocumentPart();
mainPart.Document = new Document(new Body());

// --- 在此处编写你的逻辑 ---
// 首先阅读相关的 Samples/*.cs 文件以获取已验证的模式。
// 参见下方参考部分中的 Samples/ 表格。
```

**在编写任何 C# 之前，必须先阅读相关的 `Samples/*.cs` 文件**——它们包含可编译、经 SDK 版本验证的模式。下方参考部分的 Samples 表格将主题映射到文件。

## CLI 简写

所有以下 CLI 命令使用 `$CLI` 作为以下命令的简写：
```bash
dotnet run --project scripts/dotnet/MiniMaxAIDocx.Cli --
```

## 管道路由

通过检查用户是否有输入 .docx 文件来路由：

```
用户任务
├─ 无输入文件 → 管道 A：CREATE
│   信号词："写"、"创建"、"起草"、"生成"、"新建"、"制作一份报告/建议书/备忘录"
│   → 阅读 references/scenario_a_create.md
│
└─ 有输入 .docx
    ├─ 替换/填充/修改内容 → 管道 B：FILL-EDIT
    │   信号词："填写"、"替换"、"更新"、"更改文本"、"添加章节"、"编辑"
    │   → 阅读 references/scenario_b_edit_content.md
    │
    └─ 重新格式化/应用样式/模板 → 管道 C：FORMAT-APPLY
        信号词："重新格式化"、"应用模板"、"重新设计样式"、"匹配此格式"、"套模板"、"排版"
        ├─ 模板为纯样式（无内容）→ C-1：OVERLAY（将样式应用于源文档）
        └─ 模板有结构（封面/目录/示例章节）→ C-2：BASE-REPLACE
            （使用模板作为基础，将示例内容替换为用户内容）
        → 阅读 references/scenario_c_apply_template.md
```

如果请求跨越多个管道，按顺序执行（例如，先 Create 再 Format-Apply）。

## 预处理

如需将 `.doc` 转为 `.docx`：`powershell -ExecutionPolicy Bypass -File scripts/doc_to_docx.ps1 -Input .\input.doc -OutDir .\output`

编辑前预览（避免阅读原始 XML）：`powershell -ExecutionPolicy Bypass -File scripts/docx_preview.ps1 -Input .\document.docx -OutDir .\preview`

分析结构以用于编辑场景：`$CLI analyze --input document.docx`

## 场景 A：创建

首先阅读 `references/scenario_a_create.md`、`references/typography_guide.md` 和 `references/design_principles.md`。从 `Samples/AestheticRecipeSamples.cs` 中选择与文档类型匹配的美学配方——**禁止**自行编造格式值。对于 CJK，还需阅读 `references/cjk_typography.md`。

**选择你的路径：**
- **简单**（纯文本、最少格式）：使用 CLI — `$CLI create --type report --output out.docx --config content.json`
- **结构化**（自定义样式、多节、目录、图片、复杂表格）：直接编写 C#。先阅读相关的 `Samples/*.cs`。

CLI 选项：`--type`（report|letter|memo|academic）、`--title`、`--author`、`--page-size`（letter|a4|legal|a3）、`--margins`（standard|narrow|wide）、`--header`、`--footer`、`--page-numbers`、`--toc`、`--content-json`。

然后运行**验证管道**（见下方）。

## 场景 B：编辑/填充

首先阅读 `references/scenario_b_edit_content.md`。预览 → 分析 → 编辑 → 验证。

**选择你的路径：**
- **简单**（文本替换、占位符填充）：使用 CLI 子命令。
- **结构化**（添加/重组章节、修改样式、操作表格、插入图片）：直接编写 C#。阅读 `references/openxml_element_order.md` 和相关的 `Samples/*.cs`。

可用的 CLI 编辑子命令：
- `replace-text --find "X" --replace "Y"`
- `fill-placeholders --data '{"key":"value"}'`
- `fill-table --data table.json`
- `insert-section`、`remove-section`、`update-header-footer`

```bash
$CLI edit replace-text --input in.docx --output out.docx --find "OLD" --replace "NEW"
$CLI edit fill-placeholders --input in.docx --output out.docx --data '{"name":"John"}'
```

然后运行**验证管道**。同时运行 diff 以验证最小更改：
```bash
$CLI diff --before in.docx --after out.docx
```

## 场景 C：应用模板

首先阅读 `references/scenario_c_apply_template.md`。预览并分析源文档和模板。

```bash
$CLI apply-template --input source.docx --template template.docx --output out.docx
```

对于复杂的模板操作（多模板合并、每节独立页眉/页脚、样式合并），直接编写 C#——参见下方关键规则中的必需模式。

运行**验证管道**，然后是**硬门控检查**：
```bash
$CLI validate --input out.docx --gate-check assets/xsd/business-rules.xsd
```
门控检查是**硬性要求**。通过之前**禁止**交付。如果失败：诊断、修复、重新运行。

同时运行 diff 以验证内容保留：`$CLI diff --before source.docx --after out.docx`

## 验证管道

每次写入操作后运行。对于场景 C，完整管道是**强制**的；对于 A/B，则是**推荐**的（仅在操作极其简单时可跳过）。

```bash
$CLI merge-runs --input doc.docx                                    # 1. 合并 runs
$CLI validate --input doc.docx --xsd assets/xsd/wml-subset.xsd     # 2. XSD 结构
$CLI validate --input doc.docx --business                           # 3. 业务规则
```

如果 XSD 失败，自动修复并重试：
```bash
$CLI fix-order --input doc.docx
$CLI validate --input doc.docx --xsd assets/xsd/wml-subset.xsd
```

如果 XSD 仍然失败，回退到业务规则 + 预览：
```bash
$CLI validate --input doc.docx --business
powershell -ExecutionPolicy Bypass -File scripts/docx_preview.ps1 -Input .\doc.docx -OutDir .\preview
# 验证：字体污染=0，表格数量正确，图形数量正确，sectPr 数量正确
```

最终预览：`powershell -ExecutionPolicy Bypass -File scripts/docx_preview.ps1 -Input .\doc.docx -OutDir .\preview`

## 关键规则

以下规则防止文件损坏——OpenXML 对元素顺序有严格要求。

**元素顺序**（属性始终在前）：

| 父元素 | 顺序 |
|--------|-------|
| `w:p`  | `pPr` → runs |
| `w:r`  | `rPr` → `t`/`br`/`tab` |
| `w:tbl`| `tblPr` → `tblGrid` → `tr` |
| `w:tr` | `trPr` → `tc` |
| `w:tc` | `tcPr` → `p`（至少 1 个 `<w:p/>`） |
| `w:body` | 块内容 → `sectPr`（最后一个子元素） |

**直接格式污染：** 从源文档复制内容时，内联 `rPr`（字体、颜色）和 `pPr`（边框、底纹、间距）会覆盖模板样式。始终剥离直接格式——只保留 `pStyle` 引用和 `t` 文本。同时清理表格（包括单元格内的 `pPr/rPr`）。

**修订追踪：** `<w:del>` 使用 `<w:delText>`，**禁止**使用 `<w:t>`。`<w:ins>` 使用 `<w:t>`，**禁止**使用 `<w:delText>`。

**字体大小：** `w:sz` = 点数 × 2（12pt → `sz="24"`）。边距/间距单位为 DXA（1 英寸 = 1440，1cm ≈ 567）。

**标题样式必须具有 OutlineLevel：** 在定义标题样式（Heading1、ThesisH1 等）时，始终在 `StyleParagraphProperties` 中包含 `new OutlineLevel { Val = N }`（H1→0、H2→1、H3→2）。没有此项，Word 会将它们视为普通样式文本——目录和导航窗格将无法工作。

**多模板合并：** 当给定多个模板文件（字体、标题、分节）时，首先阅读 `references/scenario_c_apply_template.md` 的"多模板合并"部分。关键规则：
- 将所有模板的样式合并到一个 styles.xml 中。结构（节/分节符）来自分节模板。
- 每个内容段落必须恰好出现一次——插入分节符时**禁止**重复。
- **禁止**插入空/空白段落作为填充或分节分隔符。输出段落数必须等于输入段落数。使用分节符属性（`w:pPr` 中的 `w:sectPr`）和样式间距（`w:spacing` 段前/段后）来实现视觉分隔。
- 在每个章节标题前插入 oddPage 分节符，而不仅仅是第一个。即使章节有双栏内容，也必须以 oddPage 开始；在标题后使用第二个 continuous 分节符来切换栏数。
- 双栏章节需要三个分节符：(1) 前一节段落 pPr 中的 oddPage，(2) 章节标题 pPr 中的 continuous+cols=2，(3) 最后正文段落 pPr 中的 continuous+cols=1 以恢复单栏。
- 为每个节从分节模板复制 `titlePg` 设置。摘要和目录节通常需要 `titlePg=true`。

**多节页眉/页脚：** 具有 10 个以上节的模板（如中文论文）每节有不同的页眉/页脚（罗马 vs 阿拉伯页码、每个区域不同的页眉文本）。规则：
- 使用 C-2 Base-Replace：将模板复制为输出基础，然后替换正文内容。这会自动保留所有节、页眉、页脚和 titlePg 设置。
- **禁止**从零重新创建页眉/页脚——逐字节复制模板的页眉/页脚 XML。
- **禁止**添加模板页眉 XML 中不存在的格式（边框、对齐、字体大小）。
- 非封面节必须具有页眉/页脚 XML 文件（至少有空页眉 + 页码页脚）。
- 参见 `references/scenario_c_apply_template.md` 的"多节页眉/页脚传输"部分。

## 参考文档

按需加载——不要一次性全部加载。选择与任务最相关的文件。

**下方的 C# 示例和设计参考是项目的知识库（"百科全书"）。** 编写 OpenXML 代码时，始终首先阅读相关的示例文件——它包含可编译、经 SDK 版本验证的模式，可防止常见错误。做美学决策时，阅读设计原则和配方文件——它们编码了来自权威来源（IEEE、ACM、APA、Nature 等）的经过测试的和谐参数集，而非猜测。

### 场景指南（每个管道首先阅读）

| 文件 | 何时使用 |
|------|------|
| `references/scenario_a_create.md` | 管道 A：从零创建 |
| `references/scenario_b_edit_content.md` | 管道 B：编辑已有内容 |
| `references/scenario_c_apply_template.md` | 管道 C：应用模板格式化 |

### C# 代码示例（可编译、注释详尽 — 编写代码时阅读）

| 文件 | 主题 |
|------|-------|
| `Samples/DocumentCreationSamples.cs` | 文档生命周期：创建、打开、保存、流、文档默认值、设置、属性、页面设置、多节 |
| `Samples/StyleSystemSamples.cs` | 样式：Normal/Heading 链、字符/表格/列表样式、DocDefaults、latentStyles、CJK 公文、APA 7th、导入、解析继承 |
| `Samples/CharacterFormattingSamples.cs` | RunProperties：字体、字号、粗体/斜体、所有下划线、颜色、高亮、删除线、上标/下标、大写、间距、底纹、边框、着重号 |
| `Samples/ParagraphFormattingSamples.cs` | ParagraphProperties：对齐、缩进、行距/段距、与下段同页/孤行控制、大纲级别、边框、制表位、编号、双向文本、框架 |
| `Samples/TableSamples.cs` | 表格：边框、网格、单元格属性、边距、行高、标题重复、合并（水平+垂直）、嵌套、浮动、三线表、斑马条纹 |
| `Samples/HeaderFooterSamples.cs` | 页眉/页脚：页码、"第 X 页 共 Y 页"、首页/偶数/奇数页、logo 图片、表格布局、公文 "-X-"、每节独立 |
| `Samples/ImageSamples.cs` | 图片：内嵌、浮动、文字环绕、边框、替代文本、页眉/表格中、替换、SVG 回退、尺寸计算 |
| `Samples/ListAndNumberingSamples.cs` | 编号：项目符号、多级十进制、自定义符号、大纲→标题、法律编号、中文 一/（一）/1./(1)、重新开始/继续 |
| `Samples/FieldAndTocSamples.cs` | 域：TOC、SimpleField vs 复杂域、DATE/PAGE/REF/SEQ/MERGEFIELD/IF/STYLEREF、TOC 样式 |
| `Samples/FootnoteAndCommentSamples.cs` | 脚注、尾注、批注（4 文件系统）、书签、超链接（内部+外部） |
| `Samples/TrackChangesSamples.cs` | 修订：插入（w:t）、删除（w:delText!）、格式更改、接受/拒绝全部、移动追踪 |
| `Samples/AestheticRecipeSamples.cs` | 来自权威来源的 13 种美学配方：ModernCorporate、AcademicThesis、ExecutiveBrief、ChineseGovernment (GB/T 9704)、MinimalModern、IEEE Conference、ACM sigconf、APA 7th、MLA 9th、Chicago/Turabian、Springer LNCS、Nature、HBR——每种都有来自官方风格指南的精确值 |

注意：`Samples/` 路径相对于 `scripts/dotnet/MiniMaxAIDocx.Core/`。

### Markdown 参考（需要规范或设计规则时阅读）

| 文件 | 何时使用 |
|------|------|
| `references/openxml_element_order.md` | XML 元素顺序规则（防止损坏） |
| `references/openxml_units.md` | 单位转换：DXA、EMU、半点、八分之一点 |
| `references/openxml_encyclopedia_part1.md` | 详细 C# 百科全书：文档创建、样式、字符和段落格式化 |
| `references/openxml_encyclopedia_part2.md` | 详细 C# 百科全书：页面设置、表格、页眉/页脚、节、文档属性 |
| `references/openxml_encyclopedia_part3.md` | 详细 C# 百科全书：TOC、脚注、域、修订追踪、批注、图片、数学公式、编号、保护 |
| `references/typography_guide.md` | 字体配对、字号、间距、页面布局、表格设计、配色方案 |
| `references/cjk_typography.md` | CJK 字体、字号、RunFonts 映射、GB/T 9704 公文标准 |
| `references/cjk_university_template_guide.md` | 中国大学论文模板：数字 styleIds（1/2/3 vs Heading1）、文档区域结构（封面→摘要→目录→正文→参考文献）、字体预期、常见错误 |
| `references/design_principles.md` | **美学基础**：6 项设计原则（留白、对比/比例、邻近、对齐、重复、层级）——教你"为什么"，而不仅仅是"是什么" |
| `references/design_good_bad_examples.md` | **好坏对比**：10 类排版错误，含 OpenXML 值、ASCII 模拟图和修复方案 |
| `references/track_changes_guide.md` | 修订标记深入详解 |
| `references/troubleshooting.md` | **按症状驱动修复**：13 个常见问题，按你看到的症状索引（标题错误、图片缺失、TOC 损坏等）——按症状搜索，找到修复方案 |
