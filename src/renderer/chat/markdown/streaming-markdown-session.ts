/**
 * 流式 Markdown 渲染会话。
 *
 * 每条正在流式生成的助手消息维护一个独立的 session。
 *
 * DOM 结构：
 * <div class="markdown-stream">
 *   <div class="markdown-stream__stable"></div>   ← committed blocks（只追加）
 *   <div class="markdown-stream__active"></div>    ← mutable tail（可替换）
 * </div>
 *
 * 流程：
 *   delta 到达 -> session.append(delta) -> scheduleRender()
 *   节流渲染 -> parse blocks -> split committed/mutable
 *   -> 新 committed block 渲染并追加到 stableRoot
 *   -> mutable tail 渲染并写入 activeRoot
 *   流结束 -> flush() -> cancel timers
 *   终态 -> render() 全量替换（由 main.ts 控制）
 */

import type MarkdownIt from "markdown-it";
import {
  parseStreamingBlocks,
  splitCommittedAndMutable,
  type StreamMarkdownBlock,
} from "./streaming-block-parser";
import { renderCommittedBlock, renderMutableTail, blockChanged } from "./streaming-block-renderer";
import {
  createStreamingRenderScheduler,
  getStreamingRenderInterval,
  type StreamingRenderScheduler,
} from "./streaming-render-scheduler";

export interface StreamingMarkdownSession {
  /** 消息 ID */
  messageId: string;
  /** 修订号（每次 append 递增，防止旧渲染写入） */
  revision: number;
  /** 原始 markdown 累积文本 */
  raw: string;
  /** 是否已销毁 */
  disposed: boolean;

  /** 追加 delta 文本 */
  append(delta: string): void;
  /** 强制 flush 最后一次渲染 */
  flush(): void;
  /** 销毁 session，取消所有 pending */
  dispose(): void;
}

/**
 * 创建流式 Markdown 渲染会话。
 *
 * @param md markdown-it 实例（已配置 KaTeX + 自定义 fence renderer）
 * @param bubble 消息气泡 DOM 元素（session 会在内部创建 stable/active root）
 * @param messageId 消息 ID
 * @param scrollContainer 滚动容器（用于滚动保护），可选
 */
export function createStreamingMarkdownSession(
  md: MarkdownIt,
  bubble: HTMLElement,
  messageId: string,
  scrollContainer?: HTMLElement,
): StreamingMarkdownSession {
  let revision = 0;
  let raw = "";
  let disposed = false;

  // 上一次解析的 committed blocks（用于 fingerprint 对比）
  let lastCommitted: StreamMarkdownBlock[] = [];
  let lastActiveHtml = "";
  let renderFailureCount = 0;
  let degraded = false;
  /** committed 部分已渲染的字符 offset（用于降级时避免重复显示） */
  let committedOffset = 0;

  // 创建 DOM 结构
  bubble.hidden = false;
  bubble.innerHTML = "";

  const streamRoot = document.createElement("div");
  streamRoot.className = "markdown-stream";

  const stableRoot = document.createElement("div");
  stableRoot.className = "markdown-stream__stable";

  const activeRoot = document.createElement("div");
  activeRoot.className = "markdown-stream__active";

  streamRoot.appendChild(stableRoot);
  streamRoot.appendChild(activeRoot);
  bubble.appendChild(streamRoot);

  // 滚动保护
  const isNearBottom = (): boolean => {
    if (!scrollContainer) return true;
    const threshold = 100;
    return scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < threshold;
  };

  const followScroll = (): void => {
    if (isNearBottom()) {
      scrollContainer!.scrollTop = scrollContainer!.scrollHeight;
    }
  };

  // 调度器
  const scheduler: StreamingRenderScheduler = createStreamingRenderScheduler({
    messageId,
    render: doRender,
    isDisposed: () => disposed,
  });

  function doRender(): void {
    if (disposed) return;

    // 降级模式：整条消息用 textContent，不做 block reconciliation
    if (degraded) {
      return; // 终态 render() 会接管
    }

    try {
      const currentRevision = revision;

      // 解析 blocks
      let blocks: StreamMarkdownBlock[];
      try {
        blocks = parseStreamingBlocks(md, raw);
      } catch (parseErr) {
        console.error("[streaming-session] parseStreamingBlocks 失败:", parseErr);
        renderFailureCount++;
        checkDegraded();
        // 降级：只更新 activeRoot（不含已 committed 的部分，避免重复）
        const activeRaw = raw.slice(committedOffset);
        activeRoot.textContent = activeRaw;
        return;
      }

      const { committed, mutable } = splitCommittedAndMutable(blocks, 2);

      // 处理新 committed blocks（只追加新增的）
      const newCommitted = committed.slice(lastCommitted.length);
      for (const block of newCommitted) {
        const html = renderCommittedBlock(md, block);
        if (html) {
          const wrapper = document.createElement("div");
          wrapper.innerHTML = html;
          while (wrapper.firstChild) {
            stableRoot.appendChild(wrapper.firstChild);
          }
        }
        committedOffset = block.endOffset;
      }
      lastCommitted = committed;

      // 渲染 mutable tail
      const activeHtml = renderMutableTail(md, mutable);
      if (activeHtml !== lastActiveHtml) {
        activeRoot.innerHTML = activeHtml;
        lastActiveHtml = activeHtml;
      }

      // 成功渲染，重置失败计数
      renderFailureCount = 0;

      followScroll();
    } catch (err) {
      console.error("[streaming-session] doRender 失败:", err);
      renderFailureCount++;
      checkDegraded();

      // 降级：只更新 activeRoot（不含已 committed 的部分，避免重复）
      try {
        const activeRaw = raw.slice(committedOffset);
        activeRoot.textContent = activeRaw;
      } catch {
        // 最后兜底
      }
    }
  }

  /** 检查是否需要进入降级模式（连续 3 次失败） */
  function checkDegraded(): void {
    if (renderFailureCount >= 3 && !degraded) {
      degraded = true;
      console.warn("[streaming-session] 连续渲染失败 3 次，进入降级模式");
      // 清空 stableRoot，用完整 raw 作为 textContent
      stableRoot.innerHTML = "";
      activeRoot.textContent = raw;
      committedOffset = 0;
    }
  }

  return {
    messageId,
    get revision() { return revision; },
    get raw() { return raw; },
    get disposed() { return disposed; },

    append(delta: string): void {
      if (disposed) return;
      raw += delta;
      revision++;
      scheduler.schedule();
    },

    flush(): void {
      if (disposed) return;
      scheduler.flush();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      scheduler.cancel();
    },
  };
}

export { getStreamingRenderInterval };
