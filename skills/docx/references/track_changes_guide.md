# 修訂追蹤指南

## 概述

OpenXML 中的修訂追蹤使用修訂標記元素記錄插入、刪除和格式更改。每個修訂都有唯一的 ID、作者和時間戳。

---

## 插入：`<w:ins>`

包裝在追蹤期間插入的 run：

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

- `w:id` — 唯一修訂 ID（整數，在全文檔內必須唯一）
- `w:author` — 標識作者的自由文本字符串
- `w:date` — 帶時區的 ISO 8601 格式：`YYYY-MM-DDTHH:MM:SSZ`
- 內部內容是普通 run（`w:r`），可帶格式

---

## 刪除：`<w:del>`

包裝在追蹤期間刪除的 run：

```xml
<w:del w:id="2" w:author="John Smith" w:date="2026-03-21T10:31:00Z">
  <w:r>
    <w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" />
      <w:sz w:val="22" />
    </w:rPr>
    <w:delText xml:space="preserve">此文本已刪除。</w:delText>
  </w:r>
</w:del>
```

**關鍵**：在 `<w:del>` 內部，文本必須使用 `<w:delText>`，**禁止**使用 `<w:t>`。在刪除中使用 `<w:t>` 是無效的，會導致損壞或意外行為。Word 可能會靜默修復它，但其他消費者會失敗。

---

## 格式更改：`<w:rPrChange>`

記錄 run 的格式被更改。放在 `w:rPr` 內部，存儲**之前的**格式：

```xml
<w:r>
  <w:rPr>
    <w:b />  <!-- 當前：粗體 -->
    <w:rPrChange w:id="3" w:author="Jane Doe" w:date="2026-03-21T11:00:00Z">
      <w:rPr>
        <!-- 之前：非粗體（空 rPr 表示無格式） -->
      </w:rPr>
    </w:rPrChange>
  </w:rPr>
  <w:t>此文本被設為粗體。</w:t>
</w:r>
```

外層 `w:rPr` 保存**新**（當前）格式。`w:rPrChange` 子元素保存**舊**（之前）格式。

---

## 段落屬性更改：`<w:pPrChange>`

記錄段落級格式更改（對齊、間距、樣式）：

```xml
<w:pPr>
  <w:jc w:val="center" />  <!-- 當前：居中 -->
  <w:pPrChange w:id="4" w:author="Jane Doe" w:date="2026-03-21T11:05:00Z">
    <w:pPr>
      <w:jc w:val="left" />  <!-- 之前：左對齊 -->
    </w:pPr>
  </w:pPrChange>
</w:pPr>
```

---

## 修訂 ID 管理

- 每個修訂元素（`w:ins`、`w:del`、`w:rPrChange`、`w:pPrChange`、`w:tblPrChange` 等）都需要 `w:id` 屬性
- ID 必須是全文檔內**唯一的整數**
- ID 應**單調遞增**（非嚴格要求，但 Word 期望如此）
- 添加修訂時，掃描當前最大 `w:id` 並從此處遞增

```
現有最大 ID：47
新插入：w:id="48"
新刪除：w:id="49"
```

---

## 作者與日期

- **作者**：自由文本。使用一致的字符串（如所有自動編輯都用 `"MiniMaxAI"`）
- **日期**：帶 UTC 時區標記的 ISO 8601：`2026-03-21T10:30:00Z`
  - 必須包含 `T` 分隔符和 `Z` 後綴（或 `+HH:MM` 偏移量）
  - 允許省略日期，但不推薦

---

## 操作

### 提議插入

在目標位置用 `<w:ins>` 包裝新內容：

```xml
<w:p>
  <w:r><w:t>現有文本。 </w:t></w:r>
  <w:ins w:id="5" w:author="MiniMaxAI" w:date="2026-03-21T12:00:00Z">
    <w:r><w:t>提議的新文本。 </w:t></w:r>
  </w:ins>
  <w:r><w:t>更多現有文本。</w:t></w:r>
</w:p>
```

### 提議刪除

用 `<w:del>` 包裝現有內容，並將 `<w:t>` 改為 `<w:delText>`：

```xml
<w:p>
  <w:r><w:t>保留這段。 </w:t></w:r>
  <w:del w:id="6" w:author="MiniMaxAI" w:date="2026-03-21T12:01:00Z">
    <w:r>
      <w:rPr><w:b /></w:rPr>
      <w:delText>刪除這段。</w:delText>
    </w:r>
  </w:del>
  <w:r><w:t> 這段也保留。</w:t></w:r>
</w:p>
```

### 接受修訂

- **接受插入**：移除 `<w:ins>` 包裝，將內部 run 保留為普通內容
- **接受刪除**：移除整個 `<w:del>` 元素及其內容

### 拒絕修訂

- **拒絕插入**：移除整個 `<w:ins>` 元素及其內容
- **拒絕刪除**：移除 `<w:del>` 包裝，將 `<w:delText>` 改回 `<w:t>`

---

## 跨段落操作

### 刪除段落分隔符（合併段落）

當修訂刪除跨越段落邊界時，在合併後的段落上使用 `<w:pPrChange>`：

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
  <w:r><w:t>第二段文本（現已合併）。</w:t></w:r>
</w:p>
```

### 插入新段落

整個新段落被 `<w:ins>` 包裝：

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

段落標記本身通過 `w:pPr > w:rPr` 內的 `w:ins` 標記為已插入。
