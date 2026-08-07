# 昔漣 × WutheringWavesUID

這個目錄啟動昔漣的鳴潮查詢後端。國際服使用 MoonShadow1976 的分支，截圖辨識則改用
macOS 內建 Vision，全程不連接 OCR.space。Discord Bot 透過只綁定在本機的 GsCore HTTP
介面呼叫 `WutheringWavesUID`；不需要建立第二隻 Discord Bot。

## 隱私模式

- 角色卡請從昔漣 Electron 的「鳴潮工具」選擇，或擷取 Discord 已開啟的大圖；不要重新貼圖給昔漣 Bot。
- 圖片只存在程序記憶體及權限為 `0700` 的暫存目錄；辨識結束立即清除。
- GsCore 日誌會把圖片與附件內容替換成遮罩，不會記錄 base64 或 OCR 文字。
- 辨識後的 UID、角色、武器、技能與聲骸資料仍會保存在本機，UI 可依 UID 刪除。
- 雲端昔漣會拒絕截圖分析，避免圖片被轉送到雲端 GsCore。

## Electron 免手動截圖

昔漣的「鳴潮工具」可以擷取 Discord 視窗中已開啟的官方 `/create` 角色卡：

1. 在 Discord 點開 wuwa bot 回傳的橫向角色卡，讓圖片以大圖顯示。
2. 回到昔漣 → 鳴潮工具，按「擷取 Discord」。
3. `cyrene-vision-card-crop` 會在本機找出角色卡、裁切並交給 Vision OCR。

擷取原圖與裁切圖只存在權限受限的系統暫存目錄，分析完成或失敗後都會立即刪除。這個
流程不會讀取官方 Bot 的私有程式碼、冒用 Discord 使用者，也不會把 Discord 視窗截圖
上傳到第三方。若卡片仍是聊天縮圖，解析度可能不足，必須先點開大圖。

WutheringWavesUID 內建的 PCAP 功能會把封包送往第三方解析服務；昔漣不會自動啟用這條
流程。若要達成真正的「不經官方 Bot、全本機直接讀遊戲資料」，仍需另行實作鳴潮封包
協定的本機解析器。

已存在本機版 GsCore 時，可重新編譯及套用隱私修正：

```bash
bash integrations/wutheringwavesuid/install-local-ocr.sh
launchctl kickstart -k gui/$(id -u)/com.cyrene.gsuid-core
```

## 啟動

需要 Docker Desktop／Docker Engine、Git 與 Python 3：

```bash
bash integrations/wutheringwavesuid/setup.sh
```

啟動後可開啟 <http://127.0.0.1:8765/app>，或在 Discord 使用：

```text
/ww command:幫助
@昔漣 ww幫助
@昔漣 ww今汐面板
```

第一次若提示素材不足，使用擁有者帳號輸入：

```text
ww下載全部資源
```

登入、Token、Cookie、抽卡連結與匯入等敏感指令只能在私訊中執行。截圖分析只能從 Electron
執行。不要將 GsCore 的 `8765`
連接埠開放到公網；它的 HTTP `/api/send_msg` 介面沒有獨立的請求 Token。

## 雲端昔漣

若雲端 Bot 與 GsCore 在同一台 VM 上，維持：

```dotenv
GSCORE_HTTP_URL=http://127.0.0.1:8765
```

然後重新建置並啟動 `cloud-bot`。若 Bot 本身也在 Docker 容器內，將 URL 改成同一個 Compose
網路裡的服務名稱，例如 `http://gsuid_core:8765`，不要為了方便直接公開 `8765`。

## 更新與停止

```bash
git -C integrations/wutheringwavesuid/plugins/WutheringWavesUID pull --ff-only
docker compose -f integrations/wutheringwavesuid/docker-compose.yml restart
```

```bash
docker compose -f integrations/wutheringwavesuid/docker-compose.yml down
```
