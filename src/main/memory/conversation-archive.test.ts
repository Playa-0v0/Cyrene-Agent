import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => state.userData } }));

import {
  appendConversationEntry,
  appendConversationTurn,
  getUnindexedConversationEntries,
  loadConversationArchive,
  markConversationEntriesIndexed,
  resetConversationArchiveCache,
  searchConversationArchive,
} from "./conversation-archive";

describe("conversation archive", () => {
  beforeEach(() => {
    state.userData = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-archive-"));
    resetConversationArchiveCache();
  });

  it("stores full verbatim text without truncation", () => {
    const exact = "昔漣請逐字記住：" + "星海".repeat(1000);
    appendConversationTurn({
      sessionId: "desktop-1",
      channel: "desktop",
      userText: exact,
      assistantText: "我記下了",
      turnId: "turn-1",
      at: 1_700_000_000_000,
    });

    const archive = loadConversationArchive();
    expect(archive).toHaveLength(2);
    expect(archive[0].content).toBe(exact);
    expect(archive[0].content.length).toBeGreaterThan(800);
  });

  it("deduplicates stable source ids and tracks RAG backlog", () => {
    const input = {
      id: "discord-message-1",
      sessionId: "channel:discord:owner",
      channel: "discord",
      role: "user" as const,
      content: "我最喜歡紫色鳶尾花",
      at: 1_700_000_000_000,
    };
    appendConversationEntry(input);
    appendConversationEntry(input);

    expect(loadConversationArchive()).toHaveLength(1);
    expect(getUnindexedConversationEntries()).toHaveLength(1);
    markConversationEntriesIndexed(["discord-message-1"]);
    expect(getUnindexedConversationEntries()).toHaveLength(0);
  });

  it("recalls exact wording across channels without an embedding provider", () => {
    appendConversationEntry({
      id: "call-1",
      sessionId: "call:desktop:1",
      channel: "call",
      role: "user",
      content: "下次旅行我想去冰島看極光",
      at: Date.now(),
    });
    appendConversationEntry({
      id: "discord-1",
      sessionId: "channel:discord:owner",
      channel: "discord",
      role: "user",
      content: "今天晚餐吃了牛肉麵",
      at: Date.now(),
    });

    const hits = searchConversationArchive("我之前說想去哪裡看極光", 5);
    expect(hits[0]?.content).toBe("下次旅行我想去冰島看極光");
    expect(hits[0]?.channel).toBe("call");
  });

  it("persists and recalls image descriptions as a distinct memory kind", () => {
    appendConversationEntry({
      id: "photo-1",
      sessionId: "desktop-photos",
      channel: "desktop",
      role: "assistant",
      kind: "image_memory",
      content: "【照片內容永久記憶】圖片裡有一隻戴紅色領巾的柴犬",
      at: Date.now(),
    });

    expect(loadConversationArchive()[0]?.kind).toBe("image_memory");
    expect(searchConversationArchive("紅色領巾柴犬", 5)[0]?.kind).toBe("image_memory");
  });
});
