# 批註系統指南（4 文件架構）

## 概述

Word 批註需要在**四個 XML 文件**之間協調，外加 `document.xml`、`[Content_Types].xml` 和 `document.xml.rels` 中的引用。

---

## 四個批註文件

### 1. `word/comments.xml` — 批註主內容

包含實際的批註文本：

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:comment w:id="1" w:author="Alice" w:date="2026-03-21T09:00:00Z" w:initials="A">
    <w:p>
      <w:pPr><w:pStyle w:val="CommentText" /></w:pPr>
      <w:r>
        <w:rPr><w:rStyle w:val="CommentReference" /></w:rPr>
        <w:annotationRef />
      </w:r>
      <w:r>
        <w:t>此處需要澄清。</w:t>
      </w:r>
    </w:p>
  </w:comment>
</w:comments>
```

關鍵屬性：`w:id`（唯一整數）、`w:author`、`w:date`（ISO 8601）、`w:initials`。

### 2. `word/commentsExtended.xml` — W15 擴展

將批註鏈接到段落並追蹤已解決狀態：

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  <w15:commentEx w15:paraId="1A2B3C4D" w15:done="0" />
</w15:commentsEx>
```

- `w15:paraId` — 匹配 `comments.xml` 中批註段落的 `w14:paraId`
- `w15:done` — `"0"` = 未解決，`"1"` = 已解決

### 3. `word/commentsIds.xml` — 持久 ID 映射

提供在跨文檔複製/粘貼後仍能存活的持久 ID：

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w16cid:commentsIds xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid">
  <w16cid:commentId w16cid:paraId="1A2B3C4D" w16cid:durableId="12345678" />
</w16cid:commentsIds>
```

- `w16cid:paraId` — 與 `w15:paraId` 相同
- `w16cid:durableId` — 全局唯一標識符（8 位十六進制）

### 4. `word/commentsExtensible.xml` — W16 擴展

現代批註擴展（用於較新版本的 Word）：

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w16cex:commentsExtensible xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex">
  <w16cex:commentExtensible w16cex:durableId="12345678" w16cex:dateUtc="2026-03-21T09:00:00Z" />
</w16cex:commentsExtensible>
```

---

## document.xml 中的引用

批註通過三個元素錨定在文檔內容中：

```xml
<w:p>
  <w:commentRangeStart w:id="1" />
  <w:r><w:t>此文本帶有一條批註。</w:t></w:r>
  <w:commentRangeEnd w:id="1" />
  <w:r>
    <w:rPr><w:rStyle w:val="CommentReference" /></w:rPr>
    <w:commentReference w:id="1" />
  </w:r>
</w:p>
```

- `w:commentRangeStart` — 標記被批註文本的起始位置
- `w:commentRangeEnd` — 標記被批註文本的結束位置
- `w:commentReference` — 可見的批註標記（上標數字），放在範圍結束之後的一個 run 中

三者的 `w:id` 必須與 `comments.xml` 中的 `w:id` 匹配。

---

## 內容類型註冊

添加到 `[Content_Types].xml`：

```xml
<Override PartName="/word/comments.xml"
          ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml" />
<Override PartName="/word/commentsExtended.xml"
          ContentType="application/vnd.ms-word.commentsExtended+xml" />
<Override PartName="/word/commentsIds.xml"
          ContentType="application/vnd.ms-word.commentsIds+xml" />
<Override PartName="/word/commentsExtensible.xml"
          ContentType="application/vnd.ms-word.commentsExtensible+xml" />
```

---

## 關係註冊

添加到 `word/_rels/document.xml.rels`：

```xml
<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
              Target="comments.xml" />
<Relationship Id="rId21" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended"
              Target="commentsExtended.xml" />
<Relationship Id="rId22" Type="http://schemas.microsoft.com/office/2016/09/relationships/commentsIds"
              Target="commentsIds.xml" />
<Relationship Id="rId23" Type="http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible"
              Target="commentsExtensible.xml" />
```

---

## 分步：添加新批註

1. **選擇唯一的批註 ID**（掃描現有 `w:id` 值，使用最大值 + 1）
2. **生成 paraId**（8 字符十六進制，如 `"1A2B3C4D"`）和 durableId（8 位十六進制）
3. **添加到 `comments.xml`**：創建帶內容的 `w:comment` 元素
4. **添加到 `commentsExtended.xml`**：創建帶 `paraId`、`done="0"` 的 `w15:commentEx`
5. **添加到 `commentsIds.xml`**：創建帶 `paraId` 和 `durableId` 的 `w16cid:commentId`
6. **添加到 `commentsExtensible.xml`**：創建帶 `durableId` 和 `dateUtc` 的 `w16cex:commentExtensible`
7. **添加到 `document.xml`**：在目標文本週圍插入 `w:commentRangeStart`、`w:commentRangeEnd` 和 `w:commentReference`
8. **驗證 `[Content_Types].xml`** 和 `document.xml.rels` 是否包含全部 4 個文件的條目

---

## 分步：添加回復

回覆是其段落的 `w14:paraId` 鏈接到父批註的批註：

1. 在 `comments.xml` 中創建帶新 `w:id` 的新 `w:comment`
2. 在 `commentsExtended.xml` 中添加 `w15:commentEx`：
   - `w15:paraId` = 新段落 ID
   - `w15:paraIdParent` = 被回覆批註的 `paraId`
   - `w15:done="0"`
3. 在 `commentsIds.xml` 和 `commentsExtensible.xml` 中添加條目
4. 在 `document.xml` 中，回覆不需要自己的範圍標記——它共享父批註的範圍

```xml
<!-- 在 commentsExtended.xml 中 -->
<w15:commentEx w15:paraId="5E6F7A8B" w15:paraIdParent="1A2B3C4D" w15:done="0" />
```

---

## 分步：解決批註

將批註的 `w15:commentEx` 條目的 `w15:done` 設為 `"1"`：

```xml
<!-- 之前 -->
<w15:commentEx w15:paraId="1A2B3C4D" w15:done="0" />

<!-- 之後 -->
<w15:commentEx w15:paraId="1A2B3C4D" w15:done="1" />
```

這會將批註（及其所有回覆）標記為已解決。批註仍可見，但在 Word 中顯示為灰色。

---

## 最小可用批註

一個可用的批註至少需要：
1. 包含 `w:comment` 元素的 `comments.xml`
2. 包含範圍標記和引用的 `document.xml`
3. `document.xml.rels` 中的關係
4. `[Content_Types].xml` 中的內容類型

擴展文件（`commentsExtended`、`commentsIds`、`commentsExtensible`）是可選的，但建議使用以完全兼容現代 Word。
