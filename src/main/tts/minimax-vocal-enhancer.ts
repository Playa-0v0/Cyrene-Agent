// MiniMax TTS 语音增强器
//
// Cyrene 的回复是纯文本，不会自带 MiniMax 支持的语气词标签（如 (laughs)、(breath) 等）。
// 本模块在文本送入 MiniMax 合成前，根据关键词/场景自动插入这些标签，让语音更拟人。
//
// 官方文档：仅 speech-2.8-hd / speech-2.8-turbo 支持语气词标签。

export interface MiniMaxVocalEnhanceOptions {
  /** 是否启用语音增强。默认 true。 */
  enabled: boolean;
}

interface TriggerRule {
  id: string;
  pattern: RegExp;
  tag: string;
  position: "before" | "after";
  /** 同一段文本内该规则最多应用几次 */
  maxPerText: number;
  /** 是否只在文本末尾匹配（用于场景触发，如“请看下面的代码块”） */
  tailOnly?: boolean;
}

/** 单段文本最多插入的标签总数，防止堆砌。 */
const MAX_TAGS_PER_TEXT = 2;

/** 已支持的 MiniMax 语气词标签集合，用于去重判断。 */
const KNOWN_VOCAL_TAGS = new Set([
  "(laughs)",
  "(chuckle)",
  "(coughs)",
  "(clear-throat)",
  "(groans)",
  "(breath)",
  "(pant)",
  "(inhale)",
  "(exhale)",
  "(gasps)",
  "(sniffs)",
  "(sighs)",
  "(snorts)",
  "(burps)",
  "(lip-smacking)",
  "(humming)",
  "(hissing)",
  "(emm)",
  "(sneezes)",
]);

const DEFAULT_RULES: TriggerRule[] = [
  // ── 笑声类：词后插入 ──
  { id: "haha", pattern: /(?<![（(])哈{2,}(?![）)])/g, tag: "(laughs)", position: "after", maxPerText: 1 },
  { id: "heihei", pattern: /(?<![（(])嘿{2,}(?![）)])/g, tag: "(chuckle)", position: "after", maxPerText: 1 },

  // ── 迟疑类：词前插入 ──
  // 嗯、嗯~、嗯…、嗯...
  { id: "en", pattern: /(?<![（(])嗯[~…\.]{0,3}(?![）)])/g, tag: "(emm)", position: "before", maxPerText: 1 },
  // emm、emmm、emm...、emmm……（避免匹配到已有标签内部）
  { id: "emm", pattern: /(?<![a-zA-Z（(])emm+m*[\.…]*/gi, tag: "(emm)", position: "before", maxPerText: 1 },

  // ── 惊讶类：词前插入 ──
  { id: "a", pattern: /(?<![（(])啊(?![）)])/g, tag: "(gasps)", position: "before", maxPerText: 1 },

  // ── 叹息类：词前插入 ──
  { id: "ai", pattern: /(?<![（(])唉(?![）)])/g, tag: "(sighs)", position: "before", maxPerText: 1 },
  { id: "ai2", pattern: /(?<![（(])哎(?![）)])/g, tag: "(sighs)", position: "before", maxPerText: 1 },

  // ── 场景类：只在文本末尾触发，词后插入 ──
  // 引导看代码块/表格后换气，模拟“请看这里，我要停顿一下”
  {
    id: "code-block-tail",
    pattern: /(?:请看下面的代码块|代码如下|见下表|如下所示|如下表所示)[:：]?\s*$/g,
    tag: "(breath)",
    position: "after",
    maxPerText: 1,
    tailOnly: true,
  },
  // 句末省略号，模拟叹息/停顿
  {
    id: "ellipsis-tail",
    pattern: /[\.…]{2,}\s*$/g,
    tag: "(sighs)",
    position: "after",
    maxPerText: 1,
    tailOnly: true,
  },
];

function hasVocalTagNearby(text: string, index: number, direction: "before" | "after"): boolean {
  const nearby = direction === "before"
    ? text.slice(Math.max(0, index - 20), index)
    : text.slice(index, index + 20);
  for (const tag of KNOWN_VOCAL_TAGS) {
    if (nearby.includes(tag)) return true;
  }
  return false;
}

function insertTag(text: string, match: RegExpExecArray, tag: string, position: "before" | "after"): string {
  if (position === "before") {
    if (hasVocalTagNearby(text, match.index, "before")) return text;
    return text.slice(0, match.index) + tag + text.slice(match.index);
  }
  // after
  const insertIndex = match.index + match[0].length;
  if (hasVocalTagNearby(text, insertIndex, "after")) return text;
  return text.slice(0, insertIndex) + tag + text.slice(insertIndex);
}

/**
 * 对即将送入 MiniMax 的文本进行语音增强。
 * 在合适位置插入 (laughs)、(breath)、(sighs) 等语气词标签。
 */
export function enhanceMiniMaxText(text: string, options?: MiniMaxVocalEnhanceOptions | null): string {
  if (!options?.enabled || !text) return text;

  let result = text;
  let totalApplied = 0;

  for (const rule of DEFAULT_RULES) {
    if (totalApplied >= MAX_TAGS_PER_TEXT) break;

    // tailOnly 规则：先快速判断当前 result 是否以该模式结尾
    if (rule.tailOnly) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(result)) continue;
    }

    let applied = 0;
    let searchIndex = 0;

    // 边匹配边插入，每次从已插入标签的后面继续搜索，避免标签被再次匹配
    while (applied < rule.maxPerText && totalApplied < MAX_TAGS_PER_TEXT) {
      rule.pattern.lastIndex = searchIndex;
      const match = rule.pattern.exec(result);
      if (!match) break;

      const insertIndex = rule.position === "before" ? match.index : match.index + match[0].length;
      if (hasVocalTagNearby(result, insertIndex, rule.position)) {
        // 附近已有标签，跳过这次匹配，从当前匹配末尾之后继续
        searchIndex = match.index + Math.max(1, match[0].length);
        continue;
      }

      result = insertTag(result, match, rule.tag, rule.position);
      applied += 1;
      totalApplied += 1;
      // 下次从当前标签之后开始搜索
      searchIndex = insertIndex + rule.tag.length;
    }

    rule.pattern.lastIndex = 0;
  }

  return result;
}
