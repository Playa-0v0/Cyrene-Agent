// channels/history-log 單元測試
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

import { appendHistory, loadRecentHistory } from "./history-log";

describe("channels/history-log", () => {
  beforeEach(() => {
    // 清理測試目錄
    const dir = path.join(HISTORY_TMP, "channels", "history");
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  });

  it("loadRecentHistory: 不存在的 session → 空數組", () => {
    const r = loadRecentHistory("channel:feishu:notexist", 16);
    expect(r).toEqual([]);
  });

  it("appendHistory + loadRecentHistory round-trip", () => {
    const sid = "channel:feishu:abc123";
    appendHistory(sid, "user", "你好");
    appendHistory(sid, "assistant", "你好！有什麼可以幫你的嗎？");

    const history = loadRecentHistory(sid, 16);
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("你好");
    expect(history[1].role).toBe("assistant");
    expect(history[1].content).toBe("你好！有什麼可以幫你的嗎？");
  });

  it("loadRecentHistory: limit 截斷 (只取最近 N 條)", () => {
    const sid = "channel:feishu:limit-test";
    for (let i = 0; i < 10; i++) {
      appendHistory(sid, "user", `問題${i}`);
      appendHistory(sid, "assistant", `回答${i}`);
    }
    // 20 條寫入，只取最近 4 條
    const history = loadRecentHistory(sid, 4);
    expect(history).toHaveLength(4);
    // 按時間順序: 最後 2 輪 = [問9, 答9, 問10...不, 索引 0-9]
    // 第 9 輪: user="問題9", assistant="回答9"
    expect(history[0].content).toBe("問題8");
    expect(history[1].content).toBe("回答8");
    expect(history[2].content).toBe("問題9");
    expect(history[3].content).toBe("回答9");
  });

  it("appendHistory: 空 sessionId 或空 content 不落盤", () => {
    appendHistory("", "user", "hello");
    appendHistory("channel:feishu:x", "user", "");
    const history = loadRecentHistory("channel:feishu:x", 16);
    expect(history).toEqual([]);
  });

  it("多 session 隔離: 不同 sessionId 文件不同", () => {
    appendHistory("channel:feishu:userA", "user", "A 說的話");
    appendHistory("channel:feishu:userB", "user", "B 說的話");

    const a = loadRecentHistory("channel:feishu:userA", 16);
    const b = loadRecentHistory("channel:feishu:userB", 16);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].content).toBe("A 說的話");
    expect(b[0].content).toBe("B 說的話");
  });

  it("文件超過 MAX_FILE_LINES 時自動截斷 (不丟失最新)", () => {
    const sid = "channel:feishu:trunc";
    // 寫 250 條 (> MAX_FILE_LINES 200)
    for (let i = 0; i < 250; i++) {
      appendHistory(sid, "user", `msg${i}`);
    }
    const history = loadRecentHistory(sid, 250);
    // 截斷後最多 200 條
    expect(history.length).toBeLessThanOrEqual(200);
    // 最新一條應該是 msg249
    expect(history[history.length - 1].content).toBe("msg249");
    // 最老一條應該是 msg50 (250 - 200 = 50)
    expect(history[0].content).toBe("msg50");
  });
});