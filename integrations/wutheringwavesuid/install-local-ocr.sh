#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="${CYRENE_WAVESUID_ROOT:-$HOME/.local/share/cyrene-wavesuid}"
GSCORE_ROOT="$INSTALL_ROOT/gsuid_core"
BIN_DIR="$INSTALL_ROOT/bin"
PLUGIN_DIR="$INSTALL_ROOT/gsuid_core/gsuid_core/plugins/WutheringWavesUID"
ANALYZE_DIR="$PLUGIN_DIR/WutheringWavesUID/wutheringwaves_analyzecard"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "全本機 Vision OCR 目前只支援 macOS。" >&2
  exit 1
fi
if [[ ! -d "$ANALYZE_DIR" ]]; then
  echo "找不到國際服 WutheringWavesUID：$ANALYZE_DIR" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
xcrun swiftc \
  -O \
  -framework AppKit \
  -framework Vision \
  "$SCRIPT_DIR/local-ocr/vision_ocr.swift" \
  -o "$BIN_DIR/cyrene-vision-ocr"
chmod 700 "$BIN_DIR/cyrene-vision-ocr"
xcrun swiftc \
  -O \
  -framework AppKit \
  -framework Vision \
  "$SCRIPT_DIR/local-ocr/vision_card_crop.swift" \
  -o "$BIN_DIR/cyrene-vision-card-crop"
chmod 700 "$BIN_DIR/cyrene-vision-card-crop"
cp "$SCRIPT_DIR/local-ocr/local_ocr.py" "$ANALYZE_DIR/local_ocr.py"
python3 "$SCRIPT_DIR/local-ocr/apply_patch.py" "$GSCORE_ROOT"

echo "本機 OCR 已安裝：$BIN_DIR/cyrene-vision-ocr"
echo "角色卡裁切器已安裝：$BIN_DIR/cyrene-vision-card-crop"
