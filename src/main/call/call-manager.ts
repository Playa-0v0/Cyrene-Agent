// 通话轮次协调器 —— 编排 ASR → agent → TTS 的轮次循环。
//
// 状态机：
//   IDLE → LISTENING → (VAD 静默) → THINKING → (agent+TTS) → SPEAKING → (播完) → LISTENING
//
// 配置通过 setCallSettings 注入 getter（避免 import index.ts 循环依赖）。

import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { VolcanoAsrStream, getAsrConfig } from "../asr/volcano-asr-engine";
import { synthesize as minimaxSynthesize } from "../tts/minimax-engine";
import { runFunctionCallingLoop } from "../orchestrator";

const LOG_PREFIX = "[CallManager]";

export type CallState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "ERROR" | "ENDED";

let callWindow: BrowserWindow | null = null;
let asrStream: VolcanoAsrStream | null = null;
let currentState: CallState = "IDLE";
let finalText = "";
let active = false;

// 注入的配置 getter（由 index.ts 启动时设置，避免循环依赖）
let modelSettingsGetter: (() => {
  provider: string; baseUrl: string; model: string; apiKey: string;
}) | null = null;
let ttsSettingsGetter: (() => {
  ttsEngine: string; ttsMinimaxKey: string; ttsMinimaxVoiceId: string;
  ttsSpeed: number; ttsVolume: number; ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
}) | null = null;

/** index.ts 启动时注入模型配置和 TTS 配置的获取器。 */
export function setCallSettings(
  modelGetter: () => { provider: string; baseUrl: string; model: string; apiKey: string },
  ttsGetter: () => {
    ttsEngine: string; ttsMinimaxKey: string; ttsMinimaxVoiceId: string;
    ttsSpeed: number; ttsVolume: number; ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  },
): void {
  modelSettingsGetter = modelGetter;
  ttsSettingsGetter = ttsGetter;
}

/** 绑定通话窗口（createCallWindow 调一次）。 */
export function setCallWindow(win: BrowserWindow | null): void {
  callWindow = win;
}

/** 是否正在通话中。 */
export function isCallActive(): boolean {
  return active;
}

function sendState(state: CallState): void {
  currentState = state;
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send(IPC.CALL_STATE, { state });
  }
  console.log(LOG_PREFIX, "状态 →", state);
}

function sendError(message: string): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send(IPC.CALL_ERROR, { message });
  }
  console.error(LOG_PREFIX, "错误:", message);
}

function sendAsrResult(partial: string | undefined, final: string | undefined): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send(IPC.CALL_ASR_RESULT, { partial, final });
  }
}

function sendTtsAudio(base64: string): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send(IPC.CALL_TTS_AUDIO, { base64 });
  }
}

/** 开始通话：初始化 ASR 流，进入 LISTENING。 */
export function startCall(): void {
  if (active) return;
  const cfg = getAsrConfig();
  if (!cfg || cfg.engine !== "aliyun" || !cfg.appKey || !cfg.accessKeyId || !cfg.accessKeySecret) {
    sendError("ASR 未配置：请在设置→ASR 中配置阿里云 AppKey 和 AccessKey");
    sendState("ERROR");
    return;
  }

  active = true;
  finalText = "";
  startAsrStream(cfg);
  sendState("LISTENING");
}

/** 创建并启动一个 ASR 流。 */
function startAsrStream(cfg: { appKey: string; accessKeyId: string; accessKeySecret: string; language: string }): void {
  asrStream = new VolcanoAsrStream(
    (text) => sendAsrResult(text, undefined),
    (text) => { finalText = text; sendAsrResult(undefined, text); },
  );
  asrStream.start(cfg.appKey, cfg.accessKeyId, cfg.accessKeySecret, cfg.language);
}

/** 结束本轮（VAD 静默）：停 ASR → 跑 agent → TTS → 播放。 */
export async function endTurn(): Promise<void> {
  if (!active || currentState !== "LISTENING") return;

  if (asrStream) asrStream.stop();

  const text = finalText.trim();
  finalText = "";

  if (!text) {
    // 空文本，直接重启 ASR 回 LISTENING
    restartAsr();
    return;
  }

  sendState("THINKING");

  try {
    // 调 agent 获取回复
    const reply = await runAgentTurn(text);
    if (!reply) {
      sendError("未收到 agent 回复");
      sendState("LISTENING");
      restartAsr();
      return;
    }

    // TTS 合成
    const tts = ttsSettingsGetter?.();
    if (!tts || tts.ttsEngine === "off" || !tts.ttsMinimaxKey || !tts.ttsMinimaxVoiceId) {
      sendError("TTS 未配置：请在设置中配置 MiniMax TTS");
      sendState("LISTENING");
      restartAsr();
      return;
    }

    sendState("SPEAKING");
    const audioBuffer = await minimaxSynthesize({
      apiKey: tts.ttsMinimaxKey,
      voiceId: tts.ttsMinimaxVoiceId,
      text: reply,
      speed: tts.ttsSpeed,
      volume: tts.ttsVolume,
      model: tts.ttsMinimaxModel,
    });
    sendTtsAudio(audioBuffer.toString("base64"));
    // 等渲染端 CALL_TTS_DONE 后恢复 LISTENING
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError("通话出错：" + msg);
    sendState("LISTENING");
    restartAsr();
  }
}

/** TTS 播完后恢复 LISTENING，重新开始 ASR。 */
export function onTtsDone(): void {
  if (!active) return;
  sendState("LISTENING");
  restartAsr();
}

/** 重新开始一轮 ASR 识别。 */
function restartAsr(): void {
  const cfg = getAsrConfig();
  if (!cfg) return;
  if (asrStream) asrStream.stop();
  finalText = "";
  startAsrStream(cfg);
}

/** 挂断：清理一切。 */
export function stopCall(): void {
  active = false;
  if (asrStream) {
    asrStream.stop();
    asrStream = null;
  }
  sendState("ENDED");
}

/** 处理音频帧：转发给 ASR。 */
export function handleAudioFrame(frame: Buffer): void {
  if (asrStream && currentState === "LISTENING") {
    asrStream.sendAudio(frame);
  }
}

/** 调 agent 获取回复文本（复用现有 FC loop）。 */
async function runAgentTurn(userText: string): Promise<string | null> {
  try {
    const ms = modelSettingsGetter?.();
    if (!ms || !ms.apiKey) return null;

    const result = await runFunctionCallingLoop(
      { provider: ms.provider, baseUrl: ms.baseUrl, model: ms.model, apiKey: ms.apiKey },
      [{ role: "user", content: userText }],
      60000,
    );
    return result?.reply ?? null;
  } catch (err) {
    console.error(LOG_PREFIX, "agent 调用失败:", err);
    return null;
  }
}

/** 注册通话 IPC handlers（main 启动时调一次）。 */
export function registerCallIpc(): void {
  ipcMain.on(IPC.CALL_START, () => startCall());
  ipcMain.on(IPC.CALL_AUDIO_FRAME, (_event, frame: ArrayBuffer) => handleAudioFrame(Buffer.from(frame)));
  ipcMain.on(IPC.CALL_TURN_END, () => void endTurn());
  ipcMain.on(IPC.CALL_TTS_DONE, () => onTtsDone());
  ipcMain.on(IPC.CALL_STOP, () => stopCall());
}
