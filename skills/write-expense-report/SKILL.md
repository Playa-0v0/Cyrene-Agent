---
name: write-expense-report

description: 当用户要生成记账/支出报告时用。读取近期支出数据，按类目汇总，输出 Excel
tools:
  - query_expense
  - write_excel
version: 1.0.0
modes:
  - work
---

# 写支出报告

执行步骤：
1. 调用 query_expense（days=30, summary=true）取近 30 天支出汇总
2. 如需明细，再调 query_expense（days=30）取逐笔
3. 用 write_excel 输出报告，列定义见 references/column-spec.md
4. 输出前向用户确认时间范围

注意：金额保留两位小数，按类目降序排列。
