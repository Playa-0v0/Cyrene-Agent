# 場景 C：應用格式化/模板

## 何時使用

以下情況使用場景 C：
- 用戶已有文檔，想應用不同的視覺樣式
- 用戶想為文檔換品牌（新字體、顏色、標題樣式）
- 用戶提供了一個模板 DOCX，想將其外觀應用到內容文檔上
- 用戶想在多個文檔間保持一致的格式

不要使用的情形：用戶想編輯內容（→ 場景 B）或從零創建（→ 場景 A）。

---

## 工作流

```
1. 分析源文檔      → CLI：analyze source.docx      （列出樣式、字體、結構）
2. 分析模板        → CLI：analyze template.docx     （列出樣式、字體、結構）
3. 映射樣式        → 創建映射方案（源樣式 → 模板樣式）
4. 應用模板        → CLI：apply-template source.docx --template template.docx --output result.docx
5. 驗證（XSD）     → CLI：validate result.docx --xsd wml-subset.xsd
6. 門控檢查        → CLI：validate result.docx --xsd business-rules.xsd   ← 必須通過
7. Diff 驗證       → CLI：diff source.docx result.docx --text-only   （內容必須完全一致）
```

---

## 從模板複製的內容

| 部件 | 文件 | 說明 |
|------|------|-------------|
| 樣式 | `word/styles.xml` | 所有樣式定義（段落、字符、表格、編號） |
| 主題 | `word/theme/theme1.xml` | 配色方案、字體方案、格式方案 |
| 編號 | `word/numbering.xml` | 列表和編號定義 |
| 頁眉 | `word/header*.xml` | 頁眉內容和格式 |
| 頁腳 | `word/footer*.xml` | 頁腳內容和格式 |
| 節屬性 | `w:sectPr` | 頁邊距、頁面尺寸、方向、分欄 |

## 不復制的內容

| 部件 | 原因 |
|------|--------|
| 文檔內容 | 段落、表格、圖片保留自源文檔 |
| 批註 | 屬於源文檔的審閱歷史 |
| 修訂標記 | 屬於源文檔的修訂歷史 |
| 自定義 XML 部件 | 應用特定數據，非視覺內容 |
| 文檔屬性 | 標題、作者、日期屬於源文檔 |
| 術語表文檔 | 模板的構建塊不轉移 |

---

## 模板結構分析（必需）

在選擇 Overlay 還是 Base-Replace 之前，你必須分析模板的內部結構。這是被跳過時導致失敗的頭號原因。

### 第 1 步：統計模板段落數並識別結構區域

運行 `$CLI analyze --input template.docx` 或手動檢查：

```bash
# 快速結構掃描
scripts/docx_preview.sh template.docx
```

識別模板中的這些區域：
```
區域 A：前置部分（封面、聲明、摘要、目錄）
        → 這些保留自模板，絕不替換
區域 B：示例/佔位符正文內容（"第1章 XXX"、樣例段落）
        → 這部分用用戶的實際內容替換
區域 C：後置部分（附錄、致謝、空白頁）
        → 這些保留自模板或移除
區域 D：末尾 sectPr
        → 始終保留自模板
```

### 第 2 步：找到區域 B 的邊界（替換範圍）

在模板的 document.xml 中搜索標記示例內容起止的錨點文本：

**起始錨點模式**（示例正文的第一段）：
- "第1章"、"第一章"、"Chapter 1"、"1 Introduction"、"緒論"
- 目錄之後第一個帶 Heading1 等效樣式的段落

**結束錨點模式**（後置部分前的最後一段）：
- "參考文獻"、"References"、"致謝"、"Acknowledgments"
- 附錄或末尾 sectPr 之前的最後一段

```python
# 查找替換範圍的偽代碼
for i, element in enumerate(template_body_elements):
    text = get_text(element)
    style = get_style(element)
    if style in heading1_styles and ("第1章" in text or "Chapter 1" in text):
        replace_start = i
    if "參考文獻" in text or "References" in text:
        replace_end = i
        break
```

**關鍵**：通過打印範圍內的內容來驗證：
```
模板元素 [0..replace_start-1]：前置部分（保留）
模板元素 [replace_start..replace_end]：示例內容（替換）
模板元素 [replace_end+1..end]：後置部分（保留）
```

如果找不到 replace_start 或 replace_end，不要繼續。請用戶識別替換邊界。

### 第 3 步：決定 Overlay 還是 Base-Replace

既然你已經瞭解了結構：

| 觀察 | 決策 |
|-------------|----------|
| 模板 ≤30 段，無封面/目錄 | **C-1：Overlay**（純樣式模板） |
| 模板 >100 段，含封面/目錄/示例章節 | **C-2：Base-Replace** |
| 模板段落數 ≈ 用戶文檔 | **C-1：Overlay**（結構相似） |
| 模板段落數 >> 用戶文檔（如 263 vs 134） | **C-2：Base-Replace** |

### 第 4 步：對於 Base-Replace，執行替換

1. 以模板為基載入（所有文件）
2. 用 `list(body)` 提取用戶內容元素 — **不要**用 `findall('w:p')`（會漏掉表格）
3. 構建新正文：`template[0:replace_start] + cleaned_user_content + template[replace_end+1:]`
4. 對每個段落應用樣式映射
5. 清理直接格式（見下方規則）
6. 重建 document.xml，保留模板的命名空間聲明
7. 合併關係（圖片 + 超鏈接）
8. 以模板為 ZIP 基礎寫出輸出

---

## 樣式映射策略

當模板樣式名與源樣式名不同時，需要映射。**此步驟是必需的** — 跳過它是模板應用中格式失敗的頭號原因。

### 第 0 步：從兩份文檔提取 StyleId（必需）

任何模板應用之前，從兩份文檔提取並比較 styleId：

```bash
# 從源文檔提取所有 styleId
$CLI analyze --input source.docx --styles-only
# 輸出示例：
#   Heading1  (paragraph, basedOn: Normal)
#   Heading2  (paragraph, basedOn: Normal)
#   Normal    (paragraph)
#   ListBullet (paragraph, basedOn: Normal)

# 從模板提取所有 styleId
$CLI analyze --input template.docx --styles-only
# 輸出示例：
#   1         (paragraph, basedOn: a, name: "heading 1")
#   2         (paragraph, basedOn: a, name: "heading 2")
#   3         (paragraph, basedOn: a, name: "heading 3")
#   a         (paragraph, name: "Normal")
#   a0        (character, name: "Default Paragraph Font")
```

**關鍵區別**：`w:styleId` vs `w:name`：
```xml
<!-- styleId="1" 但 name="heading 1" -->
<w:style w:type="paragraph" w:styleId="1">
  <w:name w:val="heading 1"/>
  <w:basedOn w:val="a"/>
</w:style>
```

`w:styleId` 屬性是 `<w:pStyle w:val="..."/>` 引用的對象。`w:name` 屬性是人類可讀的顯示名。**它們可能完全不同。** 許多 CJK 模板使用數字 styleId（`1`、`2`、`3`、`a`、`a0`）而非英文名。

### 第 1 層：精確 StyleId 匹配
如果源用 `Heading1` 且模板將 `Heading1` 定義為 styleId，直接映射。無需操作。

### 第 2 層：基於名稱的匹配
若無精確 styleId 匹配，嘗試按 `w:name` 屬性匹配：
- 源 `Heading1`（name="heading 1"）→ 模板 styleId `1`（name="heading 1"）
- 匹配對 name 值不區分大小寫

在同一類型內，還可嘗試按以下匹配：
- 內置樣式 ID（Word 內部 ID，如 heading 1 = 內置 ID 1）
- 樣式類型（段落 → 段落，字符 → 字符，表格 → 表格）

### 第 3 層：手動映射
對於重命名或自定義樣式，提供顯式映射：

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

### 常見非標準 StyleId 模式

| 模板來源 | StyleId 模式 | 示例 |
|----------------|-----------------|---------|
| 中文 Word（默認） | 數字/字母 | `1`、`2`、`3`、`a`、`a0` |
| 英文 Word（默認） | 英文名 | `Heading1`、`Normal`、`Title` |
| Google Docs 導出 | 帶前綴 | `Subtitle`、`NormalWeb` |
| WPS Office | 混合 | `1`、`Heading1`、自定義名 |
| 學術模板 | 自定義 | `ThesisHeading1`、`ThesisBody` |

### 構建映射表

遵循此算法：

1. **列出 document.xml 中實際使用的 styleId**（不是 styles.xml 中定義的全部）：
   ```python
   # 偽代碼：查找源 document.xml 中所有唯一的 pStyle 值
   used_styles = set()
   for p in body.iter('w:p'):
       pStyle = p.find('w:pPr/w:pStyle')
       if pStyle is not None:
           used_styles.add(pStyle.get('val'))
   ```

2. **對每個使用的樣式**，在模板中找最佳匹配：
   - 第一嘗試：精確 styleId 匹配
   - 第二嘗試：按 `w:name` 值匹配（不區分大小寫）
   - 第三嘗試：按樣式用途匹配（任何標題 → 模板的標題樣式）
   - 回退：映射到模板的默認段落樣式（通常是 `Normal` 或 `a`）

3. **驗證映射** — 每個源 styleId 必須映射到模板中已存在的 styleId：
   ```
   ✓ Heading1 → 1（名稱匹配："heading 1"）
   ✓ Heading2 → 2（名稱匹配："heading 2"）
   ✓ Normal   → a（名稱匹配："Normal"）
   ✗ CustomCallout → ???（未找到匹配，將回退到 'a'）
   ```

4. **複製內容時應用映射** — 更新每個 `<w:pStyle w:val="..."/>`：
   ```xml
   <!-- 源 -->
   <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
   <!-- 映射後 -->
   <w:pPr><w:pStyle w:val="1"/></w:pPr>
   ```

### 未映射的樣式
源文檔中在模板裡無匹配的樣式會記錄為警告：
```
WARNING: Style 'CustomCallout' has no mapping in template. Content will fall back to 'a' (Normal).
```

內容會保留；只有樣式引用更新為模板的默認段落樣式。

### C-2 BASE-REPLACE：額外的 StyleId 注意事項

以模板為基文檔（C-2 策略）時，模板的 `styles.xml` 已就位。你必須：

1. **絕不復制源 `styles.xml`** — 模板的樣式是權威
2. **映射每個內容段落的 pStyle** 到模板的 styleId 後再插入
3. **選擇性地剝離直接格式**（見下方詳細規則）— 讓模板樣式控制外觀
4. **驗證表格樣式** — 若源表格用 `TableGrid` 但模板定義為 `a3` 之類，也要重映射 `<w:tblStyle>`
5. **檢查字符樣式** — run 內的 `rPr` 可能引用字符樣式如 `Hyperlink` 或 `Strong`，它們在模板中有不同 ID

### 直接格式清理規則（詳細）

從源複製內容到模板時，對每個段落和 run 應用這些規則：

**從 `<w:rPr>` 移除：**
- `<w:rFonts w:ascii="..." w:hAnsi="..."/>` — 西文字體覆蓋（例外：保留 `w:eastAsia`）
- `<w:sz>`、`<w:szCs>` — 字號（讓樣式控制）
- `<w:color>` — 文本顏色
- `<w:highlight>` — 突出顯示色
- `<w:shd>` — 底紋
- `<w:b>`、`<w:i>` — 粗體/斜體，除非源樣式要求（如強調）
- `<w:u>` — 下劃線
- `<w:spacing>` — 字符間距

**在 `<w:rPr>` 中保留：**
- `<w:rFonts w:eastAsia="宋體"/>` — CJK 字體聲明（必須保留，否則中文渲染錯誤）
- `<w:rFonts w:eastAsia="華文中宋"/>` — 同上
- `<w:drawing>` 內的任何內容 — 圖片引用（通過 rId 重映射單獨處理）

**從 `<w:pPr>` 移除：**
- `<w:pBdr>` — 段落邊框
- `<w:shd>` — 段落底紋
- `<w:spacing>` — 行距/段距（讓樣式控制）
- `<w:jc>` — 對齊（讓樣式控制）
- `<w:tabs>` — 自定義製表位
- `<w:rPr>`（pPr 內的）— 段落的默認 run 格式

**在 `<w:pPr>` 中保留：**
- `<w:pStyle>` — 樣式引用（映射到模板的 styleId 之後）
- `<w:sectPr>` — 節屬性（若有意插入分節符）
- `<w:numPr>` — 編號引用（將 numId 映射到模板的編號之後）

**表格單元格（`<w:tc>`）：**
對每個單元格內的每個段落應用同樣的 rPr/pPr 清理。此外：
- 保留 `<w:tcPr>` 結構屬性（跨列、跨行、寬度）
- 移除 `<w:tcPr><w:shd>`（單元格底紋 — 讓表格樣式控制）

---

## 關係 ID 重映射

從模板複製部件（頁眉、頁腳、圖片）到源包時，關係 ID（`r:id`）可能衝突。

**問題**：
- 源有 `rId7` → `image1.png`
- 模板有 `rId7` → `header1.xml`
- 複製模板的 `rId7` 會覆蓋源的圖片引用

**解決方案**：
1. 掃描源的 `document.xml.rels` 中所有現有 `rId` 值
2. 找到最大數字 ID（如 `rId12`）
3. 從 `rId13` 起重映射所有模板關係 ID
4. 更新所複製部件中的所有引用以使用新 ID

```xml
<!-- 模板原始 -->
<Relationship Id="rId1" Type="...header" Target="header1.xml" />

<!-- 重映射到源包後 -->
<Relationship Id="rId13" Type="...header" Target="header1.xml" />

<!-- 更新 sectPr 引用 -->
<w:headerReference w:type="default" r:id="rId13" />
```

### 超鏈接關係合併

源文檔包含外部超鏈接（如參考文獻或腳註中的 URL）時，它們作為關係存儲在 `word/_rels/document.xml.rels` 中：

```xml
<Relationship Id="rId15" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
              Target="https://example.com/paper" TargetMode="External"/>
```

document.xml 中對應的文本引用此 rId：
```xml
<w:hyperlink r:id="rId15">
  <w:r><w:t>https://example.com/paper</w:t></w:r>
</w:hyperlink>
```

**合併步驟：**
1. 掃描源 document.xml 中所有 `<w:hyperlink r:id="...">` 元素
2. 對每個，在源的 rels 文件中找對應關係
3. 檢查模板是否已有相同 Target URL 的關係
   - 是：複用現有 rId，更新超鏈接引用
   - 否：分配新 rId（從模板的最大 rId + 1 起），將關係添加到模板的 rels，更新超鏈接引用
4. 同時檢查腳註（`word/_rels/footnotes.xml.rels`）和尾註中使用的超鏈接關係

**常見錯誤：** 複製超鏈接段落但未合併 rels → 超鏈接靜默失效（在 Word 中點擊無反應）。

---

## XSD 門控檢查

### 是什麼

模板應用後，輸出文檔**必須**通過 `business-rules.xsd` 驗證。這是**硬門控** — 若失敗，文檔**不可交付**。

### business-rules.xsd 檢查內容

| 規則 | 驗證內容 |
|------|-------------------|
| 模板樣式存在 | 內容段落引用的所有樣式都在 `styles.xml` 中定義 |
| 頁邊距匹配 | 頁邊距匹配模板規範 |
| 字體正確 | `w:docDefaults` 字體匹配模板的字體方案 |
| 標題層級 | 標題級別連續（無 H1 → H3 而無 H2） |
| 必需樣式存在 | `Normal`、`Heading1`-`Heading3`、`TableGrid` 存在 |
| 頁面尺寸 | 匹配模板聲明的頁面尺寸 |

### 處理失敗

```
GATE-CHECK FAILED:
  - Style 'CustomStyle1' referenced in paragraph 14 but not defined in styles.xml
  - Margin w:left=1080 does not match template requirement 1440
```

修復每個失敗：
1. **缺失樣式**：將樣式定義添加到 `styles.xml`，或將段落重映射到已存在樣式
2. **頁邊距不匹配**：更新 `w:sectPr` 頁邊距以匹配模板
3. **字體不匹配**：更新 `w:docDefaults` 以匹配模板字體方案
4. **標題層級跳級**：插入中間標題級別或調整現有級別

每次修復後重新驗證，直到門控檢查通過。

---

## 常見陷阱

### 1. 孤立的編號引用

**問題**：源文檔在列表段落中用 `w:numId="5"`，但用模板版本替換 `numbering.xml` 後，編號 ID 5 不存在。

**症狀**：列表顯示為普通段落（無項目符號/編號）。

**修復**：
- 將源編號 ID 映射到模板編號 ID
- 更新文檔內容中所有 `w:numId` 引用
- 或將源編號定義合併到模板的 `numbering.xml` 中

### 2. 缺失主題顏色

**問題**：源文檔樣式引用主題顏色（`w:themeColor="accent1"`），但模板主題中這些顏色值不同。

**症狀**：顏色意外改變（通常可接受 — 這正是重新主題化的目的）。但若樣式同時使用 `w:val` 和 `w:themeColor`，Word 中主題顏色優先。

**修復**：審查顏色變化。若必須保留特定顏色，使用不帶 `w:themeColor` 的顯式 `w:val`。

### 3. 節屬性衝突

**問題**：源文檔有多個節（如縱向 + 橫向頁），但模板假設單一節。

**症狀**：所有節獲得相同的頁邊距/方向，破壞橫向頁。

**修復**：
- 只對 `w:body` 中最後的 `w:sectPr` 應用模板節屬性
- 保留源中中間的 `w:sectPr` 元素（在 `w:pPr` 內）
- 或對所有節應用模板屬性但保留方向覆蓋

### 4. 嵌入字體衝突

**問題**：模板指定的字體在目標系統上不可用。

**修復**：在 DOCX 中嵌入字體（`word/fonts/`），或使用 Web 安全替代：
- Calibri → Windows/Mac/Office Online 可用
- Arial → 通用回退
- Times New Roman → 通用襯線回退

### 5. 破壞的樣式繼承

**問題**：模板的 `Heading1` 基於 `Normal`，但應用模板後 `Normal` 屬性不同，級聯導致標題出現不想要的變化。

**修復**：驗證所有關鍵樣式的 `w:basedOn` 鏈。確保基礎樣式也正確地從模板轉移。

---

## 驗證清單

模板應用後，驗證：

1. **內容保留** — 文本 diff 顯示零內容變化
2. **門控檢查通過** — `business-rules.xsd` 驗證成功
3. **樣式已應用** — 標題、正文、表格使用模板格式
4. **圖片完整** — 所有圖片正確渲染（關係 ID 有效）
5. **列表正常** — 編號和項目符號列表正確顯示
6. **頁眉/頁腳** — 模板頁眉/頁腳出現在所有頁
7. **頁面佈局** — 頁邊距、頁面尺寸、方向匹配模板
8. **無損壞** — 文件在 Word 中無錯誤打開
