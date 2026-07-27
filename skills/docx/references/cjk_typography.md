# CJK 排版與混排指南

DOCX 文檔中中文、日文、韓文的規則。

## 目錄

1. [字體選擇](#字體選擇)
2. [字號名稱（CJK）](#字號名稱)
3. [RunFonts 映射](#runfonts-映射)
4. [標點與換行](#標點與換行)
5. [段落縮進](#段落縮進)
6. [CJK 行距](#行距)
7. [中國政府公文標準（GB/T 9704）](#gbt-9704)
8. [CJK + 拉丁文混排最佳實踐](#混排)
9. [OpenXML 速查](#openxml-速查)

---

## 字體選擇

### 推薦 CJK 字體

| 語言 | 襯線（正文） | 無襯線（標題） | 備註 |
|----------|-------------|-------------|-------|
| **簡體中文** | 宋體 (SimSun) | 微軟雅黑 (Microsoft YaHei) | YaHei 適用於屏幕，SimSun 適用於打印 |
| **簡體中文** | 仿宋 (FangSong) | 黑體 (SimHei) | 政府文件 |
| **繁體中文** | 新細明體 (PMingLiU) | 微軟正黑體 (Microsoft JhengHei) | 臺灣標準 |
| **日文** | MS 明朝 (MS Mincho) | MS ゴシック (MS Gothic) | 經典配對 |
| **日文** | 遊明朝 (Yu Mincho) | 遊ゴシック (Yu Gothic) | 現代，Windows 10+ |
| **韓文** | 바탕 (Batang) | 맑은 고딕 (Malgun Gothic) | 標準配對 |

### 政府公文字體（公文）

| 元素 | 字體 | 字號 |
|---------|------|------|
| 標題（title） | 小標宋 (FZXiaoBiaoSong-B05S) | 二號 (22pt) |
| 一級標題 | 黑體 (SimHei) | 三號 (16pt) |
| 二級標題 | 楷體_GB2312 (KaiTi_GB2312) | 三號 (16pt) |
| 三級標題 | 仿宋_GB2312 加粗 | 三號 (16pt) |
| 正文（body） | 仿宋_GB2312 (FangSong_GB2312) | 三號 (16pt) |
| 附註/頁碼 | 宋體 (SimSun) | 四號 (14pt) |

---

## 字號名稱

CJK 使用命名的字號。映射到磅值和 `w:sz` 半點值：

| 字號 | 磅值 | `w:sz` | 常見用途 |
|------|--------|--------|------------|
| 初號 | 42pt | 84 | 展示標題 |
| 小初 | 36pt | 72 | 大標題 |
| 一號 | 26pt | 52 | 章標題 |
| 小一 | 24pt | 48 | 主要標題 |
| 二號 | 22pt | 44 | 文檔標題（公文） |
| 小二 | 18pt | 36 | 西文 H1 等效 |
| 三號 | 16pt | 32 | CJK 標題 / 公文正文 |
| 小三 | 15pt | 30 | 副標題 |
| 四號 | 14pt | 28 | CJK 副標題 |
| 小四 | 12pt | 24 | 標準正文（CJK） |
| 五號 | 10.5pt | 21 | 緊湊 CJK 正文 |
| 小五 | 9pt | 18 | 腳註 |
| 六號 | 7.5pt | 15 | 細則 |

---

## RunFonts 映射

OpenXML 用四個字體槽處理多語言文本：

```xml
<w:rFonts
  w:ascii="Calibri"        <!-- 拉丁字符（U+0000–U+007F） -->
  w:hAnsi="Calibri"        <!-- 拉丁擴展、希臘、西里爾 -->
  w:eastAsia="SimSun"      <!-- CJK 統一表意、假名、諺文 -->
  w:cs="Arial"             <!-- 阿拉伯、希伯來、泰、天城文 -->
/>
```

**Word 的字符分類邏輯：**

1. 字符在 CJK 範圍 → 用 `w:eastAsia` 字體
2. 字符在複雜文種範圍 → 用 `w:cs` 字體
3. 字符是基本拉丁（ASCII） → 用 `w:ascii` 字體
4. 其他 → 用 `w:hAnsi` 字體

**關鍵**：`w:eastAsia` 是設置 CJK 字體的**唯一**方式。僅設置 `w:ascii` 不會影響 CJK 字符。單個 run 內的混合文本在字符級自動切換字體 — 無需分開 run。

### 文檔默認值

```xml
<w:docDefaults>
  <w:rPrDefault>
    <w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimSun" w:cs="Arial" />
      <w:sz w:val="22" />
      <w:szCs w:val="22" />
      <w:lang w:val="en-US" w:eastAsia="zh-CN" />
    </w:rPr>
  </w:rPrDefault>
</w:docDefaults>
```

`w:lang w:eastAsia` 幫助 Word 解析歧義字符（如 CJK 和拉丁共用的標點）。

---

## 標點與換行

### 全角 vs 半角

CJK 文本使用全角標點：

| 類型 | CJK | 拉丁 |
|------|-----|-------|
| 句號 | 。(U+3002) | . |
| 逗號 | ，(U+FF0C) 、(U+3001) | , |
| 冒號 | ：(U+FF1A) | : |
| 分號 | ；(U+FF1B) | ; |
| 引號 | 「」『』 或 ""'' | "" '' |
| 括號 | （）(U+FF08/09) | () |

混合文本中，使用**周圍語言上下文**的標點風格。

### OpenXML 控制

```xml
<w:pPr>
  <w:adjustRightInd w:val="true" />   <!-- 為 CJK 標點調整右縮進 -->
  <w:snapToGrid w:val="true" />        <!-- 對齊文檔網格 -->
  <w:kinsoku w:val="true" />           <!-- 啟用 CJK 換行規則 -->
  <w:overflowPunct w:val="true" />     <!-- 允許標點溢出頁邊距 -->
</w:pPr>
```

### 禁則規則（禁則処理）

防止某些字符出現在行首或行尾：
- **不能行首**：`）」』】〉》。、，！？；：` 及閉括號
- **不能行尾**：`（「『【〈《` 及開括號

啟用 `w:kinsoku` 後 Word 自動應用這些規則。

### 換行

- CJK 字符可在**任意兩個字符**之間換行（無需詞邊界）
- CJK 文本中的拉丁詞仍遵循詞邊界換行
- `w:wordWrap w:val="false"` 啟用 CJK 式換行（任意處斷行）

---

## 段落縮進

### 中文標準：2 字符縮進

中文正文通常使用 2 字符首行縮進：

```xml
<w:ind w:firstLineChars="200" />  <!-- 200 = 2 字符 × 100 -->
```

優先於用固定 DXA 的 `w:firstLine`，因為 `firstLineChars` 隨字號縮放。

| 縮進 | 值 |
|--------|-------|
| 1 字符 | `w:firstLineChars="100"` |
| 2 字符 | `w:firstLineChars="200"` |
| 3 字符 | `w:firstLineChars="300"` |

---

## 行距

- CJK 字符在相同磅值下比拉丁字符高
- 默認 `1.0` 行距對 CJK 文本可能感覺擁擠
- 推薦：CJK+拉丁混排用 `1.15–1.5`，公文用 `1.0` 配固定 28pt

### 自動間距

```xml
<w:pPr>
  <w:autoSpaceDE w:val="true"/>  <!-- CJK 與拉丁之間自動間距 -->
  <w:autoSpaceDN w:val="true"/>  <!-- CJK 與數字之間自動間距 -->
</w:pPr>
```

在 CJK 與非 CJK 字符之間自動添加約 ¼ em 間距。**推薦：始終啟用。**

---

## GB/T 9704

中國政府公文標準（黨政機關公文格式）。這些是**嚴格要求**，非建議。

### 頁面設置

| 參數 | 值 | OpenXML |
|-----------|-------|---------|
| 頁面尺寸 | A4（210×297mm） | Width=11906, Height=16838 |
| 上邊距 | 37mm | 2098 DXA |
| 下邊距 | 35mm | 1984 DXA |
| 左邊距 | 28mm | 1588 DXA |
| 右邊距 | 26mm | 1474 DXA |
| 每行字數 | 28 | |
| 每頁行數 | 22 | |
| 行距 | 固定 28pt | `line="560"` lineRule="exact" |

### 文檔結構

```
┌─────────────────────────────────┐
│     發文機關標誌 (紅頭)           │  ← 小標宋 or 紅色大字
│     ══════════════════ (紅線)    │  ← Red #FF0000, 2pt
├─────────────────────────────────┤
│  發文字號: X機發〔2025〕X號      │  ← 仿宋 三號, 居中
│                                 │
│  標題 (Title)                   │  ← 小標宋 二號, 居中
│                                 │     可分多行，回行居中
│  主送機關:                      │  ← 仿宋 三號
│                                 │
│  正文 (Body)...                 │  ← 仿宋_GB2312 三號
│  一、一級標題                    │  ← 黑體 三號
│  （一）二級標題                  │  ← 楷體 三號
│  1. 三級標題                    │  ← 仿宋 三號 加粗
│  (1) 四級標題                   │  ← 仿宋 三號
│                                 │
│  附件: 1. xxx                   │  ← 仿宋 三號
│                                 │
│  發文機關署名                    │  ← 仿宋 三號
│  成文日期                       │  ← 仿宋 三號, 小寫中文數字
├─────────────────────────────────┤
│  ════════════════ (版記線)       │
│  抄送: xxx                      │  ← 仿宋 四號
│  印發機關及日期                   │  ← 仿宋 四號
└─────────────────────────────────┘
```

### 編號系統

```
一、        ← 黑體 (SimHei), 無縮進
（一）      ← 楷體 (KaiTi), 縮進 2 字符
1.          ← 仿宋加粗 (FangSong Bold), 縮進 2 字符
(1)         ← 仿宋 (FangSong), 縮進 2 字符
```

### 顏色

| 元素 | 顏色 | 要求 |
|---------|-------|-------------|
| 所有正文 | 黑色 #000000 | 強制 |
| 紅頭（機關名） | 紅色 #FF0000 | 強制 |
| 紅線（分隔符） | 紅色 #FF0000 | 強制 |
| 公章（公章） | 紅色 | 強制 |

### 頁碼

- 位置：底部居中
- 格式：`-X-`（破折號-數字-破折號）
- 字體：宋體 四號（SimSun 14pt，`sz="28"`）
- 若有封面則封面無頁碼

---

## 混排

### 字號和諧

CJK 字符在相同磅值下顯得比拉丁字符大。補償：

- 若正文是 Calibri 11pt，配 CJK 11pt（相同尺寸 — CJK 略大但可接受）
- 若需精確視覺匹配，CJK 可設小 0.5–1pt
- 實踐中，相同磅值是標準 — 不要過度優化

### 粗體與斜體

- **中文/日文無真正的斜體。** Word 合成的傾斜效果很差
- CJK 文本用**粗體**強調
- 傳統強調用著重號：在 RunProperties 上設 `<w:em w:val="dot"/>`

---

## OpenXML 速查

### 設置 EastAsia 字體（C#）

```csharp
new Run(
    new RunProperties(
        new RunFonts { EastAsia = "SimSun", Ascii = "Calibri", HighAnsi = "Calibri" },
        new FontSize { Val = "32" }  // 三號 = 16pt = sz 32
    ),
    new Text("這是正文內容")
);
```

### 文檔默認值（C#）

```csharp
new DocDefaults(new RunPropertiesDefault(new RunPropertiesBaseStyle(
    new RunFonts {
        Ascii = "Calibri", HighAnsi = "Calibri",
        EastAsia = "Microsoft YaHei"
    },
    new Languages { Val = "en-US", EastAsia = "zh-CN" }
)));
```

### 公文樣式定義（C#）

```csharp
// 標題樣式 — 小標宋 二號 居中
new Style(
    new StyleName { Val = "GongWen Title" },
    new BasedOn { Val = "Normal" },
    new StyleRunProperties(
        new RunFonts { EastAsia = "FZXiaoBiaoSong-B05S" },
        new FontSize { Val = "44" },  // 二號 = 22pt
        new Bold()
    ),
    new StyleParagraphProperties(
        new Justification { Val = JustificationValues.Center },
        new SpacingBetweenLines { Line = "560", LineRule = LineSpacingRuleValues.Exact }
    )
) { Type = StyleValues.Paragraph, StyleId = "GongWenTitle" };

// 正文樣式 — 仿宋_GB2312 三號
new Style(
    new StyleName { Val = "GongWen Body" },
    new StyleRunProperties(
        new RunFonts { EastAsia = "FangSong_GB2312", Ascii = "FangSong_GB2312" },
        new FontSize { Val = "32" }  // 三號 = 16pt
    ),
    new StyleParagraphProperties(
        new SpacingBetweenLines { Line = "560", LineRule = LineSpacingRuleValues.Exact }
    )
) { Type = StyleValues.Paragraph, StyleId = "GongWenBody" };
```

### 著重號

```csharp
new RunProperties(new Emphasis { Val = EmphasisMarkValues.Dot });
```

### 東亞文本版式

```xml
<!-- 對齊網格（將 CJK 字符對齊到字符網格） -->
<w:snapToGrid w:val="true"/>

<!-- 雙行合一 -->
<w:eastAsianLayout w:id="1" w:combine="true"/>

<!-- 單元格內垂直文本 -->
<w:textDirection w:val="tbRl"/>
```
