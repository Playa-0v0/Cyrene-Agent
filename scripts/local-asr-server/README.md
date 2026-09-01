# 本地 ASR 服务（FunASR）

Cyrene 语音通话的本地识别服务端。配合主程序设置页「语音识别引擎 → 本地（FunASR）」使用，
识别全程在本机完成，音频数据不出本机。

- 客户端引擎：`src/main/asr/local-asr-engine.ts`（主程序内置，无需安装）
- 本目录：独立 Python 服务，Cyrene 通过 HTTP 调用

## 安装

```bash
cd scripts/local-asr-server
python -m venv .venv
# Windows:
.venv\Scripts\pip install -r requirements.txt
# macOS / Linux:
.venv/bin/pip install -r requirements.txt
```

> 有 NVIDIA 显卡时建议先按 [pytorch.org](https://pytorch.org/get-started/locally/) 安装对应
> CUDA 版 torch，再装其余依赖（GPU 推理比 CPU 快约 10 倍）。

## 启动

```bash
python asr_server.py
```

首次启动会自动从 modelscope 下载模型（约 1-2 GB，需联网），之后离线可用。
启动后浏览器打开 <http://127.0.0.1:8328> 可查看服务状态 / 日志 / 测试识别。

## 配置（环境变量，全部可选）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ASR_HOST` | `127.0.0.1` | 监听地址 |
| `ASR_PORT` | `8328` | 监听端口 |
| `ASR_MODEL_DIR` | 脚本同目录 `models/` | 本地模型根目录（含三个子模型目录） |
| `ASR_DEVICE` | 自动检测 | `cuda:0` / `cpu` |
| `ASR_LOG_FILE` | 脚本同目录 `asr.log` | 日志文件路径 |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 网页控制台 |
| GET | `/api/status` | JSON 状态 |
| GET | `/api/logs` | 最近日志 |
| POST | `/api/logs/ingest` | 主进程日志聚合入口 |
| POST | `/v1/audio/transcriptions` | OpenAI 兼容转写（multipart，`file`=WAV） |

## 开机自启（Windows，可选）

用任务计划程序在登录时拉起（已含 pythonw 无句柄兜底，静默启动不会崩溃）：

```powershell
schtasks /create /tn "CyreneLocalASRAutostart" /tr "\"<此目录>\.venv\Scripts\pythonw.exe\" asr_server.py" /sc onlogon /rl limited
```

## 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| 双击/计划任务启动后进程消失 | 早期版本 pythonw 无标准句柄导致 uvicorn 崩溃；**本版已修复** | 升级到本版；若仍异常看 `asr_crash.log` |
| 端口 8328 被占用 | 已有实例在跑 | 本版会打日志后正常退出，不会静默失败 |
| 首次识别慢（5-20s） | 模型加载中 | 启动时已后台预热，稍等即可 |
| 一直识别不准 | 麦克风没选对 | 系统设置 → 声音 → 输入设备选正确麦克风 |
