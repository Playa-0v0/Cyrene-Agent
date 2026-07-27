# 故障排除指南 — 按症狀驅動

## 如何使用本指南

按你觀察到的**症狀**搜索，而非技術概念。每個條目遵循：
- **症狀** — 你看到或用戶報告的內容
- **診斷** — 如何確認根本原因
- **修復** — 確切的步驟、命令或代碼
- **預防** — 下次如何避免

**快速搜索關鍵詞：** 標題錯誤、正文、修復、損壞、字體、表格缺失、圖片缺失、目錄損壞、更新目錄、分頁、分節符、超鏈接、編號列表、項目符號、頁邊距、頁面尺寸、中文方塊、封面、修訂追蹤、修訂標記

---

## 1. "所有標題看起來像正文"（標題樣式未應用）

**症狀：** 模板應用後，標題沒有格式 — 看起來像 Normal 段落。字號、粗體、間距全錯。

**診斷：** `document.xml` 中的 `pStyle` 值與 `styles.xml` 中的 `styleId` 值不匹配。

常見不匹配：
- 源用 `Heading1` 但模板將該樣式定義為 `1`（中文模板常用數字 styleId）
- 源用 `heading1`（小寫）但模板是 `Heading1`（區分大小寫！）
- `pStyle` 引用的樣式在輸出的 `styles.xml` 中根本不存在

檢查：
```bash
# 列出文檔中使用的所有 pStyle 值
$CLI analyze --input output.docx | grep -i "pStyle"

# 列出 styles.xml 中定義的所有 styleId
$CLI analyze --input template.docx --part styles | grep "styleId"
```

**修復：** 應用模板前構建 styleId 映射表。更新文檔內容中每個 `pStyle` 值。

```csharp
// 構建映射：源 styleId → 模板 styleId
var mapping = new Dictionary<string, string>();
// 按樣式名（w:name）比較，而非 styleId
foreach (var srcStyle in sourceStyles)
{
    var templateStyle = templateStyles.FirstOrDefault(
        s => s.StyleName?.Val?.Value == srcStyle.StyleName?.Val?.Value);
    if (templateStyle != null)
        mapping[srcStyle.StyleId!] = templateStyle.StyleId!;
}

// 對所有段落應用映射
foreach (var para in body.Descendants<Paragraph>())
{
    var pStyle = para.ParagraphProperties?.ParagraphStyleId;
    if (pStyle != null && mapping.TryGetValue(pStyle.Val!, out var newId))
        pStyle.Val = newId;
}
```

**預防：** 模板應用前，始終從源和模板提取並比較 styleId。絕不假設文檔間 styleId 相同。

---

## 2. "文檔打開時出現修復警告"（XML 損壞）

**症狀：** 打開時 Word 提示"我們發現某些內容有問題"或"Word 發現不可讀的內容"。

**診斷：** 元素順序錯誤。OpenXML 對子元素順序要求嚴格。

常見違規：
- `w:p` 中 `pPr` 必須在 run 之前
- `w:tbl` 中 `tblPr` 必須在 `tblGrid` 之前
- `w:r` 中 `rPr` 必須在 `t`/`br`/`tab` 之前
- `w:tr` 中 `trPr` 必須在 `tc` 之前
- `w:tc` 中 `tcPr` 必須在內容之前

```bash
# 驗證以查找順序問題
$CLI validate --input doc.docx --xsd assets/xsd/wml-subset.xsd

# 自動修復元素順序
$CLI fix-order --input doc.docx

# 重新驗證
$CLI validate --input doc.docx --xsd assets/xsd/wml-subset.xsd
```

**修復：**
```bash
$CLI fix-order --input doc.docx
```

若自動修復未解決，解包並手動檢查：
```bash
$CLI unpack --input doc.docx --output unpacked/
# 檢查 word/document.xml 的順序問題
# 修復後重新打包：
$CLI pack --input unpacked/ --output fixed.docx
```

**預防：** 編寫任何 XML 操作代碼前閱讀 `references/openxml_element_order.md`。始終先追加屬性元素，再追加內容元素。

---

## 3. "所有文本字體錯誤"（字體汙染）

**症狀：** 模板指定 宋體/Times New Roman，但文檔顯示 Google Sans、Arial、Calibri 或源文檔使用的任何字體。

**診斷：** 源文檔的 `rPr` 包含內聯 `rFonts` 聲明，覆蓋了模板樣式。在 OpenXML 中，直接格式始終優先於基於樣式的格式。

```bash
# 檢查字體汙染
$CLI analyze --input output.docx | grep -i "font"
# 查找內容中的 rFonts — 若存在，它們正在覆蓋樣式
```

**修復：** 複製內容時從 `rPr` 剝離 `rFonts`，但對 CJK 文本保留 `w:eastAsia`：

```csharp
foreach (var rPr in body.Descendants<RunProperties>())
{
    var rFonts = rPr.GetFirstChild<RunFonts>();
    if (rFonts != null)
    {
        // 保留 EastAsia 字體用於 CJK — 移除它會導致方塊（□□□）
        var eastAsia = rFonts.EastAsia?.Value;
        rFonts.Remove();

        // 若已設置且文本含 CJK，則僅重新添加 eastAsia
        if (!string.IsNullOrEmpty(eastAsia))
        {
            rPr.Append(new RunFonts { EastAsia = eastAsia });
        }
    }
}
```

同時剝離這些常見直接格式覆蓋：
- `w:sz` / `w:szCs`（字號）
- `w:color`（文本顏色）
- `w:b` / `w:i`（當它們與樣式矛盾時）

**預防：** 在文檔間複製內容時始終清理直接格式。只保留 `pStyle`/`rStyle` 引用和 `w:t` 文本。

---

## 4. "表格缺失"（複製時表格丟失）

**症狀：** 源有 5 個表格但輸出只有 2 個（或 0 個）。

**診斷：** 代碼用了 `body.findall('w:p')` 或頂層用 `body.Descendants<Paragraph>()`，而非遍歷所有子元素。這會跳過 `w:tbl` 元素。

```bash
# 驗證表格數量
$CLI analyze --input source.docx | grep -i "table"
$CLI analyze --input output.docx | grep -i "table"
```

**修復：** 用 `list(body)` 或 `body.ChildElements` 獲取所有頂層子元素（包括表格）：

```csharp
// 錯誤 — 跳過表格、節屬性和其他非段落元素
var paragraphs = body.Elements<Paragraph>();

// 正確 — 獲取所有內容：段落、表格、SDT 塊等
var allElements = body.ChildElements.ToList();
```

Python lxml 中：
```python
# 錯誤
elements = body.findall('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p')

# 正確
elements = list(body)  # 所有直接子元素
```

**預防：** 複製內容時始終用 `list(body)` 或 `body.ChildElements` 迭代，絕不單獨按單一元素類型過濾。

---

## 5. "圖片缺失或顯示破損圖標"

**症狀：** 出現圖片佔位符但圖片不渲染。或圖片完全缺失。

**診斷：** `w:drawing` 中的 `r:embed` rId 與 `document.xml.rels` 中任何關係都不匹配，或媒體文件未被複制到輸出 ZIP。

```bash
# 檢查關係
$CLI analyze --input output.docx --part rels | grep -i "image"

# 檢查媒體文件是否存在
$CLI unpack --input output.docx --output unpacked/
ls unpacked/word/media/
```

**修復：**
1. 檢查源 rels 中的圖片文件路徑
2. 從源複製媒體文件到輸出
3. 在輸出 rels 中添加/更新關係
4. 更新 drawing 元素中的 `r:embed` 值

```csharp
// 在文檔間複製帶圖片的內容時：
foreach (var drawing in body.Descendants<Drawing>())
{
    var blip = drawing.Descendants<DocumentFormat.OpenXml.Drawing.Blip>().FirstOrDefault();
    if (blip?.Embed?.Value != null)
    {
        var sourceRel = sourcePart.GetReferenceRelationship(blip.Embed.Value);
        // 將圖片部件複製到目標文檔
        var imagePart = targetPart.AddImagePart(ImagePartType.Png);
        using var stream = sourcePart.GetPartById(blip.Embed.Value).GetStream();
        imagePart.FeedData(stream);
        // 更新 rId 引用
        blip.Embed = targetPart.GetIdOfPart(imagePart);
    }
}
```

**預防：** 在文檔間移動內容時始終做 rId 重映射 + 媒體文件複製。絕不假設 rId 可跨文檔使用。

---

## 6. "目錄顯示陳舊/錯誤條目"或"更新目錄無效"

**症狀：** 目錄顯示模板的示例條目（如"第1章 緒論...1"）而非實際標題。或在 Word 中點擊"更新目錄"無反應。

**診斷：**
- **陳舊條目（正常）：** 目錄條目是緩存在域內的靜態文本。它們不會自動更新，除非用戶在 Word 中顯式更新。
- **更新目錄失敗：** SDT 包裝器或域代碼結構損壞。真實模板中的目錄是混合結構：SDT 塊 + 域代碼 + 靜態條目。

```bash
# 檢查目錄 SDT 是否存在
$CLI analyze --input output.docx | grep -i "sdt\|toc"
```

**修復：**
- **若條目僅是陳舊：** 這是預期行為。用戶須在 Word 中右鍵目錄，然後"更新域"。或啟用自動更新：
  ```csharp
  // 見 FieldAndTocSamples.EnableUpdateFieldsOnOpen()
  FieldAndTocSamples.EnableUpdateFieldsOnOpen(settingsPart);
  ```
- **若 SDT 損壞：** 保留模板的整個 SDT 塊完整。不要修改它。
- **若域代碼缺失：** 確保目錄包含：`fldChar begin` + `instrText` + `fldChar separate` + 靜態條目 + `fldChar end`。完整模式見 `FieldAndTocSamples.CreateMixedTocStructure()`。
- **若你從零重建了目錄（常見錯誤）：** 你很可能破壞了 SDT 包裝器。改用模板的原始 SDT 塊。真實目錄的結構見 `Samples/FieldAndTocSamples.cs` 的 `CreateMixedTocStructure` 方法。

**預防：** 做 Base-Replace（C-2）時，保持模板的目錄區域完全不動。不要剝離、重建或修改 SDT 塊。用戶在 Word 中打開時目錄會自動更新。

---

## 7. "章節未從新頁開始"（缺少分節符）

**症狀：** 章節之間內容連續流動，無分頁。第 2 章緊跟第 1 章最後一段在同一頁開始。

**診斷：** 章節之間無 `sectPr` 元素或分頁段落。

**修復：** 在每個章節標題前插入 `pPr` 中含 `sectPr` 的段落，或插入分頁符：

```csharp
// 選項 1：分節符（保留每節設置如頁眉/頁邊距）
var breakPara = new Paragraph(
    new ParagraphProperties(
        new SectionProperties(
            new SectionType { Val = SectionMarkValues.NextPage })));

// 選項 2：簡單分頁符（更輕量）
var breakPara = new Paragraph(
    new Run(new Break { Type = BreakValues.Page }));

// 在每個 Heading1 前插入
body.InsertBefore(breakPara, heading1Paragraph);
```

**預防：** 複製內容時，按需在 Heading1 段落前插入分頁/分節符。複製前檢查源文檔的節結構。

---

## 8. "超鏈接無效"（鏈接斷裂）

**症狀：** 在輸出文檔中點擊超鏈接無反應，或導航到錯誤 URL。

**診斷：** `w:hyperlink r:id` 指向 `document.xml.rels` 中不存在的關係。

```bash
# 檢查超鏈接關係
$CLI analyze --input output.docx --part rels | grep -i "hyperlink"
```

**修復：** 將源文檔的超鏈接關係合併到輸出的 rels 文件。更新 rId 引用。

```csharp
foreach (var hyperlink in body.Descendants<Hyperlink>())
{
    if (hyperlink.Id?.Value != null)
    {
        var sourceRel = sourcePart.HyperlinkRelationships
            .FirstOrDefault(r => r.Id == hyperlink.Id.Value);
        if (sourceRel != null)
        {
            targetPart.AddHyperlinkRelationship(sourceRel.Uri, sourceRel.IsExternal);
            var newRel = targetPart.HyperlinkRelationships.Last();
            hyperlink.Id = newRel.Id;
        }
    }
}
```

**預防：** 合併文檔時始終合併所有關係類型（圖片、超鏈接、頁眉、頁腳）。絕不假設源 rId 在目標中可用。

---

## 9. "編號列表顯示錯誤編號"或"項目符號消失"

**症狀：** 原本編號為 1、2、3 的列表現在顯示 1、1、1，或完全沒有編號/項目符號。

**診斷：** `pPr` 中的 `numId` 引用了 `numbering.xml` 中不存在的編號定義，或 `abstractNumId` 映射斷裂。

```bash
# 檢查編號定義
$CLI analyze --input output.docx --part numbering
```

**修復：** 將源 numId 映射到模板 numId，或合併編號定義：

```csharp
// 1. 從源複製 abstractNum 定義到目標 numbering.xml
// 2. 創建指向所複製 abstractNum 的新 num 條目
// 3. 更新文檔內容中所有 numId 引用

var sourceNumbering = sourceNumberingPart.Numbering;
var targetNumbering = targetNumberingPart.Numbering;

// 獲取最大現有 ID 以避免衝突
int maxAbstractNumId = targetNumbering.Elements<AbstractNum>()
    .Max(a => a.AbstractNumberId?.Value ?? 0) + 1;
int maxNumId = targetNumbering.Elements<NumberingInstance>()
    .Max(n => n.NumberID?.Value ?? 0) + 1;
```

**預防：** 在模板應用工作流中納入 `numbering.xml` 協調。正確的編號設置見 `Samples/ListAndNumberingSamples.cs`。

---

## 10. "頁邊距/頁面尺寸錯誤"

**症狀：** 輸出的頁邊距、頁面尺寸或方向與模板不同。

**診斷：** 源文檔的 `sectPr` 覆蓋了模板的 `sectPr`。最後的 `sectPr`（body 的子元素）控制最後一節的佈局。

```bash
# 比較節屬性
$CLI analyze --input template.docx | grep -i "sectPr\|margin\|pgSz"
$CLI analyze --input output.docx | grep -i "sectPr\|margin\|pgSz"
```

**修復：** 使用模板的末尾 `sectPr`。對於中間的 `sectPr` 元素（多節文檔），謹慎合併。

```csharp
// 用模板的替換輸出的末尾 sectPr
var templateSectPr = templateBody.Elements<SectionProperties>().LastOrDefault();
var outputSectPr = outputBody.Elements<SectionProperties>().LastOrDefault();

if (templateSectPr != null)
{
    var cloned = templateSectPr.CloneNode(true) as SectionProperties;
    if (outputSectPr != null)
        outputBody.ReplaceChild(cloned!, outputSectPr);
    else
        outputBody.Append(cloned!);
}
```

**預防：** 始終以模板的 `sectPr` 作為頁面佈局權威。複製內容前剝離源文檔的 `sectPr`。

---

## 11. "中文渲染為方塊/豆腐塊"

**症狀：** 中文字符顯示為方塊（□□□）或字形缺失。

**診斷：** `rFonts w:eastAsia` 設為系統上不存在的字體，或完全缺失。沒有東亞字體聲明，渲染引擎可能回退到無 CJK 覆蓋的字體。

**修復：** 確保所有 CJK 文本的 `w:eastAsia` 設為可用字體：

```csharp
foreach (var run in body.Descendants<Run>())
{
    var text = run.InnerText;
    if (ContainsCjk(text))
    {
        var rPr = run.RunProperties ?? new RunProperties();
        var rFonts = rPr.GetFirstChild<RunFonts>();
        if (rFonts == null)
        {
            rFonts = new RunFonts();
            rPr.Append(rFonts);
        }
        // 設為通用可用的 CJK 字體
        rFonts.EastAsia = "SimSun"; // 宋體 — 最安全的默認
        if (run.RunProperties == null) run.PrependChild(rPr);
    }
}

static bool ContainsCjk(string text)
{
    return text.Any(c => c >= 0x4E00 && c <= 0x9FFF);
}
```

常見安全 CJK 字體：宋體 (SimSun)、黑體 (SimHei)、仿宋 (FangSong)、楷體 (KaiTi)。

**預防：** 清理 `rPr` 格式時，始終保留 `w:eastAsia` 字體聲明。另見 `references/cjk_typography.md`。

---

## 12. "模板的封面/聲明頁缺失"

**症狀：** 輸出文檔直接以正文內容開始 — 無封面、無聲明、無摘要、無目錄。模板的結構性前置部分被丟棄了。

**診斷：** 需要 Base-Replace（C-2）時卻用了 Overlay（C-1）策略。Overlay 將樣式應用到源文檔，但丟棄模板的結構性內容（封面、聲明、摘要、目錄）。

```bash
# 檢查模板結構
$CLI analyze --input template.docx
# 若模板有 >50 段且含封面/目錄/聲明，則需要 C-2
```

**修復：** 使用 Base-Replace（C-2）策略 — 以模板為基，只將示例正文內容區域替換為用戶內容：

1. 識別模板的"正文區域"（目錄與末尾 sectPr 之間的所有內容）
2. 移除模板的示例正文內容
3. 將用戶內容插入正文區域
4. 保留模板的其他所有內容（封面、聲明、摘要、目錄、sectPr）

```bash
$CLI apply-template --input source.docx --template template.docx --output out.docx --strategy base-replace
```

**預防：** 先分析模板結構。若模板有結構性內容（封面、目錄、聲明章節），始終用 C-2（Base-Replace）。詳細決策標準見 `references/scenario_c_apply_template.md`。

---

## 13. "意外出現修訂標記"

**症狀：** 輸出顯示源文檔中沒有的紅/綠修訂標記（插入、刪除）。

**診斷：** 模板啟用了修訂追蹤，或內容作為修訂而非普通文本插入。

```bash
# 檢查修訂標記
$CLI analyze --input output.docx | grep -i "revision\|ins\|del\|track"
```

**修復：** 通過展平 `w:ins` 和 `w:del` 元素來接受所有修訂：

```csharp
// 接受插入：解包 w:ins，保留內容
foreach (var ins in body.Descendants<InsertedRun>().ToList())
{
    var parent = ins.Parent!;
    foreach (var child in ins.ChildElements.ToList())
    {
        parent.InsertBefore(child.CloneNode(true), ins);
    }
    ins.Remove();
}

// 接受刪除：完全移除 w:del 及其內容
foreach (var del in body.Descendants<DeletedRun>().ToList())
{
    del.Remove();
}
```

或在設置中禁用追蹤：
```csharp
var settings = settingsPart.Settings;
var trackChanges = settings.GetFirstChild<TrackChanges>();
trackChanges?.Remove();
```

**預防：** 開始前檢查模板的 `settings.xml` 是否有 `trackChanges`。若有，先接受模板中的所有修訂。

---

## 恢復策略 — 當存在多個問題時

文檔有多個問題時，按此優先級順序修復：

```
1. [Content_Types].xml  — 沒有它，什麼都打不開
2. _rels/.rels          — 包關係
3. word/_rels/document.xml.rels — 部件關係（圖片、超鏈接）
4. word/document.xml    — 元素順序（fix-order）
5. word/styles.xml      — 樣式定義和 styleId 映射
6. word/numbering.xml   — 列表/編號定義
7. 其他所有內容          — 頁眉、頁腳、批註、設置
```

```bash
# 完整恢復管道
$CLI unpack --input broken.docx --output unpacked/
$CLI validate --input broken.docx --xsd assets/xsd/wml-subset.xsd  # 查找所有錯誤
$CLI fix-order --input broken.docx                                   # 修復元素順序
$CLI validate --input broken.docx --business                         # 檢查業務規則
scripts/docx_preview.sh broken.docx                                  # 視覺檢查
```
