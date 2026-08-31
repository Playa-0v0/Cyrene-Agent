# Excel 样式目录

本目录包含 write_excel 工具支持的所有预设风格。每个风格对应一个 json 配置文件。

## 使用方式

1. 模型弹卡片（ask_user_choice）前，从下方风格中选 2-4 个作为选项
2. **第一个选项固定是 `default`（默认深蓝）**
3. 后面的选项由模型根据任务场景自选
4. 用户选完后，将风格名传给 `write_excel` 的 `style` 参数

## 可用风格

| 文件 | 风格名 | 描述 | 适合场景 |
|------|--------|------|----------|
| `default.json` | default | 深蓝表头白字，专业稳重 | 通用、日常查看 |
| `dark.json` | dark | 深灰背景浅字，护眼舒适 | 长时间查看、夜间 |
| `colorful.json` | colorful | 绿色表头白字，清新活泼 | 数据展示、汇报 |
| `simple-business.json` | simple-business | 浅灰表头深字，简洁干净 | 商务报告、正式文档 |
| `financial.json` | financial | 纯黑表头白字，严肃专业 | 财务报表、审计 |

## json 格式

```json
{
  "name": "风格中文名",
  "headerFill": "FF1F4E79",
  "headerFont": "FFFFFFFF",
  "headerBorder": "FF1F4E79",
  "zebraFill": "FFF2F2F2",
  "borderColor": "FFBFBFBF"
}
```

所有颜色为 ARGB hex 格式（FF + RRGGBB）。
