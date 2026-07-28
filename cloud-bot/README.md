# Cyrene Cloud Discord Bot

這是 Cyrene-Agent 的無視窗雲端文字服務。它在 Linux 容器中維持 Discord Gateway 長連線，讓電腦關機後 Bot 仍保持上線。

## 第一階段包含

- Discord 私訊、`@Bot` 群組訊息；附圖時自動辨識，不需要額外指令
- `/chat`（可附圖）、`/status`、`/forget`
- OpenAI 相容聊天 API
- `/data` 持久化短期對話
- `/health` 健康檢查
- 使用者、伺服器與頻道白名單

語音、音樂、桌面檔案、畫面辨識與本機工具刻意停用，避免雲端 Bot 假裝能操作已關機的電腦。

## 本機驗證

```bash
npm install
npm test
```

複製 `.env.example` 為 `.env` 並填入 Discord Bot Token 與 LLM API Key，才可執行 `npm run dev`。

## Render 部署

`render.yaml` 已描述一個 Docker Web Service、健康檢查與 1 GB 持久磁碟。建立服務時必須自行填入秘密環境變數，切勿把 Token 或 API Key 提交進 Git。

必要秘密：

- `DISCORD_BOT_TOKEN`
- `OPENROUTER_API_KEY`（也相容既有的 `LLM_API_KEY`）
- `GEMINI_API_KEY`（建議；OpenRouter 免費額度用盡時自動備援）
- `SPOTIFY_CLIENT_ID`、`SPOTIFY_CLIENT_SECRET`、`SPOTIFY_REFRESH_TOKEN`（讓雲端 `/play`、`/spotify` 控制官方 Spotify 裝置）

建議另外設定 `DISCORD_ALLOWED_USER_IDS`，只允許自己的 Discord User ID。

使用 OpenRouter 時可設定 `OPENROUTER_API_KEY`、`LLM_BASE_URL=https://openrouter.ai/api/v1`、`LLM_MODEL=openrouter/free`。`LLM_VISION_MODEL` 預設沿用聊天模型；維持 `openrouter/free` 會自動路由至能看圖的免費模型，也能填入 OpenRouter 上的 Gemini 模型名稱，讓附圖訊息固定交給 Gemini。

設定 `GEMINI_API_KEY` 後，OpenRouter `openrouter/free` 回傳 402、429 或明確的額度耗盡錯誤時，會以 `GEMINI_MODEL`（預設 `gemini-3.5-flash-lite`）重新送出同一輪請求。

`/play` 與 `/spotify` 不會在 Discord 語音頻道轉播 YouTube 音源；它們透過 Spotify Connect 控制帳號目前啟用的官方裝置，因此會沿用 Premium 免廣告權益。
