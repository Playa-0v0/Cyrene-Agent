/**
 * Markdown 渲染模块统一入口。
 *
 * main.ts 只从 `./markdown/init` 导入，不直接依赖内部模块。
 */

export { renderMarkdown, escapeHtml, getMd } from "./markdown-renderer";
export { initCodeBlockController } from "./code-block-controller";
export { normalizeLang, getLanguageDisplayName } from "./language-normalizer";
export { createStreamingMarkdownSession } from "./streaming-markdown-session";
export type { StreamingMarkdownSession } from "./streaming-markdown-session";
export type { MarkdownRenderResult } from "./types";

import { initHighlighter, isHighlighterReady } from "./code-highlighter";
export { initHighlighter, isHighlighterReady };

import "./markdown.css";
import "katex/dist/katex.min.css";

/**
 * 初始化 Markdown 渲染系统：
 * - 异步启动 Shiki highlighter（不 await，不阻塞聊天）
 * - 代码块复制按钮事件委托需由 main.ts 单独调用 initCodeBlockController
 */
export function initMarkdownRenderer(): void {
  void initHighlighter();
}
