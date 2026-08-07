"""昔漣的 macOS 全本機 OCR 介面。

圖片只會寫入權限為 0700 的系統暫存目錄，Vision 辨識完成後由
TemporaryDirectory 自動刪除。此模組不建立網路連線，也不記錄辨識文字。
"""

import asyncio
import json
import os
from pathlib import Path
import tempfile

from PIL import Image


DEFAULT_BINARY = Path.home() / ".local/share/cyrene-wavesuid/bin/cyrene-vision-ocr"
OCR_TIMEOUT_SECONDS = 90


async def recognize_images(images: list[Image.Image]) -> list[dict[str, str | None]]:
    binary = Path(os.environ.get("CYRENE_VISION_OCR_BIN", DEFAULT_BINARY)).expanduser()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        return [{"error": "找不到昔漣本機 OCR 元件", "text": None} for _ in images]

    with tempfile.TemporaryDirectory(prefix="cyrene-wuwa-ocr-") as temp_dir:
        os.chmod(temp_dir, 0o700)
        paths: list[str] = []
        for index, image in enumerate(images):
            path = Path(temp_dir) / f"crop-{index:02d}.png"
            image.save(path, format="PNG")
            paths.append(str(path))

        process = await asyncio.create_subprocess_exec(
            str(binary),
            *paths,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=OCR_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            return [{"error": "本機 OCR 逾時", "text": None} for _ in images]

    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        message = f"本機 OCR 無法執行：{detail[:160]}" if detail else "本機 OCR 無法執行"
        return [{"error": message, "text": None} for _ in images]

    try:
        results = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return [{"error": "本機 OCR 回傳格式錯誤", "text": None} for _ in images]

    if not isinstance(results, list) or len(results) != len(images):
        return [{"error": "本機 OCR 回傳數量不符", "text": None} for _ in images]
    return results
