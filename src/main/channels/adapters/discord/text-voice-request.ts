/** Discord 文字頻道中，要求 Bot 回傳語音附件的自然語言判斷。 */

export interface DiscordVoiceTone {
  stylePrompt: string;
  speedMultiplier: number;
}

export function inferDiscordVoiceTone(text: string): DiscordVoiceTone {
  if (/[😢😭🥺💔]/u.test(text) || /[…]{2,}|……/u.test(text)) {
    return { stylePrompt: "語氣稍微低落、柔和，有一點難過與停頓。", speedMultiplier: 0.9 };
  }
  if (/[😡🤬💢]/u.test(text)) {
    return { stylePrompt: "語氣強烈、有氣勢，情緒明顯但發音清楚。", speedMultiplier: 1.08 };
  }
  if (/[!！🔥🥳🤩😆]/u.test(text)) {
    return { stylePrompt: "語氣興奮、有精神、有氣勢，重音明顯。", speedMultiplier: 1.1 };
  }
  if (/[?？🤔❓]/u.test(text)) {
    return { stylePrompt: "語氣帶著自然疑問與好奇，句尾微微上揚。", speedMultiplier: 1 };
  }
  if (/[~～🥰😍😘💕❤️]/u.test(text)) {
    return { stylePrompt: "語氣甜美、親近、稍微撒嬌，節奏柔和。", speedMultiplier: 0.95 };
  }
  return { stylePrompt: "語氣自然、親切，像在近距離聊天。", speedMultiplier: 1 };
}

function removeEmojiForSpeech(text: string): string {
  return text.replace(/\p{Extended_Pictographic}/gu, "").replace(/[\uFE0F\u200D]/g, "").trim();
}

/** 「能只說句…」的指定台詞；emoji 只控制語氣，不會被朗讀成名稱。 */
export function extractDiscordExactVoiceText(text: string): string | null {
  const cleaned = text
    .replace(/\[附件:\s*.*?\s*\]/gi, "")
    .replace(/<@!?\d+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = cleaned.match(/能只說(?:一)?句\s*(.+?)(?:嗎)?[？?]?\s*$/u);
  if (!match?.[1]?.trim()) return null;
  const raw = match[1].trim();
  let spoken = removeEmojiForSpeech(raw);
  if (/[🔥🥳🤩😆😡🤬💢]/u.test(raw) && !/[!！]$/.test(spoken)) spoken += "！";
  else if (/[😢😭🥺💔]/u.test(raw) && !/(?:……|…)$/.test(spoken)) spoken += "……";
  else if (/[🥰😍😘💕❤️]/u.test(raw) && !/[~～]$/.test(spoken)) spoken += "～";
  else if (/[🤔❓]/u.test(raw) && !/[?？]$/.test(spoken)) spoken += "？";
  return spoken || null;
}

/** 支援各種自然語言語音請求、指定台詞及能力確認詢問。 */
export function extractDiscordVoiceRequestTopic(text: string): string | null {
  const cleaned = text
    .replace(/\[附件:\s*.*?\s*\]/gi, "")
    .replace(/<@!?\d+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 1. 精確指定台詞
  const exactText = extractDiscordExactVoiceText(cleaned);
  if (exactText !== null) return exactText;

  // 2. 詢問是否能傳語音（如「你能傳語音嗎」、「你會發語音嗎」）
  if (
    /(?:你能|你會|你可以|你能不能|能不能|可不可以|可否|能不能夠)(?:傳|發|發送|錄|用語音|講|說)(?:音訊|語音|聲音)?(?:嗎|不|麼)?[？?]?\s*$/u.test(cleaned) ||
    /(?:可以|能)(?:傳|發|發送|錄)(?:語音|聲音)(?:嗎)?[？?]?\s*$/u.test(cleaned)
  ) {
    return "親切並確定地告訴夥伴你可以傳語音，並給予溫暖的回應";
  }

  if (/(?:教學|圖片|相片|短片|影片)/u.test(cleaned)) return null;

  // 3. 任何「想聽...」、「想聽你說...」、「想聽昔漣講...」
  const wantListenMatch = cleaned.match(/(?:想聽|聽聽|好想聽|想聽聽)(?:你|昔漣)?(?:說|講|唸|唱)?(?:一段|一個|幾句|一句|個|些)?\s*(.+?)\s*(?:嗎|吧|麼|嘛)?[？?]?\s*$/u);
  if (wantListenMatch) {
    return wantListenMatch[1]?.trim() || "自由發揮一段溫柔、親切的陪伴語音對話";
  }

  // 4. 「傳/發/錄/給 (一段/一個/幾句/一句/個/些) (topic) 的語音/語音」
  const voiceMatch = cleaned.match(/(?:能|可以|能不能|可不可以|請|幫我)?(?:傳|發|錄|給)(?:一段|一個|幾句|一句|個|些)?\s*(?:(.+?)的)?語音(?:嗎|吧|麼|嘛)?[？?]?\s*$/u);
  if (voiceMatch) {
    return voiceMatch[1]?.trim() || "自由發揮一段自然、親切的內容";
  }

  // 5. 「說/講/唸 (幾句/一句/個)...」
  const sayMatch = cleaned.match(/(?:能|可以|幫我)?(?:說|講|唸)(?:一|幾)?(?:句|個)\s*(.+?)(?:嗎|吧|麼|嘛)?[？?]?\s*$/u);
  if (sayMatch?.[1]?.trim()) {
    return sayMatch[1].trim();
  }

  // 6. 包含「語音」、「聲音」、「用講的」、「ASMR」、「唱歌」、「/sing」、「/asmr」等任何語音/音訊關鍵字
  if (/(?:語音|聲音|用講的|聽聲音|語音話|asmr|耳語|輕聲|睡前|唱|唱歌|吟唱|\/sing|\/asmr|!sing|!asmr)/iu.test(cleaned)) {
    return cleaned.replace(/(?:傳|發|錄|用語音|說|講|唸|請|幫我|能|可以|嗎|吧|麼|嘛|？|\?)/gu, "").trim() || "自由發揮一段自然親切的語音對話";
  }

  return null;
}

export function isDiscordTextVoiceRequestText(text: string): boolean {
  return extractDiscordVoiceRequestTopic(text) !== null;
}
