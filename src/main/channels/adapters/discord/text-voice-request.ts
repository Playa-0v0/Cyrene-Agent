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

/** 支援「能傳一段晚安的語音嗎」、「能說句晚安嗎」及「能只說句晚安」。 */
export function extractDiscordVoiceRequestTopic(text: string): string | null {
  const cleaned = text
    .replace(/\[附件:\s*.*?\s*\]/gi, "")
    .replace(/<@!?\d+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const exactText = extractDiscordExactVoiceText(cleaned);
  if (exactText !== null) return exactText;
  const voiceMatch = cleaned.match(/能傳一段(?:(.+?)的)?語音(?:嗎)?[？?]?\s*$/u);
  if (voiceMatch) return voiceMatch[1]?.trim() || "自由發揮一段自然、親切的內容";
  const sayMatch = cleaned.match(/能說(?:一)?句\s*(.+?)(?:嗎)?[？?]?\s*$/u);
  return sayMatch?.[1]?.trim() || null;
}

export function isDiscordTextVoiceRequestText(text: string): boolean {
  return extractDiscordVoiceRequestTopic(text) !== null;
}
