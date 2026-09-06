// moments-policy 单测：冷却 / 日上限 / run 粒度去重各分支。
// 契约：断言里不存在 unansweredCount / 夜间时段禁发类条件。
import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMomentsEventKey,
  canCharacterModelCall,
  canPost,
  defaultMomentsPolicyState,
  localDateKey,
  loadMomentsPolicyState,
  MAX_CHARACTER_MODEL_CALLS_PER_DAY,
  MAX_POSTS_PER_DAY,
  MIN_POST_INTERVAL_MS,
  recordCharacterModelCall,
  recordEventKey,
  recordPost,
  RECENT_EVENT_KEYS_CAPACITY,
  saveMomentsPolicyState,
} from "./moments-policy";

const electronMock = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => electronMock.userDataDir },
}));

const NOW = new Date("2026-09-04T19:00:00").getTime();

describe("canPost 规则闸门", () => {
  it("无历史状态时放行", () => {
    expect(canPost(defaultMomentsPolicyState(), NOW)).toEqual({ ok: true });
  });

  it("冷却期内拒绝（cooldown），冷却到期放行", () => {
    const state = { ...defaultMomentsPolicyState(), lastPostAt: NOW - MIN_POST_INTERVAL_MS + 60_000 };
    expect(canPost(state, NOW)).toEqual({ ok: false, reason: "cooldown" });

    const ready = { ...defaultMomentsPolicyState(), lastPostAt: NOW - MIN_POST_INTERVAL_MS };
    expect(canPost(ready, NOW)).toEqual({ ok: true });
  });

  it("当日达到上限拒绝（daily_limit），允许 0/1/2 条", () => {
    const date = localDateKey(NOW);
    // 已发 1 条：未到上限，放行
    expect(canPost({ ...defaultMomentsPolicyState(), postsToday: { date, count: 1 } }, NOW))
      .toEqual({ ok: true });
    // 已发满 2 条：拒绝
    expect(canPost({ ...defaultMomentsPolicyState(), postsToday: { date, count: MAX_POSTS_PER_DAY } }, NOW))
      .toEqual({ ok: false, reason: "daily_limit" });
  });

  it("昨日的计数不限制今天（按本地日期滚动）", () => {
    const yesterday = NOW - 24 * 60 * 60 * 1000;
    const state = {
      ...defaultMomentsPolicyState(),
      lastPostAt: yesterday - MIN_POST_INTERVAL_MS,
      postsToday: { date: localDateKey(yesterday), count: MAX_POSTS_PER_DAY },
    };
    expect(canPost(state, NOW)).toEqual({ ok: true });
  });
});

describe("buildMomentsEventKey 去重键（run 粒度）", () => {
  it("有 runId 时一键一 run：同 conversation 不同 runId 均有效", () => {
    const base = { conversationId: "chat-a", userText: "上午发包", assistantReply: "辛苦啦" };
    const key1 = buildMomentsEventKey({ ...base, runId: "run-1" });
    const key2 = buildMomentsEventKey({ ...base, runId: "run-2" });
    expect(key1).toBe("conversation_finished:run-1");
    expect(key2).toBe("conversation_finished:run-2");
    expect(key1).not.toBe(key2);
  });

  it("无 runId 时用内容哈希兜底：同内容同键，不同内容不同键", () => {
    const key1 = buildMomentsEventKey({ conversationId: "chat-a", userText: "晚上修 bug", assistantReply: "修好了" });
    const key2 = buildMomentsEventKey({ conversationId: "chat-a", userText: "晚上修 bug", assistantReply: "修好了" });
    const key3 = buildMomentsEventKey({ conversationId: "chat-a", userText: "晚上又修了个 bug", assistantReply: "也修好了" });
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1).toMatch(/^conversation_finished:[0-9a-f]{16}$/);
  });

  it("不同 conversation 的相同内容产生不同键", () => {
    const key1 = buildMomentsEventKey({ conversationId: "chat-a", userText: "x", assistantReply: "y" });
    const key2 = buildMomentsEventKey({ conversationId: "chat-b", userText: "x", assistantReply: "y" });
    expect(key1).not.toBe(key2);
  });
});

describe("状态记账", () => {
  it("recordEventKey 按容量 FIFO 淘汰最旧的键", () => {
    let state = defaultMomentsPolicyState();
    for (let i = 0; i < RECENT_EVENT_KEYS_CAPACITY + 5; i++) {
      state = recordEventKey(state, `key-${i}`);
    }
    expect(state.recentEventKeys).toHaveLength(RECENT_EVENT_KEYS_CAPACITY);
    expect(state.recentEventKeys[0]).toBe("key-5");
    expect(state.recentEventKeys.at(-1)).toBe(`key-${RECENT_EVENT_KEYS_CAPACITY + 4}`);
  });

  it("recordPost 刷新冷却起点并滚动当日计数", () => {
    let state = defaultMomentsPolicyState();
    state = recordPost(state, NOW);
    expect(state.lastPostAt).toBe(NOW);
    expect(state.postsToday).toEqual({ date: localDateKey(NOW), count: 1 });

    state = recordPost(state, NOW + 60_000);
    expect(state.postsToday.count).toBe(2);

    // 跨天后计数重置
    const tomorrow = NOW + 24 * 60 * 60 * 1000;
    state = recordPost(state, tomorrow);
    expect(state.postsToday).toEqual({ date: localDateKey(tomorrow), count: 1 });
  });
});

describe("角色模型调用预算", () => {
  it("未记账时放行；记账递增当日计数", () => {
    let state = defaultMomentsPolicyState();
    expect(canCharacterModelCall(state, NOW)).toBe(true);

    state = recordCharacterModelCall(state, NOW);
    expect(state.characterModelCalls).toEqual({ date: localDateKey(NOW), count: 1 });
    state = recordCharacterModelCall(state, NOW + 60_000);
    expect(state.characterModelCalls.count).toBe(2);
    expect(canCharacterModelCall(state, NOW + 60_000)).toBe(true);
  });

  it("到达日上限后拒绝，次日自动恢复", () => {
    const date = localDateKey(NOW);
    const exhausted = {
      ...defaultMomentsPolicyState(),
      characterModelCalls: { date, count: MAX_CHARACTER_MODEL_CALLS_PER_DAY },
    };
    expect(canCharacterModelCall(exhausted, NOW)).toBe(false);

    // 昨日记满不影响今天：日期滚动即恢复预算
    const yesterday = NOW - 24 * 60 * 60 * 1000;
    const staleDay = {
      ...defaultMomentsPolicyState(),
      characterModelCalls: { date: localDateKey(yesterday), count: MAX_CHARACTER_MODEL_CALLS_PER_DAY },
    };
    expect(canCharacterModelCall(staleDay, NOW)).toBe(true);

    // 跨天记账从 1 重新起算
    const rolled = recordCharacterModelCall(staleDay, NOW);
    expect(rolled.characterModelCalls).toEqual({ date, count: 1 });
  });
});

describe("moments-state.json 持久化", () => {
  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-moments-policy-"));
  });

  it("save 后 load 能还原；坏文件回退默认状态", () => {
    const state = recordPost(recordEventKey(defaultMomentsPolicyState(), "key-1"), NOW);
    saveMomentsPolicyState(state);
    expect(loadMomentsPolicyState()).toEqual(state);

    fs.writeFileSync(path.join(electronMock.userDataDir, "moments-state.json"), "not-json{", "utf8");
    expect(loadMomentsPolicyState()).toEqual(defaultMomentsPolicyState());
  });

  it("无文件时返回默认状态", () => {
    expect(loadMomentsPolicyState()).toEqual(defaultMomentsPolicyState());
  });
});