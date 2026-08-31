# OpenXML 命名空间、关系类型与内容类型

## 核心命名空间

| 前缀 | URI | 用于 |
|--------|-----|---------|
| `w` | `http://schemas.openxmlformats.org/wordprocessingml/2006/main` | document.xml、styles.xml、numbering.xml、页眉、页脚 |
| `r` | `http://schemas.openxmlformats.org/officeDocument/2006/relationships` | 关系引用（r:id） |
| `wp` | `http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing` | 文档中图片/绘图的放置 |
| `a` | `http://schemas.openxmlformats.org/drawingml/2006/main` | DrawingML 核心（形状、图片、主题） |
| `pic` | `http://schemas.openxmlformats.org/drawingml/2006/picture` | DrawingML 中的图片元素 |
| `v` | `urn:schemas-microsoft-com:vml` | VML（旧式形状、水印） |
| `o` | `urn:schemas-microsoft-com:office:office` | Office VML 扩展 |
| `m` | `http://schemas.openxmlformats.org/officeDocument/2006/math` | 数学公式（OMML） |
| `mc` | `http://schemas.openxmlformats.org/markup-compatibility/2006` | 标记兼容（Ignorable、AlternateContent） |

## 扩展命名空间

| 前缀 | URI | 用途 |
|--------|-----|---------|
| `w14` | `http://schemas.microsoft.com/office/word/2010/wordml` | Word 2010 扩展（contentPart 等） |
| `w15` | `http://schemas.microsoft.com/office/word/2012/wordml` | Word 2013 扩展（commentEx 等） |
| `w16cid` | `http://schemas.microsoft.com/office/word/2016/wordml/cid` | 批注 ID（持久 ID） |
| `w16cex` | `http://schemas.microsoft.com/office/word/2018/wordml/cex` | 批注可扩展 |
| `w16se` | `http://schemas.microsoft.com/office/word/2015/wordml/symex` | 符号扩展 |
| `wps` | `http://schemas.microsoft.com/office/word/2010/wordprocessingShape` | WordprocessingML 形状 |
| `wpc` | `http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas` | 绘图画布 |

## 关系类型

| 关系 | 类型 URI |
|-------------|----------|
| 文档 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument` |
| 样式 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles` |
| 编号 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering` |
| 字体表 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable` |
| 设置 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings` |
| 主题 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme` |
| 图片 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/image` |
| 超链接 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink` |
| 页眉 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/header` |
| 页脚 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer` |
| 批注 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments` |
| 扩展批注 | `http://schemas.microsoft.com/office/2011/relationships/commentsExtended` |
| 批注 ID | `http://schemas.microsoft.com/office/2016/09/relationships/commentsIds` |
| 可扩展批注 | `http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible` |
| 脚注 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes` |
| 尾注 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes` |
| 术语表 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/glossaryDocument` |
| Web 设置 | `http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings` |

## 内容类型（`[Content_Types].xml`）

### 默认扩展名

```xml
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
<Default Extension="xml" ContentType="application/xml" />
<Default Extension="png" ContentType="image/png" />
<Default Extension="jpeg" ContentType="image/jpeg" />
<Default Extension="gif" ContentType="image/gif" />
<Default Extension="emf" ContentType="image/x-emf" />
```

### 部件覆盖

| 部件 | 内容类型 |
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
