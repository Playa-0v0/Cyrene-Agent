const SENTENCE_END = /[。！？!?；;\n]/;
const SOFT_BREAK = /[，、,：:]/;

/** Split long replies so GPT-SoVITS can return the first playable audio sooner. */
export function splitForEarlySpeech(text: string, maxChars = 34): string[] {
  const normalized = text
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\*[^*]*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let current = "";
  for (const char of normalized) {
    current += char;
    const length = Array.from(current).length;
    if (SENTENCE_END.test(char) || (length >= 18 && SOFT_BREAK.test(char)) || length >= maxChars) {
      chunks.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}
