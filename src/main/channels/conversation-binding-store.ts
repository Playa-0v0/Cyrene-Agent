import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import type { ChannelChatType, ChannelId } from "./types";

const STORE_VERSION = 1;
const DEFAULT_MAX_EXTERNAL_CHATS = 200;

export interface ExternalChannelChat {
  sessionId: string;
  channel: ChannelId;
  chatId: string;
  chatType: ChannelChatType;
  senderName?: string;
  lastAt: number;
}

export interface ChannelConversationBinding {
  sessionId: string;
  conversationId: string;
  updatedAt: number;
}

interface PersistedBindingState {
  version: typeof STORE_VERSION;
  externalChats: ExternalChannelChat[];
  bindings: ChannelConversationBinding[];
}

export interface ChannelConversationBindingSnapshot {
  externalChats: ExternalChannelChat[];
  bindings: ChannelConversationBinding[];
}

function emptyState(): PersistedBindingState {
  return { version: STORE_VERSION, externalChats: [], bindings: [] };
}

function isChannelId(value: unknown): value is ChannelId {
  return value === "wechat" || value === "feishu" || value === "qq" || value === "qqbot";
}

function isExternalChat(value: unknown): value is ExternalChannelChat {
  if (!value || typeof value !== "object") return false;
  const chat = value as Partial<ExternalChannelChat>;
  return typeof chat.sessionId === "string"
    && chat.sessionId.length > 0
    && chat.sessionId.length <= 128
    && isChannelId(chat.channel)
    && typeof chat.chatId === "string"
    && chat.chatId.length > 0
    && chat.chatId.length <= 256
    && (chat.chatType === "private" || chat.chatType === "group")
    && (chat.senderName === undefined || (typeof chat.senderName === "string" && chat.senderName.length <= 256))
    && typeof chat.lastAt === "number"
    && Number.isFinite(chat.lastAt);
}

function isBinding(value: unknown): value is ChannelConversationBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<ChannelConversationBinding>;
  return typeof binding.sessionId === "string"
    && binding.sessionId.length > 0
    && binding.sessionId.length <= 128
    && typeof binding.conversationId === "string"
    && binding.conversationId.length > 0
    && binding.conversationId.length <= 128
    && typeof binding.updatedAt === "number"
    && Number.isFinite(binding.updatedAt);
}

export class ChannelConversationBindingStore {
  private state: PersistedBindingState | null = null;

  constructor(
    private readonly filePath: string,
    private readonly maxExternalChats = DEFAULT_MAX_EXTERNAL_CHATS,
  ) {}

  observe(chat: ExternalChannelChat): void {
    if (!isExternalChat(chat)) throw new Error("Invalid external chat");
    const state = this.load();
    const externalChats = state.externalChats.filter((item) => item.sessionId !== chat.sessionId);
    externalChats.push({ ...chat });
    externalChats.sort((a, b) => b.lastAt - a.lastAt);
    // 已绑定聊天必须稳定保留；上限只淘汰未绑定的旧观察记录，
    // 否则大量新聊天会让用户选定的上下文绑定无声失效。
    const boundSessionIds = new Set(state.bindings.map((binding) => binding.sessionId));
    const boundChats = externalChats.filter((item) => boundSessionIds.has(item.sessionId));
    const unboundChats = externalChats.filter((item) => !boundSessionIds.has(item.sessionId));
    const maxUnbound = Math.max(0, this.maxExternalChats - boundChats.length);
    state.externalChats = [...boundChats, ...unboundChats.slice(0, maxUnbound)]
      .sort((a, b) => b.lastAt - a.lastAt);
    this.persist();
  }

  bind(sessionId: string, conversationId: string, updatedAt = Date.now()): void {
    const state = this.load();
    if (!state.externalChats.some((chat) => chat.sessionId === sessionId)) {
      throw new Error("Unknown external chat");
    }
    if (!conversationId || conversationId.length > 128) {
      throw new Error("Invalid conversation id");
    }
    state.bindings = state.bindings.filter((binding) => binding.sessionId !== sessionId);
    state.bindings.push({ sessionId, conversationId, updatedAt });
    this.persist();
  }

  unbind(sessionId: string): boolean {
    const state = this.load();
    const next = state.bindings.filter((binding) => binding.sessionId !== sessionId);
    if (next.length === state.bindings.length) return false;
    state.bindings = next;
    this.persist();
    return true;
  }

  resolve(sessionId: string): string | null {
    return this.load().bindings.find((binding) => binding.sessionId === sessionId)?.conversationId ?? null;
  }

  list(): ChannelConversationBindingSnapshot {
    const state = this.load();
    return {
      externalChats: state.externalChats.map((chat) => ({ ...chat })),
      bindings: state.bindings.map((binding) => ({ ...binding })),
    };
  }

  private load(): PersistedBindingState {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<PersistedBindingState>;
      if (parsed.version !== STORE_VERSION
        || !Array.isArray(parsed.externalChats)
        || !parsed.externalChats.every(isExternalChat)
        || !Array.isArray(parsed.bindings)
        || !parsed.bindings.every(isBinding)) {
        this.state = emptyState();
      } else {
        const knownSessions = new Set(parsed.externalChats.map((chat) => chat.sessionId));
        const boundSessionIds = new Set(
          parsed.bindings
            .filter(isBinding)
            .map((binding) => binding.sessionId),
        );
        const boundChatCount = parsed.externalChats.filter((chat) => boundSessionIds.has(chat.sessionId)).length;
        const unboundChats = parsed.externalChats.filter((chat) => !boundSessionIds.has(chat.sessionId));
        const maxUnbound = Math.max(0, this.maxExternalChats - boundChatCount);
        this.state = {
          version: STORE_VERSION,
          externalChats: [...parsed.externalChats]
            .sort((a, b) => b.lastAt - a.lastAt)
            .filter((chat) => boundSessionIds.has(chat.sessionId))
            .concat(unboundChats
              .sort((a, b) => b.lastAt - a.lastAt)
              .slice(0, maxUnbound))
            .sort((a, b) => b.lastAt - a.lastAt),
          bindings: parsed.bindings.filter((binding) => knownSessions.has(binding.sessionId)),
        };
      }
    } catch {
      this.state = emptyState();
    }
    return this.state;
  }

  private persist(): void {
    const state = this.load();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(temporaryPath, this.filePath);
  }
}

let defaultStore: ChannelConversationBindingStore | null = null;

export function getChannelConversationBindingStore(): ChannelConversationBindingStore {
  if (!defaultStore) {
    defaultStore = new ChannelConversationBindingStore(
      path.join(app.getPath("userData"), "channels", "context-bindings.json"),
    );
  }
  return defaultStore;
}
