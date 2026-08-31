# 数据读取与分析指南

> 读取路径参考。用 `xlsx_reader.py` 做结构发现和数据质量审计，再用 pandas 做自定义分析。**绝不修改源文件。**

---

## 何时使用此路径

用户要求读取、分析、查看、汇总、提取或回答关于 Excel/CSV 文件内容的问题，且无需修改文件时。若需修改，转交 `edit.md`。

---

## 工作流

### 第 1 步 — 结构发现

先运行 `xlsx_reader.py`。它处理格式检测、编码回退、结构探索和数据质量审计：

```bash
python3 SKILL_DIR/scripts/xlsx_reader.py input.xlsx                 # 完整报告
python3 SKILL_DIR/scripts/xlsx_reader.py input.xlsx --sheet Sales   # 单工作表
python3 SKILL_DIR/scripts/xlsx_reader.py input.xlsx --quality       # 仅质量审计
python3 SKILL_DIR/scripts/xlsx_reader.py input.xlsx --json          # 机器可读
```

支持格式：`.xlsx`、`.xlsm`、`.csv`、`.tsv`。脚本对 CSV 尝试多种编码（utf-8-sig、gbk、utf-8、latin-1）。

### 第 2 步 — 用 pandas 做自定义分析

加载数据并执行用户请求的分析：

```python
import pandas as pd
df = pd.read_excel("input.xlsx", sheet_name=None)  # 所有工作表的字典
# CSV：pd.read_csv("input.csv")
```

**表头处理**（默认 `header=0` 不适用时）：

| 情况 | 代码 |
|-----------|------|
| 表头在第 3 行 | `pd.read_excel(path, header=2)` |
| 多级合并表头 | `pd.read_excel(path, header=[0, 1])` |
| 无表头 | `pd.read_excel(path, header=None)` |

**分析速查：**

| 场景 | 模式 |
|----------|---------|
| 描述性统计 | `df.describe()` 或 `df['Col'].agg(['sum', 'mean', 'min', 'max'])` |
| 分组聚合 | `df.groupby('Region')['Revenue'].agg(Total='sum', Avg='mean')` |
| 前 N | `df.groupby('Region')['Revenue'].sum().sort_values(ascending=False).head(5)` |
| 数据透视表 | `df.pivot_table(values='Revenue', index='Region', columns='Quarter', aggfunc='sum', margins=True)` |
| 时间序列 | `df.set_index(pd.to_datetime(df['Date'])).resample('ME')['Revenue'].sum()` |
| 跨表合并 | `pd.merge(sales, customers, on='CustomerID', how='left', validate='m:1')` |
| 堆叠工作表 | `pd.concat([df.assign(Source=name) for name, df in sheets.items()], ignore_index=True)` |
| 大文件（>50MB） | `pd.read_excel(path, usecols=['Date', 'Revenue'])` 或 `pd.read_csv(path, chunksize=10000)` |

### 第 3 步 — 输出

若用户指定了输出文件路径，将结果写入该路径（最高优先级）。报告格式：

```
## 分析报告：{filename}
### 文件概览     — 格式、工作表、行数
### 数据质量     — 空值、重复、混合类型（或"无问题"）
### 关键发现      — 对用户问题的直接回答
### 补充说明  — 公式 NaN、编码问题、注意事项
```

**数字显示**：货币 `1,234,567.89`、百分比 `12.3%`、倍数 `8.5x`、计数为整数。

---

## 常见陷阱

| 陷阱 | 原因 | 修复 |
|---------|-------|-----|
| 公式单元格读为 NaN | 新生成文件的 `<v>` 缓存为空 | 告知用户；建议在 Excel 中打开并重新保存；或用 `libreoffice_recalc.py` |
| CSV 编码错误 | 中文 Windows 导出用 GBK | `xlsx_reader.py` 自动尝试多种编码；若全失败则手动指定 |
| 列中混合类型 | 列同时有数字和文本（如 "N/A"） | `pd.to_numeric(df['Col'], errors='coerce')` — 报告无法转换的行 |
| 年份显示为 2,024 | 年份应用了千位分隔符格式 | `df['Year'].astype(int).astype(str)` |
| 多级表头 | 两行表头合并 | `pd.read_excel(path, header=[0, 1])`，再用 `' - '.join()` 拍平 |
| 行号不匹配 | pandas 0 索引 vs Excel 1 索引 | `excel_row = pandas_index + 2`（+1 为 1 索引，+1 为表头） |

**关键**：绝不用 `data_only=True` 打开后 `save()` — 这会永久销毁所有公式。

---

## 禁止事项

- 绝不修改源文件（无 `save()`、无 XML 编辑）
- 绝不把公式 NaN 报告为"数据为零" — 解释这是公式缓存问题
- 绝不把 pandas 索引当作 Excel 行号报告
- 绝不做数据不支持的推测性结论
