// channels/history-log 单元测试
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock electron
const HISTORY_TMP = path.join(os.tmpdir(), "cyrene-history-test");
fs.mkdirSync(HISTORY_TMP, { recursive: true });

vi.mock("electron", () => ({
  app: {
    getPath: () => HISTORY_TMP,
  },
}));

import { appendHistory, loadRecentHistory, migrateHistory } from "./history-log";

describe("channels/history-log", () => {
  beforeEach(() => {
    // 清理测试目录
    const dir = path.join(HISTORY_TMP, "channels", "history");
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  });

  it("loadRecentHistory: 不存在的 session → 空数组", () => {
    const r = loadRecentHistory("channel:feishu:notexist", 16);
    expect(r).toEqual([]);
  });

  it("appendHistory + loadRecentHistory round-trip", () => {
    const sid = "channel:feishu:abc123";
    appendHistory(sid, "user", "你好");
    appendHistory(sid, "assistant", "你好！有什么可以帮你的吗？");

    const history = loadRecentHistory(sid, 16);
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("你好");
    expect(history[1].role).toBe("assistant");
    expect(history[1].content).toBe("你好！有什么可以帮你的吗？");
  });

  it("loadRecentHistory: limit 截断 (只取最近 N 条)", () => {
    const sid = "channel:feishu:limit-test";
    for (let i = 0; i < 10; i++) {
      appendHistory(sid, "user", `问题${i}`);
      appendHistory(sid, "assistant", `回答${i}`);
    }
    // 20 条写入，只取最近 4 条
    const history = loadRecentHistory(sid, 4);
    expect(history).toHaveLength(4);
    // 按时间顺序: 最后 2 轮 = [问9, 答9, 问10...不, 索引 0-9]
    // 第 9 轮: user="问题9", assistant="回答9"
    expect(history[0].content).toBe("问题8");
    expect(history[1].content).toBe("回答8");
    expect(history[2].content).toBe("问题9");
    expect(history[3].content).toBe("回答9");
  });

  it("appendHistory: 空 sessionId 或空 content 不落盘", () => {
    appendHistory("", "user", "hello");
    appendHistory("channel:feishu:x", "user", "");
    const history = loadRecentHistory("channel:feishu:x", 16);
    expect(history).toEqual([]);
  });

  it("多 session 隔离: 不同 sessionId 文件不同", () => {
    appendHistory("channel:feishu:userA", "user", "A 说的话");
    appendHistory("channel:feishu:userB", "user", "B 说的话");

    const a = loadRecentHistory("channel:feishu:userA", 16);
    const b = loadRecentHistory("channel:feishu:userB", 16);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].content).toBe("A 说的话");
    expect(b[0].content).toBe("B 说的话");
  });

  it("文件超过 MAX_FILE_LINES 时自动截断 (不丢失最新)", () => {
    const sid = "channel:feishu:trunc";
    // 写 250 条 (> MAX_FILE_LINES 200)
    for (let i = 0; i < 250; i++) {
      appendHistory(sid, "user", `msg${i}`);
    }
    const history = loadRecentHistory(sid, 250);
    // 截断后最多 200 条
    expect(history.length).toBeLessThanOrEqual(200);
    // 最新一条应该是 msg249
    expect(history[history.length - 1].content).toBe("msg249");
    // 最老一条应该是 msg50 (250 - 200 = 50)
    expect(history[0].content).toBe("msg50");
  });

  describe("migrateHistory", () => {
    it("旧键(senderId)历史迁移到新键(chatId)，升级不丢上下文", () => {
      const legacy = "channel:feishu:legacyhash";
      const fresh = "channel:feishu:freshhash";
      appendHistory(legacy, "user", "旧会话消息");

      migrateHistory(legacy, fresh);

      const history = loadRecentHistory(fresh, 16);
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("旧会话消息");
      // 原文件保留作兜底
      expect(loadRecentHistory(legacy, 16)).toHaveLength(1);
    });

    it("幂等：新键已有文件时不覆盖", () => {
      const legacy = "channel:feishu:legacyhash2";
      const fresh = "channel:feishu:freshhash2";
      appendHistory(legacy, "user", "旧会话消息");
      appendHistory(fresh, "user", "新会话消息");

      migrateHistory(legacy, fresh);

      const history = loadRecentHistory(fresh, 16);
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("新会话消息");
    });

    it("旧键无文件时静默无操作", () => {
      migrateHistory("channel:feishu:never-exist", "channel:feishu:never-fresh");
      expect(loadRecentHistory("channel:feishu:never-fresh", 16)).toEqual([]);
    });

    it("同键或空键直接返回", () => {
      expect(() => migrateHistory("channel:feishu:same", "channel:feishu:same")).not.toThrow();
      expect(() => migrateHistory("", "channel:feishu:x")).not.toThrow();
    });
  });
});