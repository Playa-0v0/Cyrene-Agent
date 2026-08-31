# FIX — 修复已有 xlsx 中的损坏公式

这是一项编辑任务。你必须保留所有原始工作表和数据。绝不创建新工作簿。

## 工作流

```bash
# 第 1 步：识别错误
python3 SKILL_DIR/scripts/formula_check.py input.xlsx --json

# 第 2 步：解包
python3 SKILL_DIR/scripts/xlsx_unpack.py input.xlsx /tmp/xlsx_work/

# 第 3 步：用 Edit 工具修复工作表 XML 中每个损坏的 <f> 元素
#   （见下方"错误→修复"映射）

# 第 4 步：打包并验证
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
python3 SKILL_DIR/scripts/formula_check.py output.xlsx
```

## 错误→修复映射

| 错误 | 修复策略 |
|-------|-------------|
| `#DIV/0!` | 包裹：`IFERROR(原公式, "-")` |
| `#NAME?` | 修复拼错的函数（如 `SUMM` → `SUM`） |
| `#REF!` | 重建断裂的引用 |
| `#VALUE!` | 修复类型不匹配 |

完整的 Excel 错误类型列表和高级诊断，见 `validate.md`。

## 关键规则

- 输出必须包含与输入相同的工作表。绝不创建新工作簿。
- 只修改损坏的特定 `<f>` 元素 — 其他一切必须不动。
- 打包后，始终运行 `formula_check.py` 确认所有错误已解决。
