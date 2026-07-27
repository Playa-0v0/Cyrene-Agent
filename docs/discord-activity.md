# 昔漣 Discord Activity：繩結同行

這個版本將《繩結同行》包裝成 Discord Activity。遊戲內容與桌面版共用
`src/renderer/public/ropebound-original`，Activity 透過 Supabase Realtime 同步房間、Player 2
按鍵與房主遊戲狀態。

## 需要的 Discord 設定

1. 使用「昔漣 Bot」目前所屬的同一個 Discord Application。
2. 在 Discord Developer Portal 的 **Activities → Settings** 開啟 Activities。
3. 將部署後的 HTTPS 網址新增為 URL Mapping：Prefix 使用 `/`，Target 使用部署網域。
4. 新增 Realtime Mapping：Prefix 使用 `/supabase`，Target 使用
   `uyuerqfitpcfiyfajpbt.supabase.co`。
5. 確認 App 安裝時包含 `applications.commands` scope。
6. 重新連接昔漣 Bot；她會註冊 `/game` 指令。

玩家執行 `/game` 時，昔漣會用 Discord 的 `LAUNCH_ACTIVITY` 回應直接開啟遊戲。
Developer Portal 啟用 Activities 後也會自動建立預設的 Entry Point「Launch」。

Discord 官方參考：

- https://docs.discord.com/developers/activities/how-activities-work
- https://docs.discord.com/developers/activities/building-an-activity
- https://docs.discord.com/developers/developer-tools/embedded-app-sdk

## 本機設定與建置

在專案根目錄建立 `.env.discord-activity`：

```env
VITE_DISCORD_CLIENT_ID=昔漣的_DISCORD_APPLICATION_ID
VITE_SUPABASE_URL=https://你的專案.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=你的_PUBLISHABLE_KEY
```

然後執行：

```bash
npm run build:discord-activity
```

輸出位於 `dist/discord-activity`。Activity 必須以 HTTPS 網站部署，不能直接使用 Electron
的 `file://` 頁面。

## Vercel 部署

```bash
vercel --local-config discord-activity.vercel.json
```

在 Vercel 專案的 Environment Variables 同樣設定 `VITE_DISCORD_CLIENT_ID`，再重新部署。

## 遊玩範圍

- 同一個 Discord Activity instance 的第一位非單人玩家成為房主。
- 第一位選擇「跟房主一起玩」的人控制 Player 2；房主保存與廣播共同關卡狀態。
- 沒有真人 Player 2 時，遊戲自動把昔漣選為 AI 同伴。
- 其他人可以選擇「自己開心地玩」，其單人進度不受房主影響。
