/**
 * Markdown 渲染结果判别联合。
 *
 * - `html`: 渲染成功，`content` 是经过 DOMPurify 净化的 HTML 字符串，调用方可安全写入 innerHTML
 * - `text`: 渲染失败（markdown-it / KaTeX / DOMPurify 任一异常），`content` 是原始 Markdown 文本，
 *   调用方必须走 textContent，不得写入 innerHTML
 */
export type MarkdownRenderResult =
  | { mode: "html"; content: string }
  | { mode: "text"; content: string };
