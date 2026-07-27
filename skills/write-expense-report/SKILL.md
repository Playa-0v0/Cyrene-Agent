---
name: write-expense-report
description: 當用戶要生成記賬/支出報告時用。讀取近期支出數據，按類目彙總，輸出 Excel
tools: [query_expense, write_excel]
version: 1.0.0
---

# 寫支出報告

執行步驟：
1. 調用 query_expense（days=30, summary=true）取近 30 天支出彙總
2. 如需明細，再調 query_expense（days=30）取逐筆
3. 用 write_excel 輸出報告，列定義見 references/column-spec.md
4. 輸出前向用戶確認時間範圍

注意：金額保留兩位小數，按類目降序排列。
