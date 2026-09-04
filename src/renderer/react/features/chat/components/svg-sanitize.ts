/**
 * SVG 消毒与熔断 —— 模型输出的 SVG（Mermaid 引擎产物 / 手写 svg 围栏）注入前的统一安全层。
 *
 * 四层防护：
 * 1. 长度熔断：源码超过上限直接降级，不进同步渲染（防 UI 线程卡死）
 * 2. 字体外呼剥离：删掉引擎硬编码注入的 Google Fonts @import（隐私 + 离线可用）
 * 3. DOMPurify 消毒：剥 script / 事件属性 / javascript: 协议 / foreignObject 逃逸
 * 4. 调用方兜底：消毒后仍为空则按渲染失败降级
 */

import DOMPurify from "dompurify";

/** 源码长度熔断阈值（字符数）：千节点级流程图源码约 23KB / 渲染 265ms，再大就该降级 */
export const SVG_SOURCE_LIMIT = 20000;

/** 判断源码是否超过熔断阈值 */
export function isOverSourceLimit(source: string): boolean {
  return source.length > SVG_SOURCE_LIMIT;
}

/**
 * 剥离 <style> 块里的外部字体 @import。
 * beautiful-mermaid 会无条件注入 Google Fonts 导入，渲染端不该为一张图外呼网络。
 */
export function stripFontImports(svg: string): string {
  return svg.replace(/@import\s+url\([^)]*fonts\.googleapis\.com[^)]*\);?/g, "");
}

/**
 * DOMPurify 消毒 SVG 字符串。
 * 返回空字符串说明内容被清空，调用方按渲染失败处理。
 */
export function sanitizeSvg(svg: string): string {
  const cleaned = DOMPurify.sanitize(svg, {
    // 模型产出的图可能用到 foreignObject 内容，但那正是逃逸向量，直接整体禁掉
    FORBID_TAGS: ["script", "foreignObject", "iframe", "embed", "object", "link"],
    FORBID_ATTR: ["src", "href", "xlink:href"],
  });
  return typeof cleaned === "string" ? cleaned : "";
}
