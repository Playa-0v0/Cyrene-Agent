import type { ChatMessage } from "../orchestrator/vendors/types";

export interface ProactiveHistoryTurn {
  role: "user" | "model";
  content: string;
  at: number;
}

export interface BuildProactiveMessagesInput {
  basePersona: string;
  userProfile?: string;
  relevantMemory?: string;
  ordinaryHistory: ProactiveHistoryTurn[];
  proactiveHistory: ProactiveHistoryTurn[];
  sceneId: string;
  localNow: Date;
  idleSec: number;
  unansweredCount: 0 | 1 | 2;
  /**
   * 已 resolver 后的用户有效时区（合法 IANA 字符串）。
   * 所有"本地"时间解释（早晚判定、history 行、trigger 行的"电脑本地时间"）都基于该时区。
   * 不接受未校验的 profile.timezone 字符串；调用方需先经 resolveChatContextTimezone。
   */
  timezone: string;
}

export type ProactiveModelDecision =
  | { kind: "send"; text: string }
  | { kind: "silent" }
  | { kind: "invalid"; reason: string };

const MAX_HISTORY_MESSAGES = 16;
const MAX_PROACTIVE_TEXT_LENGTH = 500;

const PROACTIVE_SYSTEM = `[proactive_system]
你正在判断是否要主动向用户发起一次对话，而不是回答用户的新消息。
不要把历史聊天中的最后一句当作用户刚刚发来的消息；历史只用于理解用户最近的状态和话题。
如果没有自然且值得说的内容，请返回 silent。不要为了完成任务而强行寒暄。
不要提及系统检测、触发规则、评分、上下文、用户画像或内部状态。
消息应当简短自然，可以关心、分享、跟进或轻轻询问，但不要连续提出多个问题。
不要声称自己调用了工具、读取了屏幕或执行了任何外部动作。`;

const NIGHT_SYSTEM = `[night_system]
当前处于深夜，用户仍在使用电脑。
生成内容时可以更倾向于温柔关心用户的休息状态，适度提醒不要熬得太晚，但不要说教、催促或制造压力。
不要每次都提睡觉；如果上下文中有更自然、更重要的话题，可以先回应那个话题，再轻轻带到休息。
不要透露你检测到了用户的键盘、鼠标、屏幕或系统状态。
如果此刻没有值得主动说的话，请选择保持安静。`;

const FOLLOWUP_SYSTEM = `[followup_system]
这是用户未回复情况下允许的最后一次主动机会。
本地系统已经确认出现了不同于上一次的新场景理由，但你仍应判断它是否值得打扰用户。
不要责怪、催促、卖惨或表现出被冷落，也不要机械地重复"在吗"。
没有充分理由时必须返回 silent。`;

/**
 * 用 Intl 把日期拆成 {year, month, day, hour, minute}（按 timezone）。
 * 不依赖 toLocaleString 的本地化标点和顺序。
 * 失败回退 system-local（resolver 已保证 timezone 合法，此分支仅 debug）。
 */
function getZonedDateParts(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

/** 早晚判定：基于用户时区的 hour。保留原 22:00-08:00 + idle<60 语义。 */
function isActiveNight(date: Date, timezone: string, idleSec: number): boolean {
  const { hour } = getZonedDateParts(date, timezone);
  return (hour >= 22 || hour < 8) && idleSec < 60;
}

/** 用户时区下的"本地时间"格式化：`YYYY-MM-DD HH:MM`。 */
function formatLocalTime(date: Date, timezone: string): string {
  const p = getZonedDateParts(date, timezone);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  const hh = String(p.hour).padStart(2, "0");
  const min = String(p.minute).padStart(2, "0");
  return `${p.year}-${mm}-${dd} ${hh}:${min}`;
}

function formatHistory(label: string, history: ProactiveHistoryTurn[], timezone: string): string {
  const recent = history
    .filter((turn) => turn && (turn.role === "user" || turn.role === "model") && turn.content.trim())
    .slice(-MAX_HISTORY_MESSAGES);
  const lines = recent.map((turn) => {
    const role = turn.role === "model" ? "assistant" : "user";
    return `[${formatLocalTime(new Date(turn.at), timezone)}] ${role}: ${turn.content.trim()}`;
  });
  return `[${label}]\n${lines.length > 0 ? lines.join("\n") : "（暂无）"}`;
}

export function buildProactiveMessages(input: BuildProactiveMessagesInput): ChatMessage[] {
  const systemParts = [input.basePersona.trim(), PROACTIVE_SYSTEM];
  if (input.userProfile?.trim()) systemParts.push(`[用户画像]\n${input.userProfile.trim()}`);
  if (input.relevantMemory?.trim()) systemParts.push(`[相关长期记忆]\n${input.relevantMemory.trim()}`);
  systemParts.push(formatHistory("最近使用的普通聊天会话", input.ordinaryHistory, input.timezone));
  systemParts.push(formatHistory("主动聊天专用会话", input.proactiveHistory, input.timezone));
  if (isActiveNight(input.localNow, input.timezone, input.idleSec)) systemParts.push(NIGHT_SYSTEM);
  if (input.unansweredCount === 1) systemParts.push(FOLLOWUP_SYSTEM);

  const trigger = `[本次主动聊天候选]
电脑本地时间：${formatLocalTime(input.localNow, input.timezone)}
候选场景：${input.sceneId}
连续未回复次数：${input.unansweredCount}

请只返回以下一种 JSON，不要使用 Markdown 代码块，也不要添加解释：
{"decision":"send","text":"要发送的一条自然消息"}
或
{"decision":"silent","text":""}`;

  return [
    { role: "system", content: systemParts.filter(Boolean).join("\n\n---\n\n") },
    { role: "user", content: trigger },
  ];
}

export function parseProactiveDecision(text: string): ProactiveModelDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { kind: "invalid", reason: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  const value = parsed as { decision?: unknown; text?: unknown };
  if (value.decision === "silent") return { kind: "silent" };
  if (value.decision !== "send") return { kind: "invalid", reason: "invalid_decision" };
  if (typeof value.text !== "string" || !value.text.trim()) return { kind: "invalid", reason: "empty_text" };
  const cleaned = value.text.trim();
  if (cleaned.length > MAX_PROACTIVE_TEXT_LENGTH) return { kind: "invalid", reason: "text_too_long" };
  return { kind: "send", text: cleaned };
}