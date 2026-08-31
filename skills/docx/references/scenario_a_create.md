# 场景 A：从零创建新 DOCX

## 何时使用

以下情况使用场景 A：
- 用户没有现有文件，想要一份全新的文档
- 用户提供了内容（文本、表格、图片），希望将其组装成 DOCX
- 用户指定了文档类型（报告、信函、备忘录、学术论文）或描述了自定义版式

不要使用的情形：用户已有一个想要修改的 DOCX（→ 场景 B），或想要重新设计现有文档的样式（→ 场景 C）。

---

## 分步工作流

### 1. 确定文档类型

从用户请求中询问或推断文档类型：

| 类型 | 典型信号 |
|------|----------------|
| 报告（Report） | "报告"、"分析"、"白皮书"、带标题的章节 |
| 信函（Letter） | "信"、"敬启者"、地址块、称呼 |
| 备忘录（Memo） | "备忘录"、To/From/Subject 字段 |
| 学术（Academic） | "论文"、"文章"、"毕业论文"、提及 APA/MLA/Chicago |
| 自定义（Custom） | 以上都不是，或用户指定了精确格式 |

### 2. 收集内容需求

从用户处收集：
- 标题和副标题（如有）
- 作者/组织
- 章节结构（标题和嵌套层级）
- 每节的正文内容
- 表格（表头 + 行）
- 图片（文件路径或占位符）
- 特殊元素：目录、页码、水印、页眉/页脚

### 3. 选择样式集

根据文档类型，加载匹配的样式 XML 资源：
- 报告 → `assets/styles/default_styles.xml` 或 `assets/styles/corporate_styles.xml`
- 学术 → `assets/styles/academic_styles.xml`
- 信函/备忘录/自定义 → `assets/styles/default_styles.xml`（带覆盖）

### 4. 配置页面设置

根据文档类型默认值（见下方）或用户覆盖设置 `w:sectPr` 值。

```xml
<w:sectPr>
  <w:pgSz w:w="11906" w:h="16838" />  <!-- A4 -->
  <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"
           w:header="720" w:footer="720" w:gutter="0" />
</w:sectPr>
```

### 5. 构建文档结构

组装 `word/document.xml`：
1. 以 `w:body` 作为根容器
2. 用标题样式的段落（`w:p`）作为章节标题
3. 用 `Normal` 样式的正文段落
4. 按需添加表格、图片和其他元素
5. 最后的 `w:sectPr` 作为 `w:body` 的最后一个子元素

### 6. 应用排版默认值

在 `styles.xml` 的 `w:docDefaults` 下设置文档级默认值：
```xml
<w:docDefaults>
  <w:rPrDefault>
    <w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimSun" w:cs="Arial" />
      <w:sz w:val="22" />  <!-- 11pt -->
      <w:szCs w:val="22" />
    </w:rPr>
  </w:rPrDefault>
  <w:pPrDefault>
    <w:pPr>
      <w:spacing w:after="160" w:line="259" w:lineRule="auto" />
    </w:pPr>
  </w:pPrDefault>
</w:docDefaults>
```

### 7. 添加复杂元素

参见下方"复杂元素指南"部分。

### 8. 运行验证管道

```
dotnet run ... validate --xsd wml-subset.xsd
dotnet run ... validate --xsd business-rules.xsd   # 若应用了模板
```

---

## 文档类型默认值

### 报告
| 属性 | 值 |
|----------|-------|
| 正文字体 | Calibri 11pt |
| 标题字体 | Calibri Light |
| H1 / H2 / H3 / H4 字号 | 28pt / 24pt / 18pt / 14pt |
| 标题颜色 | #2F5496（企业蓝） |
| 页边距 | 四边各 1 英寸（1440 DXA） |
| 页面尺寸 | A4（11906 × 16838 DXA） |
| 行距 | 单倍（line="240"） |
| 段距 | 正文段前 0pt，段后 8pt |

### 信函
| 属性 | 值 |
|----------|-------|
| 字体 | Calibri 11pt |
| 页面尺寸 | Letter（12240 × 15840 DXA） |
| 页边距 | 四边各 1 英寸 |
| 结构 | 日期 → 地址 → 称呼 → 正文 → 结尾 → 签名 |
| 行距 | 单倍 |

### 备忘录
| 属性 | 值 |
|----------|-------|
| 字体 | Arial 11pt |
| 页面尺寸 | Letter |
| 页边距 | 0.75 英寸（1080 DXA） |
| 页眉 | "MEMO" 居中、粗体、16pt |
| 字段 | To、From、Date、Subject（标签粗体，值用制表符对齐） |

### 学术
| 属性 | 值 |
|----------|-------|
| 字体 | Times New Roman 12pt |
| 行距 | 双倍（line="480"） |
| 页边距 | 四边各 1 英寸 |
| 页面尺寸 | Letter |
| 标题 | 粗体、同字体，H1/H2/H3 为 14/13/12pt |
| 首行缩进 | 0.5 英寸（720 DXA） |
| 标题颜色 | 黑色（无颜色） |

---

## 内容配置 JSON 格式

CLI `create` 命令接受一个 JSON 配置：

```json
{
  "type": "report",
  "title": "季度营收分析",
  "subtitle": "2026 年第一季度",
  "author": "财务团队",
  "pageSize": "A4",
  "margins": { "top": 1440, "right": 1440, "bottom": 1440, "left": 1440 },
  "sections": [
    {
      "heading": "执行摘要",
      "level": 1,
      "content": [
        { "type": "paragraph", "text": "营收同比增长 12%..." },
        {
          "type": "table",
          "headers": ["地区", "营收", "增长"],
          "rows": [
            ["北美", "$4.2M", "+15%"],
            ["欧洲", "$2.8M", "+8%"],
            ["亚太", "$1.9M", "+18%"]
          ]
        },
        { "type": "image", "path": "charts/revenue.png", "width": "5in", "alt": "营收图表" }
      ]
    },
    {
      "heading": "详细分析",
      "level": 1,
      "content": [
        { "type": "paragraph", "text": "按产品线细分..." }
      ]
    }
  ]
}
```

支持的内容类型：
- `paragraph` — 正文文本（应用 Normal 样式）
- `table` — 表头 + 行（应用 TableGrid 样式）
- `image` — 内嵌图片，可控制宽高
- `list` — 项目符号或编号列表项
- `pageBreak` — 强制分页

---

## 复杂元素指南

### 目录

插入一个 TOC 域代码。Word 在打开文件时会更新实际条目：

```xml
<w:p>
  <w:pPr><w:pStyle w:val="TOCHeading" /></w:pPr>
  <w:r><w:t>目录</w:t></w:r>
</w:p>
<w:p>
  <w:r>
    <w:fldChar w:fldCharType="begin" />
  </w:r>
  <w:r>
    <w:instrText xml:space="preserve"> TOC \o "1-3" \h \z \u </w:instrText>
  </w:r>
  <w:r>
    <w:fldChar w:fldCharType="separate" />
  </w:r>
  <w:r>
    <w:t>[目录 — 请更新以填充]</w:t>
  </w:r>
  <w:r>
    <w:fldChar w:fldCharType="end" />
  </w:r>
</w:p>
```

### 页脚中的页码

添加一个页脚部件（`word/footer1.xml`）并在 `w:sectPr` 中引用它：

```xml
<!-- 在 footer1.xml 中 -->
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p>
    <w:pPr><w:jc w:val="center" /></w:pPr>
    <w:r>
      <w:fldChar w:fldCharType="begin" />
    </w:r>
    <w:r>
      <w:instrText>PAGE</w:instrText>
    </w:r>
    <w:r>
      <w:fldChar w:fldCharType="separate" />
    </w:r>
    <w:r><w:t>1</w:t></w:r>
    <w:r>
      <w:fldChar w:fldCharType="end" />
    </w:r>
  </w:p>
</w:ftr>

<!-- 在 sectPr 中 -->
<w:footerReference w:type="default" r:id="rId8" />
```

### 水印

添加一个带形状（置于文字之后）的页眉部件：

```xml
<w:hdr>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape style="position:absolute;margin-left:0;margin-top:0;width:468pt;height:180pt;
                        z-index:-251657216;mso-position-horizontal:center;
                        mso-position-vertical:center"
                 fillcolor="silver" stroked="f">
          <v:textpath style="font-family:'Calibri';font-size:1pt" string="DRAFT" />
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>
```

---

## 创建后检查清单

1. **验证** — 依据 `wml-subset.xsd`：所有元素顺序正确，必需属性存在
2. **合并相邻 run** — 格式相同的相邻 run 合并以保持 XML 整洁
3. **验证关系** — document.xml 中的每个 `r:id` 在 `document.xml.rels` 中都有匹配条目
4. **检查内容类型** — 包中的每个部件都在 `[Content_Types].xml` 中注册
5. **预览** — 在 Word 或 LibreOffice 中打开以视觉确认版式
6. **文件大小** — 确认图片大小合理（每张超过 2MB 则压缩）
