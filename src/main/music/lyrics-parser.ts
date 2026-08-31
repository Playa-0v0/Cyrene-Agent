// LRC lyric parser: pure functions, no IO.
// UI contract: `{ timeMs, text }[]` ascending by timeMs（MUSIC_GET_LYRICS 的返回形状）。

export interface LyricLine {
  timeMs: number;
  text: string;
  /** 译文（transLyric，网易云返回的翻译 LRC 按时间戳对齐合并而来）。 */
  translation?: string;
}

const TAG_RE = /^\[([^\]]*)\]/;
const TIME_TAG_RE = /^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/;
const OFFSET_TAG_RE = /^offset\s*:\s*([+-]?\d+)$/i;

/**
 * Parse an LRC document into a time-sorted timeline.
 *
 * - Supports multiple timestamps per line (`[00:12.00][00:45.10]chorus`).
 * - Supports `mm:ss` / `mm:ss.cs` (2-digit centiseconds) / `mm:ss.mmm`.
 * - Applies the `[offset:±ms]` tag (positive = lyrics appear earlier).
 * - Skips metadata tags (ti/ar/al/by...) and lines with no timestamp.
 * - Returns [] when nothing timestamped is found (caller falls back to txtLyric).
 */
export function parseLrc(lrc: string): LyricLine[] {
  if (!lrc) return [];
  let offsetMs = 0;
  const out: LyricLine[] = [];

  for (const rawLine of lrc.split(/\r?\n/)) {
    let line = rawLine.trim();
    const times: number[] = [];

    // Consume all leading [..] tags.
    for (;;) {
      const m = TAG_RE.exec(line);
      if (!m) break;
      const tag = m[1];
      const timeTag = TIME_TAG_RE.exec(tag);
      if (timeTag) {
        const min = Number(timeTag[1]);
        const sec = Number(timeTag[2]);
        let ms = 0;
        if (timeTag[3]) {
          // ".5"=500ms, ".50"=500ms, ".500"=500ms — pad right to 3 digits.
          ms = Number(timeTag[3].padEnd(3, "0"));
        }
        times.push(min * 60_000 + sec * 1_000 + ms);
      } else {
        const offsetTag = OFFSET_TAG_RE.exec(tag);
        if (offsetTag) offsetMs = Number(offsetTag[1]);
      }
      line = line.slice(m[0].length).trim();
    }

    const text = line;
    if (!text) continue;
    for (const t of times) {
      out.push({ timeMs: Math.max(0, t - offsetMs), text });
    }
  }

  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

/**
 * 把翻译 LRC（transLyric，同样带时间戳）合并进已解析的原文行。
 *
 * 对齐策略：翻译与原文的时间戳通常逐行一致；先精确匹配 timeMs，
 * 精确不中再在 ±800ms 容差内找最近的一行。找不到的原文行保持无翻译。
 * 返回新数组（不修改入参）。
 */
export function mergeTranslation(lines: LyricLine[], transLrc: string): LyricLine[] {
  const trans = parseLrc(transLrc);
  if (lines.length === 0 || trans.length === 0) return lines;

  // 按 timeMs 建索引（翻译一行只服务一个时间点）
  const exact = new Map<number, string>();
  for (const t of trans) {
    if (!exact.has(t.timeMs)) exact.set(t.timeMs, t.text);
  }

  const TOLERANCE_MS = 800;
  return lines.map((line) => {
    let text = exact.get(line.timeMs);
    if (text === undefined) {
      // 容差就近匹配（翻译时间戳与原文有零点几秒漂移的常见情况）
      let best: { dt: number; text: string } | null = null;
      for (const t of trans) {
        const dt = Math.abs(t.timeMs - line.timeMs);
        if (dt <= TOLERANCE_MS && (best === null || dt < best.dt)) {
          best = { dt, text: t.text };
        }
      }
      text = best?.text;
    }
    return text ? { ...line, translation: text } : line;
  });
}
