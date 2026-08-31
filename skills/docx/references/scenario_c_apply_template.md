# 场景 C：应用格式化/模板

## 何时使用

以下情况使用场景 C：
- 用户已有文档，想应用不同的视觉样式
- 用户想为文档换品牌（新字体、颜色、标题样式）
- 用户提供了一个模板 DOCX，想将其外观应用到内容文档上
- 用户想在多个文档间保持一致的格式

不要使用的情形：用户想编辑内容（→ 场景 B）或从零创建（→ 场景 A）。

---

## 工作流

```
1. 分析源文档      → CLI：analyze source.docx      （列出样式、字体、结构）
2. 分析模板        → CLI：analyze template.docx     （列出样式、字体、结构）
3. 映射样式        → 创建映射方案（源样式 → 模板样式）
4. 应用模板        → CLI：apply-template source.docx --template template.docx --output result.docx
5. 验证（XSD）     → CLI：validate result.docx --xsd wml-subset.xsd
6. 门控检查        → CLI：validate result.docx --xsd business-rules.xsd   ← 必须通过
7. Diff 验证       → CLI：diff source.docx result.docx --text-only   （内容必须完全一致）
```

---

## 从模板复制的内容

| 部件 | 文件 | 说明 |
|------|------|-------------|
| 样式 | `word/styles.xml` | 所有样式定义（段落、字符、表格、编号） |
| 主题 | `word/theme/theme1.xml` | 配色方案、字体方案、格式方案 |
| 编号 | `word/numbering.xml` | 列表和编号定义 |
| 页眉 | `word/header*.xml` | 页眉内容和格式 |
| 页脚 | `word/footer*.xml` | 页脚内容和格式 |
| 节属性 | `w:sectPr` | 页边距、页面尺寸、方向、分栏 |

## 不复制的内容

| 部件 | 原因 |
|------|--------|
| 文档内容 | 段落、表格、图片保留自源文档 |
| 批注 | 属于源文档的审阅历史 |
| 修订标记 | 属于源文档的修订历史 |
| 自定义 XML 部件 | 应用特定数据，非视觉内容 |
| 文档属性 | 标题、作者、日期属于源文档 |
| 术语表文档 | 模板的构建块不转移 |

---

## 模板结构分析（必需）

在选择 Overlay 还是 Base-Replace 之前，你必须分析模板的内部结构。这是被跳过时导致失败的头号原因。

### 第 1 步：统计模板段落数并识别结构区域

运行 `$CLI analyze --input template.docx` 或手动检查：

```bash
# 快速结构扫描
scripts/docx_preview.sh template.docx
```

识别模板中的这些区域：
```
区域 A：前置部分（封面、声明、摘要、目录）
        → 这些保留自模板，绝不替换
区域 B：示例/占位符正文内容（"第1章 XXX"、样例段落）
        → 这部分用用户的实际内容替换
区域 C：后置部分（附录、致谢、空白页）
        → 这些保留自模板或移除
区域 D：末尾 sectPr
        → 始终保留自模板
```

### 第 2 步：找到区域 B 的边界（替换范围）

在模板的 document.xml 中搜索标记示例内容起止的锚点文本：

**起始锚点模式**（示例正文的第一段）：
- "第1章"、"第一章"、"Chapter 1"、"1 Introduction"、"绪论"
- 目录之后第一个带 Heading1 等效样式的段落

**结束锚点模式**（后置部分前的最后一段）：
- "参考文献"、"References"、"致谢"、"Acknowledgments"
- 附录或末尾 sectPr 之前的最后一段

```python
# 查找替换范围的伪代码
for i, element in enumerate(template_body_elements):
    text = get_text(element)
    style = get_style(element)
    if style in heading1_styles and ("第1章" in text or "Chapter 1" in text):
        replace_start = i
    if "参考文献" in text or "References" in text:
        replace_end = i
        break
```

**关键**：通过打印范围内的内容来验证：
```
模板元素 [0..replace_start-1]：前置部分（保留）
模板元素 [replace_start..replace_end]：示例内容（替换）
模板元素 [replace_end+1..end]：后置部分（保留）
```

如果找不到 replace_start 或 replace_end，不要继续。请用户识别替换边界。

### 第 3 步：决定 Overlay 还是 Base-Replace

既然你已经了解了结构：

| 观察 | 决策 |
|-------------|----------|
| 模板 ≤30 段，无封面/目录 | **C-1：Overlay**（纯样式模板） |
| 模板 >100 段，含封面/目录/示例章节 | **C-2：Base-Replace** |
| 模板段落数 ≈ 用户文档 | **C-1：Overlay**（结构相似） |
| 模板段落数 >> 用户文档（如 263 vs 134） | **C-2：Base-Replace** |

### 第 4 步：对于 Base-Replace，执行替换

1. 以模板为基载入（所有文件）
2. 用 `list(body)` 提取用户内容元素 — **不要**用 `findall('w:p')`（会漏掉表格）
3. 构建新正文：`template[0:replace_start] + cleaned_user_content + template[replace_end+1:]`
4. 对每个段落应用样式映射
5. 清理直接格式（见下方规则）
6. 重建 document.xml，保留模板的命名空间声明
7. 合并关系（图片 + 超链接）
8. 以模板为 ZIP 基础写出输出

---

## 样式映射策略

当模板样式名与源样式名不同时，需要映射。**此步骤是必需的** — 跳过它是模板应用中格式失败的头号原因。

### 第 0 步：从两份文档提取 StyleId（必需）

任何模板应用之前，从两份文档提取并比较 styleId：

```bash
# 从源文档提取所有 styleId
$CLI analyze --input source.docx --styles-only
# 输出示例：
#   Heading1  (paragraph, basedOn: Normal)
#   Heading2  (paragraph, basedOn: Normal)
#   Normal    (paragraph)
#   ListBullet (paragraph, basedOn: Normal)

# 从模板提取所有 styleId
$CLI analyze --input template.docx --styles-only
# 输出示例：
#   1         (paragraph, basedOn: a, name: "heading 1")
#   2         (paragraph, basedOn: a, name: "heading 2")
#   3         (paragraph, basedOn: a, name: "heading 3")
#   a         (paragraph, name: "Normal")
#   a0        (character, name: "Default Paragraph Font")
```

**关键区别**：`w:styleId` vs `w:name`：
```xml
<!-- styleId="1" 但 name="heading 1" -->
<w:style w:type="paragraph" w:styleId="1">
  <w:name w:val="heading 1"/>
  <w:basedOn w:val="a"/>
</w:style>
```

`w:styleId` 属性是 `<w:pStyle w:val="..."/>` 引用的对象。`w:name` 属性是人类可读的显示名。**它们可能完全不同。** 许多 CJK 模板使用数字 styleId（`1`、`2`、`3`、`a`、`a0`）而非英文名。

### 第 1 层：精确 StyleId 匹配
如果源用 `Heading1` 且模板将 `Heading1` 定义为 styleId，直接映射。无需操作。

### 第 2 层：基于名称的匹配
若无精确 styleId 匹配，尝试按 `w:name` 属性匹配：
- 源 `Heading1`（name="heading 1"）→ 模板 styleId `1`（name="heading 1"）
- 匹配对 name 值不区分大小写

在同一类型内，还可尝试按以下匹配：
- 内置样式 ID（Word 内部 ID，如 heading 1 = 内置 ID 1）
- 样式类型（段落 → 段落，字符 → 字符，表格 → 表格）

### 第 3 层：手动映射
对于重命名或自定义样式，提供显式映射：

```json
{
  "styleMap": {
    "Heading1": "1",
    "Heading2": "2",
    "Heading3": "3",
    "Heading4": "3",
    "Normal": "a",
    "BodyText": "a",
    "ListBullet": "a",
    "CompanyName": "Title",
    "OldTableStyle": "TableGrid"
  }
}
```

### 常见非标准 StyleId 模式

| 模板来源 | StyleId 模式 | 示例 |
|----------------|-----------------|---------|
| 中文 Word（默认） | 数字/字母 | `1`、`2`、`3`、`a`、`a0` |
| 英文 Word（默认） | 英文名 | `Heading1`、`Normal`、`Title` |
| Google Docs 导出 | 带前缀 | `Subtitle`、`NormalWeb` |
| WPS Office | 混合 | `1`、`Heading1`、自定义名 |
| 学术模板 | 自定义 | `ThesisHeading1`、`ThesisBody` |

### 构建映射表

遵循此算法：

1. **列出 document.xml 中实际使用的 styleId**（不是 styles.xml 中定义的全部）：
   ```python
   # 伪代码：查找源 document.xml 中所有唯一的 pStyle 值
   used_styles = set()
   for p in body.iter('w:p'):
       pStyle = p.find('w:pPr/w:pStyle')
       if pStyle is not None:
           used_styles.add(pStyle.get('val'))
   ```

2. **对每个使用的样式**，在模板中找最佳匹配：
   - 第一尝试：精确 styleId 匹配
   - 第二尝试：按 `w:name` 值匹配（不区分大小写）
   - 第三尝试：按样式用途匹配（任何标题 → 模板的标题样式）
   - 回退：映射到模板的默认段落样式（通常是 `Normal` 或 `a`）

3. **验证映射** — 每个源 styleId 必须映射到模板中已存在的 styleId：
   ```
   ✓ Heading1 → 1（名称匹配："heading 1"）
   ✓ Heading2 → 2（名称匹配："heading 2"）
   ✓ Normal   → a（名称匹配："Normal"）
   ✗ CustomCallout → ???（未找到匹配，将回退到 'a'）
   ```

4. **复制内容时应用映射** — 更新每个 `<w:pStyle w:val="..."/>`：
   ```xml
   <!-- 源 -->
   <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
   <!-- 映射后 -->
   <w:pPr><w:pStyle w:val="1"/></w:pPr>
   ```

### 未映射的样式
源文档中在模板里无匹配的样式会记录为警告：
```
WARNING: Style 'CustomCallout' has no mapping in template. Content will fall back to 'a' (Normal).
```

内容会保留；只有样式引用更新为模板的默认段落样式。

### C-2 BASE-REPLACE：额外的 StyleId 注意事项

以模板为基文档（C-2 策略）时，模板的 `styles.xml` 已就位。你必须：

1. **绝不复制源 `styles.xml`** — 模板的样式是权威
2. **映射每个内容段落的 pStyle** 到模板的 styleId 后再插入
3. **选择性地剥离直接格式**（见下方详细规则）— 让模板样式控制外观
4. **验证表格样式** — 若源表格用 `TableGrid` 但模板定义为 `a3` 之类，也要重映射 `<w:tblStyle>`
5. **检查字符样式** — run 内的 `rPr` 可能引用字符样式如 `Hyperlink` 或 `Strong`，它们在模板中有不同 ID

### 直接格式清理规则（详细）

从源复制内容到模板时，对每个段落和 run 应用这些规则：

**从 `<w:rPr>` 移除：**
- `<w:rFonts w:ascii="..." w:hAnsi="..."/>` — 西文字体覆盖（例外：保留 `w:eastAsia`）
- `<w:sz>`、`<w:szCs>` — 字号（让样式控制）
- `<w:color>` — 文本颜色
- `<w:highlight>` — 突出显示色
- `<w:shd>` — 底纹
- `<w:b>`、`<w:i>` — 粗体/斜体，除非源样式要求（如强调）
- `<w:u>` — 下划线
- `<w:spacing>` — 字符间距

**在 `<w:rPr>` 中保留：**
- `<w:rFonts w:eastAsia="宋体"/>` — CJK 字体声明（必须保留，否则中文渲染错误）
- `<w:rFonts w:eastAsia="华文中宋"/>` — 同上
- `<w:drawing>` 内的任何内容 — 图片引用（通过 rId 重映射单独处理）

**从 `<w:pPr>` 移除：**
- `<w:pBdr>` — 段落边框
- `<w:shd>` — 段落底纹
- `<w:spacing>` — 行距/段距（让样式控制）
- `<w:jc>` — 对齐（让样式控制）
- `<w:tabs>` — 自定义制表位
- `<w:rPr>`（pPr 内的）— 段落的默认 run 格式

**在 `<w:pPr>` 中保留：**
- `<w:pStyle>` — 样式引用（映射到模板的 styleId 之后）
- `<w:sectPr>` — 节属性（若有意插入分节符）
- `<w:numPr>` — 编号引用（将 numId 映射到模板的编号之后）

**表格单元格（`<w:tc>`）：**
对每个单元格内的每个段落应用同样的 rPr/pPr 清理。此外：
- 保留 `<w:tcPr>` 结构属性（跨列、跨行、宽度）
- 移除 `<w:tcPr><w:shd>`（单元格底纹 — 让表格样式控制）

---

## 关系 ID 重映射

从模板复制部件（页眉、页脚、图片）到源包时，关系 ID（`r:id`）可能冲突。

**问题**：
- 源有 `rId7` → `image1.png`
- 模板有 `rId7` → `header1.xml`
- 复制模板的 `rId7` 会覆盖源的图片引用

**解决方案**：
1. 扫描源的 `document.xml.rels` 中所有现有 `rId` 值
2. 找到最大数字 ID（如 `rId12`）
3. 从 `rId13` 起重映射所有模板关系 ID
4. 更新所复制部件中的所有引用以使用新 ID

```xml
<!-- 模板原始 -->
<Relationship Id="rId1" Type="...header" Target="header1.xml" />

<!-- 重映射到源包后 -->
<Relationship Id="rId13" Type="...header" Target="header1.xml" />

<!-- 更新 sectPr 引用 -->
<w:headerReference w:type="default" r:id="rId13" />
```

### 超链接关系合并

源文档包含外部超链接（如参考文献或脚注中的 URL）时，它们作为关系存储在 `word/_rels/document.xml.rels` 中：

```xml
<Relationship Id="rId15" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
              Target="https://example.com/paper" TargetMode="External"/>
```

document.xml 中对应的文本引用此 rId：
```xml
<w:hyperlink r:id="rId15">
  <w:r><w:t>https://example.com/paper</w:t></w:r>
</w:hyperlink>
```

**合并步骤：**
1. 扫描源 document.xml 中所有 `<w:hyperlink r:id="...">` 元素
2. 对每个，在源的 rels 文件中找对应关系
3. 检查模板是否已有相同 Target URL 的关系
   - 是：复用现有 rId，更新超链接引用
   - 否：分配新 rId（从模板的最大 rId + 1 起），将关系添加到模板的 rels，更新超链接引用
4. 同时检查脚注（`word/_rels/footnotes.xml.rels`）和尾注中使用的超链接关系

**常见错误：** 复制超链接段落但未合并 rels → 超链接静默失效（在 Word 中点击无反应）。

---

## XSD 门控检查

### 是什么

模板应用后，输出文档**必须**通过 `business-rules.xsd` 验证。这是**硬门控** — 若失败，文档**不可交付**。

### business-rules.xsd 检查内容

| 规则 | 验证内容 |
|------|-------------------|
| 模板样式存在 | 内容段落引用的所有样式都在 `styles.xml` 中定义 |
| 页边距匹配 | 页边距匹配模板规范 |
| 字体正确 | `w:docDefaults` 字体匹配模板的字体方案 |
| 标题层级 | 标题级别连续（无 H1 → H3 而无 H2） |
| 必需样式存在 | `Normal`、`Heading1`-`Heading3`、`TableGrid` 存在 |
| 页面尺寸 | 匹配模板声明的页面尺寸 |

### 处理失败

```
GATE-CHECK FAILED:
  - Style 'CustomStyle1' referenced in paragraph 14 but not defined in styles.xml
  - Margin w:left=1080 does not match template requirement 1440
```

修复每个失败：
1. **缺失样式**：将样式定义添加到 `styles.xml`，或将段落重映射到已存在样式
2. **页边距不匹配**：更新 `w:sectPr` 页边距以匹配模板
3. **字体不匹配**：更新 `w:docDefaults` 以匹配模板字体方案
4. **标题层级跳级**：插入中间标题级别或调整现有级别

每次修复后重新验证，直到门控检查通过。

---

## 常见陷阱

### 1. 孤立的编号引用

**问题**：源文档在列表段落中用 `w:numId="5"`，但用模板版本替换 `numbering.xml` 后，编号 ID 5 不存在。

**症状**：列表显示为普通段落（无项目符号/编号）。

**修复**：
- 将源编号 ID 映射到模板编号 ID
- 更新文档内容中所有 `w:numId` 引用
- 或将源编号定义合并到模板的 `numbering.xml` 中

### 2. 缺失主题颜色

**问题**：源文档样式引用主题颜色（`w:themeColor="accent1"`），但模板主题中这些颜色值不同。

**症状**：颜色意外改变（通常可接受 — 这正是重新主题化的目的）。但若样式同时使用 `w:val` 和 `w:themeColor`，Word 中主题颜色优先。

**修复**：审查颜色变化。若必须保留特定颜色，使用不带 `w:themeColor` 的显式 `w:val`。

### 3. 节属性冲突

**问题**：源文档有多个节（如纵向 + 横向页），但模板假设单一节。

**症状**：所有节获得相同的页边距/方向，破坏横向页。

**修复**：
- 只对 `w:body` 中最后的 `w:sectPr` 应用模板节属性
- 保留源中中间的 `w:sectPr` 元素（在 `w:pPr` 内）
- 或对所有节应用模板属性但保留方向覆盖

### 4. 嵌入字体冲突

**问题**：模板指定的字体在目标系统上不可用。

**修复**：在 DOCX 中嵌入字体（`word/fonts/`），或使用 Web 安全替代：
- Calibri → Windows/Mac/Office Online 可用
- Arial → 通用回退
- Times New Roman → 通用衬线回退

### 5. 破坏的样式继承

**问题**：模板的 `Heading1` 基于 `Normal`，但应用模板后 `Normal` 属性不同，级联导致标题出现不想要的变化。

**修复**：验证所有关键样式的 `w:basedOn` 链。确保基础样式也正确地从模板转移。

---

## 验证清单

模板应用后，验证：

1. **内容保留** — 文本 diff 显示零内容变化
2. **门控检查通过** — `business-rules.xsd` 验证成功
3. **样式已应用** — 标题、正文、表格使用模板格式
4. **图片完整** — 所有图片正确渲染（关系 ID 有效）
5. **列表正常** — 编号和项目符号列表正确显示
6. **页眉/页脚** — 模板页眉/页脚出现在所有页
7. **页面布局** — 页边距、页面尺寸、方向匹配模板
8. **无损坏** — 文件在 Word 中无错误打开
