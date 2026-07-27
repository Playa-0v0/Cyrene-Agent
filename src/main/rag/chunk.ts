// ── 滑動窗口 Chunk 切分 ──
// 不做段落/句子邏輯判斷，直接按 token 數滑動。
// overlap 確保任何斷點都在至少兩個 chunk 裡覆蓋。
// 自動識別 Markdown 標題，給每個 chunk 帶上標題前綴。

export interface Chunk {
  id: string;
  text: string;
  source: string;       // 來源：文件名或 "memory"
  index: number;        // chunk 序號
  metadata?: Record<string, unknown>;
}

// ── Token 估算 ──
// 注意：這只是估算值，用於決定切分位置。
// 實際模型的 tokenizer 會略有不同，但滑動窗口的冗餘覆蓋能容錯。
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherTokens = text
    .replace(/[\u4e00-\u9fff]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return chineseChars + otherTokens;
}

// ── 文本位置索引（防止 chars / tokens 不一致的問題） ──
// 為了控制切分邊界在"字符"層級而不是 token 層級更精確，
// 我們先把文本按"字符"切好，用 estimateTokens 算總 token 數，
// 然後按比例在字符位置滑動。

interface CharSpan {
  start: number;   // 字符索引（包含）
  end: number;     // 字符索引（不包含）
  text: string;
}

/** 找到 text 中從 pos 開始的下一個句子邊界位置（句號/問號/感嘆號/換行符）。找不到時返回 -1。 */
function findNextSentenceBoundary(text: string, pos: number): number {
  for (let i = pos; i < text.length; i++) {
    const c = text[i];
    if (c === "\u3002" || c === "\uff01" || c === "\uff1f" || c === "\n" || c === "." || c === "!" || c === "?") {
      // 跳過連續標點
      let j = i + 1;
      while (j < text.length && "\u3002\uff01\uff1f\n.!?".includes(text[j])) j++;
      return j;
    }
  }
  return -1;
}

/** 按 token 估算比例將文本切分成滑動窗口，並在句子邊界處對齊 */
function slidingWindowChars(
  text: string,
  chunkSize: number,
  overlap: number,
): CharSpan[] {
  if (!text || !text.trim()) return [];

  const totalChars = text.length;
  // 如果總 token 數 <= chunkSize，不需要切
  if (estimateTokens(text) <= chunkSize) {
    return [{ start: 0, end: totalChars, text }];
  }

  const spans: CharSpan[] = [];
  const step = chunkSize - overlap;  // 每步前進的 token 數
  const totalTokens = estimateTokens(text);
  // 每個 token 對應的平均字符數
  const tokensPerChar = totalTokens / totalChars;

  let posStart = 0;  // 字符起始位置
  let chunkIndex = 0;

  while (posStart < totalChars) {
    // 當前窗口的 token 起始位置（理論值）
    const startToken = Math.round(posStart * tokensPerChar);
    const endToken = startToken + chunkSize;
    let posEndChar = Math.min(totalChars, Math.round(endToken / tokensPerChar));

    // 如果剩餘內容不足 chunkSize 的 1/3，合併到上一個 chunk
    if (chunkIndex > 0 && (totalChars - posStart) < chunkSize * tokensPerChar * 0.33) {
      // 把剩餘內容追加到上一個 chunk
      const lastSpan = spans[spans.length - 1];
      lastSpan.text = text.slice(lastSpan.start);
      lastSpan.end = totalChars;
      break;
    }

    // ── 句子邊界保護 ──
    // 如果 posEndChar 落在句子中間，往後延伸到下一個句子邊界。
    // 最多允許額外延伸 chunkSize 的 20%，防止單個長句撐爆上限。
    const maxExtend = posEndChar + Math.round(chunkSize * 0.2 * tokensPerChar);
    const boundary = findNextSentenceBoundary(text, posEndChar);
    if (boundary !== -1 && boundary <= Math.min(maxExtend, totalChars)) {
      posEndChar = boundary;
    }

    spans.push({
      start: Math.round(posStart),
      end: posEndChar,
      text: text.slice(Math.round(posStart), posEndChar),
    });

    chunkIndex++;
    posStart += step / tokensPerChar;
  }

  return spans;
}

// ── 標題前綴提取 ──
interface TitleRecord {
  level: number;     // 1=#, 2=##, 3=###
  title: string;     // "3.1 架構"
  tokenPos: number;  // 出現位置的 token 估算值
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

/** 根據 token 位置和標題列表，生成該位置的標題前綴 */
function getTitlePrefix(tokenPos: number, titles: TitleRecord[]): string {
  // 找距離當前位置最近且 tokenPos <= 當前位置的標題鏈
  const active: TitleRecord[] = [];
  for (const t of titles) {
    if (t.tokenPos > tokenPos) break;
    // 同層級覆蓋
    while (active.length > 0 && active[active.length - 1].level >= t.level) {
      active.pop();
    }
    active.push(t);
  }

  if (active.length === 0) return "";
  return active.map((t) => t.title).join(" > ");
}

// ── 主函數 ──
export function chunkText(
  text: string,
  source: string,
  chunkSize = 512,
  overlap = 128,
): Chunk[] {
  // 預提取標題（只需掃描一次全文）
  const titles = extractTitles(text);
  const hasTitles = titles.length > 0;

  // 滑動窗口切分
  const spans = slidingWindowChars(text, chunkSize, overlap);
  const result: Chunk[] = [];

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    let chunkTextContent = span.text.trim();
    if (!chunkTextContent) continue;

    // 加上標題前綴（如果有標題的話）
    if (hasTitles) {
      // 用該 span 的起始 token 位置計算前綴
      const startTokenPos = Math.round(estimateTokens(text.slice(0, span.start)));
      const prefix = getTitlePrefix(startTokenPos, titles);
      if (prefix) {
        chunkTextContent = `【${prefix}】${chunkTextContent}`;
      }
    }

    result.push({
      id: `${source}_${i}`,
      text: chunkTextContent,
      source,
      index: i,
    });
  }

  return result;
}