// GPT-SoVITS 本地 TTS 引擎
// 接口：官方 api_v2 (POST /api/tts)，返回 wav 字節
// 參考：https://github.com/RVC-Boss/GPT-SoVITS
import * as fs from "fs";
import { toSimplifiedChinese } from "../utils/opencc";

export interface GptsovitsSynthesizeOptions {
  baseUrl: string;          // 形如 "http://localhost:9880"，不含路徑
  refAudioPath: string;     // 參考音頻絕對路徑
  promptText: string;      // 參考音頻對應的文本
  text: string;             // 待合成文本
  speed?: number;           // 0.5~2，默認 1
  format?: "wav" | "mp3";   // 默認 wav
  timeoutMs?: number;      // 默認 60000（本地推理可能較慢）
  debugLog?: (entry: Record<string, unknown>) => void;
}

export interface GptsovitsSynthesizeResult {
  audio: Buffer;
  format: "wav" | "mp3";
}

const DEFAULT_TIMEOUT_MS = 60000;
const TTS_PATH = "/tts";

/**
 * 調 GPT-SoVITS api_v2。
 * 請求體 application/x-www-form-urlencoded：
 *   refer_wav_path / prompt_text / text / text_language / prompt_language / speed_factor / streaming / format
 * 返回完整 wav（或 mp3）字節。
 */
export async function synthesize(opts: GptsovitsSynthesizeOptions): Promise<GptsovitsSynthesizeResult> {
  const format: "wav" | "mp3" = opts.format ?? "wav";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestId = `gptsovits-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  const log = (entry: Record<string, unknown>) => {
    try { opts.debugLog?.({ requestId, ts: new Date().toISOString(), ...entry }); } catch { /* ignore */ }
  };

  // 1) 輸入校驗與音檔降級防線
  if (!opts.baseUrl) throw new Error("缺少 GPT-SoVITS API 地址");
  if (!opts.refAudioPath) throw new Error("缺少參考音頻路徑");
  if (!opts.promptText) throw new Error("缺少參考音頻對應的文本");
  if (!opts.text) throw new Error("缺少合成文本");

  const emotionsDir = "/Users/clark/GPT-SoVITS/昔涟_reference_audios/中文/emotions/";
  const cleanKaixin = "/Users/clark/GPT-SoVITS/昔涟_reference_audios/昔涟_clean_kaixin_padded.wav";

  let activeRefPath = fs.existsSync(opts.refAudioPath) ? opts.refAudioPath : cleanKaixin;
  let activePromptText = fs.existsSync(opts.refAudioPath) ? opts.promptText : "那时我们都是小孩子呢。";

  if (!fs.existsSync(activeRefPath)) {
    throw new Error(`參考音頻文件不存在且無法找到備用音檔: ${opts.refAudioPath}`);
  }

  // Clean text by stripping parentheses, stage directions, emojis, and music symbols, and normalize English terms
  const cleanText = (text: string): string => {
    if (!text) return "";
    let val = text;
    val = val.replace(/（[^）]+）/g, "");
    val = val.replace(/\([^)]+\)/g, "");
    val = val.replace(/\[[^\]]+\]/g, "");
    val = val.replace(/\*[^*]+\*/g, "");
    val = val.replace(/[\u{1F300}-\u{1F9FF}]/gu, "");
    val = val.replace(/[\u{2700}-\u{27BF}]/gu, "");
    val = val.replace(/[♪★☆♥♦♣♠♫♬💕✨🌟🎨🎭🎪🎫🎗🏵🎫🎟🎮🎲🎰🎯🎳🎱🎵🎶🎙🎛🎤🎧🎷🎸🎹🎺🎻🥁]/g, "");
    
    // Replace common English terms with clear Chinese pronunciations to avoid TTS hallucination/garbled speech
    val = val.replace(/\bDiscord\b/gi, "迪斯可");
    val = val.replace(/\bCyrene\b/gi, "昔漣");
    val = val.replace(/\bLive2D\b/gi, "立體");
    val = val.replace(/\bAI\b/gi, "愛哎");
    val = val.replace(/\bApp\b/gi, "軟體");
    val = val.replace(/\bOK\b/gi, "好的");

    val = val.replace(/\s+/g, " ");
    return val.trim();
  };

  // 自然對話情感切換（真人聊天 1.18x 配速、高昂亮麗精神 Tone、0.10s 自然對話停頓）
  let activeSpeed = opts.speed ?? 1.18;
  let activeTemp = 0.62;
  let activeTopK = 15;
  let activeTopP = 0.95;

  const rawText = opts.text;

  if (fs.existsSync(emotionsDir)) {
    if (/asmr|耳語|輕聲|睡前|陪伴|（湊在耳邊|（輕聲/i.test(rawText)) {
      // 🌙 ASMR 極致耳語陪伴（極致安詳柔和、0.92x 極沉靜語速）
      if (fs.existsSync(cleanKaixin)) {
        activeRefPath = cleanKaixin;
        activePromptText = "那时我们都是小孩子呢。";
      } else {
        activeRefPath = emotionsDir + "【难过】是呀。看着眼前的世界，悲伤的念头还是化作了现实…….wav";
        activePromptText = "是呀。看着眼前的世界，悲伤的念头还是化作了现实……";
      }
      activeSpeed = 0.92;
      activeTemp = 0.45;
      activeTopK = 10;
      activeTopP = 0.90;
    } else if (/♪|唱歌|哼唱|歌唱|旋律|演唱|唱首歌/i.test(rawText)) {
      // 🎵 唱歌 / 吟唱（高音調旋律感、1.18x 明快語速）
      const p = emotionsDir + "【吃惊】这片麦田可是我们的宝贝，不能随便踩进去哦。会把希望踩坏的。.wav";
      if (fs.existsSync(p)) {
        activeRefPath = p;
        activePromptText = "这片麦田可是我们的宝贝，不能随便踩进去哦。会把希望踩坏的。";
      }
      activeSpeed = 1.18;
      activeTemp = 0.65;
      activeTopK = 15;
      activeTopP = 0.95;
    } else if (/難過|抱歉|對不起|傷心|哭|嗚嗚|遺憾|落淚|痛苦|悲傷|低落|失落|唉|痛|難受/i.test(rawText)) {
      const p = emotionsDir + "【难过】是呀。看着眼前的世界，悲伤的念头还是化作了现实…….wav";
      if (fs.existsSync(p)) {
        activeRefPath = p;
        activePromptText = "是呀。看着眼前的世界，悲伤的念头还是化作了现实……";
        activeSpeed = 0.95;
        activeTemp = 0.48;
        activeTopK = 10;
        activeTopP = 0.90;
      }
    } else if (/生氣|哼|笨蛋|討厭|可惡|氣死|過分|走開|不理你|欺負|壞蛋/i.test(rawText)) {
      const p = emotionsDir + "【生气】嗯，毕竟…你可是我们的憧憬呀。.wav";
      if (fs.existsSync(p)) {
        activeRefPath = p;
        activePromptText = "嗯，毕竟…你可是我们的憧憬呀。";
        activeSpeed = 1.18;
        activeTemp = 0.55;
        activeTopK = 12;
        activeTopP = 0.92;
      }
    } else {
      // 默認真人自然聊天：高昂精神 1.18x 語速、亮麗情緒起伏、告別唸稿感
      const chijingRef = emotionsDir + "【吃惊】这片麦田可是我们的宝贝，不能随便踩进去哦。会把希望踩坏的。.wav";
      if (fs.existsSync(chijingRef)) {
        activeRefPath = chijingRef;
        activePromptText = "这片麦田可是我们的宝贝，不能随便踩进去哦。会把希望踩坏的。";
      } else if (fs.existsSync(cleanKaixin)) {
        activeRefPath = cleanKaixin;
        activePromptText = "那时我们都是小孩子呢。";
      }
      activeSpeed = opts.speed ?? 1.18;
      activeTemp = 0.62;
      activeTopK = 15;
      activeTopP = 0.95;
    }
  }

  // 防線 1: 如果目標參考音檔不存在，安全退回傳入的默認音檔
  if (!fs.existsSync(activeRefPath)) {
    activeRefPath = opts.refAudioPath;
    activePromptText = opts.promptText;
  }

  let cleanedText = toSimplifiedChinese(cleanText(opts.text));
  // 防線 2: 如果文本被過濾乾淨（如純表情/符號），自動降級補全，防止 400 空字串錯
  if (!cleanedText || !cleanedText.trim()) {
    cleanedText = toSimplifiedChinese(opts.text.replace(/[\u{1F300}-\u{1F9FF}]/gu, "").trim()) || "嗯。";
  }
  const promptTextSimp = toSimplifiedChinese(activePromptText);

  // 防線 3: 長文本切分適應（超長段落自動採用 cut5 切分，防止推導超時）
  const splitMethod = cleanedText.length > 250 ? "cut5" : "cut1";

  // 2) 構造 JSON body（裸對象，不包 data）
  // 契約參考 GPT-SoVITS api_v2.py: POST /tts，body 是 TTS_Request 模型
  // 必需字段：text / text_lang / ref_audio_path / prompt_lang
  const body = JSON.stringify({
    text: cleanedText,
    text_lang: "zh",
    ref_audio_path: activeRefPath,
    prompt_text: promptTextSimp,
    prompt_lang: "zh",
    top_k: activeTopK,
    top_p: activeTopP,
    temperature: activeTemp,
    repetition_penalty: 1.35,
    fragment_interval: 0.10, // 0.10s (100ms) 真人對話自然停頓節奏，不黏連也不唸稿
    text_split_method: splitMethod, // 短中句用 cut1 一氣呵成，超長句安全退回 cut5 防超時
    speed_factor: activeSpeed,
    streaming_mode: false,
    media_type: format,
  });

  // baseUrl 去掉尾部斜槓，拼 /api/tts
  const url = opts.baseUrl.replace(/\/+$/, "") + TTS_PATH;

  log({
    phase: "request.begin",
    endpoint: url,
    textChars: Array.from(opts.text).length,
    refAudioPath: opts.refAudioPath,
    format,
  });

  // 3) 發請求 + 超時控制
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      log({ phase: "error", error: `合成超時（${timeoutMs}ms）`, durationMs: Date.now() - startedAt });
      throw new Error(`GPT-SoVITS 合成超時（${timeoutMs}ms），檢查服務是否在跑`);
    }
    log({ phase: "error", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startedAt });
    throw new Error(`GPT-SoVITS 請求失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);

  // 4) 響應處理
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const preview = text.slice(0, 200);
    log({ phase: "error", status: resp.status, bodyPreview: preview, durationMs: Date.now() - startedAt });
    throw new Error(`GPT-SoVITS 合成失敗: ${resp.status} ${preview}`);
  }

  const audio = Buffer.from(await resp.arrayBuffer());

  // 校驗 magic bytes：wav 以 "RIFF" 開頭，mp3 以 ID3 或 0xFF 0xFB 開頭
  const isWav = audio.slice(0, 4).toString("ascii") === "RIFF";
  const isMp3 = audio[0] === 0x49 /* I (ID3) */ || audio[0] === 0xff;
  if (format === "wav" && !isWav && !isMp3) {
    log({ phase: "warn", message: "期望 wav 但返回的不是 RIFF 頭", firstBytes: audio.slice(0, 4).toString("hex") });
  }

  log({
    phase: "response.final",
    durationMs: Date.now() - startedAt,
    audioBytes: audio.length,
    isWav,
    isMp3,
  });

  return { audio, format };
}
