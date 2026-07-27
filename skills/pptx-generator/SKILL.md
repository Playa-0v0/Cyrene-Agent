---
name: pptx-generator
description: "生成、編輯和讀取 PowerPoint 演示文稿。使用 PptxGenJS 從零創建（封面、目錄、內容、章節分隔、總結幻燈片），通過 XML 工作流編輯已有 PPTX，或使用 markitdown 提取文本。觸發詞：PPT、PPTX、PowerPoint、演示文稿、幻燈片、slide、deck、slides。"
license: MIT
metadata:
  version: "1.0"
  category: productivity
  sources:
    - https://gitbrent.github.io/PptxGenJS/
    - https://github.com/microsoft/markitdown
---

# PPTX 生成器與編輯器

## 概述

此 skill 處理所有 PowerPoint 任務：閱讀/分析已有演示文稿、通過 XML 操作編輯基於模板的幻燈片組、以及使用 PptxGenJS 從零創建演示文稿。它包含完整的設計系統（調色板、字體、風格配方）和每種幻燈片類型的詳細指南。

## 快速參考

| 任務 | 方式 |
|------|----------|
| 閱讀/分析內容 | `python -m markitdown presentation.pptx` |
| 編輯或基於模板創建 | 參見[編輯演示文稿](references/editing.md) |
| 從零創建 | 參見下方[從零創建工作流](#從零創建工作流) |

| 項目 | 值 |
|------|-------|
| **尺寸** | 10" x 5.625" (LAYOUT_16x9) |
| **顏色** | 6 字符 hex 不帶 #（例如 `"FF0000"`） |
| **英文字體** | Arial（默認），或已批准的替代字體 |
| **中文字體** | Microsoft YaHei |
| **頁碼徽章位置** | x: 9.3", y: 5.1" |
| **主題鍵** | `primary`, `secondary`, `accent`, `light`, `bg` |
| **形狀** | RECTANGLE, OVAL, LINE, ROUNDED_RECTANGLE |
| **圖表** | BAR, LINE, PIE, DOUGHNUT, SCATTER, BUBBLE, RADAR |

## 參考文件

| 文件 | 內容 |
|------|----------|
| [slide-types.md](references/slide-types.md) | 5 種幻燈片頁面類型（封面、目錄、章節分隔、內容、總結）+ 附加布局模式 |
| [design-system.md](references/design-system.md) | 調色板、字體參考、風格配方（Sharp/Soft/Rounded/Pill）、排版與間距 |
| [editing.md](references/editing.md) | 基於模板的編輯工作流、XML 操作、格式規則、常見陷阱 |
| [pitfalls.md](references/pitfalls.md) | QA 流程、常見錯誤、關鍵 PptxGenJS 陷阱 |
| [pptxgenjs.md](references/pptxgenjs.md) | 完整 PptxGenJS API 參考 |

---

## 閱讀內容

```bash
# 文本提取
python -m markitdown presentation.pptx
```

---

## 從零創建 — 工作流

**當沒有模板或參考演示文稿可用時使用。**

### 第 1 步：調研與需求

搜索以瞭解用戶需求——主題、受眾、目的、語氣、內容深度。

### 第 2 步：選擇調色板和字體

使用[調色板參考](references/design-system.md#調色板參考)選擇與主題和受眾匹配的調色板。使用[字體參考](references/design-system.md#字體參考)選擇字體配對。

### 第 3 步：選擇設計風格

使用[風格配方](references/design-system.md#風格配方)選擇與演示語氣匹配的視覺風格（Sharp、Soft、Rounded 或 Pill）。

### 第 4 步：規劃幻燈片大綱

將**每一張幻燈片**歸類為[5 種頁面類型](references/slide-types.md)中的一種。規劃每張幻燈片的內容和佈局。確保視覺多樣性——**禁止**在幻燈片之間重複相同的佈局。

### 第 5 步：生成幻燈片 JS 文件

在 `slides/` 目錄下為每張幻燈片創建一個 JS 文件。每個文件必須導出一個同步的 `createSlide(pres, theme)` 函數。遵循[幻燈片輸出格式](#幻燈片輸出格式)和 [slide-types.md](references/slide-types.md) 中針對各類型的指南。使用子 agent 時，最多同時生成 5 張幻燈片。

**告知每個子 agent：**
1. 文件命名：`slides/slide-01.js`、`slides/slide-02.js` 等。
2. 圖片放入：`slides/imgs/`
3. 最終 PPTX 放入：`slides/output/`
4. 尺寸：10" x 5.625" (LAYOUT_16x9)
5. 字體：中文 = Microsoft YaHei，英文 = Arial（或已批准的替代字體）
6. 顏色：6 字符 hex 不帶 #（例如 `"FF0000"`）
7. 必須使用 theme 對象契約（參見[Theme 對象契約](#theme-對象契約)）
8. 必須遵循 [PptxGenJS API 參考](references/pptxgenjs.md)

### 第 6 步：編譯為最終 PPTX

創建 `slides/compile.js` 以組合所有幻燈片模塊：

```javascript
// slides/compile.js
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';

const theme = {
  primary: "22223b",    // 深色用於背景/文本
  secondary: "4a4e69",  // 次要強調色
  accent: "9a8c98",     // 高亮色
  light: "c9ada7",      // 淺強調色
  bg: "f2e9e4"          // 背景色
};

for (let i = 1; i <= 12; i++) {  // 根據實際需要調整數量
  const num = String(i).padStart(2, '0');
  const slideModule = require(`./slide-${num}.js`);
  slideModule.createSlide(pres, theme);
}

pres.writeFile({ fileName: './output/presentation.pptx' });
```

運行方式：`cd slides && node compile.js`

### 第 7 步：QA（必須執行）

參見 [QA 流程](references/pitfalls.md#qa-流程)。

### 輸出結構

```
slides/
├── slide-01.js          # 幻燈片模塊
├── slide-02.js
├── ...
├── imgs/                # 幻燈片中使用的圖片
└── output/              # 最終產物
    └── presentation.pptx
```

---

## 幻燈片輸出格式

每張幻燈片是一個**完整、可運行的 JS 文件**：

```javascript
// slide-01.js
const pptxgen = require("pptxgenjs");

const slideConfig = {
  type: 'cover',
  index: 1,
  title: '演示文稿標題'
};

// 必須為同步函數（不能是 async）
function createSlide(pres, theme) {
  const slide = pres.addSlide();
  slide.background = { color: theme.bg };

  slide.addText(slideConfig.title, {
    x: 0.5, y: 2, w: 9, h: 1.2,
    fontSize: 48, fontFace: "Arial",
    color: theme.primary, bold: true, align: "center"
  });

  return slide;
}

// 獨立預覽 - 使用幻燈片專屬文件名
if (require.main === module) {
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_16x9';
  const theme = {
    primary: "22223b",
    secondary: "4a4e69",
    accent: "9a8c98",
    light: "c9ada7",
    bg: "f2e9e4"
  };
  createSlide(pres, theme);
  pres.writeFile({ fileName: "slide-01-preview.pptx" });
}

module.exports = { createSlide, slideConfig };
```

---

## Theme 對象契約（強制執行）

編譯腳本傳遞一個包含以下**精確鍵名**的 theme 對象：

| 鍵 | 用途 | 示例 |
|-----|---------|---------|
| `theme.primary` | 最深的顏色，標題 | `"22223b"` |
| `theme.secondary` | 深強調色，正文文本 | `"4a4e69"` |
| `theme.accent` | 中間調強調色 | `"9a8c98"` |
| `theme.light` | 淺強調色 | `"c9ada7"` |
| `theme.bg` | 背景色 | `"f2e9e4"` |

**嚴禁使用其他鍵名**，如 `background`、`text`、`muted`、`darkest`、`lightest`。

---

## 頁碼徽章（必須包含）

除封面頁外的**所有幻燈片**必須在右下角包含頁碼徽章。

- **位置**：x: 9.3", y: 5.1"
- 僅顯示當前頁碼（例如 `3` 或 `03`），不是 "3/12"
- 使用調色板顏色，保持低調

### 圓形徽章（默認）

```javascript
slide.addShape(pres.shapes.OVAL, {
  x: 9.3, y: 5.1, w: 0.4, h: 0.4,
  fill: { color: theme.accent }
});
slide.addText("3", {
  x: 9.3, y: 5.1, w: 0.4, h: 0.4,
  fontSize: 12, fontFace: "Arial",
  color: "FFFFFF", bold: true,
  align: "center", valign: "middle"
});
```

### 藥丸徽章

```javascript
slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 9.1, y: 5.15, w: 0.6, h: 0.35,
  fill: { color: theme.accent },
  rectRadius: 0.15
});
slide.addText("03", {
  x: 9.1, y: 5.15, w: 0.6, h: 0.35,
  fontSize: 11, fontFace: "Arial",
  color: "FFFFFF", bold: true,
  align: "center", valign: "middle"
});
```

---

## 依賴

- `pip install "markitdown[pptx]"` — 文本提取
- `npm install -g pptxgenjs` — 從零創建
- `npm install -g react-icons react react-dom sharp` — 圖標（可選）
