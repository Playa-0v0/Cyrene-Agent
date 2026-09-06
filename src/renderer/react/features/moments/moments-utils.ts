import { t } from "../../i18n";
import type { MomentFeedItem } from "../../../../shared/moments-types";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 朋友圈式相对时间：刚刚 / n 分钟前 / HH:mm / 昨天 HH:mm / M月D日 HH:mm / 跨年全日期。 */
export function formatMomentTime(createdAt: number, now: number): string {
  const diff = Math.max(0, now - createdAt);
  if (diff < MINUTE_MS) return t("moments.time.justNow");
  if (diff < HOUR_MS) return t("moments.time.minutesAgo", { count: Math.floor(diff / MINUTE_MS) });

  const created = new Date(createdAt);
  const nowDate = new Date(now);
  const hhmm = `${pad2(created.getHours())}:${pad2(created.getMinutes())}`;

  if (created.toDateString() === nowDate.toDateString()) return hhmm;
  if (created.toDateString() === new Date(now - DAY_MS).toDateString()) {
    return `${t("moments.time.yesterday")} ${hhmm}`;
  }
  if (created.getFullYear() === nowDate.getFullYear()) {
    return `${created.getMonth() + 1}月${created.getDate()}日 ${hhmm}`;
  }
  return `${created.getFullYear()}年${created.getMonth() + 1}月${created.getDate()}日`;
}

// ── 通知派生 ────────────────────────────────────────────────────
// 派生式通知：不新增存储，从 feed 数据实时计算与用户直接相关的互动。
// 三个精确条件（缺一即伪通知）：
// - 点赞：别人赞了用户的动态（自己赞自己不算）
// - 顶层评论：别人在用户动态下发表顶级评论（replyTo 为空）
// - 回复：别人回复了用户的评论（回复目标的 author 是 user，动态作者是谁都算）
// 角色之间、角色与昔涟之间的后台互动不通知——那不是在对用户说话，
// NPC 一互动就冒红点反而像"系统在表演"。

export type MomentNoticeKind = "like" | "comment" | "reply";

export interface MomentNoticeItem {
  kind: MomentNoticeKind;
  /** 互动发起者（原始 author，显示名由组件层映射昔涟名） */
  actor: string;
  postId: string;
  /** 评论类通知的定位锚点（点击滚动到评论所在动态） */
  commentId?: string;
  /** 评论内容（点赞通知为空） */
  excerpt?: string;
  createdAt: number;
}

export function deriveMomentNotices(items: readonly MomentFeedItem[]): MomentNoticeItem[] {
  const notices: MomentNoticeItem[] = [];
  for (const { post, comments, likes } of items) {
    const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
    if (post.author === "user") {
      for (const like of likes) {
        if (like.actor === "user") continue;
        notices.push({ kind: "like", actor: like.actor, postId: post.id, createdAt: like.createdAt });
      }
      for (const comment of comments) {
        if (comment.author === "user" || comment.replyTo != null) continue;
        notices.push({
          kind: "comment",
          actor: comment.author,
          postId: post.id,
          commentId: comment.id,
          excerpt: comment.content,
          createdAt: comment.createdAt,
        });
      }
    }
    for (const comment of comments) {
      if (comment.replyTo == null || comment.author === "user") continue;
      const target = commentsById.get(comment.replyTo);
      if (target?.author !== "user") continue;
      notices.push({
        kind: "reply",
        actor: comment.author,
        postId: post.id,
        commentId: comment.id,
        excerpt: comment.content,
        createdAt: comment.createdAt,
      });
    }
  }
  // 最新互动排最前
  notices.sort((a, b) => b.createdAt - a.createdAt);
  return notices;
}

/** 未读数：水位之后的互动条数，封顶 99（徽标显示 99+） */
export function countUnreadMomentNotices(
  notices: readonly MomentNoticeItem[],
  lastReadAt: number,
): number {
  return Math.min(99, notices.filter((notice) => notice.createdAt > lastReadAt).length);
}

// ── 已读水位 ────────────────────────────────────────────────────
// localStorage 持久化 + 模块内订阅：面板打开推进水位时，导航按钮的
// 红点徽标同步清零（同窗口组件间的轻量状态共享，不引入全局状态库）。

const MOMENTS_LAST_READ_KEY = "moments.lastReadAt";

function readStoredWaterMark(): number {
  try {
    const raw = localStorage.getItem(MOMENTS_LAST_READ_KEY);
    const value = raw === null ? 0 : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    // localStorage 不可用（隐私模式/测试环境）：视作从未读过，全部计未读
    return 0;
  }
}

const waterMarkListeners = new Set<() => void>();

export function getMomentsLastReadAt(): number {
  return readStoredWaterMark();
}

/** 推进水位（只进不退）；写入失败时仅本次会话内生效 */
export function touchMomentsLastReadAt(at: number): void {
  if (at <= readStoredWaterMark()) return;
  try {
    localStorage.setItem(MOMENTS_LAST_READ_KEY, String(at));
  } catch {
    // 存储不可用：跳过持久化，仍广播本次推进（内存外无快照，徽标下次读取归零）
  }
  for (const listener of [...waterMarkListeners]) listener();
}

export function subscribeMomentsWaterMark(listener: () => void): () => void {
  waterMarkListeners.add(listener);
  return () => {
    waterMarkListeners.delete(listener);
  };
}
