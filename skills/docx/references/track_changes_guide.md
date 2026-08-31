# 修订追踪指南

## 概述

OpenXML 中的修订追踪使用修订标记元素记录插入、删除和格式更改。每个修订都有唯一的 ID、作者和时间戳。

---

## 插入：`<w:ins>`

包装在追踪期间插入的 run：

```xml
<w:ins w:id="1" w:author="John Smith" w:date="2026-03-21T10:30:00Z">
  <w:r>
    <w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" />
      <w:sz w:val="22" />
    </w:rPr>
    <w:t>此文本是插入的。</w:t>
  </w:r>
</w:ins>
```

- `w:id` — 唯一修订 ID（整数，在全文档内必须唯一）
- `w:author` — 标识作者的自由文本字符串
- `w:date` — 带时区的 ISO 8601 格式：`YYYY-MM-DDTHH:MM:SSZ`
- 内部内容是普通 run（`w:r`），可带格式

---

## 删除：`<w:del>`

包装在追踪期间删除的 run：

```xml
<w:del w:id="2" w:author="John Smith" w:date="2026-03-21T10:31:00Z">
  <w:r>
    <w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" />
      <w:sz w:val="22" />
    </w:rPr>
    <w:delText xml:space="preserve">此文本已删除。</w:delText>
  </w:r>
</w:del>
```

**关键**：在 `<w:del>` 内部，文本必须使用 `<w:delText>`，**禁止**使用 `<w:t>`。在删除中使用 `<w:t>` 是无效的，会导致损坏或意外行为。Word 可能会静默修复它，但其他消费者会失败。

---

## 格式更改：`<w:rPrChange>`

记录 run 的格式被更改。放在 `w:rPr` 内部，存储**之前的**格式：

```xml
<w:r>
  <w:rPr>
    <w:b />  <!-- 当前：粗体 -->
    <w:rPrChange w:id="3" w:author="Jane Doe" w:date="2026-03-21T11:00:00Z">
      <w:rPr>
        <!-- 之前：非粗体（空 rPr 表示无格式） -->
      </w:rPr>
    </w:rPrChange>
  </w:rPr>
  <w:t>此文本被设为粗体。</w:t>
</w:r>
```

外层 `w:rPr` 保存**新**（当前）格式。`w:rPrChange` 子元素保存**旧**（之前）格式。

---

## 段落属性更改：`<w:pPrChange>`

记录段落级格式更改（对齐、间距、样式）：

```xml
<w:pPr>
  <w:jc w:val="center" />  <!-- 当前：居中 -->
  <w:pPrChange w:id="4" w:author="Jane Doe" w:date="2026-03-21T11:05:00Z">
    <w:pPr>
      <w:jc w:val="left" />  <!-- 之前：左对齐 -->
    </w:pPr>
  </w:pPrChange>
</w:pPr>
```

---

## 修订 ID 管理

- 每个修订元素（`w:ins`、`w:del`、`w:rPrChange`、`w:pPrChange`、`w:tblPrChange` 等）都需要 `w:id` 属性
- ID 必须是全文档内**唯一的整数**
- ID 应**单调递增**（非严格要求，但 Word 期望如此）
- 添加修订时，扫描当前最大 `w:id` 并从此处递增

```
现有最大 ID：47
新插入：w:id="48"
新删除：w:id="49"
```

---

## 作者与日期

- **作者**：自由文本。使用一致的字符串（如所有自动编辑都用 `"MiniMaxAI"`）
- **日期**：带 UTC 时区标记的 ISO 8601：`2026-03-21T10:30:00Z`
  - 必须包含 `T` 分隔符和 `Z` 后缀（或 `+HH:MM` 偏移量）
  - 允许省略日期，但不推荐

---

## 操作

### 提议插入

在目标位置用 `<w:ins>` 包装新内容：

```xml
<w:p>
  <w:r><w:t>现有文本。 </w:t></w:r>
  <w:ins w:id="5" w:author="MiniMaxAI" w:date="2026-03-21T12:00:00Z">
    <w:r><w:t>提议的新文本。 </w:t></w:r>
  </w:ins>
  <w:r><w:t>更多现有文本。</w:t></w:r>
</w:p>
```

### 提议删除

用 `<w:del>` 包装现有内容，并将 `<w:t>` 改为 `<w:delText>`：

```xml
<w:p>
  <w:r><w:t>保留这段。 </w:t></w:r>
  <w:del w:id="6" w:author="MiniMaxAI" w:date="2026-03-21T12:01:00Z">
    <w:r>
      <w:rPr><w:b /></w:rPr>
      <w:delText>删除这段。</w:delText>
    </w:r>
  </w:del>
  <w:r><w:t> 这段也保留。</w:t></w:r>
</w:p>
```

### 接受修订

- **接受插入**：移除 `<w:ins>` 包装，将内部 run 保留为普通内容
- **接受删除**：移除整个 `<w:del>` 元素及其内容

### 拒绝修订

- **拒绝插入**：移除整个 `<w:ins>` 元素及其内容
- **拒绝删除**：移除 `<w:del>` 包装，将 `<w:delText>` 改回 `<w:t>`

---

## 跨段落操作

### 删除段落分隔符（合并段落）

当修订删除跨越段落边界时，在合并后的段落上使用 `<w:pPrChange>`：

```xml
<w:p>
  <w:pPr>
    <w:pPrChange w:id="7" w:author="MiniMaxAI" w:date="2026-03-21T12:05:00Z">
      <w:pPr>
        <w:pStyle w:val="Normal" />
      </w:pPr>
    </w:pPrChange>
  </w:pPr>
  <w:r><w:t>第一段文本。 </w:t></w:r>
  <w:del w:id="8" w:author="MiniMaxAI" w:date="2026-03-21T12:05:00Z">
    <w:r><w:delText> </w:delText></w:r>
  </w:del>
  <w:r><w:t>第二段文本（现已合并）。</w:t></w:r>
</w:p>
```

### 插入新段落

整个新段落被 `<w:ins>` 包装：

```xml
<w:p>
  <w:pPr>
    <w:rPr>
      <w:ins w:id="9" w:author="MiniMaxAI" w:date="2026-03-21T12:10:00Z" />
    </w:rPr>
  </w:pPr>
  <w:ins w:id="10" w:author="MiniMaxAI" w:date="2026-03-21T12:10:00Z">
    <w:r><w:t>全新段落。</w:t></w:r>
  </w:ins>
</w:p>
```

段落标记本身通过 `w:pPr > w:rPr` 内的 `w:ins` 标记为已插入。
