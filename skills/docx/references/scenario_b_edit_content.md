# 場景 B：編輯/填充已有 DOCX 內容

## 核心原則

**"首先，不造成傷害。"** 編輯已有文檔時，要最小化改動。只動需要改動的部分。保留所有未直接參與編輯的格式、樣式、關係和結構。

---

## 何時使用

- 替換佔位符文本（`{{name}}`、`$DATE$`、`[PLACEHOLDER]`）
- 更新特定段落或表格單元格
- 填寫表單字段
- 在已知位置添加或刪除段落
- 為審閱工作流插入修訂標記

不要使用的情形：用戶想改變整個文檔的外觀/樣式（→ 場景 C），或從零創建（→ 場景 A）。

---

## 工作流

```
1. 預覽    → CLI：analyze <input.docx>
2. 分析    → 理解結構：章節、樣式、標題、表格
3. 定位    → 找到精確的編輯目標（段落索引、表格索引、佔位符文本）
4. 編輯    → 通過 CLI 或直接 XML 應用外科手術式改動
5. 驗證    → CLI：validate <output.docx>
6. Diff    → 對比修改前後，確認只改動了預期內容
```

---

## 何時用 API vs 直接 XML

### 使用 CLI 編輯命令的情形：
- 替換佔位符文本（如 `{{fieldName}}` → 實際值）
- 從 JSON 填充表格數據
- 更新文檔屬性（標題、作者）
- 簡單的文本插入或刪除

### 使用直接 XML 操作的情形：
- 文本跨多個不同格式的 run（run 邊界問題）
- 添加複雜結構（嵌套表格、多圖佈局）
- 操作修訂追蹤標記
- 修改頁眉/頁腳內容
- 調整節屬性

---

## 佔位符模式

CLI 原生支持 `{{fieldName}}` 佔位符：

```bash
# 從 JSON 映射替換所有 {{佔位符}}
dotnet run ... edit input.docx --fill-placeholders data.json --output filled.docx
```

其中 `data.json`：
```json
{
  "companyName": "Acme Corp",
  "date": "March 21, 2026",
  "amount": "$15,000.00",
  "recipientName": "Jane Smith"
}
```

其他佔位符格式（`$FIELD$`、`[PLACEHOLDER]`）需要文本替換：
```bash
dotnet run ... edit input.docx --replace "$DATE$" "March 21, 2026" --output updated.docx
```

---

## 文本替換策略

### 簡單替換

當整個搜索文本在單個 `w:r`（run）內時：

```xml
<!-- 之前 -->
<w:r>
  <w:rPr><w:b /></w:rPr>
  <w:t>{{companyName}}</w:t>
</w:r>

<!-- 之後 — 格式保留 -->
<w:r>
  <w:rPr><w:b /></w:rPr>
  <w:t>Acme Corp</w:t>
</w:r>
```

直接替換。run 的 `w:rPr` 不動。

### 複雜替換（拆分 run）

當搜索文本被拆分到多個 run 時（常見於 Word 在文本中間應用拼寫檢查或格式）：

```xml
<!-- "{{companyName}}" 被拆成 3 個 run -->
<w:r><w:rPr><w:b /></w:rPr><w:t>{{company</w:t></w:r>
<w:r><w:rPr><w:b /><w:i /></w:rPr><w:t>Na</w:t></w:r>
<w:r><w:rPr><w:b /></w:rPr><w:t>me}}</w:t></w:r>
```

策略：
1. 跨 run 拼接文本以找到匹配
2. 將替換文本放入**第一個** run（保留其 `w:rPr`）
3. 從後續 run 中移除文本（若變空則整個移除該 run）

```xml
<!-- 之後 -->
<w:r><w:rPr><w:b /></w:rPr><w:t>Acme Corp</w:t></w:r>
```

**規則**：始終保留匹配中第一個 run 的格式。

---

## 表格編輯

### 按索引

表格按文檔順序從 0 開始索引：

```bash
dotnet run ... edit input.docx --table-index 0 --table-data data.json --output updated.docx
```

### 按表頭匹配

按表頭行內容查找表格：

```bash
dotnet run ... edit input.docx --table-match "Name,Amount,Date" --table-data data.json
```

### 表格數據 JSON 格式

```json
{
  "rows": [
    ["Alice Johnson", "$5,000", "2026-03-15"],
    ["Bob Smith", "$3,200", "2026-03-18"]
  ],
  "appendRows": true
}
```

- `appendRows: true` — 在現有數據後追加行
- `appendRows: false`（默認）— 替換所有數據行（保留表頭行）

### 直接 XML 表格編輯

要修改特定單元格，按行/列索引定位：

```xml
<!-- 第 2 行（0 索引），第 1 列 -->
<w:tr>  <!-- tr[2] -->
  <w:tc>...</w:tc>
  <w:tc>  <!-- tc[1] — 目標單元格 -->
    <w:p>
      <w:r><w:t>舊值</w:t></w:r>
    </w:p>
  </w:tc>
</w:tr>
```

替換 `w:t` 內容。**禁止**修改 `w:tcPr`（單元格屬性）或 `w:tblPr`（表格屬性）。

---

## 修訂追蹤指引

### 何時添加修訂標記
- 用戶明確要求追蹤修訂
- 文檔已啟用追蹤（settings 中的 `w:trackChanges`）
- 協作審閱工作流

### 何時不添加修訂標記
- 表單填寫/佔位符替換（這是"完成"文檔，而非"修訂"）
- 用戶想要乾淨結果的直接編輯
- 批量數據填充操作

### 添加修訂標記

完整 XML 示例參見 `references/track_changes_guide.md`。

速查 — 帶追蹤插入文本：
```xml
<w:ins w:id="1" w:author="MiniMaxAI" w:date="2026-03-21T10:00:00Z">
  <w:r>
    <w:t>此處為新文本</w:t>
  </w:r>
</w:ins>
```

帶追蹤刪除文本：
```xml
<w:del w:id="2" w:author="MiniMaxAI" w:date="2026-03-21T10:00:00Z">
  <w:r>
    <w:delText>已移除的文本</w:delText>  <!-- 必須用 delText，不能用 t -->
  </w:r>
</w:del>
```

---

## 常見陷阱

### 1. 破壞 run 邊界

**問題**：跨 run 的文本替換，若天真地逐個修改 run，會破壞內聯格式。

**修復**：拼接 run 文本，找到匹配邊界，合併到第一個 run，移除被消耗的 run。

### 2. 超鏈接內容

**問題**：替換 `w:hyperlink` 元素內的文本時未保留超鏈接包裝器，會移除鏈接。

```xml
<w:hyperlink r:id="rId5">
  <w:r>
    <w:rPr><w:rStyle w:val="Hyperlink" /></w:rPr>
    <w:t>點擊此處</w:t>  <!-- 只替換此文本 -->
  </w:r>
</w:hyperlink>
```

**修復**：只修改超鏈接 run 內的 `w:t`。絕不移除或替換 `w:hyperlink` 元素本身。

### 3. 修訂上下文

**問題**：替換 `w:ins` 或 `w:del` 元素內的文本時未理解修訂上下文，會產生無效標記。

**修復**：若目標文本在修訂標記內，要麼：
- 在修訂上下文內替換（保留 `w:ins`/`w:del` 包裝）
- 或刪除舊修訂並新建一個

### 4. 樣式保留

**問題**：插入新段落時未指定樣式，導致其繼承 `Normal`，可能與周圍上下文不匹配。

**修復**：插入段落時，從同類型的相鄰段落複製 `w:pStyle`。

### 5. 編號連續性

**問題**：插入新列表項會打斷編號序列。

**修復**：確保新段落與相鄰列表項具有相同的 `w:numId` 和 `w:ilvl`。若延續序列，設置 `w:numPr` 以匹配。

### 6. XML 特殊字符

**問題**：用戶內容包含 `&`、`<`、`>`、`"`、`'` — 這些在 XML 中必須轉義。

**修復**：插入 `w:t` 元素前始終對用戶提供的文本進行 XML 轉義：
- `&` → `&amp;`
- `<` → `&lt;`
- `>` → `&gt;`
- `"` → `&quot;`
- `'` → `&apos;`

### 7. 空白保留

**問題**：`w:t` 中的前導/尾隨空格會被 XML 解析器去除。

**修復**：添加 `xml:space="preserve"` 屬性：
```xml
<w:t xml:space="preserve"> 帶前導空格的文本</w:t>
```

---

## Diff 驗證

編輯後，始終對比修改前後狀態：

```bash
# 結構 diff — 只顯示變更的元素
dotnet run ... diff original.docx modified.docx

# 純文本 diff — 顯示內容變更
dotnet run ... diff original.docx modified.docx --text-only
```

驗證：
- 只有預期文本發生變化
- 沒有樣式被修改
- 沒有意外添加/移除關係
- 表格結構完整（除非有意改變，行列數相同）
- 圖片和其他媒體未變
