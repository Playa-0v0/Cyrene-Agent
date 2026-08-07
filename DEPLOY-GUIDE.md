# 昔涟 v1.0.0 便携版部署指南

## 排障经验总结

### TTS 音频播放（核心）

**问题链**：MiniMax API 始终正常返回 MP3 音频 → Electron 43 + Intel Arc A380 GPU 不兼容 → 需 `--disable-gpu --in-process-gpu` 启动 → 该模式禁用 Chromium 音频管线。

**5 轮探索**：

| 轮次 | 方案 | 结果 | 原因 |
|---|---|---|---|
| 1 | HTMLAudioElement + Blob URL | ❌ `audio.onerror` | GPU 进程崩溃 |
| 2 | AudioContext.decodeAudioData + GainNode(5x) | ❌ 解码成功，无声 | `--in-process-gpu` 无音频设备路由 |
| 3 | PowerShell WMPlayer COM 隐藏窗口 | ❌ 无声 | 隐藏窗口无音频设备 |
| 4 | `cmd /c wmplayer /play` | ✅ 有声但极小 | 播放器窗口可见，音量无控制 |
| 5 | VBS wscript WMPlayer.OCX.7 | ✅ **最终方案** | 用户会话上下文，有完整音频设备 |

**最终架构**：
```
TTS 合成完成
├─ AudioContext.decodeAudioData → GainNode → 嘴型动画计时
└─ VBS WMPlayer.OCX.7 (settings.volume=100) → 系统扬声器 🔊
   嘴型时长 = bytes/16384 + 800ms 启动延迟
```

**音量调优历程**：MiniMax API volume 0.8→1.0→2.0，VBS volume 100→200→500（上限~200）

### 次要问题

| 问题 | 根因 | 修复 |
|---|---|---|
| 首次聊天历史空白 | React cold-start useEffect 与 IPC 桥接竞态 | 加 200ms 延迟 |
| 嘴型动画与音频不同步 | AudioContext `buffer.duration` 在 GPU 限制模式下不准 | 改为文件大小估算 |
| Playwright 浏览器 | v1.0.0 默认 npx + headless + Chromium | 离线 + msedge + headed |
| 便携模式 | v1.0.0 无此功能 | PORTABLE 标记 + userdata 路由 |
| XML/DSML 泄漏 | v1.0.0 仅 stripToolProtocol | 增强正则覆盖 |

---

## 便携版部署方案

### 文件结构

```
昔涟-v1.0.0-便携版/
├── start.bat                    ← Intel/AMD GPU（含 --disable-gpu）
├── start-nvidia.bat             ← Nvidia GPU（无 GPU flags）
├── PORTABLE                     ← 便携模式标记
├── dist/  node_modules/  models/  assets/  prompts/  skills/
├── opener-pack/                 ← TTS 语音包
├── vendor/  game-recipes/
└── userdata/                    ← 预置数据（设置/API/RAG/记忆）
```

### Intel Arc A380 部署（本机）

```batch
start.bat:
  electron.exe . --disable-gpu --in-process-gpu
```
- 需 `--disable-gpu --in-process-gpu` 才能启动
- VBS 保底播放音频，嘴型由文件大小估算

### Nvidia GPU 部署（目标机）

```batch
start-nvidia.bat:
  electron.exe .    （无需任何 GPU flags）
```
- GPU 正常驱动 → Chromium 音频管线可用
- AudioContext 可直接输出音频 → 无需 VBS 保底
- VBS 代码保留作为 fallback

### 部署步骤

1. 拷贝整个 `昔涟-v1.0.0-便携版/` 到目标机
2. 确保已安装 Node.js 22+ 和 Edge 浏览器
3. Nvidia GPU → 双击 `start-nvidia.bat`
4. Intel/AMD GPU → 双击 `start.bat`
5. 首次启动自动激活便携模式（创建 userdata/）

### 预置数据清单

| 类别 | 文件 | 大小 |
|---|---|---|
| 设置 | app-settings.json, model-settings.json | ~5KB |
| RAG | rag-data/ | ~4MB |
| Embedding | sticker/scene-embedding-cache.json | ~1MB |
| 模型 | BGE-M3 (560MB), bge-reranker-base, MiniLM | ~1GB |
| 语音 | opener-pack/ (9 场景) | ~6MB |
| 历史 | cyrene-chats/ | ~50KB |
| Playwright | @playwright/mcp (离线) | ~50MB |
