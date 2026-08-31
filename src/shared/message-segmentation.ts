export const MAX_MESSAGE_SEGMENTS = 10;

const SENTENCE_SEGMENT_BREAK = /[。！？!?；;]/;

export function shouldBreakMessageSegmentAfterChar(char: string): boolean {
  return SENTENCE_SEGMENT_BREAK.test(char);
}

export function shouldSkipMessageSegmentLeadingChar(char: string, isAtSegmentStart: boolean): boolean {
  return isAtSegmentStart && /^\s$/.test(char);
}

export function splitTextBySentenceBreaks(text: string, maxParts = MAX_MESSAGE_SEGMENTS): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const safeMaxParts = Math.max(1, Math.floor(maxParts));
  const parts: string[] = [];
  let buffer = "";

  for (const char of clean) {
    if (shouldSkipMessageSegmentLeadingChar(char, buffer.length === 0)) continue;
    buffer += char;

    if (parts.length < safeMaxParts - 1 && shouldBreakMessageSegmentAfterChar(char)) {
      parts.push(buffer);
      buffer = "";
    }
  }

  if (buffer) parts.push(buffer);
  return parts;
}
