# 昔涟 v1.0.0 → v1.0.1 修复日志

> 基于 GitHub v1.0.0 重建，迁移 v0.5.0 关键修复，适配 Electron 43 + Intel Arc A380 环境。

---

## 一、TTS 音频播放（核心排障）

### 问题链

MiniMax API 始终正常返回有效 MP3 音频（ID3v2.4 头，60~140KB）→ Electron 43 + Intel Arc A380 GPU 不兼容 → 需 `--disable-gpu --in-process-gpu` 启动 → 此模式禁用 Chromium 音频管线。

### 5 轮播放方案迭代

| 轮次 | 方案 | 结果 | 根因 |
|---|---|---|---|
| 1 | `HTMLAudioElement` + Blob URL | ❌ `audio.onerror` | GPU 进程崩溃，无法解码 |
| 2 | `AudioContext.decodeAudioData` + GainNode(5x) | ❌ 解码成功，无声 | `--in-process-gpu` 吞掉音频设备路由 |
| 3 | PowerShell WMPlayer COM 隐藏窗口 | ❌ 无声 | 隐藏窗口无音频设备访问权 |
| 4 | `cmd /c wmplayer /play` | ✅ 有声但弹窗 + 极轻 | 无音量控制，窗口可见 |
| 5 | **VBS wscript WMPlayer.OCX.7** | ✅ 最终方案 | 用户会话上下文，完整音频设备 |

### 音量调优历程

| 参数 | 起始值 | 最终值 | 效果 |
|---|---|---|---|
| MiniMax API `volume` | 0.8 | **2.0** | 音源提升 ~2.5x |
| VBS `settings.volume` | 100 | **100** | COM 有天然上限（~200） |

### 最终音频架构

```
TTS 合成完成（主进程 MiniMax WebSocket）
  ├─ AudioContext.decodeAudioData + GainNode(5x) → 嘴型动画计时
  └─ VBS wscript WMPlayer.OCX.7 → Windows 原生扬声器 🔊
     嘴型时长 = bytes/16384 + 800ms (系统播放器启动延迟)
```

### 嘴型同步

- **旧方案**: AudioContext `buffer.duration` → GPU 模式下不准确 → 嘴型与音频脱节
- **新方案**: 文件大小估算 `bytes * 8 / 128000` (MP3@128kbps) + 800ms 延迟补偿
- **架构**: AudioContext 仅用于解码 + 嘴型计时，真实音频由 VBS 系统播放器输出

### 关键文件

| 文件 | 改动 |
|---|---|
| `src/main/tts/minimax-engine.ts` | 音量诊断日志 + 音频格式验证 |
| `src/main/tts/tts-ipc.ts` | `TTS_SYSTEM_PLAY` IPC → VBS + wscript 播放 |
| `src/main/services/tts/tts-synthesis-service.ts` | `supportsStreamingPlayback` 检查 → 非流式合成 |
| `src/renderer/react/features/chat/components/tts-playback.ts` | GainNode 5.0 + 文件大小估算嘴型 + 系统播放器保底 |
| `src/renderer/settings/tts/panel.ts` | GainNode 5.0 + 系统播放器保底 |
| `src/shared/ipc-channels.ts` | 新增 `TTS_SYSTEM_PLAY` 通道 |
| `src/preload/index.ts` | `__cyreneTtsFallback` contextBridge |

---

## 二、次要问题修复

### 2.1 GPU 兼容性

**问题**: Electron 43 + Intel Arc A380 → GPU 进程立即崩溃

**修复**: `start.bat` 中添加 `--disable-gpu --in-process-gpu` 参数

**副作用及应对**:
- Chromium 音频管线不可用 → VBS 系统播放器保底
- 截图助手(Native Rust)可能受影响 → 降级为可选
- **Nvidia GPU 不受影响** → `start-nvidia.bat` 无需 GPU flags

### 2.2 窗口管理

**问题**: 关闭聊天窗口后再点击"打开聊天"无法弹出

**根因**: `registerChatUiIpc` 在 `initIpcHandlers()` 中解构 `deps.windowManager`。由于 IPC 注册移至 `app.whenReady()` 内执行，此时 `windowManager` 变量仍为 `null`（后续才赋值），解构固化了 `null` 值。

**修复**: 不进行解构，改用 `deps.windowManager` 延迟求值；同时增加 `destroyed` 事件 + `isDestroyed()` 显式清理。

**文件**: `src/main/chats/chat-ui-ipc.ts`, `src/main/windows/create-aux-windows.ts`

### 2.3 首次进入聊天历史空白

**问题**: React ChatPage 冷启动时 IPC 桥接竞态，`refreshSessions` 在 store 就绪前调用

**修复**: 冷启动 `useEffect` 中添加 200ms 延迟

**文件**: `src/renderer/react/features/chat/pages/ChatPage.tsx`

### 2.4 计划模式进度条 100% 不消失

**问题**: LLM 将任务标记为 `completed` 而非传空数组，面板不消失

**修复**: TodoPanel 增加 `allCompleted` 检查（已由 v1.0.0 React 重构解决）

### 2.5 其他修复（从 v0.5.0 迁移）

| 修复 | 文件 | 说明 |
|---|---|---|
| 轮数上限 20→100 + N=10 无进展检测 | `two-phase-fc-loop.ts` | 防止长时间空转 |
| EPIPE 防御 | `index.ts` | `try-catch` 包裹 `process.stdout.write` |
| Playwright 离线 + headed + Edge | `sync-mcp-builtin.ts` | 本地 cli.js + `--browser msedge` |
| XML/DSML 7 层防护 | `langgraph-agent-loop.ts` | HTML实体解码 + DSML全角竖线 + tool_calls包裹 |
| 渲染器 loadFile 路径 | `create-aux-windows.ts` 等 | 7 处 `../../renderer` → `../../../renderer` |
| 便携模式 | `index.ts` | PORTABLE 标记 + userdata 数据路由 |
| BGE-M3 / Reranker / opener-pack | models/ + opener-pack/ | 模型文件迁移 |
| Rust 截图助手 | `resources/bin/cyrene-screenshot.exe` | VS 2022 Build Tools + Cargo 编译 |

---

## 三、Electron 43 兼容性修复

| 问题 | 修复 |
|---|---|
| `ELECTRON_RUN_AS_NODE=1` 残留导致启动崩溃 | `start.bat` 中显式清除环境变量 |
| `socialContextService` 初始化时 `app.getPath` 不可用 | 延迟到 `app.whenReady()` 后 |
| IPC handlers 注册时机 | 全部移入 `initIpcHandlers()`，在 `app.whenReady()` 内调用 |
| `registerPrivilegedSchemes` 崩溃 | try-catch 包裹，ready 后重试 |
| `process.stdout.write` EPIPE 崩溃 | try-catch 包裹 |

---

## 四、部署方案

### Intel Arc A380 (本机)
```
start.bat → electron.exe . --disable-gpu --in-process-gpu
```
- VBS 系统播放器保底音频
- 嘴型由文件大小估算

### Nvidia GPU (目标机)
```
start-nvidia.bat → electron.exe . （无 GPU flags）
```
- AudioContext 正常输出 → 无需 VBS 保底
- VBS 代码保留作为 fallback

---

*生成时间: 2026-08-07 | Cyrene v1.0.1*
