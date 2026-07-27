#!/bin/bash

# 設定環境變量，確保 GUI 啟動時能找到 npm 和 node
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# 建立日誌資料夾（如果不存在）
mkdir -p "/Users/clark/Library/Application Support/live2d-cyrene/logs"

# 避免重複點擊啟動器後殘留多組 Vite / Electron 背景程序。
# 舊版啟動器可能沒有鎖，因此也直接檢查真正的 Electron 主程序。
if pgrep -f '^/Users/clark/cy/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \.$' > /dev/null 2>&1; then
    exit 0
fi
LOCK_DIR="/Users/clark/Library/Application Support/live2d-cyrene/cyrene-dev.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    OLD_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        exit 0
    fi
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" || exit 1
fi
echo "$$" > "$LOCK_DIR/pid"
cleanup_lock() {
    rm -rf "$LOCK_DIR"
}
trap cleanup_lock EXIT INT TERM

# 1. 檢查 GPT-SoVITS 是否已在運行 (port 9880)
if ! lsof -i :9880 > /dev/null 2>&1; then
    echo "Starting GPT-SoVITS..."
    cd /Users/clark/GPT-SoVITS
    PYTHONUNBUFFERED=1 PATH="/Users/clark/bin:$PATH" /Users/clark/GPT-SoVITS/venv/bin/python api_v2.py -a 127.0.0.1 -p 9880 > "/Users/clark/Library/Application Support/live2d-cyrene/logs/gptsovits-startup.log" 2>&1 &
    # 等待 2 秒讓服務啟動
    sleep 2
fi

# 2. 啟動桌寵
cd /Users/clark/cy
npm run dev > "/Users/clark/Library/Application Support/live2d-cyrene/logs/electron.log" 2>&1
