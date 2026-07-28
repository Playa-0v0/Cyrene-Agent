/**
 * Shiki 代码高亮单例。
 *
 * 生命周期：
 * - `initHighlighter()` 在聊天模块初始化时异步执行一次，返回 Promise。
 * - `codeToHtml(code, rawLang)` 是同步调用：如果 highlighter 已就绪则调 `highlighter.codeToHtml()`，
 *   否则返回 fallback HTML（安全纯文本 `<pre><code>`）。
 * - 禁止在同步路径中 await 或 loadLanguage。
 * - 预加载 15 个语言白名单，未知语言降级为 text。
 *
 * 主题策略（Phase 1 简洁版）：
 * - 根据 `document.documentElement.dataset.uiTheme` 选择 `github-dark` / `github-light`
 * - 主题切换后由 chat render() 全量重建，Phase 1 不做双主题 CSS variables
 */

import { createHighlighter, type Highlighter } from "shiki";

import { normalizeLang } from "./language-normalizer";

/** 预加载语言白名单 */
const PRELOADED_LANGS = [
  "javascript",
  "typescript",
  "python",
  "java",
  "c",
  "cpp",
  "csharp",
  "powershell",
  "bash",
  "batch",
  "json",
  "html",
  "css",
  "sql",
] as const;

/** 预加载主题 */
const PRELOADED_THEMES = ["github-dark", "github-light"] as const;

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighter: Highlighter | null = null;

/**
 * 异步初始化 Shiki highlighter 单例。
 * 在聊天模块加载时调用一次（不 await），初始化完成后 `highlighter` 变量被填充。
 */
export function initHighlighter(): Promise<Highlighter> {
  if (highlighterPromise) return highlighterPromise;

  highlighterPromise = createHighlighter({
    themes: [...PRELOADED_THEMES],
    langs: [...PRELOADED_LANGS],
  });

  highlighterPromise
    .then((h) => {
      highlighter = h;
    })
    .catch((err) => {
      console.error("[Shiki] 初始化失败:", err);
      highlighterPromise = null; // 允许重试
    });

  return highlighterPromise;
}

/** Shiki 是否已就绪（同步检查） */
export function isHighlighterReady(): boolean {
  return highlighter !== null;
}

/**
 * 根据当前 UI 主题获取 Shiki 主题名。
 */
function getCurrentThemeName(): string {
  const uiTheme = document.documentElement.dataset.uiTheme;
  return uiTheme === "pearl-white" ? "github-light" : "github-dark";
}

/**
 * 同步高亮代码。如果 Shiki 未就绪或高亮失败，返回安全的 fallback HTML。
 *
 * 返回的是 `<pre class="shiki"><code>...</code></pre>` 形式的 HTML（已含内联 style）。
 * 调用方（markdown-renderer）负责把它包进 `.code-block` wrapper + header。
 */
export function codeToHtml(code: string, rawLang: string | undefined): string {
  if (!highlighter) {
    return fallbackCodeHtml(code);
  }

  try {
    const lang = normalizeLang(rawLang);
    const theme = getCurrentThemeName();
    return highlighter.codeToHtml(code, { lang, theme });
  } catch (err) {
    console.warn("[Shiki] codeToHtml 失败，降级为纯文本:", err);
    return fallbackCodeHtml(code);
  }
}

/**
 * 生成安全的 fallback 代码 HTML。
 * 先转义 code 内容，再放入 `<pre><code>`，不直接拼 raw。
 */
function fallbackCodeHtml(code: string): string {
  const escaped = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<pre class="shiki"><code>${escaped}</code></pre>`;
}
