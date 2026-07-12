// ── 滑动窗口 Chunk 切分 ──
// 不做段落/句子逻辑判断，直接按 token 数滑动。
// overlap 确保任何断点都在至少两个 chunk 里覆盖。
// 自动识别 Markdown 标题，给每个 chunk 带上标题前缀。

export interface Chunk {
  id: string;
  text: string;
  source: string;       // 来源：文件名或 "memory"
  index: number;        // chunk 序号
  metadata?: Record<string, unknown>;
}

export const DOCUMENT_CHUNK_SIZE = 512;
export const DOCUMENT_CHUNK_OVERLAP = 128;

// ── Token 估算 ──
// 注意：这只是估算值，用于决定切分位置。
// 实际模型的 tokenizer 会略有不同，但滑动窗口的冗余覆盖能容错。
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherTokens = text
    .replace(/[\u4e00-\u9fff]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return chineseChars + otherTokens;
}

// ── 文本位置索引（防止 chars / tokens 不一致的问题） ──
// 为了控制切分边界在"字符"层级而不是 token 层级更精确，
// 我们先把文本按"字符"切好，用 estimateTokens 算总 token 数，
// 然后按比例在字符位置滑动。

interface CharSpan {
  start: number;   // 字符索引（包含）
  end: number;     // 字符索引（不包含）
  text: string;
}

/** 找到 text 中从 pos 开始的下一个句子边界位置（句号/问号/感叹号/换行符）。找不到时返回 -1。 */
function findNextSentenceBoundary(text: string, pos: number): number {
  for (let i = pos; i < text.length; i++) {
    const c = text[i];
    if (c === "\u3002" || c === "\uff01" || c === "\uff1f" || c === "\n" || c === "." || c === "!" || c === "?") {
      // 跳过连续标点
      let j = i + 1;
      while (j < text.length && "\u3002\uff01\uff1f\n.!?".includes(text[j])) j++;
      return j;
    }
  }
  return -1;
}

function* iterateSlidingWindowChars(
  text: string,
  chunkSize: number,
  overlap: number,
): Generator<CharSpan> {
  if (!text || !text.trim()) return;

  const totalChars = text.length;
  // 如果总 token 数 <= chunkSize，不需要切
  if (estimateTokens(text) <= chunkSize) {
    yield { start: 0, end: totalChars, text };
    return;
  }

  let previousSpan: CharSpan | null = null;
  const step = chunkSize - overlap;  // 每步前进的 token 数
  const totalTokens = estimateTokens(text);
  // 每个 token 对应的平均字符数
  const tokensPerChar = totalTokens / totalChars;

  let posStart = 0;  // 字符起始位置
  let chunkIndex = 0;

  while (posStart < totalChars) {
    // 当前窗口的 token 起始位置（理论值）
    const startToken = Math.round(posStart * tokensPerChar);
    const endToken = startToken + chunkSize;
    let posEndChar = Math.min(totalChars, Math.round(endToken / tokensPerChar));

    // 如果剩余内容不足 chunkSize 的 1/3，合并到上一个 chunk
    if (chunkIndex > 0 && (totalChars - posStart) < chunkSize * tokensPerChar * 0.33) {
      // 把剩余内容追加到上一个 chunk
      if (previousSpan) {
        previousSpan.text = text.slice(previousSpan.start);
        previousSpan.end = totalChars;
      }
      break;
    }

    // ── 句子边界保护 ──
    // 如果 posEndChar 落在句子中间，往后延伸到下一个句子边界。
    // 最多允许额外延伸 chunkSize 的 20%，防止单个长句撑爆上限。
    const maxExtend = posEndChar + Math.round(chunkSize * 0.2 * tokensPerChar);
    const boundary = findNextSentenceBoundary(text, posEndChar);
    if (boundary !== -1 && boundary <= Math.min(maxExtend, totalChars)) {
      posEndChar = boundary;
    }

    if (previousSpan) yield previousSpan;
    previousSpan = {
      start: Math.round(posStart),
      end: posEndChar,
      text: text.slice(Math.round(posStart), posEndChar),
    };

    chunkIndex++;
    posStart += step / tokensPerChar;
  }

  if (previousSpan) yield previousSpan;
}

// ── 标题前缀提取 ──
interface TitleRecord {
  level: number;     // 1=#, 2=##, 3=###
  title: string;     // "3.1 架构"
  tokenPos: number;  // 出现位置的 token 估算值
}

function extractTitles(text: string): TitleRecord[] {
  const titles: TitleRecord[] = [];
  const lines = text.split("\n");
  let tokenPos = 0;

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      titles.push({
        level: match[1].length,
        title: match[2].trim(),
        tokenPos,
      });
    }
    tokenPos += estimateTokens(line + "\n");
  }

  return titles;
}

/** 根据 token 位置和标题列表，生成该位置的标题前缀 */
function getTitlePrefix(tokenPos: number, titles: TitleRecord[]): string {
  // 找距离当前位置最近且 tokenPos <= 当前位置的标题链
  const active: TitleRecord[] = [];
  for (const t of titles) {
    if (t.tokenPos > tokenPos) break;
    // 同层级覆盖
    while (active.length > 0 && active[active.length - 1].level >= t.level) {
      active.pop();
    }
    active.push(t);
  }

  if (active.length === 0) return "";
  return active.map((t) => t.title).join(" > ");
}

// ── 主函数 ──
export function chunkText(
  text: string,
  source: string,
  chunkSize = DOCUMENT_CHUNK_SIZE,
  overlap = DOCUMENT_CHUNK_OVERLAP,
): Chunk[] {
  return Array.from(iterateDocumentChunks(text, source, chunkSize, overlap));
}

export function* iterateDocumentChunks(
  text: string,
  source: string,
  chunkSize = DOCUMENT_CHUNK_SIZE,
  overlap = DOCUMENT_CHUNK_OVERLAP,
): Generator<Chunk> {
  // 预提取标题（只需扫描一次全文）
  const titles = extractTitles(text);
  const hasTitles = titles.length > 0;

  // 滑动窗口切分
  let i = 0;
  for (const span of iterateSlidingWindowChars(text, chunkSize, overlap)) {
    let chunkTextContent = span.text.trim();
    if (!chunkTextContent) continue;

    // 加上标题前缀（如果有标题的话）
    if (hasTitles) {
      // 用该 span 的起始 token 位置计算前缀
      const startTokenPos = Math.round(estimateTokens(text.slice(0, span.start)));
      const prefix = getTitlePrefix(startTokenPos, titles);
      if (prefix) {
        chunkTextContent = `【${prefix}】${chunkTextContent}`;
      }
    }

    yield {
      id: `${source}_${i}`,
      text: chunkTextContent,
      source,
      index: i,
    };
    i += 1;
  }
}
