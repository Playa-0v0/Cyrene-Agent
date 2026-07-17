/**
 * Markdown → HTML 渲染工具
 * 用于聊天消息的富文本显示，基于 marked 库。
 *
 * 安全策略：
 * - 输入直接交给 marked 解析（markdown 语法如 >、* 等原样保留）
 * - 输出再做 XSS 清洗：移除危险标签和属性
 */

import { marked } from "marked";

// 配置 marked：GFM模式
// 注意：不开启 breaks，避免聊天消息中单换行变成 <br> 导致过多空白
marked.setOptions({
  gfm: true,
});

// 危险标签（即使 marked 直通过来的也要移除）
const DANGEROUS_TAG_RE = /<\s*\/?\s*(script|iframe|object|embed|form|input|button|link|meta|style)\b[^>]*>/gi;

// 危险属性：on* 事件、javascript: URL
const DANGEROUS_ATTR_ON_RE = /\s+on\w+\s*=\s*["'][^"']*["']/gi;
const DANGEROUS_ATTR_JS_RE = /\s+href\s*=\s*["']\s*javascript:[^"']*["']/gi;

/**
 * 将 markdown 文本转为安全的 HTML。
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";

  // Step 1: marked 解析（输入原样保留，让 marked 处理 markdown 语法）
  let html: string;
  try {
    html = marked.parse(text, { async: false }) as string;
  } catch {
    // 解析失败时回退到纯文本
    html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  }

  // Step 2: 输出清洗 — 移除 dangerous tags
  html = html.replace(DANGEROUS_TAG_RE, "");

  // Step 3: 移除危险属性（onerror/onload/etc 和 javascript: href）
  html = html.replace(DANGEROUS_ATTR_ON_RE, "");
  html = html.replace(DANGEROUS_ATTR_JS_RE, "");

  return html;
}
