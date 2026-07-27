# Word 文檔樣式目錄

本目錄包含 write_word 工具支持的所有預設風格。每個風格對應一個 json 配置文件。

## 使用方式

1. 模型彈卡片（ask_user_choice）前，從下方風格中選 2-4 個作為選項
2. **第一個選項固定是 `default`（默認商務）**
3. 後面的選項由模型根據任務場景自選
4. 用戶選完後，將風格名傳給 `write_word` 的 `style` 參數

## 可用風格

| 文件 | 風格名 | 描述 | 適合場景 |
|------|--------|------|----------|
| `default.json` | default | 深藍標題+黑色正文，商務標準 | 通用、報告、方案 |
| `academic.json` | academic | 學術論文風，Times+宋體，緊湊行距 | 論文、學術報告 |
| `clean.json` | clean | 極簡風，無標題色，大行距，留白多 | 筆記、備忘、輕量文檔 |
| `elegant.json` | elegant | 優雅風，深灰標題+楷體正文，適合閱讀 | 信件、散文、閱讀型文檔 |
| `formal.json` | formal | 正式公文風，黑體標題+仿宋正文 | 公文、通知、正式文件 |

## json 格式

```json
{
  "name": "風格中文名",
  "titleColor": "FF1F4E79",
  "titleSize": 28,
  "titleFont": "微軟雅黑",
  "bodyFont": "微軟雅黑",
  "bodySize": 12,
  "bodyColor": "FF333333",
  "lineSpacing": 360,
  "headingColor": "FF1F4E79"
}
```

- `titleColor`/`headingColor`：標題/小標題顏色（ARGB hex）
- `titleSize`/`bodySize`：字號（half-point，28=14pt，24=12pt）
- `titleFont`/`bodyFont`：字體名
- `bodyColor`：正文顏色
- `lineSpacing`：行距（240=單倍，360=1.5倍，480=雙倍）
