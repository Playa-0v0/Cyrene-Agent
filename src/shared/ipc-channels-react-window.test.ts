import { describe, expect, it } from "vitest";
import { IPC } from "./ipc-channels";

describe("IPC channel contract for React chat window", () => {
  it("状态栏专用入口 CHATS_OPEN_IN_REACT_WINDOW 已存在", () => {
    expect(IPC.CHATS_OPEN_IN_REACT_WINDOW).toBe("chats:open-in-react-window");
  });

  it("reactChatWindow 切换会话通道 CHATS_REACT_SWITCH_SESSION 已存在", () => {
    expect(IPC.CHATS_REACT_SWITCH_SESSION).toBe("chats:react-switch-session");
  });

  it("reactChatWindow ready handshake 通道 CHATS_REACT_READY 已存在", () => {
    expect(IPC.CHATS_REACT_READY).toBe("chats:react-ready");
  });

  it("旧 chatWindow 通道已移除", () => {
    expect(IPC).not.toHaveProperty("CHATS_OPEN_IN_CHAT_WINDOW");
    expect(IPC).not.toHaveProperty("CHATS_SWITCH_SESSION");
  });
});
