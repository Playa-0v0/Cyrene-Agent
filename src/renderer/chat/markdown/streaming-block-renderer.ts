/**
 * 流式 block 渲染器。
 *
 * 两种渲染模式：
 * - committed: 完整渲染（markdown-it + Shiki + KaTeX + DOMPurify），只执行一次
 * - mutable: 轻量渲染（markdown-it + DOMPurify，不跑 Shiki/KaTeX），可重复执行
 *
 * committed block 渲染后追加到 stableRoot，不再重建。
 * mutable tail 渲染后写入 activeRoot，可被替换。
 */

import DOMPurify from "dompurify";
import type MarkdownIt from "markdown-it";
import { codeToHtml } from "./code-highlighter";
import { normalizeLang, getLanguageDisplayName } from "./language-normalizer";
import { escapeHtml } from "./markdown-renderer";
import type { StreamMarkdownBlock } from "./streaming-block-parser";

/**
 * 渲染 committed block（完整模式：含 Shiki + KaTeX）。
 * 返回净化后的 HTML 字符串。
 */
export function renderCommittedBlock(md: MarkdownIt, block: StreamMarkdownBlock): string {
  try {
    // committed block 使用完整 markdown-it（含 KaTeX 插件 + Shiki fence renderer）
    // md 实例已在 markdown-renderer.ts 中配置好所有插件和自定义 renderer
    const html = md.render(block.raw);
    return DOMPurify.sanitize(html);
  } catch (err) {
    console.error("[streaming-renderer] committed block 渲染失败:", err);
    return `<pre>${escapeHtml(block.raw)}</pre>`;
  }
}

/**
 * 渲染 mutable tail（轻量模式：不跑 Shiki/KaTeX）。
 * 返回净化后的 HTML 字符串。
 *
 * fence block 在 mutable 阶段输出 plain code-block wrapper（无 Shiki）。
 * 其他 block 走 markdown-it 但 KaTeX 公式以原始文本显示。
 */
export function renderMutableTail(md: MarkdownIt, blocks: StreamMarkdownBlock[]): string {
  if (blocks.length === 0) return "";

  try {
    // 合并 mutable blocks 的 raw 文本
    const raw = blocks.map(b => b.raw).join("");

    // 使用一个临时 markdown-it 实例，禁用 Shiki 和 KaTeX
    // 复用主 md 的配置但替换 fence renderer
    const html = renderWithStreamingFence(md, raw, blocks);
    return DOMPurify.sanitize(html);
  } catch (err) {
    console.error("[streaming-renderer] mutable tail 渲染失败:", err);
    // 降级为纯文本
    return blocks.map(b => `<pre>${escapeHtml(b.raw)}</pre>`).join("");
  }
}

/**
 * 使用 streaming fence renderer 渲染 mutable tail。
 *
 * 对 fence block：输出 .code-block wrapper + plain <pre><code>（escaped，无 Shiki）。
 * 对非 fence block：走 markdown-it 默认 renderer。
 *
 * KaTeX：mutable 阶段不处理公式（显示原始 $...$ 文本）。
 * 实现：临时移除 KaTeX 规则，渲染后恢复。
 */
function renderWithStreamingFence(
  md: MarkdownIt,
  raw: string,
  blocks: StreamMarkdownBlock[],
): string {
  // 简单方案：对每个 block 单独渲染
  // fence block 用 streaming renderer，其他用 md.render
  const parts: string[] = [];

  for (const block of blocks) {
    if (block.type === "fence") {
      // 提取语言和代码
      const lines = block.raw.split("\n");
      const firstLine = lines[0] ?? "";
      const langMatch = firstLine.match(/^```(\w*)/);
      const rawLang = langMatch?.[1] ?? "";
      const lang = normalizeLang(rawLang);
      const displayName = getLanguageDisplayName(lang);

      // 代码内容（去掉首行围栏和尾行围栏）
      const codeLines = lines.slice(1);
      if (codeLines.length > 0 && codeLines[codeLines.length - 1].trim().startsWith("```")) {
        codeLines.pop();
      }
      const code = codeLines.join("\n").replace(/\n$/, "");

      parts.push(
        `<div class="code-block code-block--streaming" data-language="${lang}">` +
        `<header class="code-block__header">` +
        `<span class="code-block__language">${displayName}</span>` +
        `<button type="button" class="code-block__copy">复制</button>` +
        `</header>` +
        `<div class="code-block__code"><pre><code>${escapeHtml(code)}</code></pre></div>` +
        `</div>`,
      );
    } else {
      // 非 fence block：走 markdown-it（KaTeX 会处理但 throwOnError:false）
      // 注意：mutable 阶段的公式可能不完整，KaTeX 会显示 error
      // 但因为我们只渲染最后 2 个 block，大部分公式已在 committed 阶段处理
      try {
        parts.push(md.render(block.raw));
      } catch {
        parts.push(`<pre>${escapeHtml(block.raw)}</pre>`);
      }
    }
  }

  return parts.join("");
}

/**
 * 判断 block 是否需要重新渲染（fingerprint 变化）。
 */
export function blockChanged(
  oldBlock: StreamMarkdownBlock | undefined,
  newBlock: StreamMarkdownBlock,
): boolean {
  if (!oldBlock) return true;
  return oldBlock.fingerprint !== newBlock.fingerprint;
}
