# Cyrene Cloud Discord Bot

這是 Cyrene-Agent 的無視窗雲端文字服務。它在 Linux 容器中維持 Discord Gateway 長連線，讓電腦關機後 Bot 仍保持上線。

## 第一階段包含

- Discord 私訊、`@Bot` 群組訊息
- `/chat`、`/status`、`/forget`
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
- `LLM_API_KEY`

建議另外設定 `DISCORD_ALLOWED_USER_IDS`，只允許自己的 Discord User ID。
