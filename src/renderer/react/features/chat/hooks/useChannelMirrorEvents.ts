// 渠道消息镜像：把 bot 在微信/飞书等外部渠道的收发消息，以临时系统消息的
// 形式展示在聊天窗口当前会话里（不落库，切会话即消失）。
//
// 主进程 dispatcher 在 mirrorToDesktop 开启时通过 AGUI_EVENT CUSTOM
// "cyrene.botMessage" 推送到聊天窗口；若该外部聊天已绑定到当前正在查看
// 的会话，消息会经绑定镜像落库并触发 CHATS_CHANGED 刷新展示，此处跳过
// 避免同一条消息出现两次。

import { useEffect, useRef } from "react";
import type { ChatMessageItem } from "../components/ChatMessageList";
import { aguiApi } from "../pages/chat-page-bridge";

/** 主进程推送的渠道镜像事件载荷。 */
interface ChannelMirrorPayload {
  type: "bot:incoming" | "bot:outgoing";
  channel: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  text: string;
  at: number;
}

/** 上下文绑定快照中与展示去重有关的字段。 */
interface BindingSnapshot {
  externalChats: Array<{ sessionId: string; channel: string; chatId: string }>;
  bindings: Array<{ sessionId: string; conversationId: string }>;
}

/** 设置面板暴露的渠道上下文绑定查询（preload window.settings）。 */
interface SettingsBindingApi {
  channelsContextBindingsGet: () => Promise<BindingSnapshot>;
}

export interface UseChannelMirrorEventsDeps {
  getActiveSessionId: () => string | undefined;
  appendMessages: (sessionId: string, items: ChatMessageItem[]) => void;
}

const CHANNEL_LABELS: Record<string, string> = {
  wechat: "微信",
  feishu: "飞书",
  qq: "QQ",
  qqbot: "QQ机器人",
};

/** 镜像文本截断上限：过长消息只保留开头，避免刷屏。 */
const MAX_MIRROR_TEXT = 160;

/** 消息 id 自增序号，保证同毫秒同发送者的多条消息 id 不冲突。 */
let mirrorSequence = 0;

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

function truncate(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_MIRROR_TEXT ? `${normalized.slice(0, MAX_MIRROR_TEXT)}…` : normalized;
}

function mirrorLine(payload: ChannelMirrorPayload): string {
  const label = channelLabel(payload.channel);
  const who = payload.senderName || payload.chatId;
  const text = truncate(payload.text);
  return payload.type === "bot:outgoing"
    ? `[${label}] 回复 ${who}：${text}`
    : `[${label}] ${who}：${text}`;
}

/** 查询该外部聊天当前绑定的桌面对话 id；查询失败按未绑定处理。 */
async function resolveBoundConversation(channel: string, chatId: string): Promise<string | null> {
  const settings = (window as typeof window & { settings?: SettingsBindingApi }).settings;
  if (!settings?.channelsContextBindingsGet) return null;
  try {
    const snapshot = await settings.channelsContextBindingsGet();
    const chat = snapshot.externalChats.find((item) => item.channel === channel && item.chatId === chatId);
    if (!chat) return null;
    return snapshot.bindings.find((binding) => binding.sessionId === chat.sessionId)?.conversationId ?? null;
  } catch {
    return null;
  }
}

/** 校验事件载荷形状，防御主进程字段变更。 */
function parsePayload(value: unknown): ChannelMirrorPayload | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Partial<ChannelMirrorPayload>;
  if (candidate.type !== "bot:incoming" && candidate.type !== "bot:outgoing") return null;
  if (typeof candidate.channel !== "string" || typeof candidate.chatId !== "string") return null;
  if (typeof candidate.text !== "string") return null;
  return {
    type: candidate.type,
    channel: candidate.channel,
    senderId: typeof candidate.senderId === "string" ? candidate.senderId : "",
    senderName: typeof candidate.senderName === "string" ? candidate.senderName : undefined,
    chatId: candidate.chatId,
    text: candidate.text,
    at: typeof candidate.at === "number" ? candidate.at : Date.now(),
  };
}

export function useChannelMirrorEvents(deps: UseChannelMirrorEventsDeps): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  // 事件串行链：多条镜像按到达顺序展示，绑定查询异步不乱序
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const api = aguiApi();
    if (!api?.onEvent) return;

    const off = api.onEvent((rawEvent) => {
      const event = rawEvent as { type?: string; name?: string; value?: unknown };
      if (event.type !== "CUSTOM" || event.name !== "cyrene.botMessage") return;
      const payload = parsePayload(event.value);
      if (!payload) return;

      chainRef.current = chainRef.current
        .then(async () => {
          const sessionId = depsRef.current.getActiveSessionId();
          if (!sessionId) return;
          // 已绑定到当前查看的会话：落库镜像会随刷新展示，跳过临时消息
          const bound = await resolveBoundConversation(payload.channel, payload.chatId);
          if (bound === sessionId) return;
          mirrorSequence += 1;
          depsRef.current.appendMessages(sessionId, [
            {
              id: `channel-mirror-${payload.at}-${mirrorSequence}`,
              role: "system",
              content: mirrorLine(payload),
            },
          ]);
        })
        .catch(() => {
          // 单条镜像展示失败不影响后续事件
        });
    });

    return off;
  }, []);
}
