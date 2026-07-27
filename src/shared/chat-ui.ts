// 聊天會話列表 UI 層共享代碼（settings 💬面板 + chat 窗口側欄 都用）。
//
// 這裡只放純展示相關的類型/常量/純函數——不涉及任何 DOM 構建，
// 因為兩個入口的 DOM 結構和交互不同（settings=跨窗口openInChatWindow，
// chat=本地loadSessionIntoUI），各自 build，但時間格式化/類型/默認標籤統一。

export interface ChatSessionMetaUI {
  id: string;
  title: string;
  identityId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// 默認 identity 顯示名（職位面板未做，所有會話先用這個）
export const CHAT_DEFAULT_IDENTITY_LABEL = "聊天陪伴";

// 微信式相對時間：剛剛 / N 分鐘前 / 今天 HH:mm / 昨天 HH:mm / N 天前 / MM-DD / YYYY-MM-DD
export function formatChatRelativeTime(at: number): string {
  const now = Date.now();
  const diff = now - at;
  if (diff < 0) {
    // 極少見的時鐘回撥：直接降級到絕對時間
    const d = new Date(at);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  if (diff < 60_000) return "剛剛";
  if (diff < 60 * 60_000) return Math.floor(diff / 60_000) + " 分鐘前";

  const target = new Date(at);
  const today = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.floor((startOfDay(today) - startOfDay(target)) / (24 * 3600 * 1000));

  const hh = String(target.getHours()).padStart(2, "0");
  const mm = String(target.getMinutes()).padStart(2, "0");
  if (dayDiff === 0) return `今天 ${hh}:${mm}`;
  if (dayDiff === 1) return `昨天 ${hh}:${mm}`;
  if (dayDiff < 7) return `${dayDiff} 天前`;

  const sameYear = target.getFullYear() === today.getFullYear();
  const md = `${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
  return sameYear ? md : `${target.getFullYear()}-${md}`;
}
