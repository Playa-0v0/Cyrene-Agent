# CJK 排版与混排指南

DOCX 文档中中文、日文、韩文的规则。

## 目录

1. [字体选择](#字体选择)
2. [字号名称（CJK）](#字号名称)
3. [RunFonts 映射](#runfonts-映射)
4. [标点与换行](#标点与换行)
5. [段落缩进](#段落缩进)
6. [CJK 行距](#行距)
7. [中国政府公文标准（GB/T 9704）](#gbt-9704)
8. [CJK + 拉丁文混排最佳实践](#混排)
9. [OpenXML 速查](#openxml-速查)

---

## 字体选择

### 推荐 CJK 字体

| 语言 | 衬线（正文） | 无衬线（标题） | 备注 |
|----------|-------------|-------------|-------|
| **简体中文** | 宋体 (SimSun) | 微软雅黑 (Microsoft YaHei) | YaHei 适用于屏幕，SimSun 适用于打印 |
| **简体中文** | 仿宋 (FangSong) | 黑体 (SimHei) | 政府文件 |
| **繁体中文** | 新細明體 (PMingLiU) | 微軟正黑體 (Microsoft JhengHei) | 台湾标准 |
| **日文** | MS 明朝 (MS Mincho) | MS ゴシック (MS Gothic) | 经典配对 |
| **日文** | 游明朝 (Yu Mincho) | 游ゴシック (Yu Gothic) | 现代，Windows 10+ |
| **韩文** | 바탕 (Batang) | 맑은 고딕 (Malgun Gothic) | 标准配对 |

### 政府公文字体（公文）

| 元素 | 字体 | 字号 |
|---------|------|------|
| 标题（title） | 小标宋 (FZXiaoBiaoSong-B05S) | 二号 (22pt) |
| 一级标题 | 黑体 (SimHei) | 三号 (16pt) |
| 二级标题 | 楷体_GB2312 (KaiTi_GB2312) | 三号 (16pt) |
| 三级标题 | 仿宋_GB2312 加粗 | 三号 (16pt) |
| 正文（body） | 仿宋_GB2312 (FangSong_GB2312) | 三号 (16pt) |
| 附注/页码 | 宋体 (SimSun) | 四号 (14pt) |

---

## 字号名称

CJK 使用命名的字号。映射到磅值和 `w:sz` 半点值：

| 字号 | 磅值 | `w:sz` | 常见用途 |
|------|--------|--------|------------|
| 初号 | 42pt | 84 | 展示标题 |
| 小初 | 36pt | 72 | 大标题 |
| 一号 | 26pt | 52 | 章标题 |
| 小一 | 24pt | 48 | 主要标题 |
| 二号 | 22pt | 44 | 文档标题（公文） |
| 小二 | 18pt | 36 | 西文 H1 等效 |
| 三号 | 16pt | 32 | CJK 标题 / 公文正文 |
| 小三 | 15pt | 30 | 副标题 |
| 四号 | 14pt | 28 | CJK 副标题 |
| 小四 | 12pt | 24 | 标准正文（CJK） |
| 五号 | 10.5pt | 21 | 紧凑 CJK 正文 |
| 小五 | 9pt | 18 | 脚注 |
| 六号 | 7.5pt | 15 | 细则 |

---

## RunFonts 映射

OpenXML 用四个字体槽处理多语言文本：

```xml
<w:rFonts
  w:ascii="Calibri"        <!-- 拉丁字符（U+0000–U+007F） -->
  w:hAnsi="Calibri"        <!-- 拉丁扩展、希腊、西里尔 -->
  w:eastAsia="SimSun"      <!-- CJK 统一表意、假名、谚文 -->
  w:cs="Arial"             <!-- 阿拉伯、希伯来、泰、天城文 -->
/>
```

**Word 的字符分类逻辑：**

1. 字符在 CJK 范围 → 用 `w:eastAsia` 字体
2. 字符在复杂文种范围 → 用 `w:cs` 字体
3. 字符是基本拉丁（ASCII） → 用 `w:ascii` 字体
4. 其他 → 用 `w:hAnsi` 字体

**关键**：`w:eastAsia` 是设置 CJK 字体的**唯一**方式。仅设置 `w:ascii` 不会影响 CJK 字符。单个 run 内的混合文本在字符级自动切换字体 — 无需分开 run。

### 文档默认值

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

`w:lang w:eastAsia` 帮助 Word 解析歧义字符（如 CJK 和拉丁共用的标点）。

---

## 标点与换行

### 全角 vs 半角

CJK 文本使用全角标点：

| 类型 | CJK | 拉丁 |
|------|-----|-------|
| 句号 | 。(U+3002) | . |
| 逗号 | ，(U+FF0C) 、(U+3001) | , |
| 冒号 | ：(U+FF1A) | : |
| 分号 | ；(U+FF1B) | ; |
| 引号 | 「」『』 或 ""'' | "" '' |
| 括号 | （）(U+FF08/09) | () |

混合文本中，使用**周围语言上下文**的标点风格。

### OpenXML 控制

```xml
<w:pPr>
  <w:adjustRightInd w:val="true" />   <!-- 为 CJK 标点调整右缩进 -->
  <w:snapToGrid w:val="true" />        <!-- 对齐文档网格 -->
  <w:kinsoku w:val="true" />           <!-- 启用 CJK 换行规则 -->
  <w:overflowPunct w:val="true" />     <!-- 允许标点溢出页边距 -->
</w:pPr>
```

### 禁则规则（禁則処理）

防止某些字符出现在行首或行尾：
- **不能行首**：`）」』】〉》。、，！？；：` 及闭括号
- **不能行尾**：`（「『【〈《` 及开括号

启用 `w:kinsoku` 后 Word 自动应用这些规则。

### 换行

- CJK 字符可在**任意两个字符**之间换行（无需词边界）
- CJK 文本中的拉丁词仍遵循词边界换行
- `w:wordWrap w:val="false"` 启用 CJK 式换行（任意处断行）

---

## 段落缩进

### 中文标准：2 字符缩进

中文正文通常使用 2 字符首行缩进：

```xml
<w:ind w:firstLineChars="200" />  <!-- 200 = 2 字符 × 100 -->
```

优先于用固定 DXA 的 `w:firstLine`，因为 `firstLineChars` 随字号缩放。

| 缩进 | 值 |
|--------|-------|
| 1 字符 | `w:firstLineChars="100"` |
| 2 字符 | `w:firstLineChars="200"` |
| 3 字符 | `w:firstLineChars="300"` |

---

## 行距

- CJK 字符在相同磅值下比拉丁字符高
- 默认 `1.0` 行距对 CJK 文本可能感觉拥挤
- 推荐：CJK+拉丁混排用 `1.15–1.5`，公文用 `1.0` 配固定 28pt

### 自动间距

```xml
<w:pPr>
  <w:autoSpaceDE w:val="true"/>  <!-- CJK 与拉丁之间自动间距 -->
  <w:autoSpaceDN w:val="true"/>  <!-- CJK 与数字之间自动间距 -->
</w:pPr>
```

在 CJK 与非 CJK 字符之间自动添加约 ¼ em 间距。**推荐：始终启用。**

---

## GB/T 9704

中国政府公文标准（党政机关公文格式）。这些是**严格要求**，非建议。

### 页面设置

| 参数 | 值 | OpenXML |
|-----------|-------|---------|
| 页面尺寸 | A4（210×297mm） | Width=11906, Height=16838 |
| 上边距 | 37mm | 2098 DXA |
| 下边距 | 35mm | 1984 DXA |
| 左边距 | 28mm | 1588 DXA |
| 右边距 | 26mm | 1474 DXA |
| 每行字数 | 28 | |
| 每页行数 | 22 | |
| 行距 | 固定 28pt | `line="560"` lineRule="exact" |

### 文档结构

```
┌─────────────────────────────────┐
│     发文机关标志 (红头)           │  ← 小标宋 or 红色大字
│     ══════════════════ (红线)    │  ← Red #FF0000, 2pt
├─────────────────────────────────┤
│  发文字号: X机发〔2025〕X号      │  ← 仿宋 三号, 居中
│                                 │
│  标题 (Title)                   │  ← 小标宋 二号, 居中
│                                 │     可分多行，回行居中
│  主送机关:                      │  ← 仿宋 三号
│                                 │
│  正文 (Body)...                 │  ← 仿宋_GB2312 三号
│  一、一级标题                    │  ← 黑体 三号
│  （一）二级标题                  │  ← 楷体 三号
│  1. 三级标题                    │  ← 仿宋 三号 加粗
│  (1) 四级标题                   │  ← 仿宋 三号
│                                 │
│  附件: 1. xxx                   │  ← 仿宋 三号
│                                 │
│  发文机关署名                    │  ← 仿宋 三号
│  成文日期                       │  ← 仿宋 三号, 小写中文数字
├─────────────────────────────────┤
│  ════════════════ (版记线)       │
│  抄送: xxx                      │  ← 仿宋 四号
│  印发机关及日期                   │  ← 仿宋 四号
└─────────────────────────────────┘
```

### 编号系统

```
一、        ← 黑体 (SimHei), 无缩进
（一）      ← 楷体 (KaiTi), 缩进 2 字符
1.          ← 仿宋加粗 (FangSong Bold), 缩进 2 字符
(1)         ← 仿宋 (FangSong), 缩进 2 字符
```

### 颜色

| 元素 | 颜色 | 要求 |
|---------|-------|-------------|
| 所有正文 | 黑色 #000000 | 强制 |
| 红头（机关名） | 红色 #FF0000 | 强制 |
| 红线（分隔符） | 红色 #FF0000 | 强制 |
| 公章（公章） | 红色 | 强制 |

### 页码

- 位置：底部居中
- 格式：`-X-`（破折号-数字-破折号）
- 字体：宋体 四号（SimSun 14pt，`sz="28"`）
- 若有封面则封面无页码

---

## 混排

### 字号和谐

CJK 字符在相同磅值下显得比拉丁字符大。补偿：

- 若正文是 Calibri 11pt，配 CJK 11pt（相同尺寸 — CJK 略大但可接受）
- 若需精确视觉匹配，CJK 可设小 0.5–1pt
- 实践中，相同磅值是标准 — 不要过度优化

### 粗体与斜体

- **中文/日文无真正的斜体。** Word 合成的倾斜效果很差
- CJK 文本用**粗体**强调
- 传统强调用着重号：在 RunProperties 上设 `<w:em w:val="dot"/>`

---

## OpenXML 速查

### 设置 EastAsia 字体（C#）

```csharp
new Run(
    new RunProperties(
        new RunFonts { EastAsia = "SimSun", Ascii = "Calibri", HighAnsi = "Calibri" },
        new FontSize { Val = "32" }  // 三号 = 16pt = sz 32
    ),
    new Text("这是正文内容")
);
```

### 文档默认值（C#）

```csharp
new DocDefaults(new RunPropertiesDefault(new RunPropertiesBaseStyle(
    new RunFonts {
        Ascii = "Calibri", HighAnsi = "Calibri",
        EastAsia = "Microsoft YaHei"
    },
    new Languages { Val = "en-US", EastAsia = "zh-CN" }
)));
```

### 公文样式定义（C#）

```csharp
// 标题样式 — 小标宋 二号 居中
new Style(
    new StyleName { Val = "GongWen Title" },
    new BasedOn { Val = "Normal" },
    new StyleRunProperties(
        new RunFonts { EastAsia = "FZXiaoBiaoSong-B05S" },
        new FontSize { Val = "44" },  // 二号 = 22pt
        new Bold()
    ),
    new StyleParagraphProperties(
        new Justification { Val = JustificationValues.Center },
        new SpacingBetweenLines { Line = "560", LineRule = LineSpacingRuleValues.Exact }
    )
) { Type = StyleValues.Paragraph, StyleId = "GongWenTitle" };

// 正文样式 — 仿宋_GB2312 三号
new Style(
    new StyleName { Val = "GongWen Body" },
    new StyleRunProperties(
        new RunFonts { EastAsia = "FangSong_GB2312", Ascii = "FangSong_GB2312" },
        new FontSize { Val = "32" }  // 三号 = 16pt
    ),
    new StyleParagraphProperties(
        new SpacingBetweenLines { Line = "560", LineRule = LineSpacingRuleValues.Exact }
    )
) { Type = StyleValues.Paragraph, StyleId = "GongWenBody" };
```

### 着重号

```csharp
new RunProperties(new Emphasis { Val = EmphasisMarkValues.Dot });
```

### 东亚文本版式

```xml
<!-- 对齐网格（将 CJK 字符对齐到字符网格） -->
<w:snapToGrid w:val="true"/>

<!-- 双行合一 -->
<w:eastAsianLayout w:id="1" w:combine="true"/>

<!-- 单元格内垂直文本 -->
<w:textDirection w:val="tbRl"/>
```
