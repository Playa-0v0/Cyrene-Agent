import { describe, expect, it } from "vitest";
import { decideReloadCurrentSession } from "./session-reload-policy";

describe("decideReloadCurrentSession", () => {
  it("proactive-chat 有新外部变更且非发送期间 -> reload", () => {
    expect(decideReloadCurrentSession({
      purpose: "proactive-chat", updatedAt: 200, seenAt: 100, sending: false,
    })).toBe("reload");
  });

  it("非 proactive-chat 会话 -> skip（普通会话不重载）", () => {
    expect(decideReloadCurrentSession({
      purpose: undefined, updatedAt: 200, seenAt: 100, sending: false,
    })).toBe("skip");
  });

  it("updatedAt 未增长 -> skip", () => {
    expect(decideReloadCurrentSession({
      purpose: "proactive-chat", updatedAt: 100, seenAt: 100, sending: false,
    })).toBe("skip");
  });

  it("updatedAt 回退 -> skip", () => {
    expect(decideReloadCurrentSession({
      purpose: "proactive-chat", updatedAt: 50, seenAt: 100, sending: false,
    })).toBe("skip");
  });

  // ── 竞态修复：发送期间外部变更要排队，不能立刻重载 ──
  // send() 先 push transient 思考消息、再 fire-and-forget saveSession()，期间若有
  // 外部变更立刻 loadSessionIntoUI（messages.length=0 + render）会清掉未持久化的
  // transient 消息，模型增量回来时 streamMsgId 找不到；发送结束时若最终 saveSession
  // 还没落盘就重载，还会把刚生成的回复冲掉。所以发送期间一律 defer。
  it("发送期间即使 proactive-chat 有新外部变更也 defer（排队）", () => {
    expect(decideReloadCurrentSession({
      purpose: "proactive-chat", updatedAt: 200, seenAt: 100, sending: true,
    })).toBe("defer");
  });

  it("发送期间非 proactive-chat 仍 skip（不排队无意义）", () => {
    expect(decideReloadCurrentSession({
      purpose: undefined, updatedAt: 200, seenAt: 100, sending: true,
    })).toBe("skip");
  });
});
