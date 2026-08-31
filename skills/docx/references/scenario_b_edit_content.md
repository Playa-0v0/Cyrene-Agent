# 场景 B：编辑/填充已有 DOCX 内容

## 核心原则

**"首先，不造成伤害。"** 编辑已有文档时，要最小化改动。只动需要改动的部分。保留所有未直接参与编辑的格式、样式、关系和结构。

---

## 何时使用

- 替换占位符文本（`{{name}}`、`$DATE$`、`[PLACEHOLDER]`）
- 更新特定段落或表格单元格
- 填写表单字段
- 在已知位置添加或删除段落
- 为审阅工作流插入修订标记

不要使用的情形：用户想改变整个文档的外观/样式（→ 场景 C），或从零创建（→ 场景 A）。

---

## 工作流

```
1. 预览    → CLI：analyze <input.docx>
2. 分析    → 理解结构：章节、样式、标题、表格
3. 定位    → 找到精确的编辑目标（段落索引、表格索引、占位符文本）
4. 编辑    → 通过 CLI 或直接 XML 应用外科手术式改动
5. 验证    → CLI：validate <output.docx>
6. Diff    → 对比修改前后，确认只改动了预期内容
```

---

## 何时用 API vs 直接 XML

### 使用 CLI 编辑命令的情形：
- 替换占位符文本（如 `{{fieldName}}` → 实际值）
- 从 JSON 填充表格数据
- 更新文档属性（标题、作者）
- 简单的文本插入或删除

### 使用直接 XML 操作的情形：
- 文本跨多个不同格式的 run（run 边界问题）
- 添加复杂结构（嵌套表格、多图布局）
- 操作修订追踪标记
- 修改页眉/页脚内容
- 调整节属性

---

## 占位符模式

CLI 原生支持 `{{fieldName}}` 占位符：

```bash
# 从 JSON 映射替换所有 {{占位符}}
dotnet run ... edit input.docx --fill-placeholders data.json --output filled.docx
```

其中 `data.json`：
```json
{
  "companyName": "Acme Corp",
  "date": "March 21, 2026",
  "amount": "$15,000.00",
  "recipientName": "Jane Smith"
}
```

其他占位符格式（`$FIELD$`、`[PLACEHOLDER]`）需要文本替换：
```bash
dotnet run ... edit input.docx --replace "$DATE$" "March 21, 2026" --output updated.docx
```

---

## 文本替换策略

### 简单替换

当整个搜索文本在单个 `w:r`（run）内时：

```xml
<!-- 之前 -->
<w:r>
  <w:rPr><w:b /></w:rPr>
  <w:t>{{companyName}}</w:t>
</w:r>

<!-- 之后 — 格式保留 -->
<w:r>
  <w:rPr><w:b /></w:rPr>
  <w:t>Acme Corp</w:t>
</w:r>
```

直接替换。run 的 `w:rPr` 不动。

### 复杂替换（拆分 run）

当搜索文本被拆分到多个 run 时（常见于 Word 在文本中间应用拼写检查或格式）：

```xml
<!-- "{{companyName}}" 被拆成 3 个 run -->
<w:r><w:rPr><w:b /></w:rPr><w:t>{{company</w:t></w:r>
<w:r><w:rPr><w:b /><w:i /></w:rPr><w:t>Na</w:t></w:r>
<w:r><w:rPr><w:b /></w:rPr><w:t>me}}</w:t></w:r>
```

策略：
1. 跨 run 拼接文本以找到匹配
2. 将替换文本放入**第一个** run（保留其 `w:rPr`）
3. 从后续 run 中移除文本（若变空则整个移除该 run）

```xml
<!-- 之后 -->
<w:r><w:rPr><w:b /></w:rPr><w:t>Acme Corp</w:t></w:r>
```

**规则**：始终保留匹配中第一个 run 的格式。

---

## 表格编辑

### 按索引

表格按文档顺序从 0 开始索引：

```bash
dotnet run ... edit input.docx --table-index 0 --table-data data.json --output updated.docx
```

### 按表头匹配

按表头行内容查找表格：

```bash
dotnet run ... edit input.docx --table-match "Name,Amount,Date" --table-data data.json
```

### 表格数据 JSON 格式

```json
{
  "rows": [
    ["Alice Johnson", "$5,000", "2026-03-15"],
    ["Bob Smith", "$3,200", "2026-03-18"]
  ],
  "appendRows": true
}
```

- `appendRows: true` — 在现有数据后追加行
- `appendRows: false`（默认）— 替换所有数据行（保留表头行）

### 直接 XML 表格编辑

要修改特定单元格，按行/列索引定位：

```xml
<!-- 第 2 行（0 索引），第 1 列 -->
<w:tr>  <!-- tr[2] -->
  <w:tc>...</w:tc>
  <w:tc>  <!-- tc[1] — 目标单元格 -->
    <w:p>
      <w:r><w:t>旧值</w:t></w:r>
    </w:p>
  </w:tc>
</w:tr>
```

替换 `w:t` 内容。**禁止**修改 `w:tcPr`（单元格属性）或 `w:tblPr`（表格属性）。

---

## 修订追踪指引

### 何时添加修订标记
- 用户明确要求追踪修订
- 文档已启用追踪（settings 中的 `w:trackChanges`）
- 协作审阅工作流

### 何时不添加修订标记
- 表单填写/占位符替换（这是"完成"文档，而非"修订"）
- 用户想要干净结果的直接编辑
- 批量数据填充操作

### 添加修订标记

完整 XML 示例参见 `references/track_changes_guide.md`。

速查 — 带追踪插入文本：
```xml
<w:ins w:id="1" w:author="MiniMaxAI" w:date="2026-03-21T10:00:00Z">
  <w:r>
    <w:t>此处为新文本</w:t>
  </w:r>
</w:ins>
```

带追踪删除文本：
```xml
<w:del w:id="2" w:author="MiniMaxAI" w:date="2026-03-21T10:00:00Z">
  <w:r>
    <w:delText>已移除的文本</w:delText>  <!-- 必须用 delText，不能用 t -->
  </w:r>
</w:del>
```

---

## 常见陷阱

### 1. 破坏 run 边界

**问题**：跨 run 的文本替换，若天真地逐个修改 run，会破坏内联格式。

**修复**：拼接 run 文本，找到匹配边界，合并到第一个 run，移除被消耗的 run。

### 2. 超链接内容

**问题**：替换 `w:hyperlink` 元素内的文本时未保留超链接包装器，会移除链接。

```xml
<w:hyperlink r:id="rId5">
  <w:r>
    <w:rPr><w:rStyle w:val="Hyperlink" /></w:rPr>
    <w:t>点击此处</w:t>  <!-- 只替换此文本 -->
  </w:r>
</w:hyperlink>
```

**修复**：只修改超链接 run 内的 `w:t`。绝不移除或替换 `w:hyperlink` 元素本身。

### 3. 修订上下文

**问题**：替换 `w:ins` 或 `w:del` 元素内的文本时未理解修订上下文，会产生无效标记。

**修复**：若目标文本在修订标记内，要么：
- 在修订上下文内替换（保留 `w:ins`/`w:del` 包装）
- 或删除旧修订并新建一个

### 4. 样式保留

**问题**：插入新段落时未指定样式，导致其继承 `Normal`，可能与周围上下文不匹配。

**修复**：插入段落时，从同类型的相邻段落复制 `w:pStyle`。

### 5. 编号连续性

**问题**：插入新列表项会打断编号序列。

**修复**：确保新段落与相邻列表项具有相同的 `w:numId` 和 `w:ilvl`。若延续序列，设置 `w:numPr` 以匹配。

### 6. XML 特殊字符

**问题**：用户内容包含 `&`、`<`、`>`、`"`、`'` — 这些在 XML 中必须转义。

**修复**：插入 `w:t` 元素前始终对用户提供的文本进行 XML 转义：
- `&` → `&amp;`
- `<` → `&lt;`
- `>` → `&gt;`
- `"` → `&quot;`
- `'` → `&apos;`

### 7. 空白保留

**问题**：`w:t` 中的前导/尾随空格会被 XML 解析器去除。

**修复**：添加 `xml:space="preserve"` 属性：
```xml
<w:t xml:space="preserve"> 带前导空格的文本</w:t>
```

---

## Diff 验证

编辑后，始终对比修改前后状态：

```bash
# 结构 diff — 只显示变更的元素
dotnet run ... diff original.docx modified.docx

# 纯文本 diff — 显示内容变更
dotnet run ... diff original.docx modified.docx --text-only
```

验证：
- 只有预期文本发生变化
- 没有样式被修改
- 没有意外添加/移除关系
- 表格结构完整（除非有意改变，行列数相同）
- 图片和其他媒体未变
