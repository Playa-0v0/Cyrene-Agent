#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OWNER_ID="${DISCORD_OWNER_ID:-798893182883463179}"
PLUGIN_DIR="$SCRIPT_DIR/plugins/WutheringWavesUID"
CONFIG_PATH="$SCRIPT_DIR/data/config.json"

if ! command -v docker >/dev/null 2>&1; then
  echo "找不到 Docker。請先安裝 Docker Desktop 或 Docker Engine。" >&2
  exit 1
fi

mkdir -p "$SCRIPT_DIR/data" "$SCRIPT_DIR/plugins"

if [[ -d "$PLUGIN_DIR/.git" ]]; then
  git -C "$PLUGIN_DIR" pull --ff-only
else
  git clone --depth=1 https://github.com/moonshadow1976/WutheringWavesUID.git "$PLUGIN_DIR"
fi

python3 - "$CONFIG_PATH" "$OWNER_ID" <<'PY'
import json
import secrets
import sys
from pathlib import Path

path = Path(sys.argv[1])
owner_id = sys.argv[2]
config = {}
if path.exists():
    config = json.loads(path.read_text(encoding="utf-8"))
config.update({
    "HOST": "0.0.0.0",
    "PORT": "8765",
    "ENABLE_HTTP": True,
    "masters": [owner_id],
    "command_start": [],
})
config.setdefault("WS_TOKEN", secrets.token_urlsafe(32))
config.setdefault("TRUSTED_IPS", ["localhost", "::1", "127.0.0.1"])
config.setdefault("superusers", [])
config.setdefault("REGISTER_CODE", secrets.token_hex(16))
path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d
echo "GsCore 與 WutheringWavesUID 已啟動：http://127.0.0.1:8765/app"
echo "回 Discord 私訊昔漣並輸入：ww幫助"
