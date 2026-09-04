import { t } from "../../i18n";

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

// ── 背景点赞名单（纯前端展示）──────────────────────────────────
// 12 位好友来自 src/renderer/tast 的头像命名；只在点赞行展示名字，
// 不落库、不评论、不参与任何主进程逻辑。

/** 背景点赞的 12 位好友名单 */
const BACKGROUND_LIKERS: readonly string[] = [
  "阿格莱雅", "白厄", "丹恒", "风堇", "海瑟音",
  "刻律德菈", "那刻夏", "赛飞儿", "缇宝", "万敌", "遐蝶", "长夜月",
];

/** FNV-1a 字符串哈希：把 postId 变成种子，让每条动态的名单各自独立 */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 伪随机：同种子同序列，保证同一条动态刷新/重渲染结果不变 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 按动态 id 派生背景点赞名单：从 12 位好友里随机挑 1~6 位。
 * postId 做种子——不同动态各自随机（不会全员齐点赞），
 * 同一动态结果稳定（滚动、刷新、重渲染不闪变）。
 */
export function getBackgroundLikers(postId: string): string[] {
  const random = mulberry32(hashString(postId));
  const count = 1 + Math.floor(random() * 6);
  const pool = [...BACKGROUND_LIKERS];
  // Fisher-Yates 局部洗牌：只洗前 count 个位置，取走即止
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    const picked = pool[j];
    pool[j] = pool[i];
    pool[i] = picked;
  }
  return pool.slice(0, count);
}
