# Google Cloud 免費層部署（安全模式）

這個部署包只包含 Linux VM 需要的原始碼與 lockfile，不包含 macOS `node_modules`、桌面 Electron、AI 模型或任何 Token。

## 免費層核對

- 機型：`e2-micro`
- 地區：`us-west1`、`us-central1` 或 `us-east1`
- 開機磁碟：Standard persistent disk（`pd-standard`），所有符合資格磁碟合計不超過 30 GB-month
- 不使用 GPU、TPU、快照、額外磁碟、負載平衡器或保留靜態外部 IP
- 雲端程式提供 Discord 上線、文字聊天、直接網址／既有收藏播放與固定播放器控制
- 音樂功能不呼叫 AI：不接受歌名搜尋，也不搜尋、推薦、分析或辨識歌曲
- `CLOUD_MUSIC_MONTHLY_MINUTES=300`：每月最多播放 300 分鐘，達到上限後自動停止，預留免費層網路流量
- AI 語音、Spotify/Bilibili 搜尋與其他媒體處理不會載入；Discord 圖片附件直接交由 OpenRouter 視覺模型辨識，不佔 VM 本機推論資源
- `DISCORD_ALLOWED_USER_IDS=798893182883463179`：雲端版只接受擁有者的訊息；未設定時程式會拒絕啟動
- `HISTORY_MESSAGES=8`、`MAX_OUTPUT_TOKENS=500`：限制每次聊天帶入的短期記憶與最大回覆長度
- `DATA_DIR` 必須位於 VM persistent disk；`discord-history.jsonl` 會 append-only 保存永久原文，`HISTORY_MESSAGES` 不會刪除舊記憶
- 設定 `GEMINI_API_KEY` 後，附圖會直接使用 `GEMINI_MODEL`；一般文字仍走 OpenRouter。未設定 Gemini Key 時才沿用 `LLM_VISION_MODEL=openrouter/free`

Google Cloud 的預算警示不會自動停止計費。要保證不超額，仍須定期檢查 Billing 報表與 VM 設定。

## 在 Ubuntu VM 安裝

SSH 成功後，先上傳 `cyrene-gcp-free.zip` 到家目錄，再執行：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl unzip
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
unzip -q cyrene-gcp-free.zip
cd cyrene-gcp-free/cloud-bot
npm ci
npm run build
cp .env.example .env
```

接著由使用者本人用 `nano .env` 填入 `DISCORD_BOT_TOKEN` 與 `OPENROUTER_API_KEY`。不要把 `.env` 上傳、貼進聊天或提交到 Git。

首次驗證：

```bash
npm test
set -a
source .env
set +a
npm start
```

確認 Discord Bot 正常後，再另外設定 systemd 常駐服務。設定服務前不要刪除本機 Bot Token，且同一個 Token 不應同時讓本機與雲端 Gateway 上線。
