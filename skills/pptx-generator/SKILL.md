---
name: pptx-generator

description: >-
  生成、编辑和读取 PowerPoint 演示文稿。使用 PptxGenJS 从零创建（封面、目录、内容、章节分隔、总结幻灯片），通过 XML 工作流编辑已有
  PPTX，或使用 markitdown 提取文本。触发词：PPT、PPTX、PowerPoint、演示文稿、幻灯片、slide、deck、slides。
license: MIT
metadata:
  version: '1.0'
  category: productivity
  sources:
    - 'https://gitbrent.github.io/PptxGenJS/'
    - 'https://github.com/microsoft/markitdown'
---

# PPTX 生成器与编辑器

## 概述

此 skill 处理所有 PowerPoint 任务：阅读/分析已有演示文稿、通过 XML 操作编辑基于模板的幻灯片组、以及使用 PptxGenJS 从零创建演示文稿。它包含完整的设计系统（调色板、字体、风格配方）和每种幻灯片类型的详细指南。

## Windows 起步

从项目根目录在 PowerShell 中运行 Node.js；不需要浏览器自动化。新建演示文稿时，先从共享 Office 主题加载颜色，再使用 PptxGenJS 生成文件：

```powershell
node -e "const {loadTheme}=require('./skills/pptx-generator/scripts/theme-loader'); console.log(loadTheme('business'))"
Set-Location .\slides
node .\compile.js
```

`theme-loader.js` 将 `../office-design/assets/themes/` 的标准主题映射为 `primary`、`secondary`、`accent`、`light`、`bg` 五个 PptxGenJS 颜色键。中文使用 `Microsoft YaHei`，英文默认使用 Arial。除用户明确要求改版外，编辑现有 PPTX 必须保留其原有主题和字体。

## 快速参考

| 任务 | 方式 |
|------|----------|
| 阅读/分析内容 | `python -m markitdown presentation.pptx` |
| 编辑或基于模板创建 | 参见[编辑演示文稿](references/editing.md) |
| 从零创建 | 参见下方[从零创建工作流](#从零创建工作流) |

| 项目 | 值 |
|------|-------|
| **尺寸** | 10" x 5.625" (LAYOUT_16x9) |
| **颜色** | 6 字符 hex 不带 #（例如 `"FF0000"`） |
| **英文字体** | Arial（默认），或已批准的替代字体 |
| **中文字体** | Microsoft YaHei |
| **页码徽章位置** | x: 9.3", y: 5.1" |
| **主题键** | `primary`, `secondary`, `accent`, `light`, `bg` |
| **形状** | RECTANGLE, OVAL, LINE, ROUNDED_RECTANGLE |
| **图表** | BAR, LINE, PIE, DOUGHNUT, SCATTER, BUBBLE, RADAR |

## 参考文件

| 文件 | 内容 |
|------|----------|
| [slide-types.md](references/slide-types.md) | 5 种幻灯片页面类型（封面、目录、章节分隔、内容、总结）+ 附加布局模式 |
| [design-system.md](references/design-system.md) | 调色板、字体参考、风格配方（Sharp/Soft/Rounded/Pill）、排版与间距 |
| [editing.md](references/editing.md) | 基于模板的编辑工作流、XML 操作、格式规则、常见陷阱 |
| [pitfalls.md](references/pitfalls.md) | QA 流程、常见错误、关键 PptxGenJS 陷阱 |
| [pptxgenjs.md](references/pptxgenjs.md) | 完整 PptxGenJS API 参考 |

---

## 阅读内容

```bash
# 文本提取
python -m markitdown presentation.pptx
```

---

## 从零创建 — 工作流

**当没有模板或参考演示文稿可用时使用。**

### 第 1 步：调研与需求

搜索以了解用户需求——主题、受众、目的、语气、内容深度。

### 第 2 步：选择调色板和字体

使用[调色板参考](references/design-system.md#调色板参考)选择与主题和受众匹配的调色板。使用[字体参考](references/design-system.md#字体参考)选择字体配对。

### 第 3 步：选择设计风格

使用[风格配方](references/design-system.md#风格配方)选择与演示语气匹配的视觉风格（Sharp、Soft、Rounded 或 Pill）。

### 第 4 步：规划幻灯片大纲

将**每一张幻灯片**归类为[5 种页面类型](references/slide-types.md)中的一种。规划每张幻灯片的内容和布局。确保视觉多样性——**禁止**在幻灯片之间重复相同的布局。

### 第 5 步：生成幻灯片 JS 文件

在 `slides/` 目录下为每张幻灯片创建一个 JS 文件。每个文件必须导出一个同步的 `createSlide(pres, theme)` 函数。遵循[幻灯片输出格式](#幻灯片输出格式)和 [slide-types.md](references/slide-types.md) 中针对各类型的指南。使用子 agent 时，最多同时生成 5 张幻灯片。

**告知每个子 agent：**
1. 文件命名：`slides/slide-01.js`、`slides/slide-02.js` 等。
2. 图片放入：`slides/imgs/`
3. 最终 PPTX 放入：`slides/output/`
4. 尺寸：10" x 5.625" (LAYOUT_16x9)
5. 字体：中文 = Microsoft YaHei，英文 = Arial（或已批准的替代字体）
6. 颜色：6 字符 hex 不带 #（例如 `"FF0000"`）
7. 必须使用 theme 对象契约（参见[Theme 对象契约](#theme-对象契约)）
8. 必须遵循 [PptxGenJS API 参考](references/pptxgenjs.md)

### 第 6 步：编译为最终 PPTX

创建 `slides/compile.js` 以组合所有幻灯片模块：

```javascript
// slides/compile.js
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';

const { loadTheme } = require('../skills/pptx-generator/scripts/theme-loader');
const theme = loadTheme('business');

for (let i = 1; i <= 12; i++) {  // 根据实际需要调整数量
  const num = String(i).padStart(2, '0');
  const slideModule = require(`./slide-${num}.js`);
  slideModule.createSlide(pres, theme);
}

pres.writeFile({ fileName: './output/presentation.pptx' });
```

运行方式：`Set-Location .\slides; node .\compile.js`

### 第 7 步：QA（必须执行）

参见 [QA 流程](references/pitfalls.md#qa-流程)。

### 输出结构

```
slides/
├── slide-01.js          # 幻灯片模块
├── slide-02.js
├── ...
├── imgs/                # 幻灯片中使用的图片
└── output/              # 最终产物
    └── presentation.pptx
```

---

## 幻灯片输出格式

每张幻灯片是一个**完整、可运行的 JS 文件**：

```javascript
// slide-01.js
const pptxgen = require("pptxgenjs");

const slideConfig = {
  type: 'cover',
  index: 1,
  title: '演示文稿标题'
};

// 必须为同步函数（不能是 async）
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

// 独立预览 - 使用幻灯片专属文件名
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

## Theme 对象契约（强制执行）

编译脚本传递一个包含以下**精确键名**的 theme 对象：

| 键 | 用途 | 示例 |
|-----|---------|---------|
| `theme.primary` | 最深的颜色，标题 | `"22223b"` |
| `theme.secondary` | 深强调色，正文文本 | `"4a4e69"` |
| `theme.accent` | 中间调强调色 | `"9a8c98"` |
| `theme.light` | 浅强调色 | `"c9ada7"` |
| `theme.bg` | 背景色 | `"f2e9e4"` |

**严禁使用其他键名**，如 `background`、`text`、`muted`、`darkest`、`lightest`。

---

## 页码徽章（必须包含）

除封面页外的**所有幻灯片**必须在右下角包含页码徽章。

- **位置**：x: 9.3", y: 5.1"
- 仅显示当前页码（例如 `3` 或 `03`），不是 "3/12"
- 使用调色板颜色，保持低调

### 圆形徽章（默认）

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

### 药丸徽章

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

## 依赖

- `pip install "markitdown[pptx]"` — 文本提取
- `npm install -g pptxgenjs` — 从零创建
- `npm install -g react-icons react react-dom sharp` — 图标（可选）
