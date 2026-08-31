/** Extract a stored `[sticker:id]` marker without exposing it as chat text. */
export function extractMessageStickerId(content: string, explicitSticker?: string | null): string | undefined {
  if (explicitSticker) return explicitSticker;
  return content.match(/\[sticker:([^\]]+)\]/i)?.[1]?.trim() || undefined;
}

/** Remove all transport markers after their image has been resolved. */
export function stripMessageStickerMarkers(content: string): string {
  return content.replace(/\[sticker:[^\]]+\]/gi, "").trim();
}
