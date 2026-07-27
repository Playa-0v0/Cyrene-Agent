# OpenXML 命名空間、關係類型與內容類型

## 核心命名空間

| 前綴 | URI | 用於 |
|--------|-----|---------|
| `w` | `http://schemas.openxmlformats.org/wordprocessingml/2006/main` | document.xml、styles.xml、numbering.xml、頁眉、頁腳 |
| `r` | `http://schemas.openxmlformats.org/officeDocument/2006/relationships` | 關係引用（r:id） |
| `wp` | `http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing` | 文檔中圖片/繪圖的放置 |
| `a` | `http://schemas.openxmlformats.org/drawingml/2006/main` | DrawingML 核心（形狀、圖片、主題） |
| `pic` | `http://schemas.openxmlformats.org/drawingml/2006/picture` | DrawingML 中的圖片元素 |
| `v` | `urn:schemas-microsoft-com:vml` | VML（舊式形狀、水印） |
| `o` | `urn:schemas-microsoft-com:office:office` | Office VML 擴展 |
| `m` | `http://schemas.openxmlformats.org/officeDocument/2006/math` | 數學公式（OMML） |
| `mc` | `http://schemas.openxmlformats.org/markup-compatibility/2006` | 標記兼容（Ignorable、AlternateContent） |

## 擴展命名空間

| 前綴 | URI | 用途 |
|--------|-----|---------|
| `w14` | `http://schemas.microsoft.com/office/word/2010/wordml` | Word 2010 擴展（contentPart 等） |
| `w15` | `http://schemas.microsoft.com/office/word/2012/wordml` | Word 2013 擴展（commentEx 等） |
| `w16cid` | `http://schemas.microsoft.com/office/word/2016/wordml/cid` | 批註 ID（持久 ID） |
| `w16cex` | `http://schemas.microsoft.com/office/word/2018/wordml/cex` | 批註可擴展 |
| `w16se` | `http://schemas.microsoft.com/office/word/2015/wordml/symex` | 符號擴展 |
| `wps` | `http://schemas.microsoft.com/office/word/2010/wordprocessingShape` | WordprocessingML 形狀 |
| `wpc` | `http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas` | 繪圖畫布 |

## 關係類型

| 關係 | 類型 URI |
|-------------|----------|
| 文檔 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument` |
| 樣式 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles` |
| 編號 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering` |
| 字體表 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable` |
| 設置 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings` |
| 主題 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme` |
| 圖片 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/image` |
| 超鏈接 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink` |
| 頁眉 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/header` |
| 頁腳 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer` |
| 批註 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments` |
| 擴展批註 | `http://schemas.microsoft.com/office/2011/relationships/commentsExtended` |
| 批註 ID | `http://schemas.microsoft.com/office/2016/09/relationships/commentsIds` |
| 可擴展批註 | `http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible` |
| 腳註 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes` |
| 尾註 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes` |
| 術語表 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/glossaryDocument` |
| Web 設置 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings` |

## 內容類型（`[Content_Types].xml`）

### 默認擴展名

```xml
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
<Default Extension="xml" ContentType="application/xml" />
<Default Extension="png" ContentType="image/png" />
<Default Extension="jpeg" ContentType="image/jpeg" />
<Default Extension="gif" ContentType="image/gif" />
<Default Extension="emf" ContentType="image/x-emf" />
```

### 部件覆蓋

| 部件 | 內容類型 |
|------|-------------|
| `/word/document.xml` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml` |
| `/word/styles.xml` | `application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml` |
| `/word/numbering.xml` | `application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml` |
| `/word/settings.xml` | `application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml` |
| `/word/fontTable.xml` | `application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml` |
| `/word/theme/theme1.xml` | `application/vnd.openxmlformats-officedocument.theme+xml` |
| `/word/header1.xml` | `application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml` |
| `/word/footer1.xml` | `application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml` |
| `/word/comments.xml` | `application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml` |
| `/word/commentsExtended.xml` | `application/vnd.ms-word.commentsExtended+xml` |
| `/word/commentsIds.xml` | `application/vnd.ms-word.commentsIds+xml` |
| `/word/commentsExtensible.xml` | `application/vnd.ms-word.commentsExtensible+xml` |
| `/word/footnotes.xml` | `application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml` |
| `/word/endnotes.xml` | `application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml` |
