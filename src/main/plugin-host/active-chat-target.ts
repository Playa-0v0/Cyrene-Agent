/**
 * 活动聊天目标登记表：记录当前聊天窗口正在查看的会话与渲染目标标识。
 *
 * 语音输入租约依赖它冻结“提交目标”（会话 + 渲染页面）：
 * - 渲染页面每次初始化生成新的 rendererTargetId（preload 模块级生成），
 *   同一页面内切换会话不改变该标识，因此不会迁移或终止已取得的租约；
 * - 页面重新加载、导航或 WebContents 销毁使旧渲染桥失效，登记表清空
 *   目标并通知监听方（租约据此中止）；
 * - 只有聊天窗口的 WebContents 可以登记目标（由调用方校验 sender）。
 */
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { ConversationMode } from "../../shared/chat-types";

/** 冻结的活动目标快照：取得租约时拷贝，后续切换会话不影响已冻结值。 */
export interface ActiveChatTarget {
  sessionId: string;
  mode: ConversationMode;
  rendererTargetId: string;
  webContentsId: number;
}

export type ActiveChatTargetInvalidReason =
  | "target-destroyed"
  | "navigation"
  | "session-deleted";

export interface ActiveChatTargetRegistry {
  /** 渲染端上报活动会话（首次或切换）；sender 必须是聊天窗口的 WebContents。 */
  setActive(input: {
    sender: WebContents;
    sessionId: string;
    mode: ConversationMode;
    rendererTargetId: string;
  }): void;
  /** 渲染端清空活动会话（回到欢迎页）。 */
  clearActive(sender: WebContents): void;
  /** 当前活动目标快照；无目标返回 null。 */
  getActive(): ActiveChatTarget | null;
  /**
   * 目标失效监听（webContents 销毁/导航/会话删除）。
   * affected 为失效前的目标快照；无目标时为 null。
   */
  onInvalidated(
    listener: (reason: ActiveChatTargetInvalidReason, affected: ActiveChatTarget | null) => void,
  ): () => void;
  /**
   * 任意会话删除监听（无论是否当前目标）：冻结了该会话的租约据此中止，
   * 即使页面已切到其他会话。
   */
  onSessionDeleted(listener: (sessionId: string) => void): () => void;
  /** 会话被删除时通知（chats-ipc 删除路径调用）；删除当前目标会话会使目标失效。 */
  notifySessionDeleted(sessionId: string): void;
  /** 注销所有监听并清空目标（应用退出时调用）。 */
  dispose(): void;
}

/** 校验渲染端上报的活动目标字段；非法时返回 null（调用方忽略该次上报）。 */
export function parseActiveTargetPayload(
  payload: unknown,
): { sessionId: string; mode: ConversationMode; rendererTargetId: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { sessionId?: unknown; mode?: unknown; rendererTargetId?: unknown };
  if (typeof p.sessionId !== "string" || !p.sessionId) return null;
  if (typeof p.mode !== "string" || !["chat", "work", "learn", "code"].includes(p.mode)) return null;
  if (typeof p.rendererTargetId !== "string" || !p.rendererTargetId) return null;
  return {
    sessionId: p.sessionId,
    mode: p.mode as ConversationMode,
    rendererTargetId: p.rendererTargetId,
  };
}

export function createActiveChatTargetRegistry(): ActiveChatTargetRegistry {
  const listeners = new Set<
    (reason: ActiveChatTargetInvalidReason, affected: ActiveChatTarget | null) => void
  >();
  const sessionDeletedListeners = new Set<(sessionId: string) => void>();
  let current: ActiveChatTarget | null = null;
  // 已挂失效监听的 webContents；切换会话复用同一页面时不重复挂载。
  let watched: WebContents | null = null;
  let disposed = false;

  function notifyInvalidated(
    reason: ActiveChatTargetInvalidReason,
    affected: ActiveChatTarget | null,
  ): void {
    for (const listener of [...listeners]) {
      try {
        listener(reason, affected);
      } catch (error) {
        console.warn("[active-chat-target] 失效监听器抛错", error);
      }
    }
  }

  function detachWatchers(): void {
    if (!watched) return;
    watched.removeListener("destroyed", handleDestroyed);
    watched.removeListener("did-start-navigation", handleNavigation);
    watched = null;
  }

  function handleDestroyed(): void {
    const affected = current;
    current = null;
    watched = null;
    notifyInvalidated("target-destroyed", affected);
  }

  function handleNavigation(
    _event: unknown,
    _url: string,
    _isInPlace: boolean,
    isMainFrame: boolean,
  ): void {
    // 只看主框架导航：同文档锚点跳转不算页面重载，不使渲染桥失效
    if (!isMainFrame) return;
    // 页面导航/重新加载：旧渲染桥立即失效（preload 会生成新的 rendererTargetId）
    const affected = current;
    current = null;
    notifyInvalidated("navigation", affected);
  }

  return {
    setActive({ sender, sessionId, mode, rendererTargetId }) {
      if (disposed) return;
      if (sender.isDestroyed()) return;
      // 首次登记（或页面重新加载后）挂失效监听；同页面切换会话复用已有监听。
      if (watched !== sender) {
        detachWatchers();
        watched = sender;
        sender.once("destroyed", handleDestroyed);
        // 用 on 而非 once：同文档/子框架导航不失效，不能消耗掉监听器
        sender.on("did-start-navigation", handleNavigation);
      }
      current = {
        sessionId,
        mode,
        rendererTargetId,
        webContentsId: sender.id,
      };
    },
    clearActive(sender) {
      if (disposed) return;
      if (current && current.webContentsId === sender.id) {
        current = null;
      }
    },
    getActive() {
      return current ? { ...current } : null;
    },
    onInvalidated(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notifySessionDeleted(sessionId) {
      if (disposed) return;
      // 无论是否当前目标都通知：冻结了该会话的租约据此中止，即使页面已切到其他会话。
      for (const listener of [...sessionDeletedListeners]) {
        try {
          listener(sessionId);
        } catch (error) {
          console.warn("[active-chat-target] 会话删除监听器抛错", error);
        }
      }
      if (current && current.sessionId === sessionId) {
        const affected = current;
        current = null;
        notifyInvalidated("session-deleted", affected);
      }
    },
    onSessionDeleted(listener) {
      sessionDeletedListeners.add(listener);
      return () => {
        sessionDeletedListeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detachWatchers();
      current = null;
      listeners.clear();
      sessionDeletedListeners.clear();
    },
  };
}

/** 生成渲染目标标识；preload 每次页面初始化时调用一次。 */
export function generateRendererTargetId(): string {
  return randomUUID();
}

/** 全局唯一登记表实例：chat-ui-ipc 上报、speech-input-service 冻结目标共用。 */
export const activeChatTargetRegistry = createActiveChatTargetRegistry();
