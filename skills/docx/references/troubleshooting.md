# 故障排除指南 — 按症状驱动

## 如何使用本指南

按你观察到的**症状**搜索，而非技术概念。每个条目遵循：
- **症状** — 你看到或用户报告的内容
- **诊断** — 如何确认根本原因
- **修复** — 确切的步骤、命令或代码
- **预防** — 下次如何避免

**快速搜索关键词：** 标题错误、正文、修复、损坏、字体、表格缺失、图片缺失、目录损坏、更新目录、分页、分节符、超链接、编号列表、项目符号、页边距、页面尺寸、中文方块、封面、修订追踪、修订标记

---

## 1. "所有标题看起来像正文"（标题样式未应用）

**症状：** 模板应用后，标题没有格式 — 看起来像 Normal 段落。字号、粗体、间距全错。

**诊断：** `document.xml` 中的 `pStyle` 值与 `styles.xml` 中的 `styleId` 值不匹配。

常见不匹配：
- 源用 `Heading1` 但模板将该样式定义为 `1`（中文模板常用数字 styleId）
- 源用 `heading1`（小写）但模板是 `Heading1`（区分大小写！）
- `pStyle` 引用的样式在输出的 `styles.xml` 中根本不存在

检查：
```bash
# 列出文档中使用的所有 pStyle 值
$CLI analyze --input output.docx | grep -i "pStyle"

# 列出 styles.xml 中定义的所有 styleId
$CLI analyze --input template.docx --part styles | grep "styleId"
```

**修复：** 应用模板前构建 styleId 映射表。更新文档内容中每个 `pStyle` 值。

```csharp
// 构建映射：源 styleId → 模板 styleId
var mapping = new Dictionary<string, string>();
// 按样式名（w:name）比较，而非 styleId
foreach (var srcStyle in sourceStyles)
{
    var templateStyle = templateStyles.FirstOrDefault(
        s => s.StyleName?.Val?.Value == srcStyle.StyleName?.Val?.Value);
    if (templateStyle != null)
        mapping[srcStyle.StyleId!] = templateStyle.StyleId!;
}

// 对所有段落应用映射
foreach (var para in body.Descendants<Paragraph>())
{
    var pStyle = para.ParagraphProperties?.ParagraphStyleId;
    if (pStyle != null && mapping.TryGetValue(pStyle.Val!, out var newId))
        pStyle.Val = newId;
}
```

**预防：** 模板应用前，始终从源和模板提取并比较 styleId。绝不假设文档间 styleId 相同。

---

## 2. "文档打开时出现修复警告"（XML 损坏）

**症状：** 打开时 Word 提示"我们发现某些内容有问题"或"Word 发现不可读的内容"。

**诊断：** 元素顺序错误。OpenXML 对子元素顺序要求严格。

常见违规：
- `w:p` 中 `pPr` 必须在 run 之前
- `w:tbl` 中 `tblPr` 必须在 `tblGrid` 之前
- `w:r` 中 `rPr` 必须在 `t`/`br`/`tab` 之前
- `w:tr` 中 `trPr` 必须在 `tc` 之前
- `w:tc` 中 `tcPr` 必须在内容之前

```bash
# 验证以查找顺序问题
$CLI validate --input doc.docx --xsd assets/xsd/wml-subset.xsd

# 自动修复元素顺序
$CLI fix-order --input doc.docx

# 重新验证
$CLI validate --input doc.docx --xsd assets/xsd/wml-subset.xsd
```

**修复：**
```bash
$CLI fix-order --input doc.docx
```

若自动修复未解决，解包并手动检查：
```bash
$CLI unpack --input doc.docx --output unpacked/
# 检查 word/document.xml 的顺序问题
# 修复后重新打包：
$CLI pack --input unpacked/ --output fixed.docx
```

**预防：** 编写任何 XML 操作代码前阅读 `references/openxml_element_order.md`。始终先追加属性元素，再追加内容元素。

---

## 3. "所有文本字体错误"（字体污染）

**症状：** 模板指定 宋体/Times New Roman，但文档显示 Google Sans、Arial、Calibri 或源文档使用的任何字体。

**诊断：** 源文档的 `rPr` 包含内联 `rFonts` 声明，覆盖了模板样式。在 OpenXML 中，直接格式始终优先于基于样式的格式。

```bash
# 检查字体污染
$CLI analyze --input output.docx | grep -i "font"
# 查找内容中的 rFonts — 若存在，它们正在覆盖样式
```

**修复：** 复制内容时从 `rPr` 剥离 `rFonts`，但对 CJK 文本保留 `w:eastAsia`：

```csharp
foreach (var rPr in body.Descendants<RunProperties>())
{
    var rFonts = rPr.GetFirstChild<RunFonts>();
    if (rFonts != null)
    {
        // 保留 EastAsia 字体用于 CJK — 移除它会导致方块（□□□）
        var eastAsia = rFonts.EastAsia?.Value;
        rFonts.Remove();

        // 若已设置且文本含 CJK，则仅重新添加 eastAsia
        if (!string.IsNullOrEmpty(eastAsia))
        {
            rPr.Append(new RunFonts { EastAsia = eastAsia });
        }
    }
}
```

同时剥离这些常见直接格式覆盖：
- `w:sz` / `w:szCs`（字号）
- `w:color`（文本颜色）
- `w:b` / `w:i`（当它们与样式矛盾时）

**预防：** 在文档间复制内容时始终清理直接格式。只保留 `pStyle`/`rStyle` 引用和 `w:t` 文本。

---

## 4. "表格缺失"（复制时表格丢失）

**症状：** 源有 5 个表格但输出只有 2 个（或 0 个）。

**诊断：** 代码用了 `body.findall('w:p')` 或顶层用 `body.Descendants<Paragraph>()`，而非遍历所有子元素。这会跳过 `w:tbl` 元素。

```bash
# 验证表格数量
$CLI analyze --input source.docx | grep -i "table"
$CLI analyze --input output.docx | grep -i "table"
```

**修复：** 用 `list(body)` 或 `body.ChildElements` 获取所有顶层子元素（包括表格）：

```csharp
// 错误 — 跳过表格、节属性和其他非段落元素
var paragraphs = body.Elements<Paragraph>();

// 正确 — 获取所有内容：段落、表格、SDT 块等
var allElements = body.ChildElements.ToList();
```

Python lxml 中：
```python
# 错误
elements = body.findall('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p')

# 正确
elements = list(body)  # 所有直接子元素
```

**预防：** 复制内容时始终用 `list(body)` 或 `body.ChildElements` 迭代，绝不单独按单一元素类型过滤。

---

## 5. "图片缺失或显示破损图标"

**症状：** 出现图片占位符但图片不渲染。或图片完全缺失。

**诊断：** `w:drawing` 中的 `r:embed` rId 与 `document.xml.rels` 中任何关系都不匹配，或媒体文件未被复制到输出 ZIP。

```bash
# 检查关系
$CLI analyze --input output.docx --part rels | grep -i "image"

# 检查媒体文件是否存在
$CLI unpack --input output.docx --output unpacked/
ls unpacked/word/media/
```

**修复：**
1. 检查源 rels 中的图片文件路径
2. 从源复制媒体文件到输出
3. 在输出 rels 中添加/更新关系
4. 更新 drawing 元素中的 `r:embed` 值

```csharp
// 在文档间复制带图片的内容时：
foreach (var drawing in body.Descendants<Drawing>())
{
    var blip = drawing.Descendants<DocumentFormat.OpenXml.Drawing.Blip>().FirstOrDefault();
    if (blip?.Embed?.Value != null)
    {
        var sourceRel = sourcePart.GetReferenceRelationship(blip.Embed.Value);
        // 将图片部件复制到目标文档
        var imagePart = targetPart.AddImagePart(ImagePartType.Png);
        using var stream = sourcePart.GetPartById(blip.Embed.Value).GetStream();
        imagePart.FeedData(stream);
        // 更新 rId 引用
        blip.Embed = targetPart.GetIdOfPart(imagePart);
    }
}
```

**预防：** 在文档间移动内容时始终做 rId 重映射 + 媒体文件复制。绝不假设 rId 可跨文档使用。

---

## 6. "目录显示陈旧/错误条目"或"更新目录无效"

**症状：** 目录显示模板的示例条目（如"第1章 绪论...1"）而非实际标题。或在 Word 中点击"更新目录"无反应。

**诊断：**
- **陈旧条目（正常）：** 目录条目是缓存在域内的静态文本。它们不会自动更新，除非用户在 Word 中显式更新。
- **更新目录失败：** SDT 包装器或域代码结构损坏。真实模板中的目录是混合结构：SDT 块 + 域代码 + 静态条目。

```bash
# 检查目录 SDT 是否存在
$CLI analyze --input output.docx | grep -i "sdt\|toc"
```

**修复：**
- **若条目仅是陈旧：** 这是预期行为。用户须在 Word 中右键目录，然后"更新域"。或启用自动更新：
  ```csharp
  // 见 FieldAndTocSamples.EnableUpdateFieldsOnOpen()
  FieldAndTocSamples.EnableUpdateFieldsOnOpen(settingsPart);
  ```
- **若 SDT 损坏：** 保留模板的整个 SDT 块完整。不要修改它。
- **若域代码缺失：** 确保目录包含：`fldChar begin` + `instrText` + `fldChar separate` + 静态条目 + `fldChar end`。完整模式见 `FieldAndTocSamples.CreateMixedTocStructure()`。
- **若你从零重建了目录（常见错误）：** 你很可能破坏了 SDT 包装器。改用模板的原始 SDT 块。真实目录的结构见 `Samples/FieldAndTocSamples.cs` 的 `CreateMixedTocStructure` 方法。

**预防：** 做 Base-Replace（C-2）时，保持模板的目录区域完全不动。不要剥离、重建或修改 SDT 块。用户在 Word 中打开时目录会自动更新。

---

## 7. "章节未从新页开始"（缺少分节符）

**症状：** 章节之间内容连续流动，无分页。第 2 章紧跟第 1 章最后一段在同一页开始。

**诊断：** 章节之间无 `sectPr` 元素或分页段落。

**修复：** 在每个章节标题前插入 `pPr` 中含 `sectPr` 的段落，或插入分页符：

```csharp
// 选项 1：分节符（保留每节设置如页眉/页边距）
var breakPara = new Paragraph(
    new ParagraphProperties(
        new SectionProperties(
            new SectionType { Val = SectionMarkValues.NextPage })));

// 选项 2：简单分页符（更轻量）
var breakPara = new Paragraph(
    new Run(new Break { Type = BreakValues.Page }));

// 在每个 Heading1 前插入
body.InsertBefore(breakPara, heading1Paragraph);
```

**预防：** 复制内容时，按需在 Heading1 段落前插入分页/分节符。复制前检查源文档的节结构。

---

## 8. "超链接无效"（链接断裂）

**症状：** 在输出文档中点击超链接无反应，或导航到错误 URL。

**诊断：** `w:hyperlink r:id` 指向 `document.xml.rels` 中不存在的关系。

```bash
# 检查超链接关系
$CLI analyze --input output.docx --part rels | grep -i "hyperlink"
```

**修复：** 将源文档的超链接关系合并到输出的 rels 文件。更新 rId 引用。

```csharp
foreach (var hyperlink in body.Descendants<Hyperlink>())
{
    if (hyperlink.Id?.Value != null)
    {
        var sourceRel = sourcePart.HyperlinkRelationships
            .FirstOrDefault(r => r.Id == hyperlink.Id.Value);
        if (sourceRel != null)
        {
            targetPart.AddHyperlinkRelationship(sourceRel.Uri, sourceRel.IsExternal);
            var newRel = targetPart.HyperlinkRelationships.Last();
            hyperlink.Id = newRel.Id;
        }
    }
}
```

**预防：** 合并文档时始终合并所有关系类型（图片、超链接、页眉、页脚）。绝不假设源 rId 在目标中可用。

---

## 9. "编号列表显示错误编号"或"项目符号消失"

**症状：** 原本编号为 1、2、3 的列表现在显示 1、1、1，或完全没有编号/项目符号。

**诊断：** `pPr` 中的 `numId` 引用了 `numbering.xml` 中不存在的编号定义，或 `abstractNumId` 映射断裂。

```bash
# 检查编号定义
$CLI analyze --input output.docx --part numbering
```

**修复：** 将源 numId 映射到模板 numId，或合并编号定义：

```csharp
// 1. 从源复制 abstractNum 定义到目标 numbering.xml
// 2. 创建指向所复制 abstractNum 的新 num 条目
// 3. 更新文档内容中所有 numId 引用

var sourceNumbering = sourceNumberingPart.Numbering;
var targetNumbering = targetNumberingPart.Numbering;

// 获取最大现有 ID 以避免冲突
int maxAbstractNumId = targetNumbering.Elements<AbstractNum>()
    .Max(a => a.AbstractNumberId?.Value ?? 0) + 1;
int maxNumId = targetNumbering.Elements<NumberingInstance>()
    .Max(n => n.NumberID?.Value ?? 0) + 1;
```

**预防：** 在模板应用工作流中纳入 `numbering.xml` 协调。正确的编号设置见 `Samples/ListAndNumberingSamples.cs`。

---

## 10. "页边距/页面尺寸错误"

**症状：** 输出的页边距、页面尺寸或方向与模板不同。

**诊断：** 源文档的 `sectPr` 覆盖了模板的 `sectPr`。最后的 `sectPr`（body 的子元素）控制最后一节的布局。

```bash
# 比较节属性
$CLI analyze --input template.docx | grep -i "sectPr\|margin\|pgSz"
$CLI analyze --input output.docx | grep -i "sectPr\|margin\|pgSz"
```

**修复：** 使用模板的末尾 `sectPr`。对于中间的 `sectPr` 元素（多节文档），谨慎合并。

```csharp
// 用模板的替换输出的末尾 sectPr
var templateSectPr = templateBody.Elements<SectionProperties>().LastOrDefault();
var outputSectPr = outputBody.Elements<SectionProperties>().LastOrDefault();

if (templateSectPr != null)
{
    var cloned = templateSectPr.CloneNode(true) as SectionProperties;
    if (outputSectPr != null)
        outputBody.ReplaceChild(cloned!, outputSectPr);
    else
        outputBody.Append(cloned!);
}
```

**预防：** 始终以模板的 `sectPr` 作为页面布局权威。复制内容前剥离源文档的 `sectPr`。

---

## 11. "中文渲染为方块/豆腐块"

**症状：** 中文字符显示为方块（□□□）或字形缺失。

**诊断：** `rFonts w:eastAsia` 设为系统上不存在的字体，或完全缺失。没有东亚字体声明，渲染引擎可能回退到无 CJK 覆盖的字体。

**修复：** 确保所有 CJK 文本的 `w:eastAsia` 设为可用字体：

```csharp
foreach (var run in body.Descendants<Run>())
{
    var text = run.InnerText;
    if (ContainsCjk(text))
    {
        var rPr = run.RunProperties ?? new RunProperties();
        var rFonts = rPr.GetFirstChild<RunFonts>();
        if (rFonts == null)
        {
            rFonts = new RunFonts();
            rPr.Append(rFonts);
        }
        // 设为通用可用的 CJK 字体
        rFonts.EastAsia = "SimSun"; // 宋体 — 最安全的默认
        if (run.RunProperties == null) run.PrependChild(rPr);
    }
}

static bool ContainsCjk(string text)
{
    return text.Any(c => c >= 0x4E00 && c <= 0x9FFF);
}
```

常见安全 CJK 字体：宋体 (SimSun)、黑体 (SimHei)、仿宋 (FangSong)、楷体 (KaiTi)。

**预防：** 清理 `rPr` 格式时，始终保留 `w:eastAsia` 字体声明。另见 `references/cjk_typography.md`。

---

## 12. "模板的封面/声明页缺失"

**症状：** 输出文档直接以正文内容开始 — 无封面、无声明、无摘要、无目录。模板的结构性前置部分被丢弃了。

**诊断：** 需要 Base-Replace（C-2）时却用了 Overlay（C-1）策略。Overlay 将样式应用到源文档，但丢弃模板的结构性内容（封面、声明、摘要、目录）。

```bash
# 检查模板结构
$CLI analyze --input template.docx
# 若模板有 >50 段且含封面/目录/声明，则需要 C-2
```

**修复：** 使用 Base-Replace（C-2）策略 — 以模板为基，只将示例正文内容区域替换为用户内容：

1. 识别模板的"正文区域"（目录与末尾 sectPr 之间的所有内容）
2. 移除模板的示例正文内容
3. 将用户内容插入正文区域
4. 保留模板的其他所有内容（封面、声明、摘要、目录、sectPr）

```bash
$CLI apply-template --input source.docx --template template.docx --output out.docx --strategy base-replace
```

**预防：** 先分析模板结构。若模板有结构性内容（封面、目录、声明章节），始终用 C-2（Base-Replace）。详细决策标准见 `references/scenario_c_apply_template.md`。

---

## 13. "意外出现修订标记"

**症状：** 输出显示源文档中没有的红/绿修订标记（插入、删除）。

**诊断：** 模板启用了修订追踪，或内容作为修订而非普通文本插入。

```bash
# 检查修订标记
$CLI analyze --input output.docx | grep -i "revision\|ins\|del\|track"
```

**修复：** 通过展平 `w:ins` 和 `w:del` 元素来接受所有修订：

```csharp
// 接受插入：解包 w:ins，保留内容
foreach (var ins in body.Descendants<InsertedRun>().ToList())
{
    var parent = ins.Parent!;
    foreach (var child in ins.ChildElements.ToList())
    {
        parent.InsertBefore(child.CloneNode(true), ins);
    }
    ins.Remove();
}

// 接受删除：完全移除 w:del 及其内容
foreach (var del in body.Descendants<DeletedRun>().ToList())
{
    del.Remove();
}
```

或在设置中禁用追踪：
```csharp
var settings = settingsPart.Settings;
var trackChanges = settings.GetFirstChild<TrackChanges>();
trackChanges?.Remove();
```

**预防：** 开始前检查模板的 `settings.xml` 是否有 `trackChanges`。若有，先接受模板中的所有修订。

---

## 恢复策略 — 当存在多个问题时

文档有多个问题时，按此优先级顺序修复：

```
1. [Content_Types].xml  — 没有它，什么都打不开
2. _rels/.rels          — 包关系
3. word/_rels/document.xml.rels — 部件关系（图片、超链接）
4. word/document.xml    — 元素顺序（fix-order）
5. word/styles.xml      — 样式定义和 styleId 映射
6. word/numbering.xml   — 列表/编号定义
7. 其他所有内容          — 页眉、页脚、批注、设置
```

```bash
# 完整恢复管道
$CLI unpack --input broken.docx --output unpacked/
$CLI validate --input broken.docx --xsd assets/xsd/wml-subset.xsd  # 查找所有错误
$CLI fix-order --input broken.docx                                   # 修复元素顺序
$CLI validate --input broken.docx --business                         # 检查业务规则
scripts/docx_preview.sh broken.docx                                  # 视觉检查
```
