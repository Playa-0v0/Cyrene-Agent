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
  breaks: true,   // 单换行 \n → <br>，保留 LLM 输出的换行意图
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

// ── 块级数学公式自定义 renderer ────────────────────────────
// 默认 KaTeX 输出 <div class="katex-display">...</div>
// 包裹成 <div class="math-block"><div class="math-block__scroll">...</div></div>
// 外层负责 margin 和自然高度，内层只负责横向滚动
// 避免 overflow-x:auto + overflow-y:visible 冲突导致的纵向裁切

const defaultMathBlockRenderer = md.renderer.rules.math_block
  || function (tokens: MarkdownIt.Token[], idx: number, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.math_block = function (tokens, idx, options, env, self) {
  const innerHtml = defaultMathBlockRenderer(tokens, idx, options, env, self);
  return (
    `<div class="math-block">` +
    `<div class="math-block__scroll">${innerHtml}</div>` +
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

// ── 渲染常量 ──────────────────────────────────────────────

/** markdown-it 正常解析的字符上限（超过则降级为纯文本） */
const MARKDOWN_PARSE_LIMIT = 40_000;
/** 消息总字符上限（超过则截断） */
const MESSAGE_CHAR_LIMIT = 140_000;
/** 渲染版本号（Shiki/KaTeX/renderer 规则变更时递增，使旧缓存失效） */
const RENDER_VERSION = 1;
/** LRU 缓存容量 */
const CACHE_LIMIT = 200;

// ── DOMPurify 白名单 ─────────────────────────────────────
// Shiki 生成：span, pre, code, style(内联 class)
// KaTeX 生成：span, math, semantics, mi, mo, mn, mrow 等
// 自定义：div(.code-block), button(复制), details/summary(折叠)

const ALLOWED_TAGS = [
  // 基础 Markdown
  "p", "br", "hr", "strong", "em", "del", "s", "code", "pre",
  "blockquote", "a", "img",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td",
  // 代码块自定义
  "div", "span", "button", "details", "summary",
  // KaTeX（math 标签由 KaTeX 输出）
  "math", "semantics", "mrow", "mi", "mo", "mn", "msup", "msub",
  "mfrac", "msqrt", "mroot", "mstyle", "merror", "mpadded",
  "mphantom", "mfenced", "menclose", "mspace", "munder", "mover",
  "munderover", "mmultiscripts", "mtable", "mtr", "mtd", "mlabeledtr",
  "maction", "annotation", "annotation-xml",
];

const ALLOWED_ATTRS = [
  // 通用
  "class", "id", "title", "aria-label", "aria-hidden", "role",
  // 链接
  "href", "target", "rel",
  // 图片
  "src", "alt", "width", "height",
  // 代码块
  "data-code", "data-lang",
  // Shiki
  "data-theme",
  // KaTeX
  "data-mathml", "data-annotation",
  // 表格
  "colspan", "rowspan", "align",
  // 折叠
  "open",
  // 复制按钮
  "type",
  // KaTeX/Shiki 内联样式（通过 uponSanitizeAttribute hook 限制只在可信区域内生效）
  "style",
  // KaTeX MathML
  "xmlns", "encoding",
];

// ── DOMPurify Hook：只允许可信渲染器区域内的 style ────────
// KaTeX 用 style 定位分子/分母/积分上下限，Shiki 用 style 着色
// 模型原始输出不允许携带 style
const TRUSTED_STYLE_ROOTS = ".katex, .katex-display, .shiki, .code-block";

if (typeof DOMPurify.addHook === "function") {
  DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName !== "style") return;
    const el = _node as Element;
    // 只允许可信渲染器生成区域内的内联 style
    if (typeof el.closest === "function" && el.closest(TRUSTED_STYLE_ROOTS)) {
      return; // 保留
    }
    data.keepAttr = false; // 删除
  });
}

// ── LRU 缓存 ─────────────────────────────────────────────

const htmlCache = new Map<string, MarkdownRenderResult>();

function cacheGet(key: string): MarkdownRenderResult | undefined {
  const val = htmlCache.get(key);
  if (val) {
    // 移到最新（LRU）
    htmlCache.delete(key);
    htmlCache.set(key, val);
  }
  return val;
}

function cacheSet(key: string, val: MarkdownRenderResult): void {
  if (htmlCache.size >= CACHE_LIMIT) {
    // 删除最旧的
    const oldest = htmlCache.keys().next().value;
    if (oldest !== undefined) htmlCache.delete(oldest);
  }
  htmlCache.set(key, val);
}

// ── 纯文本降级 ────────────────────────────────────────────

function renderEscapedPlainText(raw: string): MarkdownRenderResult {
  const escaped = escapeHtml(raw).replace(/\n/g, "<br>");
  return { mode: "html", content: `<p>${escaped}</p>` };
}

// ── 主渲染函数 ────────────────────────────────────────────

/**
 * 把 raw markdown 渲染为安全的 HTML。
 *
 * 管线：长度保护 → markdown-it → DOMPurify → 协议校验 → 缓存
 *
 * 返回判别联合 MarkdownRenderResult：
 * - { mode: "html", content }: 渲染成功，content 是 DOMPurify 净化后的 HTML
 * - { mode: "text", content }: 渲染失败，content 是原始 markdown，调用方走 textContent
 */
export function renderMarkdown(raw: string): MarkdownRenderResult {
  if (!raw || !raw.trim()) {
    return { mode: "html", content: "" };
  }

  // ── 长度保护 ──
  const text = raw.length > MESSAGE_CHAR_LIMIT
    ? raw.slice(0, MESSAGE_CHAR_LIMIT) + "\n\n[消息过长，已截断]"
    : raw;

  // 超长文本降级：不跑 markdown-it，直接转义
  if (text.length > MARKDOWN_PARSE_LIMIT) {
    return renderEscapedPlainText(text);
  }

  // ── 缓存查找 ──
  // 简单 hash（避免 crypto 依赖）
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  const cacheKey = `${RENDER_VERSION}:${hash}:${text.length}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // ── markdown-it 渲染 ──
  let html: string;
  try {
    html = md.render(text);
  } catch (err) {
    console.warn("[markdown] markdown-it 解析失败，降级纯文本:", err);
    return renderEscapedPlainText(text);
  }

  // ── DOMPurify 清洗 ──
  let sanitized: string;
  try {
    sanitized = DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR: ALLOWED_ATTRS,
      // 不允许任何 HTML 实体中的 script/iframe/style
      // 协议白名单：只允许 http/https/mailto/tel/相对路径
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    });
  } catch (err) {
    console.warn("[markdown] DOMPurify 净化失败，降级纯文本:", err);
    return renderEscapedPlainText(text);
  }

  const result: MarkdownRenderResult = { mode: "html", content: sanitized };
  cacheSet(cacheKey, result);
  return result;
}

// ── 导出 ──────────────────────────────────────────────────
export { escapeHtml };
export { MARKDOWN_PARSE_LIMIT, MESSAGE_CHAR_LIMIT, RENDER_VERSION };
