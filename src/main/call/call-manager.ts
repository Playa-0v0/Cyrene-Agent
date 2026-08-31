// 通话轮次协调器 —— 编排 ASR → agent → TTS 的轮次循环。
//
// 状态机：
//   IDLE → LISTENING → (VAD 静默) → THINKING → (agent+TTS) → SPEAKING → (播完) → LISTENING
//
// 配置通过 setCallSettings 注入 getter（避免 import index.ts 循环依赖）。

import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { getAsrConfig, type AsrConfig } from "../asr/asr-config";
import { createAsrStream, type AsrStreamSession } from "../asr/asr-dispatcher";
import { synthesizeByEngine } from "../tts/tts-dispatcher";
import type { TtsEngine } from "../../shared/tts-types";
import { getAdapterForConfig, buildVendorUrl } from "../orchestrator/vendors";
import { resolveTimeoutPolicy } from "../runtime-policy";
import { recordRequest, recordUsage } from "../token-usage-store";
import type { ChatMessage } from "../orchestrator/vendors/types";

const LOG_PREFIX = "[CallManager]";

export type CallState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "ERROR" | "ENDED";

let callWindow: BrowserWindow | null = null;
let asrStream: AsrStreamSession | null = null;
let currentState: CallState = "IDLE";
let finalText = "";
let latestPartialText = "";
let active = false;

/** 通话上下文：保留最近 N 轮对话历史（每轮 = user + assistant 一对）。
 * 主聊天窗口（src/main/index.ts:1276 normalizeChatMessages）默认保留 24 条（12 轮）。
 * 通话场景对短上下文敏感度低，但用户希望"加点内存"——给到 24 轮（48 条），
 * 短上下文模型如果爆了由 settings 里的 model context_length 兜底。 */
const MAX_CALL_CONTEXT_TURNS = 24;
const callHistory: ChatMessage[] = [];

/** 滑动窗口截断：每次 push 两轮后调用，保留最近 MAX_CALL_CONTEXT_TURNS 轮。
 * 这样 callHistory 数组本身有界（48 条），不会被长通话撑爆内存。 */
function trimCallHistory(): void {
  if (callHistory.length > MAX_CALL_CONTEXT_TURNS * 2) {
    callHistory.splice(0, callHistory.length - MAX_CALL_CONTEXT_TURNS * 2);
  }
}

// 注入的配置 getter（由 index.ts 启动时设置，避免循环依赖）
let modelSettingsGetter: (() => {
  provider: string; baseUrl: string; model: string; apiKey: string;
}) | null = null;
let ttsSettingsGetter: (() => {
  ttsEngine: TtsEngine;
  ttsMinimaxKey: string; ttsMinimaxVoiceId: string;
  ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  ttsSpeed: number; ttsVolume: number;
  // MiniMax
  ttsMinimaxVocalEnhance: boolean;
  ttsGptsovitsBaseUrl: string; ttsGptsovitsRefAudioPath: string;
  ttsGptsovitsPromptText: string; ttsGptsovitsFormat: "wav" | "mp3";
  ttsGptsovitsTimeoutMs: number;
  ttsCustomCloudEndpointUrl: string; ttsCustomCloudApiKey: string; ttsCustomCloudVoiceId: string;
  ttsCustomCloudFormat: "wav" | "mp3"; ttsCustomCloudTimeoutMs: number;
  ttsMimoKey: string; ttsMimoVoiceAudioPath: string; ttsMimoStylePrompt: string;
}) | null = null;

/** index.ts 启动时注入模型配置、TTS 配置和 system prompt 构建器。 */
let systemPromptBuilder: ((userText: string) => Promise<string>) | null = null;
let weatherHandler: ((userText: string) => Promise<string | null>) | null = null;

export function setCallSettings(
  modelGetter: () => { provider: string; baseUrl: string; model: string; apiKey: string; explicitTransport?: "openai" | "anthropic" | "responses" | "auto" },
  ttsGetter: () => {
    ttsEngine: TtsEngine;
    ttsMinimaxKey: string; ttsMinimaxVoiceId: string;
    ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
    ttsSpeed: number; ttsVolume: number;
    ttsMinimaxVocalEnhance: boolean;
    ttsGptsovitsBaseUrl: string; ttsGptsovitsRefAudioPath: string;
    ttsGptsovitsPromptText: string; ttsGptsovitsFormat: "wav" | "mp3";
    ttsGptsovitsTimeoutMs: number;
    ttsCustomCloudEndpointUrl: string; ttsCustomCloudApiKey: string; ttsCustomCloudVoiceId: string;
    ttsCustomCloudFormat: "wav" | "mp3"; ttsCustomCloudTimeoutMs: number;
    ttsMimoKey: string; ttsMimoVoiceAudioPath: string; ttsMimoStylePrompt: string;
  },
  systemPromptFn: (userText: string) => Promise<string>,
  weatherFn: (userText: string) => Promise<string | null>,
): void {
  modelSettingsGetter = modelGetter;
  ttsSettingsGetter = ttsGetter;
  systemPromptBuilder = systemPromptFn;
  weatherHandler = weatherFn;
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
  const missingConfig = !cfg
    || (cfg.engine === "aliyun" && (!cfg.appKey || !cfg.accessKeyId || !cfg.accessKeySecret))
    || (cfg.engine === "mossland" && !cfg.apiKey);
  if (missingConfig) {
    sendError("ASR 未配置：请在设置→ASR 中选择服务商并填写凭据");
    sendState("ERROR");
    return;
  }

  active = true;
  finalText = "";
  latestPartialText = "";
  callHistory.length = 0;
  console.log(LOG_PREFIX, "startCall 重置: finalText 清空, history 清空");
  startAsrStream(cfg);
  sendState("LISTENING");
}

/** 创建并启动一个 ASR 流。 */
function startAsrStream(cfg: AsrConfig): void {
  asrStream = createAsrStream(
    cfg,
    (text) => { latestPartialText = text; sendAsrResult(text, undefined); },
    (text) => { finalText = text; latestPartialText = text; sendAsrResult(undefined, text); },
  );
  void asrStream.start().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    sendError(`ASR 启动失败：${message}`);
    sendState("ERROR");
  });
}

/** 结束本轮（VAD 静默）：停 ASR → 跑 agent → TTS → 播放。 */
export async function endTurn(): Promise<void> {
  console.log(LOG_PREFIX, "endTurn 入口: active=", active, "state=", currentState, "finalText.length=", finalText.length);
  if (!active || currentState !== "LISTENING") return;

  // 立即离开 LISTENING，避免批量转写等待期间被手动按钮或 VAD 重复提交。
  sendState("THINKING");

  if (asrStream) {
    try {
      await asrStream.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(message);
      sendState("LISTENING");
      restartAsr();
      return;
    }
  }

  const text = finalText.trim() || latestPartialText.trim();
  finalText = "";
  latestPartialText = "";

  if (!text) {
    // 空文本，直接重启 ASR 回 LISTENING
    console.log(LOG_PREFIX, "endTurn 空文本，直接重启 ASR");
    sendState("LISTENING");
    restartAsr();
    return;
  }

  try {
    // 调 agent 获取回复
    console.log(LOG_PREFIX, "runAgentTurn 开始, text.length=", text.length);
    const reply = await runAgentTurn(text);
    console.log(LOG_PREFIX, "runAgentTurn 结果: reply.length=", reply?.length ?? "null");
    if (!reply) {
      sendError("未收到 agent 回复");
      sendState("LISTENING");
      restartAsr();
      return;
    }

    // TTS 合成（按 ttsEngine 分发到对应引擎）
    const tts = ttsSettingsGetter?.();
    if (!tts || tts.ttsEngine === "off") {
      sendError("TTS 未配置：请在设置中启用 TTS 引擎");
      sendState("LISTENING");
      restartAsr();
      return;
    }

    // 引擎配置完整性检查
    if (tts.ttsEngine === "minimax" && (!tts.ttsMinimaxKey || !tts.ttsMinimaxVoiceId)) {
      sendError("TTS 未配置：请在设置中配置 MiniMax API Key 和音色 ID");
      sendState("LISTENING");
      restartAsr();
      return;
    }
    if (tts.ttsEngine === "gptsovits" && (!tts.ttsGptsovitsBaseUrl || !tts.ttsGptsovitsRefAudioPath || !tts.ttsGptsovitsPromptText)) {
      sendError("TTS 未配置：请在设置中配置 GPT-SoVITS baseUrl、参考音频和文本");
      sendState("LISTENING");
      restartAsr();
      return;
    }
    if (tts.ttsEngine === "custom-cloud" && !tts.ttsCustomCloudEndpointUrl) {
      sendError("TTS 未配置：请在设置中配置自定义云端 Endpoint URL");
      sendState("LISTENING");
      restartAsr();
      return;
    }
    if (tts.ttsEngine === "mimo" && (!tts.ttsMimoKey || !tts.ttsMimoVoiceAudioPath)) {
      sendError("TTS 未配置：请在设置中配置小米 MiMo API Key 和昔涟克隆音频");
      sendState("LISTENING");
      restartAsr();
      return;
    }

    sendState("SPEAKING");
    try {
      const result = await synthesizeByEngine(tts.ttsEngine, {
        text: reply,
        speed: tts.ttsSpeed,
        volume: tts.ttsVolume,
        // minimax
        apiKey: tts.ttsEngine === "mimo"
          ? tts.ttsMimoKey
          : tts.ttsEngine === "custom-cloud"
            ? tts.ttsCustomCloudApiKey
            : tts.ttsMinimaxKey,
        voiceId: tts.ttsEngine === "mimo"
          ? ""
          : tts.ttsEngine === "custom-cloud"
            ? tts.ttsCustomCloudVoiceId
            : tts.ttsMinimaxVoiceId,
        model: tts.ttsMinimaxModel,
        // gptsovits
        baseUrl: tts.ttsGptsovitsBaseUrl,
        refAudioPath: tts.ttsGptsovitsRefAudioPath,
        promptText: tts.ttsGptsovitsPromptText,
        format: tts.ttsGptsovitsFormat,
        // custom-cloud
        endpointUrl: tts.ttsCustomCloudEndpointUrl,
        timeoutMs: tts.ttsEngine === "gptsovits" ? tts.ttsGptsovitsTimeoutMs : tts.ttsCustomCloudTimeoutMs,
        vocalEnhance: tts.ttsEngine === "minimax" ? { enabled: tts.ttsMinimaxVocalEnhance } : undefined,
        voiceAudioPath: tts.ttsMimoVoiceAudioPath,
        stylePrompt: tts.ttsMimoStylePrompt,
        ...(tts.ttsEngine === "custom-cloud" ? { format: tts.ttsCustomCloudFormat } : {}),
      });
      sendTtsAudio(result.audio.toString("base64"));
      // 等渲染端 CALL_TTS_DONE 后恢复 LISTENING
    } catch (ttsErr) {
      const msg = ttsErr instanceof Error ? ttsErr.message : String(ttsErr);
      sendError("TTS 合成失败：" + msg);
      sendState("LISTENING");
      restartAsr();
    }
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
  if (asrStream) void Promise.resolve(asrStream.stop()).catch((err) => {
    console.warn(LOG_PREFIX, "停止上一轮 ASR 失败:", err);
  });
  finalText = "";
  latestPartialText = "";
  startAsrStream(cfg);
}

/** 挂断：清理一切。 */
export function stopCall(): void {
  active = false;
  finalText = "";
  latestPartialText = "";
  callHistory.length = 0;
  if (asrStream) {
    void Promise.resolve(asrStream.stop()).catch((err) => {
      console.warn(LOG_PREFIX, "挂断时停止 ASR 失败:", err);
    });
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

/** 天气关键词正则匹配 */
const WEATHER_REGEX = /天气|今天.*热|今天.*冷|下雨|下雪|气温|几度|多少度|穿什么/;

/**
 * 获取回复文本。
 * 1. 先正则匹配天气 → 直接查天气
 * 2. 否则直接调 LLM（不走 FC loop，不调工具），用通话专用 system prompt
 * 3. 回复过滤掉 [sticker:xxx] 表情包标记
 */
async function runAgentTurn(userText: string): Promise<string | null> {
  try {
    // 1. 天气正则匹配
    if (WEATHER_REGEX.test(userText) && weatherHandler) {
      const weatherReply = await weatherHandler(userText);
      if (weatherReply) {
        // 天气走快捷路径，也记入上下文
        callHistory.push({ role: "user", content: userText });
        callHistory.push({ role: "assistant", content: weatherReply });
        trimCallHistory();
        return weatherReply;
      }
    }

    // 2. 直接调 LLM（不走 FC loop）
    const ms = modelSettingsGetter?.();
    if (!ms || !ms.apiKey) {
      throw new Error("模型配置缺失或未填写 API Key");
    }

    // 协议跟随档案配置（explicitTransport），缺失时由 resolveTransport 回退厂商默认
    const adapter = getAdapterForConfig(ms);

    const url = buildVendorUrl(ms.baseUrl, adapter.transport);
    const systemPrompt = await systemPromptBuilder?.(userText) ?? "";
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      // 取最近 MAX_CALL_CONTEXT_TURNS 轮历史（每轮 2 条：user + assistant）
      ...callHistory.slice(-MAX_CALL_CONTEXT_TURNS * 2),
      { role: "user", content: userText },
    ];

    // Kimi k2.6 只允许特定 temperature，省略让服务端用默认值
    const callTemperature = ms.model.match(/^kimi-k2\.6(?:$|-)/i) ? undefined : 0.8;
    const req = adapter.buildRequest(
      { model: ms.model, messages, ...(callTemperature !== undefined ? { temperature: callTemperature } : {}) },
      { provider: ms.provider, baseUrl: ms.baseUrl, model: ms.model, apiKey: ms.apiKey },
    );

    const httpResp = await fetch(url, {
      method: "POST",
      headers: { ...req.headers, "Content-Type": "application/json" },
      body: req.body,
      signal: AbortSignal.timeout(resolveTimeoutPolicy({ stage: "call-management" }).totalMs),
    });

    if (!httpResp.ok) {
      throw new Error(`LLM 请求失败: ${httpResp.status}`);
    }

    const raw = await httpResp.json();
    const resp = adapter.parseResponse(raw);
    // 记入 Token 用量统计（电话通话此前完全不记录）
    recordRequest(ms.model);
    if (resp.usage) {
      recordUsage(resp.usage.input, resp.usage.output, 1, resp.usage.cachedInput, ms.model, resp.usage.cacheCreation);
    }
    // 过滤掉表情包标记
    const reply = (resp.text || "").replace(/\[sticker:[^\]]+\]/g, "").trim();

    // 记入通话上下文
    if (reply) {
      callHistory.push({ role: "user", content: userText });
      callHistory.push({ role: "assistant", content: reply });
      trimCallHistory();
    }

    return reply || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "LLM 调用失败:", msg);
    throw new Error(`LLM 调用失败: ${msg}`);
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
