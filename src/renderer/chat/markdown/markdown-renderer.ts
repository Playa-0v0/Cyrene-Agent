/**
 * 终态 Markdown 渲染总入口。
 *
 * 数据流：
 *   raw markdown
 *   -> markdown-it 解析（html:false, linkify, breaks:false）
 *   -> KaTeX 插件处理公式（行内 $...$ / 块级 $$...$$）
 *   -> fenced code 自定义 renderer -> Shiki codeToHtml
 *   -> DOMPurify 净化
 *   -> 返回 MarkdownRenderResult
 *
 * 降级策略：
 *   - 单个 Shiki 代码块失败：只降级该代码块，不影响整条消息
 *   - KaTeX 解析失败：显示原始 LaTeX 文本（throwOnError:false），不丢失内容
 *   - markdown-it 整体异常：返回 { mode:"text", content: raw }
 *   - DOMPurify 整体异常：返回 { mode:"text", content: raw }
 *
 * HTML 所有权：
 *   - .code-block wrapper + header 由本模块生成
 *   - Shiki 返回的 <pre class="shiki"> 放在 .code-block__code 内
 *   - fallback 代码先转义再拼入 HTML
 */

import MarkdownIt from "markdown-it";
import { katex as katexPlugin } from "@mdit/plugin-katex";
import DOMPurify from "dompurify";
import { codeToHtml } from "./code-highlighter";
import { normalizeLang, getLanguageDisplayName } from "./language-normalizer";
import type { MarkdownRenderResult } from "./types";

// ── markdown-it 实例（模块级单例） ──────────────────────────

/** 获取 markdown-it 实例（供 streaming session 使用） */
export function getMd(): MarkdownIt { return md; }

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

// KaTeX 插件：处理行内 $...$ 和块级 $$...$$ 公式
// throwOnError:false -> 无效 LaTeX 显示原始文本，不崩溃
md.use(katexPlugin, { throwOnError: false });

// ── 链接安全：自定义 link_open renderer ────────────────────

/**
 * 判断 href 是否安全。拒绝 javascript: / data: / vbscript: / file: 等危险协议。
 */
function isAllowedHref(href: string): boolean {
  if (!href) return true; // 空链接（如锚点）允许
  const lower = href.trim().toLowerCase();
  // 允许 http/https/mailto/tel/相对路径/#anchor
  if (/^(https?:|mailto:|tel:|\/|#|\.|\?)/i.test(href)) return true;
  // 显式拒绝危险协议
  if (/^(javascript:|data:|vbscript:|file:)/i.test(lower)) return false;
  // 其他未知协议保守拒绝
  return false;
}

// 保存默认 link_open renderer
const defaultLinkOpenRenderer = md.renderer.rules.link_open
  || function (tokens: MarkdownIt.Token[], idx: number, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const href = token.attrGet("href") ?? "";

  if (!isAllowedHref(href)) {
    token.attrSet("href", "#");
  }

  // 外部链接（http/https）加 target + rel
  if (/^https?:\/\//i.test(href) && isAllowedHref(href)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }

  return defaultLinkOpenRenderer(tokens, idx, options, env, self);
};

// ── fenced code 自定义 renderer ──────────────────────────────

const defaultFenceRenderer = md.renderer.rules.fence
  || function (tokens: MarkdownIt.Token[], idx: number, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.fence = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const info = token.info.trim();
  const rawLang = info.split(/\s+/)[0] || "";
  const code = token.content;
  const lang = normalizeLang(rawLang);
  const displayName = getLanguageDisplayName(lang);

  // 调用 Shiki 同步高亮（未就绪/失败返回 fallback <pre class="shiki">）
  const highlightedHtml = codeToHtml(code, rawLang);

  // 生成 .code-block wrapper + header
  // Shiki 返回的 <pre class="shiki"> 放在 .code-block__code 内
  return (
    `<div class="code-block" data-language="${lang}">` +
    `<header class="code-block__header">` +
    `<span class="code-block__language">${displayName}</span>` +
    `<button type="button" class="code-block__copy" title="复制代码">复制</button>` +
    `</header>` +
    `<div class="code-block__code">${highlightedHtml}</div>` +
    `</div>`
  );
};

// ── HTML 转义工具 ──────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── 公共 API ───────────────────────────────────────────────

/**
 * 把 raw markdown 渲染为安全的 HTML。
 *
 * 返回判别联合 MarkdownRenderResult：
 * - { mode: "html", content }: 渲染成功，content 是 DOMPurify 净化后的 HTML
 * - { mode: "text", content }: 渲染失败，content 是原始 markdown，调用方走 textContent
 */
export function renderMarkdown(raw: string): MarkdownRenderResult {
  if (!raw || !raw.trim()) {
    return { mode: "html", content: "" };
  }

  let html: string;
  try {
    html = md.render(raw);
  } catch (err) {
    console.error("[markdown] markdown-it 解析失败:", err);
    return { mode: "text", content: raw };
  }

  try {
    const sanitized = DOMPurify.sanitize(html, {
      // 默认配置：禁 script/iframe/style/事件属性
      // 不自定义 ALLOWED_URI_REGEXP（按你的 #4）
    });
    return { mode: "html", content: sanitized };
  } catch (err) {
    console.error("[markdown] DOMPurify 净化失败:", err);
    return { mode: "text", content: raw };
  }
}

// 导出 escapeHtml 供其他模块使用
export { escapeHtml };
