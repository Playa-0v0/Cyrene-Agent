# Word 文档样式目录

本目录包含 write_word 工具支持的所有预设风格。每个风格对应一个 json 配置文件。

## 使用方式

1. 模型弹卡片（ask_user_choice）前，从下方风格中选 2-4 个作为选项
2. **第一个选项固定是 `default`（默认商务）**
3. 后面的选项由模型根据任务场景自选
4. 用户选完后，将风格名传给 `write_word` 的 `style` 参数

## 可用风格

| 文件 | 风格名 | 描述 | 适合场景 |
|------|--------|------|----------|
| `default.json` | default | 深蓝标题+黑色正文，商务标准 | 通用、报告、方案 |
| `academic.json` | academic | 学术论文风，Times+宋体，紧凑行距 | 论文、学术报告 |
| `clean.json` | clean | 极简风，无标题色，大行距，留白多 | 笔记、备忘、轻量文档 |
| `elegant.json` | elegant | 优雅风，深灰标题+楷体正文，适合阅读 | 信件、散文、阅读型文档 |
| `formal.json` | formal | 正式公文风，黑体标题+仿宋正文 | 公文、通知、正式文件 |

## json 格式

```json
{
  "name": "风格中文名",
  "titleColor": "FF1F4E79",
  "titleSize": 28,
  "titleFont": "微软雅黑",
  "bodyFont": "微软雅黑",
  "bodySize": 12,
  "bodyColor": "FF333333",
  "lineSpacing": 360,
  "headingColor": "FF1F4E79"
}
```

- `titleColor`/`headingColor`：标题/小标题颜色（ARGB hex）
- `titleSize`/`bodySize`：字号（half-point，28=14pt，24=12pt）
- `titleFont`/`bodyFont`：字体名
- `bodyColor`：正文颜色
- `lineSpacing`：行距（240=单倍，360=1.5倍，480=双倍）
