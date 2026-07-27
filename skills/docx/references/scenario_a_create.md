# 場景 A：從零創建新 DOCX

## 何時使用

以下情況使用場景 A：
- 用戶沒有現有文件，想要一份全新的文檔
- 用戶提供了內容（文本、表格、圖片），希望將其組裝成 DOCX
- 用戶指定了文檔類型（報告、信函、備忘錄、學術論文）或描述了自定義版式

不要使用的情形：用戶已有一個想要修改的 DOCX（→ 場景 B），或想要重新設計現有文檔的樣式（→ 場景 C）。

---

## 分步工作流

### 1. 確定文檔類型

從用戶請求中詢問或推斷文檔類型：

| 類型 | 典型信號 |
|------|----------------|
| 報告（Report） | "報告"、"分析"、"白皮書"、帶標題的章節 |
| 信函（Letter） | "信"、"敬啟者"、地址塊、稱呼 |
| 備忘錄（Memo） | "備忘錄"、To/From/Subject 字段 |
| 學術（Academic） | "論文"、"文章"、"畢業論文"、提及 APA/MLA/Chicago |
| 自定義（Custom） | 以上都不是，或用戶指定了精確格式 |

### 2. 收集內容需求

從用戶處收集：
- 標題和副標題（如有）
- 作者/組織
- 章節結構（標題和嵌套層級）
- 每節的正文內容
- 表格（表頭 + 行）
- 圖片（文件路徑或佔位符）
- 特殊元素：目錄、頁碼、水印、頁眉/頁腳

### 3. 選擇樣式集

根據文檔類型，加載匹配的樣式 XML 資源：
- 報告 → `assets/styles/default_styles.xml` 或 `assets/styles/corporate_styles.xml`
- 學術 → `assets/styles/academic_styles.xml`
- 信函/備忘錄/自定義 → `assets/styles/default_styles.xml`（帶覆蓋）

### 4. 配置頁面設置

根據文檔類型默認值（見下方）或用戶覆蓋設置 `w:sectPr` 值。

```xml
<w:sectPr>
  <w:pgSz w:w="11906" w:h="16838" />  <!-- A4 -->
  <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"
           w:header="720" w:footer="720" w:gutter="0" />
</w:sectPr>
```

### 5. 構建文檔結構

組裝 `word/document.xml`：
1. 以 `w:body` 作為根容器
2. 用標題樣式的段落（`w:p`）作為章節標題
3. 用 `Normal` 樣式的正文段落
4. 按需添加表格、圖片和其他元素
5. 最後的 `w:sectPr` 作為 `w:body` 的最後一個子元素

### 6. 應用排版默認值

在 `styles.xml` 的 `w:docDefaults` 下設置文檔級默認值：
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

### 7. 添加複雜元素

參見下方"複雜元素指南"部分。

### 8. 運行驗證管道

```
dotnet run ... validate --xsd wml-subset.xsd
dotnet run ... validate --xsd business-rules.xsd   # 若應用了模板
```

---

## 文檔類型默認值

### 報告
| 屬性 | 值 |
|----------|-------|
| 正文字體 | Calibri 11pt |
| 標題字體 | Calibri Light |
| H1 / H2 / H3 / H4 字號 | 28pt / 24pt / 18pt / 14pt |
| 標題顏色 | #2F5496（企業藍） |
| 頁邊距 | 四邊各 1 英寸（1440 DXA） |
| 頁面尺寸 | A4（11906 × 16838 DXA） |
| 行距 | 單倍（line="240"） |
| 段距 | 正文段前 0pt，段後 8pt |

### 信函
| 屬性 | 值 |
|----------|-------|
| 字體 | Calibri 11pt |
| 頁面尺寸 | Letter（12240 × 15840 DXA） |
| 頁邊距 | 四邊各 1 英寸 |
| 結構 | 日期 → 地址 → 稱呼 → 正文 → 結尾 → 簽名 |
| 行距 | 單倍 |

### 備忘錄
| 屬性 | 值 |
|----------|-------|
| 字體 | Arial 11pt |
| 頁面尺寸 | Letter |
| 頁邊距 | 0.75 英寸（1080 DXA） |
| 頁眉 | "MEMO" 居中、粗體、16pt |
| 字段 | To、From、Date、Subject（標籤粗體，值用製表符對齊） |

### 學術
| 屬性 | 值 |
|----------|-------|
| 字體 | Times New Roman 12pt |
| 行距 | 雙倍（line="480"） |
| 頁邊距 | 四邊各 1 英寸 |
| 頁面尺寸 | Letter |
| 標題 | 粗體、同字體，H1/H2/H3 為 14/13/12pt |
| 首行縮進 | 0.5 英寸（720 DXA） |
| 標題顏色 | 黑色（無顏色） |

---

## 內容配置 JSON 格式

CLI `create` 命令接受一個 JSON 配置：

```json
{
  "type": "report",
  "title": "季度營收分析",
  "subtitle": "2026 年第一季度",
  "author": "財務團隊",
  "pageSize": "A4",
  "margins": { "top": 1440, "right": 1440, "bottom": 1440, "left": 1440 },
  "sections": [
    {
      "heading": "執行摘要",
      "level": 1,
      "content": [
        { "type": "paragraph", "text": "營收同比增長 12%..." },
        {
          "type": "table",
          "headers": ["地區", "營收", "增長"],
          "rows": [
            ["北美", "$4.2M", "+15%"],
            ["歐洲", "$2.8M", "+8%"],
            ["亞太", "$1.9M", "+18%"]
          ]
        },
        { "type": "image", "path": "charts/revenue.png", "width": "5in", "alt": "營收圖表" }
      ]
    },
    {
      "heading": "詳細分析",
      "level": 1,
      "content": [
        { "type": "paragraph", "text": "按產品線細分..." }
      ]
    }
  ]
}
```

支持的內容類型：
- `paragraph` — 正文文本（應用 Normal 樣式）
- `table` — 表頭 + 行（應用 TableGrid 樣式）
- `image` — 內嵌圖片，可控制寬高
- `list` — 項目符號或編號列表項
- `pageBreak` — 強制分頁

---

## 複雜元素指南

### 目錄

插入一個 TOC 域代碼。Word 在打開文件時會更新實際條目：

```xml
<w:p>
  <w:pPr><w:pStyle w:val="TOCHeading" /></w:pPr>
  <w:r><w:t>目錄</w:t></w:r>
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
    <w:t>[目錄 — 請更新以填充]</w:t>
  </w:r>
  <w:r>
    <w:fldChar w:fldCharType="end" />
  </w:r>
</w:p>
```

### 頁腳中的頁碼

添加一個頁腳部件（`word/footer1.xml`）並在 `w:sectPr` 中引用它：

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

添加一個帶形狀（置於文字之後）的頁眉部件：

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

## 創建後檢查清單

1. **驗證** — 依據 `wml-subset.xsd`：所有元素順序正確，必需屬性存在
2. **合併相鄰 run** — 格式相同的相鄰 run 合併以保持 XML 整潔
3. **驗證關係** — document.xml 中的每個 `r:id` 在 `document.xml.rels` 中都有匹配條目
4. **檢查內容類型** — 包中的每個部件都在 `[Content_Types].xml` 中註冊
5. **預覽** — 在 Word 或 LibreOffice 中打開以視覺確認版式
6. **文件大小** — 確認圖片大小合理（每張超過 2MB 則壓縮）
