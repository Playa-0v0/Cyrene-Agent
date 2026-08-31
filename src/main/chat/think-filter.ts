/**
 * <think> 标签流式过滤器。
 *
 * 用于 AG-UI 事件桥层，防止模型的思维链标签泄漏到用户可见文本。
 *
 * 两种模式：
 * - "strict": 过滤全文所有 <think>...</think> 块（用于已知会混入 think 的模型）
 * - "leading-only": 只在消息开头（跳过空白后）以 <think> 开头时才进入过滤模式；
 *   否则原样透传。避免正文讨论 <think> 标签或代码块中的 <think> 被误删。
 *
 * 生命周期：按单条 assistant message（TEXT_MESSAGE_START ~ TEXT_MESSAGE_END）隔离，
 * 不贯穿整个 run。多轮 FC 循环中每次 LLM 调用都有独立的消息边界。
 */

export type ThinkFilterMode = "strict" | "leading-only" | "disabled";

export interface ThinkStreamFilter {
  /** 推入一个 chunk，返回过滤后的可见文本（可能为空字符串）。 */
  push(chunk: string): string;
  /** 消息结束时 flush 残留的可见文本（可能为空字符串）。 */
  flush(): string;
  /** 取出自上次读取后捕获到的公开 <think> 文本。 */
  takeThinking(): string;
}

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * 创建一个全量 <think> 过滤器（strict 模式内部使用）。
 * 跨 chunk 保持状态，处理标签被拆分的情况。
 */
function createStrictFilter(): ThinkStreamFilter {
  let pending = "";
  let insideThink = false;
  let thinking = "";

  return {
    push(chunk: string): string {
      pending += chunk;
      let visible = "";

      while (pending) {
        const lower = pending.toLowerCase();

        if (insideThink) {
          const closeIndex = lower.indexOf(CLOSE_TAG);
          if (closeIndex < 0) {
            // 保留末尾可能跨 chunk 的部分
            const safeLength = Math.max(0, pending.length - (CLOSE_TAG.length - 1));
            thinking += pending.slice(0, safeLength);
            pending = pending.slice(safeLength);
            break;
          }
          thinking += pending.slice(0, closeIndex);
          pending = pending.slice(closeIndex + CLOSE_TAG.length);
          insideThink = false;
          continue;
        }

        const openIndex = lower.indexOf(OPEN_TAG);
        if (openIndex < 0) {
          // 没找到 <think>，输出大部分但保留末尾可能跨 chunk 的部分
          const safeLength = Math.max(0, pending.length - (OPEN_TAG.length - 1));
          visible += pending.slice(0, safeLength);
          pending = pending.slice(safeLength);
          break;
        }

        // 找到 <think>，输出它之前的内容
        visible += pending.slice(0, openIndex);
        pending = pending.slice(openIndex + OPEN_TAG.length);
        insideThink = true;
      }

      return visible;
    },

    flush(): string {
      if (insideThink) {
        // 未闭合的 <think> 不进入正文，但仍可作为已公开的思考过程展示。
        thinking += pending;
        pending = "";
        return "";
      }
      const rest = pending;
      pending = "";
      return rest;
    },

    takeThinking(): string {
      const value = thinking;
      thinking = "";
      return value;
    },
  };
}

/**
 * 创建一个 leading-only 过滤器。
 *
 * 行为：
 * 1. 初始为 "buffering" 态，累积字符直到能判断消息是否以 <think> 开头
 * 2. 如果开头（跳过空白）是 <think> -> 进入 "filtering" 态，后续全部走 strict 过滤
 * 3. 如果开头不是 <think> -> 进入 "passthrough" 态，后续原样透传
 */
function createLeadingOnlyFilter(): ThinkStreamFilter {
  type State = "buffering" | "filtering" | "passthrough";
  let state: State = "buffering";
  let buffer = "";
  let inner: ThinkStreamFilter = createStrictFilter();

  return {
    push(chunk: string): string {
      if (state === "passthrough") return chunk;

      if (state === "filtering") return inner.push(chunk);

      // state === "buffering"
      buffer += chunk;
      const trimmed = buffer.trimStart();

      // 已确定以 <think> 开头
      if (trimmed.toLowerCase().startsWith(OPEN_TAG)) {
        state = "filtering";
        const result = inner.push(buffer);
        buffer = "";
        return result;
      }

      // 第一个非空白字符不是 '<'，确定不是 <think>
      if (trimmed.length > 0 && !trimmed.startsWith("<")) {
        state = "passthrough";
        const result = buffer;
        buffer = "";
        return result;
      }

      // 以 '<' 开头但还不够 7 个字符判断
      if (trimmed.length >= OPEN_TAG.length && !trimmed.toLowerCase().startsWith(OPEN_TAG)) {
        state = "passthrough";
        const result = buffer;
        buffer = "";
        return result;
      }

      // 字符不够，继续缓冲
      return "";
    },

    flush(): string {
      if (state === "passthrough") return "";
      if (state === "buffering") {
        // 消息结束仍未遇到 <think>，输出全部缓冲
        state = "passthrough";
        const result = buffer;
        buffer = "";
        return result;
      }
      // state === "filtering"
      return inner.flush();
    },

    takeThinking(): string {
      return state === "filtering" ? inner.takeThinking() : "";
    },
  };
}

/**
 * 创建 <think> 流式过滤器。
 *
 * @param mode "strict" | "leading-only" | "disabled"
 * - "strict": 过滤全文所有 <think> 块
 * - "leading-only": 只过滤消息开头的 <think> 块（默认，最安全）
 * - "disabled": 不过滤，原样透传
 */
export function createThinkFilter(mode: ThinkFilterMode = "leading-only"): ThinkStreamFilter {
  if (mode === "disabled") {
    return { push: (s: string) => s, flush: () => "", takeThinking: () => "" };
  }
  if (mode === "strict") {
    return createStrictFilter();
  }
  return createLeadingOnlyFilter();
}

/**
 * 对完整文本一次性剥离 <think> 块（非流式场景使用）。
 * 保留未闭合 <think> 之后的内容会被丢弃。
 */
export function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}
