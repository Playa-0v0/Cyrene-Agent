// 通話輪次協調器 —— 編排 ASR → agent → TTS 的輪次循環。
//
// 狀態機：
//   IDLE → LISTENING → (VAD 靜默) → THINKING → (agent+TTS) → SPEAKING → (播完) → LISTENING
//
// 配置通過 setCallSettings 注入 getter（避免 import index.ts 循環依賴）。

import { BrowserWindow, ipcMain, systemPreferences } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { VolcanoAsrStream, getAsrConfig } from "../asr/volcano-asr-engine";
import { transcribeOfflineWhisper } from "../asr/offline-whisper-engine";
import { synthesizeByEngine } from "../tts/tts-dispatcher";
import type { TtsEngine } from "../../shared/tts-types";
import { runFunctionCallingLoop } from "../orchestrator";
import { getAdapter, buildVendorUrlByProvider } from "../orchestrator/vendors";
import type { ChatMessage } from "../orchestrator/vendors/types";
import { toTraditionalTaiwan } from "../utils/opencc";
import { splitForEarlySpeech } from "./tts-segmentation";
import { captionImage } from "../orchestrator/vision-captioner";
import { parseSharedScreenFrame, shouldUseSharedScreen, type SharedScreenFrame } from "./screen-context";
import { startCallUsage, stopCallUsage } from "../call-usage-store";

const LOG_PREFIX = "[CallManager]";

export type CallState = "IDLE" | "LISTENING" | "THINKING" | "SYNTHESIZING" | "SPEAKING" | "ERROR" | "ENDED";

let callWindow: BrowserWindow | null = null;
let asrStream: VolcanoAsrStream | null = null;
let currentState: CallState = "IDLE";
let finalText = "";
let active = false;
let latestScreenFrame: SharedScreenFrame | null = null;

/** 通話上下文：保留最近 N 輪對話歷史（每輪 = user + assistant 一對）。
 * 主聊天窗口（src/main/index.ts:1276 normalizeChatMessages）默認保留 24 條（12 輪）。
 * 通話場景對短上下文敏感度低，但用戶希望"加點內存"——給到 24 輪（48 條），
 * 短上下文模型如果爆了由 settings 裡的 model context_length 兜底。 */
const MAX_CALL_CONTEXT_TURNS = 24;
const callHistory: ChatMessage[] = [];

/** 滑動窗口截斷：每次 push 兩輪後調用，保留最近 MAX_CALL_CONTEXT_TURNS 輪。
 * 這樣 callHistory 數組本身有界（48 條），不會被長通話撐爆內存。 */
function trimCallHistory(): void {
  if (callHistory.length > MAX_CALL_CONTEXT_TURNS * 2) {
    callHistory.splice(0, callHistory.length - MAX_CALL_CONTEXT_TURNS * 2);
  }
}

// 注入的配置 getter（由 index.ts 啟動時設置，避免循環依賴）
let modelSettingsGetter: (() => {
  provider: string; baseUrl: string; model: string; apiKey: string; perProvider?: any;
}) | null = null;
let ttsSettingsGetter: (() => {
  ttsEngine: TtsEngine;
  ttsMinimaxKey: string; ttsMinimaxVoiceId: string;
  ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  ttsSpeed: number; ttsVolume: number;
  // GPT-SoVITS
  ttsGptsovitsBaseUrl: string; ttsGptsovitsRefAudioPath: string;
  ttsGptsovitsPromptText: string; ttsGptsovitsFormat: "wav" | "mp3";
  ttsCustomCloudEndpointUrl: string; ttsCustomCloudApiKey: string; ttsCustomCloudVoiceId: string;
  ttsCustomCloudFormat: "wav" | "mp3"; ttsCustomCloudTimeoutMs: number;
  ttsMimoKey: string; ttsMimoVoiceAudioPath: string; ttsMimoStylePrompt: string;
}) | null = null;

/** index.ts 啟動時注入模型配置、TTS 配置和 system prompt 構建器。 */
let systemPromptBuilder: ((userText: string) => Promise<string>) | null = null;
let weatherHandler: ((userText: string) => Promise<string | null>) | null = null;

let localAudioBuffer = Buffer.alloc(0);

function findGroqApiKey(settings: any): string | null {
  if (!settings) return null;
  if (typeof settings.apiKey === "string" && settings.apiKey.startsWith("gsk_")) {
    return settings.apiKey;
  }
  if (settings.perProvider && typeof settings.perProvider === "object") {
    for (const key of Object.keys(settings.perProvider)) {
      const prov = settings.perProvider[key];
      if (prov && typeof prov.apiKey === "string" && prov.apiKey.startsWith("gsk_")) {
        return prov.apiKey;
      }
    }
  }
  return null;
}

function encodeWAV(pcmBuffer: Buffer, sampleRate = 16000): Buffer {
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = pcmBuffer.length;
  const chunkSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(chunkSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * 將一段完整的 16kHz/16-bit/mono PCM 交給目前通話 ASR 設定。
 * Discord 語音通話會復用這條路徑，因此桌面通話與 Discord 不會各自維護一套金鑰。
 */
export async function transcribeCallPcm(pcm: Buffer): Promise<string> {
  const cfg = getAsrConfig();
  if (!cfg) throw new Error("ASR 未配置，請先在設定中選擇語音辨識引擎");
  if (!pcm.length) return "";

  try {

  if (cfg.engine === "web-speech") {
    return await transcribeOfflineWhisper(pcm, cfg.language);
  }

  if (cfg.engine === "local") {
    const groqKey = findGroqApiKey(modelSettingsGetter?.());
    if (!groqKey) throw new Error("未找到 Groq API 金鑰");
    const wavBuffer = encodeWAV(pcm, 16000);
    const formData = new (globalThis as any).FormData();
    const blob = new (globalThis as any).Blob([wavBuffer], { type: "audio/wav" });
    formData.append("file", blob, "discord-speech.wav");
    formData.append("model", "whisper-large-v3");
    formData.append("language", cfg.language === "zh" ? "zh" : "en");
    const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}` },
      body: formData,
    });
    if (!resp.ok) throw new Error(`Groq Whisper ASR API returned status ${resp.status}`);
    const data = await resp.json() as { text?: string };
    return data.text?.trim() ?? "";
  }

  if (cfg.engine === "aliyun") {
    if (!cfg.appKey || !cfg.accessKeyId || !cfg.accessKeySecret) {
      throw new Error("阿里雲 ASR 設定不完整");
    }
    const finals: string[] = [];
    const stream = new VolcanoAsrStream(() => undefined, (text) => finals.push(text));
    await stream.start(cfg.appKey, cfg.accessKeyId, cfg.accessKeySecret, cfg.language);
    if (!await stream.waitUntilReady()) {
      stream.stop();
      throw new Error("阿里雲 ASR 連線逾時");
    }
    for (let offset = 0; offset < pcm.length; offset += 6400) {
      stream.sendAudio(pcm.subarray(offset, offset + 6400));
    }
    await stream.stopAndWaitFinal(5000);
    return finals.join(" ").trim();
  }

    throw new Error(`不支援的 ASR 引擎：${cfg.engine}`);
  } catch (error) {
    if (cfg.engine !== "web-speech" && cfg.fallbackToLocal) {
      console.warn(LOG_PREFIX, `雲端 ASR 失敗，切換本機 Whisper：${error instanceof Error ? error.message : String(error)}`);
      sendAsrResult("雲端辨識失敗，已切換本機 Whisper", undefined);
      return transcribeOfflineWhisper(pcm, cfg.language);
    }
    throw error;
  }
}

export function setCallSettings(
  modelGetter: () => { provider: string; baseUrl: string; model: string; apiKey: string; perProvider?: any },
  ttsGetter: () => {
    ttsEngine: TtsEngine;
    ttsMinimaxKey: string; ttsMinimaxVoiceId: string;
    ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
    ttsSpeed: number; ttsVolume: number;
    ttsGptsovitsBaseUrl: string; ttsGptsovitsRefAudioPath: string;
    ttsGptsovitsPromptText: string; ttsGptsovitsFormat: "wav" | "mp3";
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

/** 綁定通話窗口（createCallWindow 調一次）。 */
export function setCallWindow(win: BrowserWindow | null): void {
  callWindow = win;
}

/** 是否正在通話中。 */
export function isCallActive(): boolean {
  return active;
}

function sendState(state: CallState): void {
  currentState = state;
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send(IPC.CALL_STATE, { state });
  }
  console.log(LOG_PREFIX, "狀態 →", state);
}

function sendError(message: string): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send(IPC.CALL_ERROR, { message });
  }
  console.error(LOG_PREFIX, "錯誤:", message);
}

function sendAsrResult(partial: string | undefined, final: string | undefined): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send(IPC.CALL_ASR_RESULT, { partial, final });
  }
}

function sendTtsAudio(base64: string, format: "wav" | "mp3", isFinal: boolean): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send(IPC.CALL_TTS_AUDIO, { base64, format, isFinal });
  }
}

/** 開始通話：初始化 ASR 流，進入 LISTENING。 */
export function startCall(): void {
  if (active) return;

  if (process.platform === "darwin") {
    try {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      console.log(LOG_PREFIX, "macOS microphone access status:", status);
      if (status !== "granted") {
        void systemPreferences.askForMediaAccess("microphone").then((granted) => {
          console.log(LOG_PREFIX, "macOS microphone access request result:", granted);
        });
      }
    } catch (e) {
      console.warn(LOG_PREFIX, "Failed to check macOS microphone permission:", e);
    }
  }

  const cfg = getAsrConfig();
  if (!cfg) {
    sendError("ASR 未配置");
    sendState("ERROR");
    return;
  }

  if (cfg.engine === "aliyun") {
    if (!cfg.appKey || !cfg.accessKeyId || !cfg.accessKeySecret) {
      if (!cfg.fallbackToLocal) {
        sendError("ASR 未配置：請在設置→ASR 中配置阿里雲 AppKey 和 AccessKey");
        sendState("ERROR");
        return;
      }
    }
  } else if (cfg.engine === "local") {
    const settings = modelSettingsGetter?.();
    const groqKey = findGroqApiKey(settings);
    if (!groqKey && !cfg.fallbackToLocal) {
      sendError("語音識別需要 Groq API 金鑰，請先在「設置 → 模型」中填入 Groq 的 API Key（或 MiniMax 處填寫的 gsk_ 格式金鑰）");
      sendState("ERROR");
      return;
    }
  } else if (cfg.engine === "web-speech") {
    // 免費本機 Whisper，不需要驗證金鑰
  } else {
    sendError("不支持的 ASR 引擎");
    sendState("ERROR");
    return;
  }

  active = true;
  startCallUsage("desktop");
  finalText = "";
  localAudioBuffer = Buffer.alloc(0);
  callHistory.length = 0;
  latestScreenFrame = null;
  if (cfg.engine === "aliyun" && cfg.appKey && cfg.accessKeyId && cfg.accessKeySecret) {
    startAsrStream(cfg);
  }
  sendState("LISTENING");
}

/** 創建並啟動一個 ASR 流。 */
function startAsrStream(cfg: { appKey: string; accessKeyId: string; accessKeySecret: string; language: string }): void {
  asrStream = new VolcanoAsrStream(
    (text) => sendAsrResult(text, undefined),
    (text) => { finalText = text; sendAsrResult(undefined, text); },
  );
  asrStream.start(cfg.appKey, cfg.accessKeyId, cfg.accessKeySecret, cfg.language);
}

/** 結束本輪（VAD 靜默）：停 ASR → 跑 agent → TTS → 播放。 */
export async function endTurn(passedText?: string): Promise<void> {
  if (!active || currentState !== "LISTENING") return;

  const cfg = getAsrConfig();
  if (!cfg) return;

  if (passedText !== undefined) {
    finalText = passedText;
  } else if (cfg.engine === "aliyun") {
    if (asrStream) await asrStream.stopAndWaitFinal();
    if (!active) return;
    if (!finalText.trim() && cfg.fallbackToLocal && localAudioBuffer.length) {
      sendAsrResult("雲端沒有回傳結果，已切換本機 Whisper", undefined);
      finalText = await transcribeOfflineWhisper(localAudioBuffer, cfg.language);
      sendAsrResult(undefined, finalText);
    }
  } else if (cfg.engine === "local" || cfg.engine === "web-speech") {
    if (localAudioBuffer.length === 0) {
      restartAsr();
      return;
    }
    sendState("THINKING");
    try {
      finalText = await transcribeCallPcm(localAudioBuffer);
      sendAsrResult(undefined, finalText);
    } catch (err: any) {
      console.error(LOG_PREFIX, "語音識別失敗:", err);
      sendState("LISTENING");
      restartAsr();
      // 最後送出具體錯誤，避免緊接著的 LISTENING 狀態把它覆蓋掉。
      sendError("語音識別失敗，請重試: " + err.message);
      return;
    }
  }

  const text = finalText.trim();
  finalText = "";

  if (!text) {
    // 空文本，直接重啟 ASR 回 LISTENING
    restartAsr();
    return;
  }

  sendState("THINKING");

  try {
    // 調 agent 獲取回覆
    const reply = await runAgentTurn(text);
    if (!reply) {
      sendError("未收到 agent 回覆");
      sendState("LISTENING");
      restartAsr();
      return;
    }

    // TTS 合成（按 ttsEngine 分發到對應引擎）
    const tts = ttsSettingsGetter?.();
    if (!tts || tts.ttsEngine === "off") {
      sendError("TTS 未配置：請在設置中啟用 TTS 引擎");
      sendState("LISTENING");
      restartAsr();
      return;
    }

    // 引擎配置完整性檢查
    if (tts.ttsEngine === "minimax" && (!tts.ttsMinimaxKey || !tts.ttsMinimaxVoiceId)) {
      sendError("TTS 未配置：請在設置中配置 MiniMax API Key 和音色 ID");
      sendState("LISTENING");
      restartAsr();
      return;
    }
    if (tts.ttsEngine === "gptsovits" && (!tts.ttsGptsovitsBaseUrl || !tts.ttsGptsovitsRefAudioPath || !tts.ttsGptsovitsPromptText)) {
      sendError("TTS 未配置：請在設置中配置 GPT-SoVITS baseUrl、參考音頻和文本");
      sendState("LISTENING");
      restartAsr();
      return;
    }
    if (tts.ttsEngine === "custom-cloud" && !tts.ttsCustomCloudEndpointUrl) {
      sendError("TTS 未配置：請在設置中配置自定義雲端 Endpoint URL");
      sendState("LISTENING");
      restartAsr();
      return;
    }
    if (tts.ttsEngine === "mimo" && (!tts.ttsMimoKey || !tts.ttsMimoVoiceAudioPath)) {
      sendError("TTS 未配置：請在設置中配置小米 MiMo API Key 和昔漣克隆音頻");
      sendState("LISTENING");
      restartAsr();
      return;
    }

    sendState("SYNTHESIZING");
    try {
      const segments = splitForEarlySpeech(reply);
      for (let index = 0; index < segments.length; index += 1) {
        const result = await synthesizeByEngine(tts.ttsEngine, {
        text: segments[index],
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
        timeoutMs: tts.ttsCustomCloudTimeoutMs,
        voiceAudioPath: tts.ttsMimoVoiceAudioPath,
        stylePrompt: tts.ttsMimoStylePrompt,
        ...(tts.ttsEngine === "custom-cloud" ? { format: tts.ttsCustomCloudFormat } : {}),
        });
        if (index === 0) sendState("SPEAKING");
        sendTtsAudio(result.audio.toString("base64"), result.format, index === segments.length - 1);
      }
      // 等渲染端 CALL_TTS_DONE 後恢復 LISTENING
    } catch (ttsErr) {
      const msg = ttsErr instanceof Error ? ttsErr.message : String(ttsErr);
      sendError("TTS 合成失敗：" + msg);
      sendState("LISTENING");
      restartAsr();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError("通話出錯：" + msg);
    sendState("LISTENING");
    restartAsr();
  }
}

/** TTS 播完後恢復 LISTENING，重新開始 ASR。 */
export function onTtsDone(): void {
  if (!active) return;
  sendState("LISTENING");
  restartAsr();
}

/** 重新開始一輪 ASR 識別。 */
function restartAsr(): void {
  const cfg = getAsrConfig();
  if (!cfg) return;
  finalText = "";
  localAudioBuffer = Buffer.alloc(0);
  if (cfg.engine === "aliyun") {
    if (asrStream) asrStream.stop();
    startAsrStream(cfg);
  }
}

/** 掛斷：清理一切。 */
export function stopCall(): void {
  active = false;
  stopCallUsage("desktop");
  callHistory.length = 0;
  latestScreenFrame = null;
  localAudioBuffer = Buffer.alloc(0);
  if (asrStream) {
    asrStream.stop();
    asrStream = null;
  }
  sendState("ENDED");
}

/** 處理音頻幀：轉發給 ASR。 */
export function handleAudioFrame(frame: Buffer): void {
  const cfg = getAsrConfig();
  if (cfg?.engine === "aliyun" && cfg.fallbackToLocal && currentState === "LISTENING") {
    localAudioBuffer = Buffer.concat([localAudioBuffer, frame]);
  }
  if (cfg && (cfg.engine === "local" || cfg.engine === "web-speech")) {
    if (currentState === "LISTENING") {
      localAudioBuffer = Buffer.concat([localAudioBuffer, frame]);
    }
  } else {
    if (asrStream && currentState === "LISTENING") {
      asrStream.sendAudio(frame);
    }
  }
}

/** 保存 renderer 最近取樣的一幀；null 代表停止分享。 */
export function handleScreenFrame(dataUrl: unknown): void {
  if (dataUrl === null) {
    latestScreenFrame = null;
    return;
  }
  const parsed = parseSharedScreenFrame(dataUrl);
  if (parsed) latestScreenFrame = parsed;
}

/** 天氣關鍵詞正則匹配 */
const WEATHER_REGEX = /天氣|今天.*熱|今天.*冷|下雨|下雪|氣溫|幾度|多少度|穿什麼/;

/**
 * 獲取回覆文本。
 * 1. 先正則匹配天氣 → 直接查天氣
 * 2. 否則直接調 LLM（不走 FC loop，不調工具），用通話專用 system prompt
 * 3. 回覆過濾掉 [sticker:xxx] 表情包標記
 */
async function runAgentTurn(userText: string): Promise<string | null> {
  try {
    // 1. 天氣正則匹配
    if (WEATHER_REGEX.test(userText) && weatherHandler) {
      const weatherReply = await weatherHandler(userText);
      if (weatherReply) {
        // 天氣走快捷路徑，也記入上下文
        callHistory.push({ role: "user", content: userText });
        callHistory.push({ role: "assistant", content: weatherReply });
        trimCallHistory();
        return weatherReply;
      }
    }

    // 2. 直接調 LLM（不走 FC loop）
    const ms = modelSettingsGetter?.();
    if (!ms || !ms.apiKey) return null;

    // 分享期間只在用戶真的提到畫面時取用最新幀，避免一般閒聊多一次視覺請求。
    // 視覺模型已直接回答用戶問題，因此不再串第二次 LLM，維持通話反應速度。
    if (latestScreenFrame && shouldUseSharedScreen(userText)) {
      const visualReply = await captionImage(latestScreenFrame, userText, {
        baseUrl: ms.baseUrl,
        apiKey: ms.apiKey,
        model: ms.model,
      });
      if (visualReply && !visualReply.startsWith("[錯誤·")) {
        const reply = toTraditionalTaiwan(visualReply.trim());
        callHistory.push({ role: "user", content: userText });
        callHistory.push({ role: "assistant", content: reply });
        trimCallHistory();
        return reply;
      }
      console.warn(LOG_PREFIX, "分享畫面分析失敗，改以一般語音問題處理");
    }

    const adapter = getAdapter(ms.provider);
    if (!adapter) return null;

    const url = buildVendorUrlByProvider(ms.provider, ms.baseUrl);
    const systemPrompt = await systemPromptBuilder?.(userText) ?? "";
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      // 取最近 MAX_CALL_CONTEXT_TURNS 輪歷史（每輪 2 條：user + assistant）
      ...callHistory.slice(-MAX_CALL_CONTEXT_TURNS * 2),
      { role: "user", content: userText },
    ];

    const req = adapter.buildRequest(
      { model: ms.model, messages, temperature: 0.8 },
      { provider: ms.provider, baseUrl: ms.baseUrl, model: ms.model, apiKey: ms.apiKey },
    );

    const httpResp = await fetch(url, {
      method: "POST",
      headers: { ...req.headers, "Content-Type": "application/json" },
      body: req.body,
    });

    if (!httpResp.ok) {
      console.error(LOG_PREFIX, "LLM 請求失敗:", httpResp.status);
      return null;
    }

    const raw = await httpResp.json();
    const resp = adapter.parseResponse(raw);
    // 過濾掉表情包標記
    let reply = (resp.text || "").replace(/\[sticker:[^\]]+\]/g, "").trim();
    if (reply) {
      reply = toTraditionalTaiwan(reply);
    }

    // 記入通話上下文
    if (reply) {
      callHistory.push({ role: "user", content: userText });
      callHistory.push({ role: "assistant", content: reply });
      trimCallHistory();
    }

    return reply || null;
  } catch (err) {
    console.error(LOG_PREFIX, "LLM 調用失敗:", err);
    return null;
  }
}

/** 註冊通話 IPC handlers（main 啟動時調一次）。 */
export function registerCallIpc(): void {
  ipcMain.on(IPC.CALL_START, () => startCall());
  ipcMain.on(IPC.CALL_AUDIO_FRAME, (_event, frame: ArrayBuffer) => handleAudioFrame(Buffer.from(frame)));
  ipcMain.on(IPC.CALL_SCREEN_FRAME, (_event, dataUrl: string | null) => handleScreenFrame(dataUrl));
  ipcMain.on(IPC.CALL_TURN_END, (_event, text?: string) => void endTurn(text));
  ipcMain.on(IPC.CALL_TTS_DONE, () => onTtsDone());
  ipcMain.on(IPC.CALL_STOP, () => stopCall());
}
