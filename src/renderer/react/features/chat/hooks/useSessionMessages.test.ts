// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSessionMessages, type SessionMessagesApi } from "./useSessionMessages";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ConversationMode } from "../../../../../shared/chat-types";

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: SessionMessagesApi;
let activeSessionByMode: Partial<Record<ConversationMode, string>> = {};

function mountProbe() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  function Probe() {
    latest = useSessionMessages((mode) => activeSessionByMode[mode]);
    return null;
  }
  act(() => {
    root!.render(createElement(Probe));
  });
}

function userItem(id: string, content: string): ChatMessageItem {
  return { id, role: "user", content };
}

beforeEach(() => {
  activeSessionByMode = {};
  mountProbe();
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (host) {
    host.remove();
    host = null;
  }
});

describe("useSessionMessages", () => {
  it("appendMessages 按会话追加且保序，replace 整体替换", () => {
    act(() => {
      latest.appendMessages("s1", [userItem("u1", "hello"), userItem("u2", "world")]);
      latest.appendMessages("s2", [userItem("x1", "other")]);
      latest.appendMessages("s1", [userItem("u3", "again")]);
    });
    expect(latest.messagesBySession.s1.map((item) => item.id)).toEqual(["u1", "u2", "u3"]);
    expect(latest.messagesBySession.s2.map((item) => item.id)).toEqual(["x1"]);
    act(() => {
      latest.replaceSessionMessages("s1", [userItem("r1", "fresh")]);
    });
    expect(latest.messagesBySession.s1.map((item) => item.id)).toEqual(["r1"]);
    expect(latest.messagesBySession.s2.map((item) => item.id)).toEqual(["x1"]);
  });

  it("patchMessage 按会话 id 直接路由，只补丁目标消息", () => {
    act(() => {
      latest.appendMessages("s1", [userItem("u1", "hello"), userItem("u2", "world")]);
      latest.appendMessages("s2", [userItem("u1", "mirror-id")]);
    });
    act(() => {
      latest.patchMessage("s1", "u2", { content: "patched" });
    });
    expect(latest.messagesBySession.s1[1].content).toBe("patched");
    // 会话 id 路由优先：即使 s2 有同 id 消息也不受影响
    expect(latest.messagesBySession.s2[0].content).toBe("mirror-id");
    expect(latest.messagesBySession.s1[0].content).toBe("hello");
  });

  it("patchMessage 按模式路由：跨会话按消息 id 找归属", () => {
    activeSessionByMode = { chat: "s1" };
    act(() => {
      latest.appendMessages("s2", [userItem("u2", "world")]);
    });
    act(() => {
      latest.patchMessage("chat", "u2", { content: "found-by-id" });
    });
    expect(latest.messagesBySession.s2[0].content).toBe("found-by-id");
  });

  it("patchMessage 按模式路由：id 无归属时回退该模式激活会话", () => {
    activeSessionByMode = { chat: "s1" };
    act(() => {
      latest.appendMessages("s1", [userItem("u1", "hello")]);
    });
    act(() => {
      latest.patchMessage("chat", "missing-id", { content: "noop" });
    });
    // 回退会话存在但 id 不匹配：内容不变
    expect(latest.messagesBySession.s1[0].content).toBe("hello");
  });

  it("patchMessage 无归属会话时安全无操作", () => {
    activeSessionByMode = {};
    act(() => {
      latest.appendMessages("s1", [userItem("u1", "hello")]);
      latest.patchMessage("chat", "missing-id", { content: "noop" });
      latest.patchMessage("s-none", "u1", { content: "noop" });
    });
    expect(latest.messagesBySession.s1[0].content).toBe("hello");
    // 未知会话 id 路由会留下空列表（与迁移前 patchSessionMessage 行为一致，渲染上无差别）
    expect(latest.messagesBySession["s-none"]).toEqual([]);
  });

  it("hydrateMessages：有活跃 run 且已有渲染态时保留，否则灌入存储态", () => {
    act(() => {
      latest.appendMessages("s1", [userItem("u1", "live-streaming")]);
    });
    act(() => {
      latest.hydrateMessages("s1", [userItem("u1", "stored")], true);
    });
    expect(latest.messagesBySession.s1[0].content).toBe("live-streaming");
    act(() => {
      latest.hydrateMessages("s1", [userItem("u1", "stored")], false);
    });
    expect(latest.messagesBySession.s1[0].content).toBe("stored");
    // 无渲染态时即使有活跃 run 也灌入（首次加载）
    act(() => {
      latest.hydrateMessages("s2", [userItem("v1", "first-load")], true);
    });
    expect(latest.messagesBySession.s2[0].content).toBe("first-load");
  });

  it("patchMessageAttachments 只改目标消息的附件，从现有数组起步", () => {
    act(() => {
      latest.appendMessages("s1", [
        userItem("u1", "hi"),
        { id: "a1", role: "assistant", content: "" },
      ]);
    });
    act(() => {
      latest.patchMessageAttachments("s1", "a1", (current) => [
        ...current,
        { kind: "image", name: "shot.png", status: "processing" },
      ]);
    });
    expect(latest.messagesBySession.s1[1].attachments?.map((a) => a.name)).toEqual(["shot.png"]);
    expect(latest.messagesBySession.s1[0].attachments).toBeUndefined();
    act(() => {
      latest.patchMessageAttachments("s1", "a1", (current) => [
        ...current,
        { kind: "document", name: "doc.txt" },
      ]);
    });
    expect(latest.messagesBySession.s1[1].attachments?.map((a) => a.name)).toEqual(["shot.png", "doc.txt"]);
  });
});