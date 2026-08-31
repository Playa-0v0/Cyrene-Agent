---
name: office-design
description: 为 Word、Excel、PDF 和 PowerPoint 选择并校验统一品牌主题。仅在需要跨格式保持颜色、字体、间距和数据语义一致时使用；单一格式的编辑仍优先使用对应技能。
license: MIT
metadata:
  version: '1.0'
  category: document-design
---

# Office 设计主题

选择最接近文档目的的主题，读取对应的 `assets/themes/<theme>.json`，并将语义 token 映射到目标格式的原生样式。

| 主题 | 适用场景 |
|---|---|
| `business` | 报告、方案、通用商务文档 |
| `academic` | 论文、研究、课程材料 |
| `formal-cn` | 中文正式通知、公文、制度文件 |
| `financial` | 预算、财务模型、审计材料 |

不要把坐标、页边距或单元格尺寸放入共享主题；这些属于各格式自身的布局职责。

## 校验

在新增或修改主题后运行：

```powershell
python scripts/validate_theme.py assets/themes/business.json
```

校验器确认颜色、字体、间距、数据角色和图表色板完整。主题无效时，不应用它；改用对应格式的既有默认主题并报告原因。

## 格式映射

按需读取 [token-schema.md](references/token-schema.md)：

- PDF：颜色、字体和间距映射到 ReportLab 样式。
- Word：映射到段落样式、表格样式、页眉和页脚。
- Excel：映射到填充、字体、边框、数字格式和图表色板。
- PowerPoint：映射到幻灯片背景、文本层级、形状和图表。
