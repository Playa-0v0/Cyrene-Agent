#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Cyrene 本地 ASR 服务（FunASR 引擎配套服务端）
==================================================
与 src/main/asr/local-asr-engine.ts（TypeScript 客户端）配套的本地服务。
监听 127.0.0.1:8328（可用环境变量覆盖）：

    GET  /                            网页控制台（服务状态/监听地址/识别模型/日志/测试识别）
    GET  /api/status                  JSON 状态
    GET  /api/logs                    最近日志
    POST /api/logs/ingest             主进程日志聚合入口（Cyrene 通话链路日志转发）
    POST /v1/audio/transcriptions     OpenAI 兼容转写（Cyrene 通话调用）

模型：paraformer-large + fsmn-vad + punc（中文语音识别全家桶）
  - 优先使用 ASR_MODEL_DIR 下的本地模型目录
  - 未提供时由 funasr/modelscope 自动下载（首次启动需联网，约 1-2 GB）

环境变量（全部可选）：
  ASR_HOST      监听地址，默认 127.0.0.1
  ASR_PORT      监听端口，默认 8328
  ASR_MODEL_DIR 本地模型根目录（内含三个子模型目录），默认取脚本同目录 models/
  ASR_DEVICE    计算设备，默认自动检测（cuda:0 或 cpu）
  ASR_LOG_FILE  日志文件路径，默认脚本同目录 asr.log
  ASR_MODEL_ID / VAD_MODEL_ID / PUNC_MODEL_ID 模型名，默认 paraformer-large 全家桶

运行环境：Python 3.9+，依赖见同目录 requirements.txt
"""
import os
import io
import time
import wave
import logging
import threading
import collections

import numpy as np

# ================= 配置 =================
HOST = os.environ.get("ASR_HOST", "127.0.0.1")
PORT = int(os.environ.get("ASR_PORT", "8328"))
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("ASR_MODEL_DIR", os.path.join(_BASE_DIR, "models"))

# 模型名（funasr 标准模型 ID，未找到本地目录时自动下载）
ASR_MODEL_ID = os.environ.get(
    "ASR_MODEL_ID",
    "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
)
VAD_MODEL_ID = os.environ.get(
    "VAD_MODEL_ID",
    "speech_fsmn_vad_zh-cn-16k-common-pytorch",
)
PUNC_MODEL_ID = os.environ.get(
    "PUNC_MODEL_ID",
    "punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
)
TARGET_SR = 16000


def _resolve_model(model_id: str):
    """优先本地目录，否则返回模型名交给 funasr 自动下载。"""
    if MODEL_DIR and os.path.isdir(MODEL_DIR):
        local = os.path.join(MODEL_DIR, model_id)
        if os.path.isdir(local):
            return local
    return model_id


# ================= 日志（内存环形缓冲 + 文件，供网页控制台/设置页显示） =================
LOG_RING = collections.deque(maxlen=50)
RECOG_COUNT = [0]  # 已识别句数


class RingHandler(logging.Handler):
    def emit(self, record):
        try:
            LOG_RING.append(self.format(record))
        except Exception:
            pass


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("cyrene-local-asr")
_ring = RingHandler()
_ring.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
log.addHandler(_ring)
LOG_FILE = os.environ.get("ASR_LOG_FILE", os.path.join(_BASE_DIR, "asr.log"))
_file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
_file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
log.addHandler(_file_handler)

# ================= 模型懒加载（双检锁；启动时由预热线程触发） =================
_asr = None
_asr_lock = threading.Lock()
_infer_lock = threading.Lock()


def get_asr():
    """加载 FunASR 模型（双检锁，首次调用约 5~20 秒，之后立即返回）。

    服务启动时会用后台预热线程提前调用一次，避免首次通话转写卡顿；
    预热未完成时首个请求会阻塞在锁上，行为与懒加载一致，不会出错。
    """
    global _asr
    if _asr is None:
        with _asr_lock:
            if _asr is None:
                device = os.environ.get("ASR_DEVICE", "")
                if not device:
                    try:
                        import torch
                        device = "cuda:0" if torch.cuda.is_available() else "cpu"
                    except Exception:
                        device = "cpu"
                log.info("Loading FunASR models ...")
                log.info("  model_dir: %s", MODEL_DIR)
                log.info("  device:    %s", device)
                t0 = time.time()
                from funasr import AutoModel as FunASRModel
                _asr = FunASRModel(
                    model=_resolve_model(ASR_MODEL_ID),
                    vad_model=_resolve_model(VAD_MODEL_ID),
                    punc_model=_resolve_model(PUNC_MODEL_ID),
                    device=device,
                )
                log.info("  models loaded in %.1fs", time.time() - t0)
    return _asr


def _wav_to_float32(raw: bytes) -> np.ndarray:
    """WAV 字节流 -> 16kHz mono float32（paraformer 输入格式）。"""
    with wave.open(io.BytesIO(raw)) as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        data = w.readframes(w.getnframes())
    if sw == 2:
        audio = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        audio = np.frombuffer(data, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"不支持的采样位宽: {sw*8}bit")
    if ch > 1:
        audio = audio.reshape(-1, ch).mean(axis=1)
    if sr != TARGET_SR:
        import librosa
        audio = librosa.resample(audio, orig_sr=sr, target_sr=TARGET_SR)
    return audio


def recognize(raw: bytes) -> str:
    # _infer_lock 串行化推理：funasr 模型非线程安全，且 GPU 上并发推理会互相拖慢
    with _infer_lock:
        audio = _wav_to_float32(raw)
        asr = get_asr()
        r = asr.generate(input=audio, batch_size_s=300)
    text = (r[0].get("text") or "").strip() if r else ""
    return text


# ================= FastAPI =================
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse

app = FastAPI(title="Cyrene Local ASR", version="1.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", response_class=HTMLResponse)
def console():
    """网页控制台：服务状态 / 监听地址 / 识别模型 / 日志 / 测试识别"""
    return CONSOLE_HTML.replace("__PORT__", str(PORT))


@app.get("/status")
@app.get("/api/status")
def api_status():
    device = os.environ.get("ASR_DEVICE", "")
    if not device:
        try:
            import torch
            device = "cuda:0" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"
    return {
        "status": "running",
        "model_loaded": _asr is not None,
        "device": device,
        "recognized": RECOG_COUNT[0],
        "engine": "funasr-paraformer-large",
        "model_dir": MODEL_DIR,
        "endpoint": f"http://{HOST}:{PORT}/v1/audio/transcriptions",
    }


@app.get("/api/logs")
def api_logs():
    return {"logs": list(LOG_RING)}


@app.post("/api/logs/ingest")
async def api_logs_ingest(payload: dict):
    """主进程日志聚合入口：Cyrene 主进程把通话链路日志转发到这里，
    写入 LOG_RING，设置页"查看日志"面板即可看到 ASR/LLM/TTS 全链路日志。"""
    level = str(payload.get("level", "INFO")).upper()
    message = str(payload.get("message", "")).strip()
    source = str(payload.get("source", "main"))
    if not message:
        return JSONResponse({"ok": False, "reason": "empty message"}, status_code=400)
    line = f"[{source}] {message}"
    if level == "ERROR":
        log.error(line)
    elif level == "WARN":
        log.warning(line)
    else:
        log.info(line)
    return {"ok": True, "level": level, "log": line}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form("moss-transcribe"),
    response_format: str = Form("json"),
):
    """OpenAI 兼容转写入口。请求体为 multipart/form-data：
    file=WAV 音频，返回 {"text": "..."}。结构与 OpenAI /v1/audio/transcriptions
    对齐，local-asr-engine.ts 按此契约消费。"""
    t0 = time.time()
    raw = await file.read()
    log.info("[POST /v1/audio/transcriptions] file=%s size=%dB model=%s",
             file.filename, len(raw), model)
    if not raw:
        return JSONResponse({"error": {"message": "empty audio"}}, status_code=400)
    try:
        text = recognize(raw)
    except Exception as e:
        log.exception("recognize failed")
        return JSONResponse({"error": {"message": str(e)}}, status_code=500)
    RECOG_COUNT[0] += 1
    log.info("  done %.2fs -> %r", time.time() - t0, text[:40])
    return {"text": text}


CONSOLE_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cyrene 本地 ASR 控制台</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#f5f6f8;padding:24px;color:#1f2328}
.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;margin-bottom:4px}
h2{font-size:15px;margin-bottom:12px;color:#1f2328}
.sub{color:#57606a;font-size:13px;margin-bottom:16px}
.row{display:flex;gap:24px;flex-wrap:wrap}
.item{min-width:180px}
.item .label{font-size:12px;color:#57606a;margin-bottom:4px}
.item .value{font-size:14px;font-weight:500}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.dot.ok{background:#1a7f37}.dot.wait{background:#9a6700}.dot.err{background:#cf222e}
pre.log{background:#0d1117;color:#e6edf3;border-radius:8px;padding:14px;font-size:12px;
  max-height:240px;overflow:auto;line-height:1.7;white-space:pre-wrap;word-break:break-all}
.btn{background:#1f883d;color:#fff;border:none;border-radius:6px;padding:8px 18px;
  font-size:13px;cursor:pointer;margin-right:8px}
.btn:hover{opacity:.9}
.upload-row{display:flex;align-items:center;gap:12px;margin-top:12px}
input[type=file]{font-size:13px}
.result{margin-top:14px;padding:12px;border-radius:8px;background:#f0f7ff;border:1px solid #b6d4fe;
  font-size:14px;display:none}
.result .text{font-size:15px;font-weight:500;margin-top:6px;color:#0a3069}
.status-line{font-size:13px;margin-top:10px;color:#57606a}
</style></head><body>
<h1>Cyrene 本地 ASR 控制台</h1>
<div class="sub">FunASR 本地语音识别 · 数据不出本机 · 供 Cyrene 语音通话调用</div>

<div class="card">
<h2>服务状态</h2>
<div class="row">
  <div class="item"><div class="label">运行状态</div><div class="value"><span class="dot ok" id="st-dot"></span><span id="st-status">检测中...</span></div></div>
  <div class="item"><div class="label">监听地址</div><div class="value">http://127.0.0.1:__PORT__</div></div>
  <div class="item"><div class="label">识别模型</div><div class="value">paraformer-large + fsmn-vad + punc</div></div>
  <div class="item"><div class="label">计算设备</div><div class="value" id="st-device">-</div></div>
  <div class="item"><div class="label">已识别句数</div><div class="value" id="st-count">0</div></div>
</div>
<div class="status-line" id="st-line">模型首次加载需 3-20 秒（取决于设备），之后每句约 0.3-3 秒。</div>
</div>

<div class="card">
<h2>测试识别</h2>
<div class="sub">上传一段 WAV（16kHz 单声道）或直接对着麦克风录 3 秒</div>
<div class="upload-row">
  <input type="file" id="wav" accept=".wav">
  <button class="btn" onclick="testRecognize()">识别这个文件</button>
</div>
<div class="result" id="result"><div class="label">识别结果</div><div class="text" id="result-text"></div></div>
</div>

<div class="card">
<h2>最近日志</h2>
<pre class="log" id="logs">加载中...</pre>
</div>

<script>
async function refresh() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    document.getElementById('st-status').textContent = s.model_loaded ? '运行中（模型已加载）' : '运行中（模型未加载）';
    document.getElementById('st-dot').className = 'dot ' + (s.model_loaded ? 'ok' : 'wait');
    document.getElementById('st-device').textContent = s.device || '-';
    document.getElementById('st-count').textContent = s.recognized || 0;
    const lr = await fetch('/api/logs');
    const logs = await lr.json();
    document.getElementById('logs').textContent = (logs.logs || []).join('\\n') || '(暂无日志)';
  } catch(e) {
    document.getElementById('st-status').textContent = '无法连接服务';
    document.getElementById('st-dot').className = 'dot err';
  }
}
async function testRecognize() {
  const fileInput = document.getElementById('wav');
  if (!fileInput.files || !fileInput.files[0]) { alert('请先选择 wav 文件'); return; }
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  fd.append('model', 'moss-transcribe');
  document.getElementById('result').style.display = 'block';
  document.getElementById('result-text').textContent = '识别中...';
  try {
    const r = await fetch('/v1/audio/transcriptions', { method: 'POST', body: fd });
    const d = await r.json();
    document.getElementById('result-text').textContent = d.text || ('错误: ' + JSON.stringify(d));
  } catch(e) {
    document.getElementById('result-text').textContent = '识别失败: ' + e;
  }
  refresh();
}
refresh();
setInterval(refresh, 3000);
</script></body></html>"""


def _port_in_use(host: str, port: int) -> bool:
    """检查端口是否已被占用（已有实例在跑时直接退出，避免静默失败）。"""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex((host, port)) == 0


if __name__ == "__main__":
    import sys
    import uvicorn

    # --- Windows 静默启动兜底（pythonw / bat / 计划任务场景） ---
    # pythonw 被无标准句柄方式启动时 sys.stdout/stderr 为 None，
    # uvicorn 的 ColorFormatter 调 isatty() 会 AttributeError 直接退出
    # （无窗口、无报错、无日志，极难排查）。补 devnull 兜底。
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w")

    # --- 故障诊断：pythonw 无控制台，崩溃/卡死无迹可循 ---
    # faulthandler 落盘 asr_crash.log + 60 秒看门狗：
    # 启动后 60 秒内 uvicorn 未完成绑定（模型加载死锁/依赖崩溃）则转储线程栈并退出。
    import faulthandler
    _FH = open(os.path.join(_BASE_DIR, "asr_crash.log"), "a", encoding="utf-8")
    _FH.write("==== startup %s pid=%d ====\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), os.getpid()))
    _FH.flush()
    faulthandler.enable(file=_FH)
    faulthandler.dump_traceback_later(timeout=60, file=_FH, exit=True)

    @app.on_event("startup")
    async def _cancel_watchdog():
        faulthandler.cancel_dump_traceback_later()

    # --- 端口守卫：已有实例时打日志退出，而不是静默失败或端口冲突崩溃 ---
    if _port_in_use(HOST, PORT):
        log.error("port %d already in use - another ASR instance is running, exit.", PORT)
        raise SystemExit(1)

    # --- 启动预热：后台线程加载 FunASR 模型（约 5~20 秒），避免首次通话转写卡顿 ---
    # get_asr() 自带双检锁，预热未完成时首个请求会等锁，行为与懒加载一致。
    threading.Thread(target=get_asr, name="model-preload", daemon=True).start()
    log.info("Cyrene Local ASR listening on http://%s:%d (models preloading)", HOST, PORT)
    log.info("model_dir: %s", MODEL_DIR)
    try:
        uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
    except BaseException:
        import traceback
        _FH.write("FATAL in uvicorn.run:\n" + traceback.format_exc() + "\n")
        _FH.flush()
        raise
