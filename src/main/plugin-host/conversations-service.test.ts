import { describe, expect, it } from "vitest";
import { isPluginHostError } from "../../plugins/api";
import type { ChatMessage, ChatSession, ChatSessionMeta } from "../../shared/chat-types";
import { createPluginConversationsService, type PluginChatsStoreReader } from "./conversations-service";

interface FixtureSession {
  id: string;
  title: string;
  mode: ChatSessionMeta["mode"];
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

function msg(id: string, role: "user" | "model", text: string, at: number): ChatMessage {
  return { id, role, content: text, at };
}

/** 可变的内存会话存储假件：messages 数组在测试中途可追加或替换。 */
function makeReader(sessions: FixtureSession[]): PluginChatsStoreReader & {
  find(id: string): FixtureSession | undefined;
} {
  return {
    listSessions: () => sessions
      .map(({ messages, ...meta }): ChatSessionMeta => ({
        ...meta,
        identityId: null,
        messageCount: messages.length,
        pinned: false,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    getSession: (id) => {
      const found = sessions.find((s) => s.id === id);
      if (!found) return null;
      const session: ChatSession = {
        id: found.id,
        title: found.title,
        identityId: null,
        messages: found.messages,
        createdAt: found.createdAt,
        updatedAt: found.updatedAt,
        schemaVersion: 1,
        mode: found.mode,
      };
      return session;
    },
    find: (id) => sessions.find((s) => s.id === id),
  };
}

function service(reader: PluginChatsStoreReader, signal?: AbortSignal) {
  return createPluginConversationsService({ reader, signal });
}

function expectHostError(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => { throw new Error(`期望抛出 ${code}`); },
    (err: unknown) => {
      expect(isPluginHostError(err)).toBe(true);
      expect((err as { code: string }).code).toBe(code);
    },
  );
}

describe("插件会话列表服务", () => {
  it("默认每页 20 条并按游标翻页", async () => {
    const sessions: FixtureSession[] = Array.from({ length: 25 }, (_, i) => ({
      id: `conv-${i}`,
      title: `会话 ${i}`,
      mode: "work",
      createdAt: 1000 + i,
      updatedAt: 2000 + i,
      messages: [],
    }));
    const svc = service(makeReader(sessions));
    const page1 = await svc.list();
    expect(page1.items).toHaveLength(20);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await svc.list({ cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(5);
    expect(page2.nextCursor).toBeUndefined();
    // 无并发编辑时两页不重不漏
    const ids = [...page1.items, ...page2.items].map((s) => s.id);
    expect(new Set(ids).size).toBe(25);
  });

  it("列表投影只含稳定字段，时间戳为 ISO 字符串", async () => {
    const sessions: FixtureSession[] = [{
      id: "conv-1",
      title: "示例",
      mode: "chat",
      createdAt: 1700000000000,
      updatedAt: 1700000100000,
      messages: [],
    }];
    const page = await service(makeReader(sessions)).list();
    expect(page.items[0]).toEqual({
      id: "conv-1",
      title: "示例",
      mode: "chat",
      createdAt: new Date(1700000000000).toISOString(),
      updatedAt: new Date(1700000100000).toISOString(),
    });
  });

  it("非法 limit 与非法游标返回 E_INVALID_ARGUMENT", async () => {
    const svc = service(makeReader([]));
    for (const limit of [0, -1, 101, 1.5]) {
      await expectHostError(svc.list({ limit }), "E_INVALID_ARGUMENT");
    }
    await expectHostError(svc.list({ cursor: "!!!not-base64-json!!!" }), "E_INVALID_ARGUMENT");
    // 消息游标不能用于列表
    const badCursor = Buffer.from(
      JSON.stringify({ v: 1, kind: "messages", conversationId: "x", lastIndex: 0 }),
      "utf8",
    ).toString("base64url");
    await expectHostError(svc.list({ cursor: badCursor }), "E_INVALID_ARGUMENT");
  });

  it("插件停止后返回 E_PLUGIN_STOPPING", async () => {
    const controller = new AbortController();
    const svc = service(makeReader([]), controller.signal);
    controller.abort();
    await expectHostError(svc.list(), "E_PLUGIN_STOPPING");
  });
});

describe("插件会话消息服务", () => {
  function fixture(): { reader: ReturnType<typeof makeReader>; svc: ReturnType<typeof service> } {
    const session: FixtureSession = {
      id: "conv-1",
      title: "示例",
      mode: "work",
      createdAt: 1,
      updatedAt: 2,
      messages: [
        msg("m1", "user", "你好", 1000),
        msg("m2", "model", "你好，有什么可以帮你？", 2000),
        msg("m3", "user", "继续", 3000),
        msg("m4", "model", "好的", 4000),
        msg("m5", "model", "补充说明", 5000),
      ],
    };
    const reader = makeReader([session]);
    return { reader, svc: service(reader) };
  }

  it("返回包含式边界内的消息，model 映射为 assistant，正序排列", async () => {
    const { svc } = fixture();
    const page = await svc.getMessages({
      conversationId: "conv-1",
      fromMessageId: "m2",
      throughMessageId: "m4",
    });
    expect(page.items.map((m) => m.id)).toEqual(["m2", "m3", "m4"]);
    expect(page.items.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(page.items[0]).toEqual({
      id: "m2",
      role: "assistant",
      text: "你好，有什么可以帮你？",
      at: new Date(2000).toISOString(),
    });
    expect(page.range).toEqual({ fromMessageId: "m2", throughMessageId: "m4" });
    expect(page.nextCursor).toBeUndefined();
  });

  it("分页时游标冻结边界，且不返回消息原文以外的内部字段", async () => {
    const { svc } = fixture();
    const page1 = await svc.getMessages({
      conversationId: "conv-1",
      fromMessageId: "m1",
      throughMessageId: "m5",
      limit: 2,
    });
    expect(page1.items.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await svc.getMessages({
      conversationId: "conv-1",
      cursor: page1.nextCursor,
      limit: 2,
    });
    expect(page2.items.map((m) => m.id)).toEqual(["m3", "m4"]);
    const page3 = await svc.getMessages({
      conversationId: "conv-1",
      cursor: page2.nextCursor,
    });
    expect(page3.items.map((m) => m.id)).toEqual(["m5"]);
    expect(page3.nextCursor).toBeUndefined();
    // 每页都回显同一组冻结边界
    expect(page2.range).toEqual({ fromMessageId: "m1", throughMessageId: "m5" });
    // 投影字段是白名单：只有 id/role/text/at
    for (const item of [...page1.items, ...page2.items, ...page3.items]) {
      expect(Object.keys(item).sort()).toEqual(["at", "id", "role", "text"]);
    }
  });

  it("冻结终点后的新增消息不会混入后续页", async () => {
    const { reader, svc } = fixture();
    const page1 = await svc.getMessages({
      conversationId: "conv-1",
      fromMessageId: "m1",
      throughMessageId: "m4",
      limit: 2,
    });
    // 第一页取得后，会话又产生了新一轮消息
    reader.find("conv-1")!.messages.push(msg("m6", "user", "新轮次", 6000), msg("m7", "model", "新回答", 7000));
    const page2 = await svc.getMessages({ conversationId: "conv-1", cursor: page1.nextCursor });
    expect(page2.items.map((m) => m.id)).toEqual(["m3", "m4"]);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("游标与显式边界同时提交时必须完全一致", async () => {
    const { svc } = fixture();
    const page1 = await svc.getMessages({
      conversationId: "conv-1",
      fromMessageId: "m1",
      throughMessageId: "m5",
      limit: 2,
    });
    // 一致的边界可以重复提交
    await svc.getMessages({
      conversationId: "conv-1",
      cursor: page1.nextCursor,
      fromMessageId: "m1",
      throughMessageId: "m5",
    });
    // 不一致则拒绝
    await expectHostError(svc.getMessages({
      conversationId: "conv-1",
      cursor: page1.nextCursor,
      fromMessageId: "m2",
    }), "E_INVALID_ARGUMENT");
    await expectHostError(svc.getMessages({
      conversationId: "conv-1",
      cursor: page1.nextCursor,
      throughMessageId: "m4",
    }), "E_INVALID_ARGUMENT");
  });

  it("边界消息被删除后翻页返回 E_NOT_FOUND，不悄悄扩到最新", async () => {
    const { reader, svc } = fixture();
    const page1 = await svc.getMessages({
      conversationId: "conv-1",
      fromMessageId: "m1",
      throughMessageId: "m5",
      limit: 2,
    });
    const session = reader.find("conv-1")!;
    session.messages = session.messages.filter((m) => m.id !== "m5");
    await expectHostError(svc.getMessages({ conversationId: "conv-1", cursor: page1.nextCursor }), "E_NOT_FOUND");
  });

  it("会话不存在、边界不存在、起点在终点之后均返回稳定错误", async () => {
    const { svc } = fixture();
    await expectHostError(svc.getMessages({ conversationId: "missing" }), "E_NOT_FOUND");
    await expectHostError(svc.getMessages({ conversationId: "conv-1", fromMessageId: "nope" }), "E_NOT_FOUND");
    await expectHostError(svc.getMessages({ conversationId: "conv-1", throughMessageId: "nope" }), "E_NOT_FOUND");
    await expectHostError(svc.getMessages({
      conversationId: "conv-1",
      fromMessageId: "m4",
      throughMessageId: "m1",
    }), "E_INVALID_ARGUMENT");
  });

  it("非法会话 id、非法 limit 和非法游标返回 E_INVALID_ARGUMENT", async () => {
    const { svc } = fixture();
    await expectHostError(svc.getMessages({ conversationId: "" }), "E_INVALID_ARGUMENT");
    for (const limit of [0, -1, 101, 2.5]) {
      await expectHostError(svc.getMessages({ conversationId: "conv-1", limit }), "E_INVALID_ARGUMENT");
    }
    await expectHostError(svc.getMessages({
      conversationId: "conv-1",
      cursor: "garbage!!!",
    }), "E_INVALID_ARGUMENT");
    // 列表游标不能用于消息分页
    const listCursor = Buffer.from(JSON.stringify({ v: 1, kind: "list", offset: 20 }), "utf8")
      .toString("base64url");
    await expectHostError(svc.getMessages({ conversationId: "conv-1", cursor: listCursor }), "E_INVALID_ARGUMENT");
  });

  it("游标换会话返回 E_INVALID_ARGUMENT", async () => {
    const reader = makeReader([{
      id: "conv-1",
      title: "a",
      mode: "work",
      createdAt: 1,
      updatedAt: 2,
      messages: [msg("m1", "user", "hi", 1), msg("m2", "model", "hello", 2)],
    }, {
      id: "conv-2",
      title: "b",
      mode: "work",
      createdAt: 1,
      updatedAt: 2,
      messages: [msg("x1", "user", "hi", 1)],
    }]);
    const svc = service(reader);
    const page1 = await svc.getMessages({ conversationId: "conv-1", limit: 1 });
    await expectHostError(svc.getMessages({ conversationId: "conv-2", cursor: page1.nextCursor }), "E_INVALID_ARGUMENT");
  });

  it("不带边界时从会话开头分页", async () => {
    const { svc } = fixture();
    const page1 = await svc.getMessages({ conversationId: "conv-1", limit: 3 });
    expect(page1.items.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(page1.range).toEqual({});
    const page2 = await svc.getMessages({ conversationId: "conv-1", cursor: page1.nextCursor });
    expect(page2.items.map((m) => m.id)).toEqual(["m4", "m5"]);
  });

  it("插件停止后返回 E_PLUGIN_STOPPING", async () => {
    const controller = new AbortController();
    const { reader } = fixture();
    const svc = service(reader, controller.signal);
    controller.abort();
    await expectHostError(svc.getMessages({ conversationId: "conv-1" }), "E_PLUGIN_STOPPING");
  });
});
