---
name: minimax-pdf
description: >
  當 PDF 的視覺質量和設計感很重要時，使用此 skill。
  CREATE（從零生成）："製作一個 PDF"、"生成一份報告"、"寫一份建議書"、
  "創建一份簡歷"、"精美的 PDF"、"專業文檔"、"封面"、
  "精緻的 PDF"、"客戶就緒文檔"。
  FILL（填寫表單域）："填寫表單"、"填寫這個 PDF"、
  "完成表單字段"、"將值寫入 PDF"、"這個 PDF 有哪些字段"。
  REFORMAT（對已有文檔應用設計）："重新格式化此文檔"、"應用我們的風格"、
  "將此 Markdown/文本轉換為 PDF"、"讓這個文檔看起來好看"、"重新設計此 PDF 的樣式"。
  此 skill 使用基於 token 的設計系統：顏色、排版和間距根據文檔類型派生並貫穿每一頁。輸出為打印就緒格式。
  優先使用此 skill 當外觀很重要時，而不僅僅是需要 PDF 輸出時。
license: MIT
metadata:
  version: "1.0"
  category: document-generation
---

# minimax-pdf

三項任務，一個 skill。

## 在執行任何 CREATE 或 REFORMAT 工作之前，必須閱讀 `design/design.md`

---

## 路由表

| 用戶意圖 | 路由 | 使用的腳本 |
|---|---|---|
| 從零生成一個新 PDF | **CREATE** | `palette.py` → `cover.py` → `render_cover.js` → `render_body.py` → `merge.py` |
| 填寫/完成已有 PDF 中的表單字段 | **FILL** | `fill_inspect.py` → `fill_write.py` |
| 重新格式化/重新設計已有文檔 | **REFORMAT** | `reformat_parse.py` → 完整的 CREATE 管道 |

**規則：** 當在 CREATE 和 REFORMAT 之間猶豫時，詢問用戶是否已有文檔作為起點。如有 → REFORMAT。如無 → CREATE。

---

## 路由 A: CREATE

完整管道 — 內容 → 設計 token → 封面 → 正文 → 合併 PDF。

```bash
bash scripts/make.sh run \
  --title "Q3 策略評審" --type proposal \
  --author "策略團隊" --date "2025 年 10 月" \
  --accent "#2D5F8A" \
  --content content.json --out report.pdf
```

**文檔類型：** `report` · `proposal` · `resume` · `portfolio` · `academic` · `general` · `minimal` · `stripe` · `diagonal` · `frame` · `editorial` · `magazine` · `darkroom` · `terminal` · `poster`

| 類型 | 封面模式 | 視覺標識 |
|---|---|---|
| `report` | `fullbleed` | 深色背景，點陣網格，Playfair Display |
| `proposal` | `split` | 左側面板 + 右側幾何，Syne |
| `resume` | `typographic` | 超大首詞，DM Serif Display |
| `portfolio` | `atmospheric` | 近黑色，徑向發光，Fraunces |
| `academic` | `typographic` | 淺色背景，經典襯線體，EB Garamond |
| `general` | `fullbleed` | 深灰藍，Outfit |
| `minimal` | `minimal` | 白色 + 單條 8px 強調線，Cormorant Garamond |
| `stripe` | `stripe` | 3 條粗水平色帶，Barlow Condensed |
| `diagonal` | `diagonal` | SVG 斜切，深/淺兩半，Montserrat |
| `frame` | `frame` | 內嵌邊框，角飾，Cormorant |
| `editorial` | `editorial` | 幽靈字母，全大寫標題，Bebas Neue |
| `magazine` | `magazine` | 暖米色背景，居中堆疊，主圖，Playfair Display |
| `darkroom` | `darkroom` | 深藍背景，居中堆疊，灰度圖像，Playfair Display |
| `terminal` | `terminal` | 近黑色，網格線，等寬字體，霓虹綠 |
| `poster` | `poster` | 白色背景，粗側邊欄，超大標題，Barlow Condensed |

封面附加項（通過 `--abstract`、`--cover-image` 注入 token）：
- `--abstract "文本"` — 封面上的摘要文本塊（magazine/darkroom）
- `--cover-image "url"` — 主圖 URL/路徑（magazine、darkroom、poster）

**顏色覆蓋 — 始終根據文檔內容選擇：**
- `--accent "#HEX"` — 覆蓋強調色；`accent_lt` 自動通過向白色淡化派生
- `--cover-bg "#HEX"` — 覆蓋封面背景色

**強調色選擇指南：**

你對強調色擁有創作權。從文檔的語義上下文——標題、行業、目的、受眾——中選取，而非選擇通用的"安全"色。強調色出現在節間分隔線、標註欄、表頭以及封面上：它承載著文檔的視覺標識。

| 上下文 | 建議強調色範圍 |
|---|---|
| 法律/合規/金融 | 深海軍藍 `#1C3A5E`，炭灰 `#2E3440`，石板灰 `#3D4C5E` |
| 醫療/健康 | 青綠色 `#2A6B5A`，冷綠 `#3A7D6A` |
| 技術/工程 | 鋼藍 `#2D5F8A`，靛藍 `#3D4F8A` |
| 環境/可持續 | 森林綠 `#2E5E3A`，橄欖綠 `#4A5E2A` |
| 創意/藝術/文化 | 勃艮第紅 `#6B2A35`，梅紫 `#5A2A6B`，陶土色 `#8A3A2A` |
| 學術/研究 | 深青 `#2A5A6B`，圖書館藍 `#2A4A6B` |
| 企業/中性 | 石板灰 `#3D4A5A`，石墨灰 `#444C56` |
| 奢侈/高級 | 暖黑 `#1A1208`，古銅 `#4A3820` |

**規則：** 選擇一位有品味的設計師會為這份特定文檔選擇的顏色——而不是類型的默認色。柔和、低飽和度的色調效果最好；避免鮮豔的原色。猶豫不決時，選擇更暗、更中性的顏色。

**content.json 塊類型：**

| 塊類型 | 用途 | 關鍵字段 |
|---|---|---|
| `h1` | 章節標題 + 強調分隔線 | `text` |
| `h2` | 子章節標題 | `text` |
| `h3` | 子子章節（粗體） | `text` |
| `body` | 兩端對齊段落；支持 `<b>` `<i>` 標記 | `text` |
| `bullet` | 無序列表項（• 前綴） | `text` |
| `numbered` | 有序列表項 — 計數器在遇到非編號塊時自動重置 | `text` |
| `callout` | 帶強調左側色條的高亮見解框 | `text` |
| `table` | 數據表格 — 強調色表頭，交替行底色 | `headers`, `rows`, `col_widths`?, `caption`? |
| `image` | 縮放至列寬的嵌入式圖片 | `path`/`src`, `caption`? |
| `figure` | 帶自動編號 "圖 N:" 的圖片 | `path`/`src`, `caption`? |
| `code` | 帶強調色左邊框的等寬代碼塊 | `text`, `language`? |
| `math` | 顯示數學公式 — LaTeX 語法，通過 matplotlib mathtext 渲染 | `text`, `label`?, `caption`? |
| `chart` | 使用 matplotlib 渲染的柱/折/餅圖 | `chart_type`, `labels`, `datasets`, `title`?, `x_label`?, `y_label`?, `caption`?, `figure`? |
| `flowchart` | 使用 matplotlib 繪製的流程節點 + 連線圖 | `nodes`, `edges`, `caption`?, `figure`? |
| `bibliography` | 帶懸掛縮進的編號參考文獻列表 | `items` [{id, text}], `title`? |
| `divider` | 強調色全寬分隔線 | — |
| `caption` | 小型弱化標籤 | `text` |
| `pagebreak` | 強制分頁 | — |
| `spacer` | 垂直空白 | `pt`（默認 12） |

**chart / flowchart 模式：**
```json
{"type":"chart","chart_type":"bar","labels":["Q1","Q2","Q3","Q4"],
 "datasets":[{"label":"Revenue","values":[120,145,132,178]}],"caption":"Q results"}

{"type":"flowchart",
 "nodes":[{"id":"s","label":"Start","shape":"oval"},
          {"id":"p","label":"Process","shape":"rect"},
          {"id":"d","label":"Valid?","shape":"diamond"},
          {"id":"e","label":"End","shape":"oval"}],
 "edges":[{"from":"s","to":"p"},{"from":"p","to":"d"},
          {"from":"d","to":"e","label":"Yes"},{"from":"d","to":"p","label":"No"}]}

{"type":"bibliography","items":[
  {"id":"1","text":"Author (Year). Title. Publisher."}]}
```

---

## 路由 B: FILL

填寫已有 PDF 中的表單字段，不改變佈局或設計。

```bash
# Step 1: inspect
python3 scripts/fill_inspect.py --input form.pdf

# Step 2: fill
python3 scripts/fill_write.py --input form.pdf --out filled.pdf \
  --values '{"FirstName": "Jane", "Agree": "true", "Country": "US"}'
```

| 字段類型 | 值格式 |
|---|---|
| `text` | 任意字符串 |
| `checkbox` | `"true"` 或 `"false"` |
| `dropdown` | 必須匹配 inspect 輸出中的某個選項值 |
| `radio` | 必須匹配某個 radio 值（通常以 `/` 開頭） |

始終先運行 `fill_inspect.py` 以獲取精確的字段名稱。

---

## 路由 C: REFORMAT

解析已有文檔 → content.json → CREATE 管道。

```bash
bash scripts/make.sh reformat \
  --input source.md --title "我的報告" --type report --out output.pdf
```

**支持的輸入格式：** `.md` `.txt` `.pdf` `.json`

---

## 環境

```bash
bash scripts/make.sh check   # 驗證所有依賴
bash scripts/make.sh fix     # 自動安裝缺失的依賴
bash scripts/make.sh demo    # 構建示例 PDF
```

| 工具 | 使用者 | 安裝方式 |
|---|---|---|
| Python 3.9+ | 所有 `.py` 腳本 | 系統 |
| `reportlab` | `render_body.py` | `pip install reportlab` |
| `pypdf` | fill，merge，reformat | `pip install pypdf` |
| Node.js 18+ | `render_cover.js` | 系統 |
| `playwright` + Chromium | `render_cover.js` | `npm install -g playwright && npx playwright install chromium` |
