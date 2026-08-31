/**
 * 将聊天内容压缩成适合贴纸语义匹配的自然语言。
 *
 * 贴纸只应反映对话情绪/意图；代码与数学表达式会给 embedding 带来大量无关 token，
 * 因此在调用 embedding provider 前直接剔除，而非尝试解释或转写它们。
 *
 * 之前用 markdown-it 完整 parse 一次再重组 inline token，但因为我们只关心"留什么 /
 * 删什么"，纯正则反而更轻、更直接，也避免了 lib 依赖。
 */
export function extractStickerEmbeddingText(source: string): string {
  if (!source.trim()) return "";

  return source
    // fenced code blocks (both Markdown fence styles)
    .replace(/(?:^|\n)[ \t]*```[\s\S]*?```[ \t]*(?=\n|$)/g, "\n")
    .replace(/(?:^|\n)[ \t]*~~~[\s\S]*?~~~[ \t]*(?=\n|$)/g, "\n")
    // display and inline TeX math
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\\\([\s\S]*?\\\)/g, " ")
    .replace(/\$(?:\\.|[^$\r\n])+\$/g, " ")
    // inline code spans
    .replace(/`[^`\n]*`/g, " ")
    // inline / block-level HTML tags: drop angle-bracket markup, keep inner text
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    // image syntax ![alt](url) — drop entirely (alt text is usually a filename, not sentiment)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    // markdown links [text](url) — keep text, drop the URL half which is noise for embedding
    .replace(/\]\([^)]*\)/g, "]")
    // explicit sticker markers (control sequence emitted by the assistant)
    .replace(/\[sticker:[^\]]+\]/gi, " ")
    // collapse all whitespace (newlines, tabs, multiple spaces) into single spaces
    .replace(/\s+/g, " ")
    .trim();
}

/** Build the bounded, natural-language-only query sent to the embedding provider. */
export function buildStickerEmbeddingQuery(reply: string, userText: string, maxLength = 1000): string {
  return [extractStickerEmbeddingText(reply), extractStickerEmbeddingText(userText)]
    .filter(Boolean)
    .join("\n")
    .slice(0, maxLength);
}