# 數據讀取與分析指南

> 讀取路徑參考。用 `xlsx_reader.py` 做結構發現和數據質量審計，再用 pandas 做自定義分析。**絕不修改源文件。**

---

## 何時使用此路徑

用戶要求讀取、分析、查看、彙總、提取或回答關於 Excel/CSV 文件內容的問題，且無需修改文件時。若需修改，轉交 `edit.md`。

---

## 工作流

### 第 1 步 — 結構發現

先運行 `xlsx_reader.py`。它處理格式檢測、編碼回退、結構探索和數據質量審計：

```bash
python3 SKILL_DIR/scripts/xlsx_reader.py input.xlsx                 # 完整報告
python3 SKILL_DIR/scripts/xlsx_reader.py input.xlsx --sheet Sales   # 單工作表
python3 SKILL_DIR/scripts/xlsx_reader.py input.xlsx --quality       # 僅質量審計
python3 SKILL_DIR/scripts/xlsx_reader.py input.xlsx --json          # 機器可讀
```

支持格式：`.xlsx`、`.xlsm`、`.csv`、`.tsv`。腳本對 CSV 嘗試多種編碼（utf-8-sig、gbk、utf-8、latin-1）。

### 第 2 步 — 用 pandas 做自定義分析

加載數據並執行用戶請求的分析：

```python
import pandas as pd
df = pd.read_excel("input.xlsx", sheet_name=None)  # 所有工作表的字典
# CSV：pd.read_csv("input.csv")
```

**表頭處理**（默認 `header=0` 不適用時）：

| 情況 | 代碼 |
|-----------|------|
| 表頭在第 3 行 | `pd.read_excel(path, header=2)` |
| 多級合併表頭 | `pd.read_excel(path, header=[0, 1])` |
| 無表頭 | `pd.read_excel(path, header=None)` |

**分析速查：**

| 場景 | 模式 |
|----------|---------|
| 描述性統計 | `df.describe()` 或 `df['Col'].agg(['sum', 'mean', 'min', 'max'])` |
| 分組聚合 | `df.groupby('Region')['Revenue'].agg(Total='sum', Avg='mean')` |
| 前 N | `df.groupby('Region')['Revenue'].sum().sort_values(ascending=False).head(5)` |
| 數據透視表 | `df.pivot_table(values='Revenue', index='Region', columns='Quarter', aggfunc='sum', margins=True)` |
| 時間序列 | `df.set_index(pd.to_datetime(df['Date'])).resample('ME')['Revenue'].sum()` |
| 跨表合併 | `pd.merge(sales, customers, on='CustomerID', how='left', validate='m:1')` |
| 堆疊工作表 | `pd.concat([df.assign(Source=name) for name, df in sheets.items()], ignore_index=True)` |
| 大文件（>50MB） | `pd.read_excel(path, usecols=['Date', 'Revenue'])` 或 `pd.read_csv(path, chunksize=10000)` |

### 第 3 步 — 輸出

若用戶指定了輸出文件路徑，將結果寫入該路徑（最高優先級）。報告格式：

```
## 分析報告：{filename}
### 文件概覽     — 格式、工作表、行數
### 數據質量     — 空值、重複、混合類型（或"無問題"）
### 關鍵發現      — 對用戶問題的直接回答
### 補充說明  — 公式 NaN、編碼問題、注意事項
```

**數字顯示**：貨幣 `1,234,567.89`、百分比 `12.3%`、倍數 `8.5x`、計數為整數。

---

## 常見陷阱

| 陷阱 | 原因 | 修復 |
|---------|-------|-----|
| 公式單元格讀為 NaN | 新生成文件的 `<v>` 緩存為空 | 告知用戶；建議在 Excel 中打開並重新保存；或用 `libreoffice_recalc.py` |
| CSV 編碼錯誤 | 中文 Windows 導出用 GBK | `xlsx_reader.py` 自動嘗試多種編碼；若全失敗則手動指定 |
| 列中混合類型 | 列同時有數字和文本（如 "N/A"） | `pd.to_numeric(df['Col'], errors='coerce')` — 報告無法轉換的行 |
| 年份顯示為 2,024 | 年份應用了千位分隔符格式 | `df['Year'].astype(int).astype(str)` |
| 多級表頭 | 兩行表頭合併 | `pd.read_excel(path, header=[0, 1])`，再用 `' - '.join()` 拍平 |
| 行號不匹配 | pandas 0 索引 vs Excel 1 索引 | `excel_row = pandas_index + 2`（+1 為 1 索引，+1 為表頭） |

**關鍵**：絕不用 `data_only=True` 打開後 `save()` — 這會永久銷燬所有公式。

---

## 禁止事項

- 絕不修改源文件（無 `save()`、無 XML 編輯）
- 絕不把公式 NaN 報告為"數據為零" — 解釋這是公式緩存問題
- 絕不把 pandas 索引當作 Excel 行號報告
- 絕不做數據不支持的推測性結論
