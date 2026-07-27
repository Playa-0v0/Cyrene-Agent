---
name: minimax-docx
license: MIT
metadata:
  version: "1.0.0"
  category: document-processing
  author: Minimax
  sources:
    - "ECMA-376 Office Open XML File Formats"
    - "GB/T 9704-2012 公文版面佈局標準"
    - "IEEE / ACM / APA / MLA / Chicago / Turabian 風格指南"
    - "Springer LNCS / Nature / HBR 文檔模板"
description: >
  使用 OpenXML SDK (.NET) 進行專業的 DOCX 文檔創建、編輯和格式化。
  三種管道：(A) 從零創建新文檔，(B) 在已有文檔中填充/編輯內容，
  (C) 應用模板格式化並通過 XSD 驗證門控檢查。
  當用戶需要生成、修改或格式化 Word 文檔時，必須使用此 skill——
  包括他們說"寫一份報告"、"起草建議書"、"製作合同"、
  "填寫此表單"、"按此模板重新排版"，或任何最終輸出為 .docx 文件的任務。
  即使用戶未明確提及 "docx"，如果任務暗示生成可打印/正式文檔，也應使用此 skill。
triggers:
  - Word
  - docx
  - document
  - 文檔
  - Word文檔
  - 報告
  - 合同
  - 公文
  - 排版
  - 套模板
---

# minimax-docx

通過 CLI 工具或基於 OpenXML SDK (.NET) 的直接 C# 腳本創建、編輯和格式化 DOCX 文檔。

## ⚠️ 先判斷：是否需要本 Skill

在開始任何操作前，先判斷任務複雜度：

- **簡單文檔生成**（報告、總結、方案、請假條等純文本段落）→ **直接用 `write_word` 工具**，不要繼續讀本 Skill。
  `write_word` 已內置美觀樣式（標題顏色/字號、正文行距/字體/顏色）和支持多種預設風格。
  用戶說"美觀""好看"時，讀 `styles/catalog.md` 選 2-4 個風格，用 `ask_user_choice` 彈卡片讓用戶選。
  **第一個選項固定是 `default`（默認商務）**。用戶選完傳 `style` 參數給 `write_word` 即可。

- **需要以下任一才繼續本 Skill**：
  - 頁眉/頁腳、目錄、圖片插入
  - 複雜表格、多節佈局
  - 編輯已有 docx 文件（保留格式/批註/修訂）
  - 應用模板格式化 + XSD 驗證門控

### 執行紀律（必須遵守）

1. **只讀完成任務所需的最少 reference**——讀完能執行就立即開始。
2. **同一 reference 文件不要重複讀取**（系統會攔截重複讀取）。
3. **不要花多輪搜索腳本路徑**——`scripts/` 路徑在 `SKILL_DIR` 下，用一行命令定位。
4. **信息足夠後立即執行**——不要繼續研究文檔。
5. **若預計輪數緊張，優先輸出可交付版本**而非繼續優化排版。

## 環境準備

**首次使用：** `bash scripts/setup.sh`（Windows 上使用 `powershell scripts/setup.ps1`，`--minimal` 跳過可選依賴）。

**會話中首次操作：** `scripts/env_check.sh` — 如果返回 `NOT READY` 則不得繼續。（同一會話內的後續操作可跳過此步驟。）

## 快速入門：直接 C# 路徑

當任務需要結構化文檔操作（自定義樣式、複雜表格、多節佈局、頁眉/頁腳、目錄、圖片）時，直接編寫 C# 而不是糾結於 CLI 限制。使用此腳手架：

```csharp
// 文件：scripts/dotnet/task.csx（或 Console 項目中的新 .cs 文件）
// dotnet run --project scripts/dotnet/MiniMaxAIDocx.Cli -- run-script task.csx
#r "nuget: DocumentFormat.OpenXml, 3.2.0"

using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

using var doc = WordprocessingDocument.Create("output.docx", WordprocessingDocumentType.Document);
var mainPart = doc.AddMainDocumentPart();
mainPart.Document = new Document(new Body());

// --- 在此處編寫你的邏輯 ---
// 首先閱讀相關的 Samples/*.cs 文件以獲取已驗證的模式。
// 參見下方參考部分中的 Samples/ 表格。
```

**在編寫任何 C# 之前，必須先閱讀相關的 `Samples/*.cs` 文件**——它們包含可編譯、經 SDK 版本驗證的模式。下方參考部分的 Samples 表格將主題映射到文件。

## CLI 簡寫

所有以下 CLI 命令使用 `$CLI` 作為以下命令的簡寫：
```bash
dotnet run --project scripts/dotnet/MiniMaxAIDocx.Cli --
```

## 管道路由

通過檢查用戶是否有輸入 .docx 文件來路由：

```
用戶任務
├─ 無輸入文件 → 管道 A：CREATE
│   信號詞："寫"、"創建"、"起草"、"生成"、"新建"、"製作一份報告/建議書/備忘錄"
│   → 閱讀 references/scenario_a_create.md
│
└─ 有輸入 .docx
    ├─ 替換/填充/修改內容 → 管道 B：FILL-EDIT
    │   信號詞："填寫"、"替換"、"更新"、"更改文本"、"添加章節"、"編輯"
    │   → 閱讀 references/scenario_b_edit_content.md
    │
    └─ 重新格式化/應用樣式/模板 → 管道 C：FORMAT-APPLY
        信號詞："重新格式化"、"應用模板"、"重新設計樣式"、"匹配此格式"、"套模板"、"排版"
        ├─ 模板為純樣式（無內容）→ C-1：OVERLAY（將樣式應用於源文檔）
        └─ 模板有結構（封面/目錄/示例章節）→ C-2：BASE-REPLACE
            （使用模板作為基礎，將示例內容替換為用戶內容）
        → 閱讀 references/scenario_c_apply_template.md
```

如果請求跨越多個管道，按順序執行（例如，先 Create 再 Format-Apply）。

## 預處理

如需將 `.doc` 轉為 `.docx`：`scripts/doc_to_docx.sh input.doc output_dir/`

編輯前預覽（避免閱讀原始 XML）：`scripts/docx_preview.sh document.docx`

分析結構以用於編輯場景：`$CLI analyze --input document.docx`

## 場景 A：創建

首先閱讀 `references/scenario_a_create.md`、`references/typography_guide.md` 和 `references/design_principles.md`。從 `Samples/AestheticRecipeSamples.cs` 中選擇與文檔類型匹配的美學配方——**禁止**自行編造格式值。對於 CJK，還需閱讀 `references/cjk_typography.md`。

**選擇你的路徑：**
- **簡單**（純文本、最少格式）：使用 CLI — `$CLI create --type report --output out.docx --config content.json`
- **結構化**（自定義樣式、多節、目錄、圖片、複雜表格）：直接編寫 C#。先閱讀相關的 `Samples/*.cs`。

CLI 選項：`--type`（report|letter|memo|academic）、`--title`、`--author`、`--page-size`（letter|a4|legal|a3）、`--margins`（standard|narrow|wide）、`--header`、`--footer`、`--page-numbers`、`--toc`、`--content-json`。

然後運行**驗證管道**（見下方）。

## 場景 B：編輯/填充

首先閱讀 `references/scenario_b_edit_content.md`。預覽 → 分析 → 編輯 → 驗證。

**選擇你的路徑：**
- **簡單**（文本替換、佔位符填充）：使用 CLI 子命令。
- **結構化**（添加/重組章節、修改樣式、操作表格、插入圖片）：直接編寫 C#。閱讀 `references/openxml_element_order.md` 和相關的 `Samples/*.cs`。

可用的 CLI 編輯子命令：
- `replace-text --find "X" --replace "Y"`
- `fill-placeholders --data '{"key":"value"}'`
- `fill-table --data table.json`
- `insert-section`、`remove-section`、`update-header-footer`

```bash
$CLI edit replace-text --input in.docx --output out.docx --find "OLD" --replace "NEW"
$CLI edit fill-placeholders --input in.docx --output out.docx --data '{"name":"John"}'
```

然後運行**驗證管道**。同時運行 diff 以驗證最小更改：
```bash
$CLI diff --before in.docx --after out.docx
```

## 場景 C：應用模板

首先閱讀 `references/scenario_c_apply_template.md`。預覽並分析源文檔和模板。

```bash
$CLI apply-template --input source.docx --template template.docx --output out.docx
```

對於複雜的模板操作（多模板合併、每節獨立頁眉/頁腳、樣式合併），直接編寫 C#——參見下方關鍵規則中的必需模式。

運行**驗證管道**，然後是**硬門控檢查**：
```bash
$CLI validate --input out.docx --gate-check assets/xsd/business-rules.xsd
```
門控檢查是**硬性要求**。通過之前**禁止**交付。如果失敗：診斷、修復、重新運行。

同時運行 diff 以驗證內容保留：`$CLI diff --before source.docx --after out.docx`

## 驗證管道

每次寫入操作後運行。對於場景 C，完整管道是**強制**的；對於 A/B，則是**推薦**的（僅在操作極其簡單時可跳過）。

```bash
$CLI merge-runs --input doc.docx                                    # 1. 合併 runs
$CLI validate --input doc.docx --xsd assets/xsd/wml-subset.xsd     # 2. XSD 結構
$CLI validate --input doc.docx --business                           # 3. 業務規則
```

如果 XSD 失敗，自動修復並重試：
```bash
$CLI fix-order --input doc.docx
$CLI validate --input doc.docx --xsd assets/xsd/wml-subset.xsd
```

如果 XSD 仍然失敗，回退到業務規則 + 預覽：
```bash
$CLI validate --input doc.docx --business
scripts/docx_preview.sh doc.docx
# 驗證：字體汙染=0，表格數量正確，圖形數量正確，sectPr 數量正確
```

最終預覽：`scripts/docx_preview.sh doc.docx`

## 關鍵規則

以下規則防止文件損壞——OpenXML 對元素順序有嚴格要求。

**元素順序**（屬性始終在前）：

| 父元素 | 順序 |
|--------|-------|
| `w:p`  | `pPr` → runs |
| `w:r`  | `rPr` → `t`/`br`/`tab` |
| `w:tbl`| `tblPr` → `tblGrid` → `tr` |
| `w:tr` | `trPr` → `tc` |
| `w:tc` | `tcPr` → `p`（至少 1 個 `<w:p/>`） |
| `w:body` | 塊內容 → `sectPr`（最後一個子元素） |

**直接格式汙染：** 從源文檔複製內容時，內聯 `rPr`（字體、顏色）和 `pPr`（邊框、底紋、間距）會覆蓋模板樣式。始終剝離直接格式——只保留 `pStyle` 引用和 `t` 文本。同時清理表格（包括單元格內的 `pPr/rPr`）。

**修訂追蹤：** `<w:del>` 使用 `<w:delText>`，**禁止**使用 `<w:t>`。`<w:ins>` 使用 `<w:t>`，**禁止**使用 `<w:delText>`。

**字體大小：** `w:sz` = 點數 × 2（12pt → `sz="24"`）。邊距/間距單位為 DXA（1 英寸 = 1440，1cm ≈ 567）。

**標題樣式必須具有 OutlineLevel：** 在定義標題樣式（Heading1、ThesisH1 等）時，始終在 `StyleParagraphProperties` 中包含 `new OutlineLevel { Val = N }`（H1→0、H2→1、H3→2）。沒有此項，Word 會將它們視為普通樣式文本——目錄和導航窗格將無法工作。

**多模板合併：** 當給定多個模板文件（字體、標題、分節）時，首先閱讀 `references/scenario_c_apply_template.md` 的"多模板合併"部分。關鍵規則：
- 將所有模板的樣式合併到一個 styles.xml 中。結構（節/分節符）來自分節模板。
- 每個內容段落必須恰好出現一次——插入分節符時**禁止**重複。
- **禁止**插入空/空白段落作為填充或分節分隔符。輸出段落數必須等於輸入段落數。使用分節符屬性（`w:pPr` 中的 `w:sectPr`）和樣式間距（`w:spacing` 段前/段後）來實現視覺分隔。
- 在每個章節標題前插入 oddPage 分節符，而不僅僅是第一個。即使章節有雙欄內容，也必須以 oddPage 開始；在標題後使用第二個 continuous 分節符來切換欄數。
- 雙欄章節需要三個分節符：(1) 前一節段落 pPr 中的 oddPage，(2) 章節標題 pPr 中的 continuous+cols=2，(3) 最後正文段落 pPr 中的 continuous+cols=1 以恢復單欄。
- 為每個節從分節模板複製 `titlePg` 設置。摘要和目錄節通常需要 `titlePg=true`。

**多節頁眉/頁腳：** 具有 10 個以上節的模板（如中文論文）每節有不同的頁眉/頁腳（羅馬 vs 阿拉伯頁碼、每個區域不同的頁眉文本）。規則：
- 使用 C-2 Base-Replace：將模板複製為輸出基礎，然後替換正文內容。這會自動保留所有節、頁眉、頁腳和 titlePg 設置。
- **禁止**從零重新創建頁眉/頁腳——逐字節複製模板的頁眉/頁腳 XML。
- **禁止**添加模板頁眉 XML 中不存在的格式（邊框、對齊、字體大小）。
- 非封面節必須具有頁眉/頁腳 XML 文件（至少有空頁眉 + 頁碼頁腳）。
- 參見 `references/scenario_c_apply_template.md` 的"多節頁眉/頁腳傳輸"部分。

## 參考文檔

按需加載——不要一次性全部加載。選擇與任務最相關的文件。

**下方的 C# 示例和設計參考是項目的知識庫（"百科全書"）。** 編寫 OpenXML 代碼時，始終首先閱讀相關的示例文件——它包含可編譯、經 SDK 版本驗證的模式，可防止常見錯誤。做美學決策時，閱讀設計原則和配方文件——它們編碼了來自權威來源（IEEE、ACM、APA、Nature 等）的經過測試的和諧參數集，而非猜測。

### 場景指南（每個管道首先閱讀）

| 文件 | 何時使用 |
|------|------|
| `references/scenario_a_create.md` | 管道 A：從零創建 |
| `references/scenario_b_edit_content.md` | 管道 B：編輯已有內容 |
| `references/scenario_c_apply_template.md` | 管道 C：應用模板格式化 |

### C# 代碼示例（可編譯、註釋詳盡 — 編寫代碼時閱讀）

| 文件 | 主題 |
|------|-------|
| `Samples/DocumentCreationSamples.cs` | 文檔生命週期：創建、打開、保存、流、文檔默認值、設置、屬性、頁面設置、多節 |
| `Samples/StyleSystemSamples.cs` | 樣式：Normal/Heading 鏈、字符/表格/列表樣式、DocDefaults、latentStyles、CJK 公文、APA 7th、導入、解析繼承 |
| `Samples/CharacterFormattingSamples.cs` | RunProperties：字體、字號、粗體/斜體、所有下劃線、顏色、高亮、刪除線、上標/下標、大寫、間距、底紋、邊框、著重號 |
| `Samples/ParagraphFormattingSamples.cs` | ParagraphProperties：對齊、縮進、行距/段距、與下段同頁/孤行控制、大綱級別、邊框、製表位、編號、雙向文本、框架 |
| `Samples/TableSamples.cs` | 表格：邊框、網格、單元格屬性、邊距、行高、標題重複、合併（水平+垂直）、嵌套、浮動、三線表、斑馬條紋 |
| `Samples/HeaderFooterSamples.cs` | 頁眉/頁腳：頁碼、"第 X 頁 共 Y 頁"、首頁/偶數/奇數頁、logo 圖片、表格佈局、公文 "-X-"、每節獨立 |
| `Samples/ImageSamples.cs` | 圖片：內嵌、浮動、文字環繞、邊框、替代文本、頁眉/表格中、替換、SVG 回退、尺寸計算 |
| `Samples/ListAndNumberingSamples.cs` | 編號：項目符號、多級十進制、自定義符號、大綱→標題、法律編號、中文 一/（一）/1./(1)、重新開始/繼續 |
| `Samples/FieldAndTocSamples.cs` | 域：TOC、SimpleField vs 複雜域、DATE/PAGE/REF/SEQ/MERGEFIELD/IF/STYLEREF、TOC 樣式 |
| `Samples/FootnoteAndCommentSamples.cs` | 腳註、尾註、批註（4 文件系統）、書籤、超鏈接（內部+外部） |
| `Samples/TrackChangesSamples.cs` | 修訂：插入（w:t）、刪除（w:delText!）、格式更改、接受/拒絕全部、移動追蹤 |
| `Samples/AestheticRecipeSamples.cs` | 來自權威來源的 13 種美學配方：ModernCorporate、AcademicThesis、ExecutiveBrief、ChineseGovernment (GB/T 9704)、MinimalModern、IEEE Conference、ACM sigconf、APA 7th、MLA 9th、Chicago/Turabian、Springer LNCS、Nature、HBR——每種都有來自官方風格指南的精確值 |

注意：`Samples/` 路徑相對於 `scripts/dotnet/MiniMaxAIDocx.Core/`。

### Markdown 參考（需要規範或設計規則時閱讀）

| 文件 | 何時使用 |
|------|------|
| `references/openxml_element_order.md` | XML 元素順序規則（防止損壞） |
| `references/openxml_units.md` | 單位轉換：DXA、EMU、半點、八分之一點 |
| `references/openxml_encyclopedia_part1.md` | 詳細 C# 百科全書：文檔創建、樣式、字符和段落格式化 |
| `references/openxml_encyclopedia_part2.md` | 詳細 C# 百科全書：頁面設置、表格、頁眉/頁腳、節、文檔屬性 |
| `references/openxml_encyclopedia_part3.md` | 詳細 C# 百科全書：TOC、腳註、域、修訂追蹤、批註、圖片、數學公式、編號、保護 |
| `references/typography_guide.md` | 字體配對、字號、間距、頁面佈局、表格設計、配色方案 |
| `references/cjk_typography.md` | CJK 字體、字號、RunFonts 映射、GB/T 9704 公文標準 |
| `references/cjk_university_template_guide.md` | 中國大學論文模板：數字 styleIds（1/2/3 vs Heading1）、文檔區域結構（封面→摘要→目錄→正文→參考文獻）、字體預期、常見錯誤 |
| `references/design_principles.md` | **美學基礎**：6 項設計原則（留白、對比/比例、鄰近、對齊、重複、層級）——教你"為什麼"，而不僅僅是"是什麼" |
| `references/design_good_bad_examples.md` | **好壞對比**：10 類排版錯誤，含 OpenXML 值、ASCII 模擬圖和修復方案 |
| `references/track_changes_guide.md` | 修訂標記深入詳解 |
| `references/troubleshooting.md` | **按症狀驅動修復**：13 個常見問題，按你看到的症狀索引（標題錯誤、圖片缺失、TOC 損壞等）——按症狀搜索，找到修復方案 |
