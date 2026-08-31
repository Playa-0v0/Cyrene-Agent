import fs from "node:fs";
import path from "node:path";
import { dialog, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { validateMiniMaxVoiceId } from "../../shared/minimax-voice";
import type { StartTtsRequest } from "../../shared/tts-session";
import { synthesize as customCloudSynthesize } from "./custom-cloud-engine";
import { synthesize as gptsovitsSynthesize } from "./gptsovits-engine";
import { synthesize as mimoSynthesize } from "./mimo-engine";
import { cloneVoice as minimaxCloneVoice, synthesize as minimaxSynthesize, uploadFile as minimaxUploadFile } from "./minimax-engine";
import { cloneVoice as mosslandCloneVoice, listVoices as mosslandListVoices, synthesize as mosslandSynthesize } from "./mossland-engine";
import { TtsSessionService } from "./tts-session-service";
import {
  appendCustomCloudTtsLog,
  appendGptsovitsTtsLog,
  appendMinimaxTtsLog,
  appendMimoTtsLog,
  assertTtsCacheKey,
  buildCustomCloudCacheKey,
  buildGptsovitsCacheKey,
  buildMimoCacheKey,
  buildMosslandCacheKey,
  buildTtsCacheKey,
  getTtsCachePath,
} from "./tts-cache";
import { versionTtsCacheKey } from "./tts-cache-key";

export interface RegisterTtsIpcDeps {
  ttsSessionService: TtsSessionService;
}

export function registerTtsIpc(deps: RegisterTtsIpcDeps): void {
  ipcMain.handle(IPC.TTS_SESSION_START, async (event, request: StartTtsRequest) => {
    if (
      !request?.requestId
      || !request.conversationId
      || !request.messageId
      || !request.speechText.trim()
      || !/^[a-z\d][a-z\d._-]{0,63}$/i.test(request.converterVersion)
    ) {
      throw new Error("TTS 会话请求不完整");
    }
    const sender = event.sender;
    return await deps.ttsSessionService.start(request, (sessionEvent) => {
      if (!sender.isDestroyed()) sender.send(IPC.TTS_SESSION_EVENT, sessionEvent);
    });
  });
  ipcMain.handle(IPC.TTS_SESSION_CANCEL, (_event, requestId: string) => {
    return typeof requestId === "string" && requestId.length > 0
      ? deps.ttsSessionService.cancel(requestId)
      : false;
  });

  // 上传音频文件 → file_id
  ipcMain.handle(IPC.TTS_UPLOAD, async (_event, payload: { apiKey: string; filePath: string; purpose: "voice_clone" | "prompt_audio" }) => {
    if (!payload?.apiKey || !payload?.filePath) {
      throw new Error("缺少 API Key 或文件路径");
    }
    return await minimaxUploadFile(payload.apiKey, payload.filePath, payload.purpose);
  });

  // 选择音频文件（Electron dialog）
  ipcMain.handle(IPC.TTS_PICK_AUDIO, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择音频文件",
      filters: [{ name: "音频文件", extensions: ["mp3", "m4a", "wav"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // 音色快速复刻 → voice_id
  ipcMain.handle(IPC.TTS_CLONE, async (_event, payload: {
    apiKey: string; fileId: string; voiceId: string;
    promptAudioId?: string; promptText?: string;
    text: string; model?: string;
  }) => {
    if (!payload?.apiKey || !payload?.fileId || !payload?.voiceId || !payload?.text) {
      throw new Error("缺少必要参数（apiKey/fileId/voiceId/text）");
    }
    const voiceIdError = validateMiniMaxVoiceId(payload.voiceId);
    if (voiceIdError) throw new Error(voiceIdError);
    return await minimaxCloneVoice(payload);
  });

  // 语音合成 → base64 音频（聊天朗读 / 测试发音都用这个）
  ipcMain.handle(IPC.TTS_SYNTHESIZE, async (_event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    vocalEnhance?: { enabled: boolean };
  }) => {
    if (!payload?.apiKey || !payload?.voiceId || !payload?.text) {
      throw new Error("缺少必要参数（apiKey/voiceId/text）");
    }
    const audioBuffer = await minimaxSynthesize({
      ...payload,
      debugLog: appendMinimaxTtsLog,
    });
    // Buffer → base64 传给渲染进程（渲染进程用 atob 解码再播）
    return audioBuffer.toString("base64");
  });

  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED, async (_event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => {
    const format = payload.format ?? "mp3";

    // 回听优先：如果 expectedCacheKey 对应的缓存文件存在，直接返回，不需要 apiKey/voiceId。
    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 格式非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      appendMinimaxTtsLog({
        requestId: `tts-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        phase: "cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuffer.length,
        textChars: Array.from(payload.text).length,
      });
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
      };
    }

    // 缓存未命中 → 需要合成，检查 apiKey/voiceId
    if (!payload?.apiKey || !payload?.voiceId || !payload?.text || payload.apiKey === "cache-only") {
      throw new Error("缓存未命中且缺少必要参数（apiKey/voiceId/text）");
    }

    const cacheKey = buildTtsCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const audioBuffer = await minimaxSynthesize({
      ...payload,
      format,
      debugLog: appendMinimaxTtsLog,
    });
    fs.writeFileSync(audioPath, audioBuffer);
    appendMinimaxTtsLog({
      requestId: `tts-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      phase: "cache.write",
      cacheKey,
      audioBytes: audioBuffer.length,
      textChars: Array.from(payload.text).length,
    });
    return {
      base64: audioBuffer.toString("base64"),
      cacheKey,
      cached: false,
    };
  });

  // 流式语音合成（minimax WS 边合成边推 chunk 给渲染端播）
  // 主进程同时攒完整 buffer 落盘缓存，下次同文本走缓存
  ipcMain.handle(IPC.TTS_STREAM_START, async (event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    vocalEnhance?: { enabled: boolean };
    expectedCacheKey?: string;
  }) => {
    const format = payload.format ?? "mp3";
    const sender = event.sender;

    // 回听优先：expectedCacheKey 命中缓存直接发完整 base64（走 STREAM_END，不走 chunk）
    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try { expectedPath = getTtsCachePath(payload.expectedCacheKey, format); } catch { /* */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuf = fs.readFileSync(expectedPath);
      appendMinimaxTtsLog({
        requestId: `tts-stream-cache-${Date.now()}`,
        ts: new Date().toISOString(),
        phase: "stream.cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuf.length,
      });
      // 缓存命中：一次性发完整音频（渲染端会按 STREAM_END 处理，直接播完整 buffer）
      sender.send(IPC.TTS_AUDIO_CHUNK, { base64: cachedBuf.toString("base64") });
      sender.send(IPC.TTS_STREAM_END, { cacheKey: payload.expectedCacheKey, cached: true, format });
      return { started: false, cacheKey: payload.expectedCacheKey, cached: true };
    }

    if (!payload?.apiKey || !payload?.voiceId || !payload?.text) {
      throw new Error("流式合成缺少必要参数（apiKey/voiceId/text）");
    }

    const cacheKey = buildTtsCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    const fullChunks: Buffer[] = [];

    // 异步合成，不 await（handler 立即返回，chunk 通过 send 推送）
    void (async () => {
      try {
        const audioBuffer = await minimaxSynthesize({
          apiKey: payload.apiKey,
          voiceId: payload.voiceId,
          text: payload.text,
          speed: payload.speed,
          volume: payload.volume,
          pitch: payload.pitch,
          model: payload.model,
          format,
          vocalEnhance: payload.vocalEnhance,
          debugLog: appendMinimaxTtsLog,
          onChunk: (chunkBase64) => {
            fullChunks.push(Buffer.from(chunkBase64, "base64"));
            if (!sender.isDestroyed()) sender.send(IPC.TTS_AUDIO_CHUNK, { base64: chunkBase64 });
          },
        });
        // 落盘缓存（用完整 buffer，不用拼接的 fullChunks——synthesize 返回的更可靠）
        fs.writeFileSync(audioPath, audioBuffer);
        appendMinimaxTtsLog({
          requestId: `tts-stream-${Date.now()}`,
          ts: new Date().toISOString(),
          phase: "stream.cache.write",
          cacheKey,
          audioBytes: audioBuffer.length,
        });
        if (!sender.isDestroyed()) sender.send(IPC.TTS_STREAM_END, { cacheKey, cached: false, format });
      } catch (err) {
        if (!sender.isDestroyed()) {
          sender.send(IPC.TTS_STREAM_ERROR, { message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();

    return { started: true, cacheKey, cached: false };
  });

  // GPT-SoVITS 语音合成 → base64 音频（测试发音用，不缓存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_GPTSOVITS, async (_event, payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
  }) => {
    if (!payload?.baseUrl || !payload?.refAudioPath || !payload?.promptText || !payload?.text) {
      throw new Error("缺少必要参数（baseUrl/refAudioPath/promptText/text）");
    }
    const result = await gptsovitsSynthesize({
      ...payload,
      debugLog: appendGptsovitsTtsLog,
    });
    const cacheKey = buildGptsovitsCacheKey(payload);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // GPT-SoVITS 语音合成 + 本地缓存（聊天朗读用）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED_GPTSOVITS, async (_event, payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
    expectedCacheKey?: string;
  }) => {
    const format: "wav" | "mp3" = payload.format ?? "wav";

    // 回听优先：如果 expectedCacheKey 对应的缓存文件存在，直接返回，不需要 baseUrl/refAudioPath。
    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 格式非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      appendGptsovitsTtsLog({
        requestId: `gptsovits-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        phase: "cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuffer.length,
        textChars: Array.from(payload.text).length,
      });
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
        format,
      };
    }

    // 缓存未命中 → 需要合成，检查必要参数
    if (!payload?.baseUrl || !payload?.refAudioPath || !payload?.promptText || !payload?.text) {
      throw new Error("缓存未命中且缺少必要参数（baseUrl/refAudioPath/promptText/text）");
    }

    const cacheKey = buildGptsovitsCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const result = await gptsovitsSynthesize({
      baseUrl: payload.baseUrl,
      refAudioPath: payload.refAudioPath,
      promptText: payload.promptText,
      text: payload.text,
      speed: payload.speed,
      format,
      debugLog: appendGptsovitsTtsLog,
    });
    fs.writeFileSync(audioPath, result.audio);
    appendGptsovitsTtsLog({
      requestId: `gptsovits-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      phase: "cache.write",
      cacheKey,
      audioBytes: result.audio.length,
      textChars: Array.from(payload.text).length,
    });
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 自定义云端 TTS 合成 → base64 音频（测试发音用，不缓存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CUSTOM_CLOUD, async (_event, payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
  }) => {
    if (!payload?.endpointUrl || !payload?.text) {
      throw new Error("缺少必要参数（endpointUrl/text）");
    }
    const result = await customCloudSynthesize({
      ...payload,
      debugLog: appendCustomCloudTtsLog,
    });
    const cacheKey = buildCustomCloudCacheKey(payload);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 自定义云端 TTS 合成 + 本地缓存（聊天朗读用）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED_CUSTOM_CLOUD, async (_event, payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
    expectedCacheKey?: string;
  }) => {
    const format: "wav" | "mp3" = payload.format ?? "mp3";

    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 格式非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      appendCustomCloudTtsLog({
        requestId: `custom-cloud-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        phase: "cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuffer.length,
        textChars: Array.from(payload.text).length,
      });
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
        format,
      };
    }

    if (!payload?.endpointUrl || !payload?.text) {
      throw new Error("缓存未命中且缺少必要参数（endpointUrl/text）");
    }

    const cacheKey = buildCustomCloudCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const result = await customCloudSynthesize({
      endpointUrl: payload.endpointUrl,
      apiKey: payload.apiKey,
      voiceId: payload.voiceId,
      text: payload.text,
      speed: payload.speed,
      volume: payload.volume,
      format,
      timeoutMs: payload.timeoutMs,
      debugLog: appendCustomCloudTtsLog,
    });
    fs.writeFileSync(audioPath, result.audio);
    appendCustomCloudTtsLog({
      requestId: `custom-cloud-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      phase: "cache.write",
      cacheKey,
      audioBytes: result.audio.length,
      textChars: Array.from(payload.text).length,
    });
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 小米 MiMo TTS 合成 → base64 音频（测试发音用，不缓存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_MIMO, async (_event, payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
  }) => {
    if (!payload?.apiKey || !payload?.voiceAudioPath || !payload?.text) {
      throw new Error("缺少必要参数（apiKey/voiceAudioPath/text）");
    }
    const result = await mimoSynthesize({
      apiKey: payload.apiKey,
      voiceAudioPath: payload.voiceAudioPath,
      text: payload.text,
      stylePrompt: payload.stylePrompt,
      debugLog: appendMimoTtsLog,
    });
    const cacheKey = buildMimoCacheKey(payload);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 小米 MiMo TTS 合成 + 本地缓存（聊天朗读用）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED_MIMO, async (_event, payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
    expectedCacheKey?: string;
  }) => {
    const format: "wav" = "wav";

    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 格式非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      appendMimoTtsLog({
        requestId: `mimo-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        phase: "cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuffer.length,
        textChars: Array.from(payload.text).length,
      });
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
        format,
      };
    }

    if (!payload?.apiKey || !payload?.voiceAudioPath || !payload?.text || payload.apiKey === "cache-only") {
      throw new Error("缓存未命中且缺少必要参数（apiKey/voiceAudioPath/text）");
    }

    const cacheKey = buildMimoCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const result = await mimoSynthesize({
      apiKey: payload.apiKey,
      voiceAudioPath: payload.voiceAudioPath,
      text: payload.text,
      stylePrompt: payload.stylePrompt,
      debugLog: appendMimoTtsLog,
    });
    fs.writeFileSync(audioPath, result.audio);
    appendMimoTtsLog({
      requestId: `mimo-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      phase: "cache.write",
      cacheKey,
      audioBytes: result.audio.length,
      textChars: Array.from(payload.text).length,
    });
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // ── Mossland (api.mosi.cn) ──────────────────────────────────────

  // Mossland 合成（Settings「测试发音」用，无缓存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_MOSSLAND, async (_event, payload: {
    apiKey: string; voiceId: string; text: string;
    model?: string; format?: "mp3" | "wav";
  }) => {
    if (!payload?.apiKey || !payload?.voiceId || !payload?.text) {
      throw new Error("缺少必要参数（apiKey/voiceId/text）");
    }
    const result = await mosslandSynthesize({
      apiKey: payload.apiKey,
      voiceId: payload.voiceId,
      text: payload.text,
      model: payload.model,
      format: payload.format,
    });
    const cacheKey = buildMosslandCacheKey(payload);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // Mossland 合成 + 本地缓存（聊天自动朗读用；cache-only 兜底由 chat 侧传 "cache-only"）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED_MOSSLAND, async (_event, payload: {
    apiKey: string; voiceId: string; text: string;
    model?: string; format?: "mp3" | "wav";
    expectedCacheKey?: string;
  }) => {
    const format: "mp3" | "wav" = payload.format ?? "mp3";

    // 缓存命中
    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
        format,
      };
    }

    // 缓存未命中 + 缺关键参数（或 chat 端 cache-only 占位）→ 抛错
    if (!payload?.apiKey || !payload?.voiceId || !payload?.text
        || payload.apiKey === "cache-only" || payload.voiceId === "cache-only") {
      throw new Error("缓存未命中且缺少必要参数（apiKey/voiceId/text）");
    }

    const cacheKey = buildMosslandCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const result = await mosslandSynthesize({
      apiKey: payload.apiKey,
      voiceId: payload.voiceId,
      text: payload.text,
      model: payload.model,
      format,
    });
    fs.writeFileSync(audioPath, result.audio);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // Mossland 音色克隆（multipart 上传）
  ipcMain.handle(IPC.TTS_CLONE_MOSSLAND, async (_event, payload: {
    apiKey: string; filePath: string; name?: string; description?: string;
  }) => {
    const result = await mosslandCloneVoice({
      apiKey: payload.apiKey,
      filePath: payload.filePath,
      name: payload.name,
      description: payload.description,
    });
    return {
      voiceId: result.voiceId,
      name: result.name,
      createdAt: result.createdAt,
    };
  });

  // Mossland 拉取账号下音色列表
  ipcMain.handle(IPC.TTS_LIST_MOSSLAND_VOICES, async (_event, payload: {
    apiKey: string; limit?: number; offset?: number; after?: string; status?: string;
  }) => {
    const result = await mosslandListVoices({
      apiKey: payload.apiKey,
      limit: payload.limit,
      offset: payload.offset,
      after: payload.after,
      status: payload.status,
    });
    return result;
  });
}
