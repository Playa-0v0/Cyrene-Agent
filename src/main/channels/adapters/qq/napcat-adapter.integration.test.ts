import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { IncomingMessage, OutgoingMessage } from "../../types";

const mockedSettings = vi.hoisted(() => ({
  wechat: { enabled: false },
  feishu: { enabled: false },
  qq: {
    enabled: true,
    listenMode: "loopback" as const,
    port: 0,
    allowedPrivateUserIds: ["1000"],
    allowedGroupIds: ["2000", "2001"],
    groupRequireMention: true as const,
    groupReplyStyle: "reply-and-mention" as const,
    groupToolPolicy: "off" as const,
    groupMemoryPolicy: "shared-personal" as const,
  },
  inboundPort: 0,
  sharedSecret: "",
  rateLimitPerUser: 10,
  rateLimitPerChannel: 100,
  ttsEnabled: false,
  stickerEnabled: false,
  mirrorToDesktop: false,
  toolSandbox: "all" as const,
}));

vi.mock("electron", () => ({
  app: { getPath: () => process.env.TEMP ?? process.cwd() },
}));

vi.mock("../../settings-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../settings-store")>();
  return { ...actual, loadChannelsSettings: () => mockedSettings };
});

import { NapCatAdapter } from "./napcat-adapter";

const sockets: WebSocket[] = [];
const adapters: NapCatAdapter[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const adapter of adapters.splice(0)) await adapter.stop();
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fake NapCat flow");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("NapCatAdapter fake reverse WebSocket integration", () => {
  it("handshakes, filters events, deduplicates, and sends private/group replies", async () => {
    const adapter = new NapCatAdapter();
    adapters.push(adapter);
    await adapter.start();
    const url = String(adapter.getConnectionInfo().listenUrl);
    const socket = new WebSocket(url, { headers: { "X-Self-ID": "9000" } });
    sockets.push(socket);
    const actions: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];

    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString()) as { action: string; params: Record<string, unknown>; echo: string };
      actions.push(request);
      const data = request.action === "get_login_info"
        ? { user_id: "9000", nickname: "昔涟测试号" }
        : request.action === "get_version_info"
          ? { app_name: "NapCat", app_version: "4.8.115", protocol_version: "v11" }
          : request.action === "get_status"
            ? { online: true, good: true }
          : { message_id: `sent-${actions.length}` };
      socket.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: request.echo }));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await waitFor(() => adapter.getStatus().phase === "running");
    expect(adapter.getConnectionInfo()).toMatchObject({
      selfId: "9000",
      nickname: "昔涟测试号",
      appVersion: "4.8.115",
      supportsStream: true,
    });
    await expect(adapter.testConnection()).resolves.toMatchObject({
      ok: true,
      detail: { selfId: "9000", nickname: "昔涟测试号", appVersion: "4.8.115", supportsStream: true },
    });

    const incoming: IncomingMessage[] = [];
    adapter.onMessage = async (message) => {
      incoming.push(message);
      const outgoing: OutgoingMessage = {
        channel: "qq",
        chatType: message.chatType,
        targetId: message.chatId,
        replyContext: message.chatType === "group"
          ? { messageId: message.messageId!, mentionUserId: message.senderId }
          : undefined,
        parts: message.chatType === "group"
          ? [{ kind: "text", text: `收到：${message.text}` }, { kind: "text", text: "第二段" }]
          : [{ kind: "text", text: `收到：${message.text}` }],
      };
      await adapter.send(outgoing);
      return outgoing;
    };

    const groupEvent = {
      time: 1_700_000_000,
      self_id: "9000",
      post_type: "message",
      message_type: "group",
      message_id: "group-1",
      user_id: "1000",
      group_id: "2000",
      sender: { user_id: "1000", card: "群成员" },
      message: [
        { type: "at", data: { qq: "9000" } },
        { type: "text", data: { text: "你好" } },
      ],
    };
    socket.send(JSON.stringify(groupEvent));
    await waitFor(() => actions.filter((item) => item.action === "send_group_msg").length === 2);
    const groupSends = actions.filter((item) => item.action === "send_group_msg");
    const groupSend = groupSends[0];
    expect(groupSend.params.group_id).toBe("2000");
    expect(groupSend.params.message).toEqual([
      { type: "reply", data: { id: "group-1" } },
      { type: "at", data: { qq: "1000" } },
      { type: "text", data: { text: " " } },
      { type: "text", data: { text: "收到：你好" } },
    ]);
    expect(groupSends[1].params.message).toEqual([{ type: "text", data: { text: "第二段" } }]);

    socket.send(JSON.stringify(groupEvent));
    socket.send(JSON.stringify({ ...groupEvent, message_id: "group-no-at", message: [{ type: "text", data: { text: "不应回复" } }] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(actions.filter((item) => item.action === "send_group_msg")).toHaveLength(2);

    socket.send(JSON.stringify({
      ...groupEvent,
      message_type: "private",
      message_id: "private-1",
      group_id: undefined,
      message: [{ type: "text", data: { text: "私聊" } }],
    }));
    await waitFor(() => actions.some((item) => item.action === "send_private_msg"));
    expect(actions.find((item) => item.action === "send_private_msg")?.params).toMatchObject({
      user_id: "1000",
      message: [{ type: "text", data: { text: "收到：私聊" } }],
    });

    socket.send(JSON.stringify({
      ...groupEvent,
      message_type: "private",
      message_id: "private-denied",
      user_id: "1001",
      group_id: undefined,
      message: [{ type: "text", data: { text: "不在白名单" } }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(incoming).toHaveLength(2);

    const serialOrder: string[] = [];
    adapter.onMessage = async (message) => {
      serialOrder.push(`start:${message.messageId}`);
      if (message.messageId === "serial-1") await new Promise((resolve) => setTimeout(resolve, 20));
      serialOrder.push(`end:${message.messageId}`);
      return null;
    };
    socket.send(JSON.stringify({ ...groupEvent, message_id: "serial-1" }));
    socket.send(JSON.stringify({ ...groupEvent, message_id: "serial-2" }));
    await waitFor(() => serialOrder.length === 4);
    expect(serialOrder).toEqual(["start:serial-1", "end:serial-1", "start:serial-2", "end:serial-2"]);

    const parallelOrder: string[] = [];
    adapter.onMessage = async (message) => {
      parallelOrder.push(`start:${message.chatId}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      parallelOrder.push(`end:${message.chatId}`);
      return null;
    };
    socket.send(JSON.stringify({ ...groupEvent, message_id: "parallel-1", group_id: "2000" }));
    socket.send(JSON.stringify({ ...groupEvent, message_id: "parallel-2", group_id: "2001" }));
    await waitFor(() => parallelOrder.length === 4);
    expect(new Set(parallelOrder.slice(0, 2))).toEqual(new Set(["start:2000", "start:2001"]));

    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    let queueRuns = 0;
    adapter.onMessage = async () => {
      queueRuns++;
      if (queueRuns === 1) await queueGate;
      return null;
    };
    for (let index = 0; index < 21; index++) {
      socket.send(JSON.stringify({ ...groupEvent, message_id: `queued-${index}` }));
    }
    await waitFor(() => queueRuns === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseQueue();
    await waitFor(() => queueRuns === 20);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queueRuns).toBe(20);
  });
});
