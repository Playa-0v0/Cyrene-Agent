// 通用格式化纯函数：HTML 转义与时间显示
// 从 settings.ts 抽离，无 DOM/状态依赖。

/** 将时间戳格式化为 zh-CN 本地字符串（YYYY/MM/DD HH:mm）；0 或无效返回「暂无时间」。 */
export function formatDateTime(timestamp: number): string {
  if (!timestamp) return "暂无时间";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "暂无时间";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 转义 HTML 特殊字符：& < > " '。用于把动态文本安全插入 innerHTML。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
