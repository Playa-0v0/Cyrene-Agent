export interface SmartSegmentationOptions {
  contentThreshold?: number;
  maxChars?: number;
  maxParts?: number;
  sentenceFallback?: boolean;
}

export function isStructuredReply(text: string): boolean {
  if (text.includes("```")) return true;
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return false;
  return lines.some((line) => /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)、]\s|>\s|\|.+\|)/.test(line));
}

export function splitSmartReply(text: string, options: SmartSegmentationOptions = {}): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const threshold = options.contentThreshold ?? 200;
  if (normalized.length > threshold || isStructuredReply(normalized)) return [normalized];

  const explicitParagraphs = normalized.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  const rawParts = explicitParagraphs.length > 1
    ? explicitParagraphs
    : options.sentenceFallback
      ? normalized.match(/[^。！？!?；;\n]+[。！？!?；;]?\s*/g)?.map((part) => part.trim()).filter(Boolean) ?? [normalized]
      : [normalized];

  const maxChars = options.maxChars ?? 180;
  const chunks: string[] = [];
  for (const rawPart of rawParts) {
    let part = rawPart;
    while (part.length > maxChars) {
      chunks.push(part.slice(0, maxChars));
      part = part.slice(maxChars);
    }
    if (part) chunks.push(part);
  }

  const maxParts = Math.max(1, options.maxParts ?? 4);
  if (chunks.length <= maxParts) return chunks;
  return [...chunks.slice(0, maxParts - 1), chunks.slice(maxParts - 1).join("")];
}

export function calculateSmartSegmentDelay(
  textLength: number,
  mode: "random" | "length",
  minDelay: number,
  maxDelay: number,
  random = Math.random,
): number {
  const min = Math.max(0, minDelay);
  const max = Math.max(min, maxDelay);
  if (mode === "random") return Math.round(min + random() * (max - min));
  const typingRatio = Math.min(1, Math.max(0, textLength) / 24);
  return Math.round(min + (max - min) * typingRatio);
}
