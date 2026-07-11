import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage as HttpIncomingMessage } from "http";
import type { ChannelAdapter } from "../base";
import type {
  ChannelCapability,
  ChannelStatus,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  OutgoingPart,
} from "../../types";
import { loadChannelsSettings, type QqNapCatChannelConfig } from "../../settings-store";
import { calculateSmartSegmentDelay, splitSmartReply } from "../../../../shared/smart-segmentation";

export { calculateSmartSegmentDelay as calculateSegmentDelay } from "../../../../shared/smart-segmentation";

const LOG = "[QqNapCatAdapter]";

const QQ_CAPABILITY: ChannelCapability = {
  text: true,
  image: true,
  audio: false,
  file: false,
  video: false,
  markdown: false,
  card: false,
  sticker: false,
  maxTextLength: 4500,
};

type OneBotMessageSegment = {
  type: string;
  data?: Record<string, unknown>;
};

type OneBotMessageEvent = {
  post_type?: string;
  message_type?: "private" | "group";
  sub_type?: string;
  self_id?: number | string;
  user_id?: number | string;
  group_id?: number | string;
  message_id?: number | string;
  raw_message?: string;
  message?: string | OneBotMessageSegment[];
  sender?: {
    nickname?: string;
    card?: string;
    user_id?: number | string;
  };
};

type PendingAction = {
  action: string;
  params: Record<string, unknown>;
  echo: string;
};

type OneBotActionResponse = {
  status?: string;
  retcode?: number;
  message?: string;
  wording?: string;
  echo?: unknown;
};

type PendingActionResult = {
  resolve: (result: { ok: boolean; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type NormalizedOneBotPayload = {
  text: string;
  attachments?: IncomingMessage["attachments"];
};

function toId(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export class RecentMessageIds {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity = 1000) {}

  seen(id: unknown): boolean {
    const key = toId(id);
    if (!key) return false;
    if (this.ids.has(key)) return true;
    this.ids.add(key);
    this.order.push(key);
    while (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest) this.ids.delete(oldest);
    }
    return false;
  }

  clear(): void {
    this.ids.clear();
    this.order.length = 0;
  }
}

function parseList(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((v) => v.trim()).filter(Boolean));
}

function messageToText(message: OneBotMessageEvent["message"], rawMessage: string | undefined): string {
  if (Array.isArray(message)) {
    return message
      .map((seg) => {
        if (seg.type === "text") return String(seg.data?.text ?? "");
        if (seg.type === "at") return `[CQ:at,qq=${String(seg.data?.qq ?? "")}]`;
        if (seg.type === "image") return `[图片:${String(seg.data?.url ?? seg.data?.file ?? "")}]`;
        if (seg.type === "face") return `[表情:${String(seg.data?.id ?? "")}]`;
        return `[${seg.type}]`;
      })
      .join("")
      .trim();
  }
  if (typeof message === "string") return message.trim();
  return (rawMessage ?? "").trim();
}

export function normalizeOneBotPayload(
  message: OneBotMessageEvent["message"],
  rawMessage: string | undefined,
): NormalizedOneBotPayload {
  if (!Array.isArray(message)) {
    return { text: messageToText(message, rawMessage) };
  }
  const attachments: IncomingMessage["attachments"] = [];
  const text = message
    .map((seg) => {
      if (seg.type === "text") return String(seg.data?.text ?? "");
      if (seg.type === "at") return `[CQ:at,qq=${String(seg.data?.qq ?? "")}]`;
      if (seg.type === "image") {
        const url = typeof seg.data?.url === "string" ? seg.data.url : undefined;
        const file = typeof seg.data?.file === "string" ? seg.data.file : undefined;
        attachments.push({ kind: "image", url, caption: file });
        return `[图片:${url ?? file ?? ""}]`;
      }
      if (seg.type === "file") {
        const url = typeof seg.data?.url === "string" ? seg.data.url : undefined;
        const file = typeof seg.data?.file === "string" ? seg.data.file : undefined;
        attachments.push({ kind: "file", url, caption: file });
        return `[文件:${file ?? url ?? ""}]`;
      }
      if (seg.type === "record") {
        const url = typeof seg.data?.url === "string" ? seg.data.url : undefined;
        const file = typeof seg.data?.file === "string" ? seg.data.file : undefined;
        attachments.push({ kind: "audio", url, caption: file });
        return `[语音:${file ?? url ?? ""}]`;
      }
      if (seg.type === "video") {
        const url = typeof seg.data?.url === "string" ? seg.data.url : undefined;
        const file = typeof seg.data?.file === "string" ? seg.data.file : undefined;
        attachments.push({ kind: "video", url, caption: file });
        return `[视频:${file ?? url ?? ""}]`;
      }
      if (seg.type === "face") return `[表情:${String(seg.data?.id ?? "")}]`;
      return `[${seg.type}]`;
    })
    .join("")
    .trim();
  return { text, attachments: attachments.length > 0 ? attachments : undefined };
}

function stripAt(text: string, selfId: string): { text: string; mentioned: boolean } {
  if (!selfId) return { text, mentioned: false };
  const atPattern = new RegExp(`\\[CQ:at,qq=${selfId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "g");
  const mentioned = atPattern.test(text);
  return { text: text.replace(atPattern, "").trim(), mentioned };
}

function shouldAcceptPrivate(config: QqNapCatChannelConfig, userId: string): boolean {
  if (config.ownerQq && config.ownerQq === userId) return true;
  const allowedUsers = parseList(config.allowedUsers);
  return allowedUsers.size === 0 || allowedUsers.has(userId);
}

function shouldAcceptGroup(config: QqNapCatChannelConfig, groupId: string, userId: string): boolean {
  const allowedGroups = parseList(config.allowedGroups);
  const allowedUsers = parseList(config.allowedUsers);
  if (allowedGroups.size > 0 && !allowedGroups.has(groupId)) return false;
  if (allowedUsers.size > 0 && !allowedUsers.has(userId) && config.ownerQq !== userId) return false;
  return true;
}

export function applyGroupTrigger(config: QqNapCatChannelConfig, sourceText: string, selfId: string): string | null {
  const stripped = stripAt(sourceText, selfId);
  const mode = config.groupTriggerMode ?? "mention";
  if (mode === "mention") return stripped.mentioned && stripped.text ? stripped.text : null;
  if (mode === "prefix") {
    const prefix = config.groupPrefix || "/cyrene";
    if (!stripped.text.startsWith(prefix)) return null;
    return stripped.text.slice(prefix.length).trim() || null;
  }
  if (mode === "keyword") {
    const textLower = stripped.text.toLocaleLowerCase();
    const matched = (config.groupKeywords ?? [])
      .map((keyword) => keyword.trim())
      .filter(Boolean)
      .some((keyword) => textLower.includes(keyword.toLocaleLowerCase()));
    return matched && stripped.text ? stripped.text : null;
  }
  return stripped.text || null;
}

export function shouldProactivelyReply(
  config: QqNapCatChannelConfig,
  lastReplyAt: number,
  now = Date.now(),
  random = Math.random,
): boolean {
  if (!config.proactiveGroupEnabled) return false;
  const cooldownMs = Math.max(5, config.proactiveGroupCooldownSeconds ?? 120) * 1000;
  if (now - lastReplyAt < cooldownMs) return false;
  const probability = Math.min(1, Math.max(0, config.proactiveGroupProbability ?? 0.08));
  return random() < probability;
}

export function splitQqText(text: string, maxChars = 180, maxParts = 4, contentThreshold = 200): string[] {
  return splitSmartReply(text, { maxChars, maxParts, contentThreshold, sentenceFallback: true });
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export class QqNapCatAdapter implements ChannelAdapter {
  readonly id = "qq" as const;
  readonly displayName = "QQ / NapCat";
  readonly capability = QQ_CAPABILITY;
  onMessage: MessageHandler | null = null;

  private server: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private status: ChannelStatus = { enabled: false, phase: "offline" };
  private actionSeq = 0;
  private readonly recentMessageIds = new RecentMessageIds();
  private readonly pendingActions = new Map<string, PendingActionResult>();
  private readonly proactiveGroupReplyAt = new Map<string, number>();

  async start(): Promise<void> {
    const config = loadChannelsSettings().qq;
    if (!config.enabled) {
      this.status = { enabled: false, phase: "offline", message: "未启用" };
      return;
    }

    await this.stop();
    const host = config.host || "127.0.0.1";
    const port = config.port || 3001;
    const path = config.path || "/onebot/v11/ws";

    this.status = { enabled: true, phase: "starting", message: "等待 NapCat 连接" };
    this.server = new WebSocketServer({ host, port, path });
    this.server.on("connection", (ws, request) => this.handleConnection(ws, request));
    this.server.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.status = { enabled: true, phase: "error", message };
      console.error(LOG, "server error:", message);
    });

    this.status = {
      enabled: true,
      phase: "starting",
      message: `监听 ws://${host}:${port}${path}`,
      detail: { url: `ws://${host}:${port}${path}` },
    };
    console.log(LOG, `listening on ws://${host}:${port}${path}`);
  }

  async stop(): Promise<void> {
    for (const [echo, pending] of this.pendingActions) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: `NapCat connection closed before response (${echo})` });
    }
    this.pendingActions.clear();
    this.recentMessageIds.clear();
    this.proactiveGroupReplyAt.clear();
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }
    this.status = { enabled: false, phase: "offline", message: "已停止" };
  }

  getStatus(): ChannelStatus {
    const config = loadChannelsSettings().qq;
    if (!config.enabled) return { enabled: false, phase: "offline", message: "未启用" };
    return {
      ...this.status,
      enabled: true,
      detail: {
        ...(this.status.detail ?? {}),
        clients: this.clients.size,
      },
    };
  }

  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    if (this.clients.size === 0) return { ok: false, error: "NapCat 未连接" };
    const text = msg.parts.map((p) => this.partToText(p)).filter(Boolean).join("\n").trim();
    if (!text) return { ok: false, error: "没有可发送的文本内容" };

    const config = loadChannelsSettings().qq;
    const segments = config.segmentedReplies
      ? splitQqText(text, config.segmentMaxChars, config.segmentMaxParts, config.segmentContentThreshold)
      : [text];
    const action = msg.threadId ? "send_group_msg" : "send_private_msg";
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const params = msg.threadId
        ? { group_id: Number(msg.targetId) || msg.targetId, message: segment }
        : { user_id: Number(msg.targetId) || msg.targetId, message: segment };
      const result = await this.sendAction({ action, params, echo: `cyrene-${Date.now()}-${++this.actionSeq}` });
      if (!result.ok) return result;
      if (index < segments.length - 1) {
        const minDelay = Math.max(0, config.segmentDelayMinMs ?? 350);
        const maxDelay = Math.max(minDelay, config.segmentDelayMaxMs ?? 900);
        await wait(calculateSmartSegmentDelay(segment.length, config.segmentIntervalMode ?? "length", minDelay, maxDelay));
      }
    }
    return { ok: true };
  }

  private handleConnection(ws: WebSocket, request: HttpIncomingMessage): void {
    const config = loadChannelsSettings().qq;
    if (config.accessToken) {
      const auth = request.headers.authorization ?? "";
      const token = Array.isArray(auth) ? auth[0] : auth;
      if (token !== `Bearer ${config.accessToken}`) {
        ws.close(1008, "invalid access token");
        return;
      }
    }

    this.clients.add(ws);
    this.status = { enabled: true, phase: "running", message: `NapCat 已连接 (${this.clients.size})` };
    console.log(LOG, "NapCat connected");

    ws.on("message", (data) => {
      void this.handleRawMessage(data.toString()).catch((err) => {
        console.error(LOG, "handle message failed:", err);
      });
    });
    ws.on("close", () => {
      this.clients.delete(ws);
      this.status = {
        enabled: true,
        phase: this.clients.size > 0 ? "running" : "starting",
        message: this.clients.size > 0 ? `NapCat 已连接 (${this.clients.size})` : "等待 NapCat 连接",
      };
    });
  }

  private async handleRawMessage(raw: string): Promise<void> {
    let payload: OneBotMessageEvent & OneBotActionResponse;
    try {
      payload = JSON.parse(raw) as OneBotMessageEvent & OneBotActionResponse;
    } catch {
      return;
    }
    const echo = toId(payload.echo);
    if (echo) {
      const pending = this.pendingActions.get(echo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingActions.delete(echo);
        const ok = payload.status === "ok" && (payload.retcode === undefined || payload.retcode === 0);
        pending.resolve({
          ok,
          error: ok ? undefined : payload.wording || payload.message || `OneBot retcode ${payload.retcode ?? "unknown"}`,
        });
      }
      return;
    }
    const event = payload;
    if (event.post_type !== "message") return;
    if (event.message_type !== "private" && event.message_type !== "group") return;
    if (!this.onMessage) return;

    const config = loadChannelsSettings().qq;
    const userId = toId(event.user_id);
    const groupId = toId(event.group_id);
    const selfId = toId(config.botSelfId || event.self_id);
    if (!userId) return;
    if (selfId && userId === selfId) return;
    if (this.recentMessageIds.seen(event.message_id)) return;

    const normalized = normalizeOneBotPayload(event.message, event.raw_message);
    let text = normalized.text;
    if (!text) return;

    let chatId = userId;
    let senderId = userId;
    let threadId: string | undefined;

    if (event.message_type === "group") {
      if (!groupId || !shouldAcceptGroup(config, groupId, userId)) return;
      const triggeredText = applyGroupTrigger(config, text, selfId);
      if (triggeredText) {
        text = triggeredText;
      } else {
        const lastReplyAt = this.proactiveGroupReplyAt.get(groupId) ?? 0;
        if (!shouldProactivelyReply(config, lastReplyAt)) return;
        this.proactiveGroupReplyAt.set(groupId, Date.now());
        text = stripAt(text, selfId).text;
        if (!text) return;
      }
      chatId = groupId;
      senderId = `group:${groupId}:user:${userId}`;
      threadId = userId;
    } else if (!shouldAcceptPrivate(config, userId)) {
      return;
    }

    const incoming: IncomingMessage = {
      channel: "qq",
      senderId,
      senderName: event.sender?.card || event.sender?.nickname,
      chatId,
      threadId,
      text,
      attachments: normalized.attachments,
      at: new Date(),
      _raw: event,
    };
    await this.onMessage(incoming);
  }

  private async sendAction(action: PendingAction): Promise<{ ok: boolean; error?: string }> {
    const payload = JSON.stringify(action);
    const ws = Array.from(this.clients).find((client) => client.readyState === WebSocket.OPEN);
    if (!ws) return { ok: false, error: "没有可用的 NapCat WebSocket 连接" };

    return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(action.echo);
        resolve({ ok: false, error: "NapCat 响应超时" });
      }, 10_000);
      this.pendingActions.set(action.echo, { resolve, timer });
      ws.send(payload, (err) => {
        if (!err) return;
        const pending = this.pendingActions.get(action.echo);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingActions.delete(action.echo);
        pending.resolve({ ok: false, error: err.message });
      });
    });
  }

  private partToText(part: OutgoingPart): string {
    switch (part.kind) {
      case "text":
        return part.text;
      case "image":
        return part.caption || part.url || part.filePath ? `[图片] ${part.caption ?? part.url ?? part.filePath}` : "[图片]";
      case "audio":
        return "[语音消息请在桌面端查看]";
      case "card":
        return [part.title, part.markdown, ...(part.fields ?? []).map((f) => `${f.key}: ${f.value}`)]
          .filter(Boolean)
          .join("\n");
      case "sticker":
        return "";
    }
  }
}
