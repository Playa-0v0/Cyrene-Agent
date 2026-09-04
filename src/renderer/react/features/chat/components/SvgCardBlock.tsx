/**
 * SvgCardBlock —— 模型手写 SVG 学习卡片的渲染（```svg 围栏分支）。
 *
 * 与 MermaidBlock 同构的四层保护：长度熔断（阈值放宽到 3 倍，手写标签更冗长）
 * → 剥字体外呼 → DOMPurify 消毒 → 非 <svg> 根内容兜底降级。
 * 手写 SVG 不经过渲染引擎，熔断防的是超大 DOM 注入而不是同步渲染耗时。
 */

import { useMemo } from "react";
import { useTranslation } from "../../../i18n";
import { isOverHandwrittenSvgLimit, sanitizeSvg, stripFontImports } from "./svg-sanitize";

type SvgCardResult =
  | { kind: "svg"; svg: string }
  | { kind: "fuse" }
  | { kind: "error" };

/** 消毒管线；超限、无 svg 根或内容被清空都返回降级标记 */
export function renderSvgCardSafe(code: string): SvgCardResult {
  if (isOverHandwrittenSvgLimit(code)) return { kind: "fuse" };
  const svg = sanitizeSvg(stripFontImports(code.trim()));
  if (!svg || !svg.includes("<svg")) return { kind: "error" };
  return { kind: "svg", svg };
}

export function SvgCardBlock({ code, streaming }: { code: string; streaming?: boolean }) {
  const { t } = useTranslation();
  // 流式期间内容在变，显示占位；流结束后一次性消毒注入
  const result = useMemo(() => (streaming ? null : renderSvgCardSafe(code)), [code, streaming]);

  if (streaming || result === null) {
    return <div className="cy-svg-card cy-svg-card--pending">{t("messageList.svgCardPending")}</div>;
  }

  if (result.kind === "svg") {
    return (
      <div
        className="cy-svg-card"
        // 内容已经过 stripFontImports + DOMPurify 消毒
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
    );
  }

  return (
    <div className="cy-svg-card cy-svg-card--fallback">
      <div className="cy-svg-card__hint">{t("messageList.svgCardFallback")}</div>
      <pre className="cy-svg-card__source">{code}</pre>
    </div>
  );
}
