export const PET_CHAT_REPLY_MAX_CHARS = 84;

function charCount(value: string): number {
  return Array.from(value).length;
}

/**
 * 桌寵氣泡專用的最後一道長度保護。
 * 一般聊天、Discord 與其他渠道不會經過此函數。
 */
export function compactPetReply(raw: string, maxChars = PET_CHAT_REPLY_MAX_CHARS): string {
  const normalized = raw
    .replace(/^(?:（[^）]{0,40}）|\([^)]{0,40}\))\s*/u, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!normalized || charCount(normalized) <= maxChars) return normalized;

  const sentences = normalized.match(/.*?[。！？!?♪～~]+|.+$/gu) ?? [normalized];
  let compact = "";
  for (const sentence of sentences) {
    const candidate = compact + sentence;
    if (charCount(candidate) > maxChars) break;
    compact = candidate;
  }

  // 避免只保留很短的語氣詞；此時改為在安全長度內自然收尾。
  if (compact && charCount(compact) >= Math.min(24, Math.floor(maxChars * 0.4))) {
    return compact.trim();
  }

  const shortened = Array.from(normalized)
    .slice(0, Math.max(1, maxChars - 1))
    .join("")
    .replace(/[，、；：\s]+$/u, "");
  return shortened + "…";
}
