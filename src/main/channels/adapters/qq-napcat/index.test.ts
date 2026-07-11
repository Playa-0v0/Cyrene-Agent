import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "C:\\tmp\\cyrene-test",
    getName: () => "live2d-cyrene-test",
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}));

import {
  applyGroupTrigger,
  calculateSegmentDelay,
  normalizeOneBotPayload,
  RecentMessageIds,
  shouldProactivelyReply,
  splitQqText,
} from "./index";

describe("QqNapCatAdapter normalizeOneBotPayload", () => {
  it("keeps plain text messages", () => {
    expect(normalizeOneBotPayload("hello", undefined)).toEqual({ text: "hello" });
  });

  it("normalizes array text and at segments", () => {
    const normalized = normalizeOneBotPayload(
      [
        { type: "at", data: { qq: "12345" } },
        { type: "text", data: { text: " 你好" } },
      ],
      undefined,
    );
    expect(normalized.text).toBe("[CQ:at,qq=12345] 你好");
    expect(normalized.attachments).toBeUndefined();
  });

  it("extracts image attachments", () => {
    const normalized = normalizeOneBotPayload(
      [
        { type: "text", data: { text: "看图" } },
        { type: "image", data: { file: "abc.jpg", url: "http://127.0.0.1/image/abc.jpg" } },
      ],
      undefined,
    );
    expect(normalized.text).toContain("看图");
    expect(normalized.text).toContain("[图片:http://127.0.0.1/image/abc.jpg]");
    expect(normalized.attachments).toEqual([
      { kind: "image", url: "http://127.0.0.1/image/abc.jpg", caption: "abc.jpg" },
    ]);
  });

  it("extracts file, audio, and video attachments", () => {
    const normalized = normalizeOneBotPayload(
      [
        { type: "file", data: { file: "report.pdf", url: "http://127.0.0.1/file/report.pdf" } },
        { type: "record", data: { file: "voice.amr", url: "http://127.0.0.1/file/voice.amr" } },
        { type: "video", data: { file: "clip.mp4", url: "http://127.0.0.1/file/clip.mp4" } },
      ],
      undefined,
    );
    expect(normalized.attachments).toEqual([
      { kind: "file", url: "http://127.0.0.1/file/report.pdf", caption: "report.pdf" },
      { kind: "audio", url: "http://127.0.0.1/file/voice.amr", caption: "voice.amr" },
      { kind: "video", url: "http://127.0.0.1/file/clip.mp4", caption: "clip.mp4" },
    ]);
  });
});

describe("RecentMessageIds", () => {
  it("rejects duplicate OneBot message ids", () => {
    const recent = new RecentMessageIds();
    expect(recent.seen(123)).toBe(false);
    expect(recent.seen("123")).toBe(true);
  });

  it("evicts the oldest id when capacity is reached", () => {
    const recent = new RecentMessageIds(2);
    expect(recent.seen("a")).toBe(false);
    expect(recent.seen("b")).toBe(false);
    expect(recent.seen("c")).toBe(false);
    expect(recent.seen("a")).toBe(false);
  });

  it("does not deduplicate events without a message id", () => {
    const recent = new RecentMessageIds();
    expect(recent.seen(undefined)).toBe(false);
    expect(recent.seen(undefined)).toBe(false);
  });
});

describe("QQ group reply rules", () => {
  it("supports multiple case-insensitive keywords", () => {
    const config = { enabled: true, groupTriggerMode: "keyword" as const, groupKeywords: ["昔涟", "Cyrene"] };
    expect(applyGroupTrigger(config, "CYRENE 在吗", "10000")).toBe("CYRENE 在吗");
    expect(applyGroupTrigger(config, "大家好", "10000")).toBeNull();
  });

  it("honors proactive probability and cooldown", () => {
    const config = {
      enabled: true,
      proactiveGroupEnabled: true,
      proactiveGroupProbability: 0.2,
      proactiveGroupCooldownSeconds: 60,
    };
    expect(shouldProactivelyReply(config, 0, 120_000, () => 0.1)).toBe(true);
    expect(shouldProactivelyReply(config, 0, 120_000, () => 0.3)).toBe(false);
    expect(shouldProactivelyReply(config, 90_000, 120_000, () => 0.1)).toBe(false);
  });
});

describe("splitQqText", () => {
  it("splits long replies at sentence boundaries", () => {
    expect(splitQqText("第一句话。第二句话！第三句话？", 6, 4)).toEqual(["第一句话。", "第二句话！", "第三句话？"]);
  });

  it("splits short multi-sentence replies like human chat messages", () => {
    expect(splitQqText("好呀。马上来！", 180, 4)).toEqual(["好呀。", "马上来！"]);
  });

  it("keeps code blocks in one message", () => {
    const code = "```ts\nconst answer = 42;\n```";
    expect(splitQqText(code, 5, 4)).toEqual([code]);
  });

  it("keeps long explanatory replies intact", () => {
    const text = "第一部分说明。第二部分说明。第三部分说明。";
    expect(splitQqText(text, 180, 4, 10)).toEqual([text]);
  });

  it("keeps structured lists intact", () => {
    const list = "处理步骤：\n1. 打开设置\n2. 保存配置";
    expect(splitQqText(list, 180, 4, 200)).toEqual([list]);
  });
});

describe("calculateSegmentDelay", () => {
  it("uses message length for typing-like timing", () => {
    expect(calculateSegmentDelay(0, "length", 300, 900)).toBe(300);
    expect(calculateSegmentDelay(24, "length", 300, 900)).toBe(900);
    expect(calculateSegmentDelay(12, "length", 300, 900)).toBe(600);
  });

  it("supports AstrBot-style random intervals", () => {
    expect(calculateSegmentDelay(12, "random", 300, 900, () => 0.5)).toBe(600);
  });
});
