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
