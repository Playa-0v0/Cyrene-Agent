// 上下文容量观看器：composer footer 右侧的环形进度控件 + 占比菜单。
//
// 数据来源：assistant 消息的 contextUsage 快照（主进程每轮 preRequest 实时推送、
// run 终态持久化，见 docs/context-usage-viewer-construction-plan.md）。
// - 无快照 → 不渲染（不占位）。
// - 占用比 = totalTokens / contextWindowTokens；SVG 弧长只吃 clamp 后的
//   visualRatio（ratio>1 时文本诚实显示如 118%，圆环 clamp 到整圈）。
// - 颜色分级：正常主题强调色；≥70% 暖色；≥90% 警示红。仅变色，无动画。
// - 菜单趣味性：按档位切换 Cyrene 小人（开心/提醒/担心）+ 一句拟人提示。
// - 小人可点击主动压缩（chats:compact）：悬停 crossfade 到压缩小人图，
//   点击把模型窗口内旧消息摘要成一条记忆，聊天窗口经 CHATS_CHANGED 重载。
import { Popover } from "antd";
import { useState } from "react";
import { t, useTranslation } from "../../../i18n";
import type { ContextUsageCategoryKey, ContextUsageSnapshot } from "../../../../../shared/context-usage";
import { resolveAsset } from "../../../../../shared/renderer-base";
import "./ContextUsageRing.css";

const RING_SIZE = 20;
const RING_STROKE = 3;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
/** 导出供单测断言弧长比例；圆环几何的唯一事实源。 */
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 主动压缩 IPC 的返回形状（preload chatStoreApi.compactConversation）。 */
interface CompactConversationResult {
  ok: boolean;
  error?: string;
  before?: number;
  after?: number;
}

interface CompactChatApi {
  compactConversation?: (sessionId: string) => Promise<CompactConversationResult>;
}

function compactApi(): CompactChatApi | undefined {
  // 主动压缩走会话存储 API（preload 的 chatStoreApi），挂在 window.chatStore；
  // window.chat 是窗口控制（minimize/close 等），之前取错对象导致点击静默无反应。
  return (window as typeof window & { chatStore?: CompactChatApi }).chatStore;
}

/** 类别展示元数据（label 为用户可见文案）。
 *  t() 不能在模块顶层常量里调用（语言切换后不更新），故改为函数、在调用时求值。 */
export function contextUsageCategoryMeta(): Record<ContextUsageCategoryKey, { label: string; color: string }> {
  return {
    systemPrompt: { label: t("contextRing.categorySystemPrompt"), color: "#8B5CF6" },
    tools: { label: t("contextRing.categoryTools"), color: "#3B82F6" },
    skills: { label: t("contextRing.categorySkills"), color: "#06B6D4" },
    runtimeAndToolLogs: { label: t("contextRing.categoryRuntimeAndToolLogs"), color: "#F59E0B" },
    conversation: { label: t("contextRing.categoryConversation"), color: "#10B981" },
    other: { label: t("contextRing.categoryOther"), color: "#9CA3AF" },
    // 旧快照兼容（拆分前"工具与 Skill"合一）；新快照不再产出此 key。
    toolDefinitions: { label: t("contextRing.categoryToolDefinitions"), color: "#3B82F6" },
  };
}

/** 三档趣味性小人：normal / warm / alert；素材走 public 目录，不进 bundle。
 *  当前为占位图，后续直接替换 public/context-usage/ 下的同名文件即可。
 *  拟人提示为用户可见文案，同上按调用时求值。 */
export function contextUsageMoodMeta(): Record<ContextUsageRingTone, { src: string; text: string }> {
  return {
    normal: { src: resolveAsset("context-usage/normal.png"), text: t("contextRing.moodNormal") },
    warm: { src: resolveAsset("context-usage/warm.png"), text: t("contextRing.moodWarm") },
    alert: { src: resolveAsset("context-usage/alert.png"), text: t("contextRing.moodAlert") },
  };
}

/** 压缩小人：悬停小人图时 crossfade 显示，点击触发主动压缩。 */
export const CONTEXT_USAGE_COMPACT_SRC = resolveAsset("context-usage/compact.png");

/** 数字格式：>=1000 显示 12.3k（>=100k 取整），否则原值。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return String(Math.round(value));
}

/** 占用比；窗口非法（<=0）时返回 NaN，由调用方决定是否展示百分比。 */
export function computeUsageRatio(totalTokens: number, contextWindowTokens: number): number {
  if (!Number.isFinite(totalTokens) || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return Number.NaN;
  }
  return totalTokens / contextWindowTokens;
}

/** 只喂给 SVG 的弧长比例：clamp 到 [0,1]，NaN/Infinity 归 0。 */
export function clampVisualRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

export type ContextUsageRingTone = "normal" | "warm" | "alert";

/** 颜色分级：≥90% 警示红；≥70% 暖色（逼近压缩阈值）；否则主题强调色。 */
export function resolveRingTone(ratio: number): ContextUsageRingTone {
  if (!Number.isFinite(ratio)) return "normal";
  if (ratio >= 0.9) return "alert";
  if (ratio >= 0.7) return "warm";
  return "normal";
}

/** 主动压缩的状态机：idle → running → done/error。 */
export type ContextCompactPhase = "idle" | "running" | "done" | "error";

interface ContextUsageRingProps {
  usage?: ContextUsageSnapshot;
  /** 当前会话 ID：提供后小人可点击触发主动压缩。 */
  sessionId?: string;
  /** 模型运行中：禁用压缩，避免与 run 的消息写回竞态。 */
  busy?: boolean;
}

export function ContextUsageRing({ usage, sessionId, busy }: ContextUsageRingProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [compactPhase, setCompactPhase] = useState<ContextCompactPhase>("idle");
  if (!usage) return null;

  const ratio = computeUsageRatio(usage.totalTokens, usage.contextWindowTokens);
  const showRatio = Number.isFinite(ratio);
  const visualRatio = clampVisualRatio(ratio);
  const tone = resolveRingTone(ratio);
  const percentText = showRatio ? `${Math.round(ratio * 100)}%` : undefined;
  const summaryText = showRatio
    ? `${formatTokenCount(usage.totalTokens)} / ${formatTokenCount(usage.contextWindowTokens)} tokens (${percentText})`
    : `${formatTokenCount(usage.totalTokens)} tokens`;
  const title = t("contextRing.title", { summary: summaryText.replace(" tokens ", " ") });

  // 主动压缩：无 sessionId（如 demo 会话）或运行中不可点。
  const canCompact = Boolean(sessionId) && !busy;
  const handleCompactClick = (): void => {
    if (!canCompact || compactPhase === "running" || !sessionId) return;
    const invoke = compactApi()?.compactConversation;
    // API 接线缺失时进入 error 态给用户反馈，避免静默无反应难排查。
    if (!invoke) {
      setCompactPhase("error");
      return;
    }
    setCompactPhase("running");
    void invoke(sessionId)
      .then((result) => setCompactPhase(result?.ok ? "done" : "error"))
      .catch(() => setCompactPhase("error"));
  };

  const compacting = compactPhase === "running";
  const moodMeta = contextUsageMoodMeta();
  const moodText = compactPhase === "running"
    ? t("contextRing.compactRunning")
    : compactPhase === "done"
      ? t("contextRing.compactDone")
      : compactPhase === "error"
        ? t("contextRing.compactError")
        : moodMeta[tone].text;

  // 明细行按 token 从大到小排队，大头一眼置顶。
  const visibleCategories = usage.categories
    .filter((category) => category.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const categoryMeta = contextUsageCategoryMeta();

  const menu = (
    <div className="cy-context-usage-menu" aria-label={t("contextRing.menuAria")}>
      <div className="cy-context-usage-menu__header">
        <strong>{t("contextRing.menuTitle")}</strong>
        <span>{summaryText}</span>
      </div>
      <div className={`cy-context-usage-menu__progress is-${tone}`} aria-hidden="true">
        <span style={{ width: `${visualRatio * 100}%` }} />
      </div>
      <div
        className={[
          "cy-context-usage-menu__mood",
          `is-${tone}`,
          canCompact ? "can-compact" : "",
          compacting ? "is-compacting" : "",
        ].filter(Boolean).join(" ")}
      >
        <button
          type="button"
          className="cy-context-usage-menu__mood-figure"
          onClick={handleCompactClick}
          disabled={!canCompact || compacting}
          title={canCompact ? t("contextRing.compactTitle") : undefined}
          aria-label={t("contextRing.compactTitle")}
        >
          <img
            className="cy-context-usage-menu__mood-img"
            src={moodMeta[tone].src}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
          <img
            className="cy-context-usage-menu__mood-img cy-context-usage-menu__mood-img--compact"
            src={CONTEXT_USAGE_COMPACT_SRC}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        </button>
        <span>{moodText}</span>
      </div>
      <ul className="cy-context-usage-menu__rows">
        {visibleCategories.map((category, index) => {
          const meta = categoryMeta[category.key];
          // 占已用比例：各类加总恒 100%，直观看构成；与顶行"占窗口容量"互补。
          const share = usage.totalTokens > 0
            ? Math.round((category.tokens / usage.totalTokens) * 100)
            : undefined;
          // 圆点统一主题色，透明度按排序位次递减（榜首最实，往下渐淡）。
          const dotOpacity = Math.max(0.25, 1 - index * 0.15);
          return (
            <li key={category.key}>
              <span
                className="cy-context-usage-menu__dot"
                style={{ opacity: dotOpacity }}
                aria-hidden="true"
              />
              <span className="cy-context-usage-menu__name">{meta.label}</span>
              <span className="cy-context-usage-menu__tokens">{formatTokenCount(category.tokens)}</span>
              {share !== undefined && <span className="cy-context-usage-menu__share">{share}%</span>}
            </li>
          );
        })}
      </ul>
      <div className="cy-context-usage-menu__footnote">{t("contextRing.footnote")}</div>
    </div>
  );

  return (
    <Popover
      content={menu}
      trigger="click"
      placement="topRight"
      open={open}
      onOpenChange={setOpen}
      rootClassName="cy-context-usage-popover"
    >
      <button
        type="button"
        className={`cy-context-usage-ring is-${tone}`}
        aria-label={title}
        title={title}
        onClick={() => setOpen(!open)}
      >
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
          <circle
            className="cy-context-usage-ring__track"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
          />
          {visualRatio > 0 && (
            <circle
              className="cy-context-usage-ring__progress"
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={`${visualRatio * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
              transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            />
          )}
        </svg>
      </button>
    </Popover>
  );
}
