# 主题令牌结构

每个主题 JSON 必须包含：

```json
{
  "id": "business",
  "colors": {
    "primary": "#1B2A38",
    "secondary": "#3B6D8A",
    "accent": "#3B6D8A",
    "background": "#FAFAF8",
    "surface": "#FFFFFF",
    "foreground": "#2C2C30",
    "muted": "#7A7A84",
    "border": "#D9DEE3"
  },
  "fonts": {
    "cjk": ["Microsoft YaHei", "SimSun"],
    "latin": ["Aptos", "Arial"],
    "fallback": ["Helvetica"]
  },
  "spacing": { "base": 8 },
  "roles": {
    "table_header": "primary",
    "input": "#0000FF",
    "formula": "#000000",
    "warning": "#C2410C",
    "success": "#15803D"
  },
  "chart_colors": ["#3B6D8A", "#4E6070", "#7A7A84"]
}
```

颜色使用 `#RRGGBB`。`fonts` 数组按优先级排序，目标格式应选取本机可用的第一个字体。`roles` 的值可以引用 `colors` 内的键，也可以是独立颜色。
