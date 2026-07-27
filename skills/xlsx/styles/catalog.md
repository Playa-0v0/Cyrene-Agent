# Excel 樣式目錄

本目錄包含 write_excel 工具支持的所有預設風格。每個風格對應一個 json 配置文件。

## 使用方式

1. 模型彈卡片（ask_user_choice）前，從下方風格中選 2-4 個作為選項
2. **第一個選項固定是 `default`（默認深藍）**
3. 後面的選項由模型根據任務場景自選
4. 用戶選完後，將風格名傳給 `write_excel` 的 `style` 參數

## 可用風格

| 文件 | 風格名 | 描述 | 適合場景 |
|------|--------|------|----------|
| `default.json` | default | 深藍表頭白字，專業穩重 | 通用、日常查看 |
| `dark.json` | dark | 深灰背景淺字，護眼舒適 | 長時間查看、夜間 |
| `colorful.json` | colorful | 綠色表頭白字，清新活潑 | 數據展示、彙報 |
| `simple-business.json` | simple-business | 淺灰表頭深字，簡潔乾淨 | 商務報告、正式文檔 |
| `financial.json` | financial | 純黑表頭白字，嚴肅專業 | 財務報表、審計 |

## json 格式

```json
{
  "name": "風格中文名",
  "headerFill": "FF1F4E79",
  "headerFont": "FFFFFFFF",
  "headerBorder": "FF1F4E79",
  "zebraFill": "FFF2F2F2",
  "borderColor": "FFBFBFBF"
}
```

所有顏色為 ARGB hex 格式（FF + RRGGBB）。
