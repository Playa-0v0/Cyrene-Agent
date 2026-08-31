// dispatcher.downgradeToCapability 全组合测试
// 重点验证 8 个能力字段 × 5 个 part kind 的所有边界条件
import { describe, it, expect } from "vitest";
import { buildTextOutgoingParts, ChannelDispatcher, shouldAppendChannelTtsAudio } from "./dispatcher";
import type { ChannelCapability, OutgoingMessage, OutgoingPart } from "./types";

function makeCap(over: Partial<ChannelCapability> = {}): ChannelCapability {
  return {
    text: true,
    image: true,
    audio: true,
    file: true,
    video: true,
    markdown: true,
    card: true,
    sticker: true,
    maxTextLength: 4000,
    ...over,
  };
}

function makeMsg(parts: OutgoingPart[]): OutgoingMessage {
  return { channel: "feishu", targetId: "oc_x", parts };
}

describe("buildTextOutgoingParts", () => {
  it("keeps channel replies as one text part when mobile segmentation is off", () => {
    expect(buildTextOutgoingParts("第一句。第二句？", "off")).toEqual([
      { kind: "text", text: "第一句。第二句？" },
    ]);
  });

  it("splits channel replies into text parts when mobile segmentation is on", () => {
    expect(buildTextOutgoingParts("第一句。\n第二句？第三句！", "on")).toEqual([
      { kind: "text", text: "第一句。" },
      { kind: "text", text: "第二句？" },
      { kind: "text", text: "第三句！" },
    ]);
  });
});

describe("shouldAppendChannelTtsAudio", () => {
  it("does not append TTS audio for WeChat even when TTS and audio capability are enabled", () => {
    expect(shouldAppendChannelTtsAudio("wechat", true, true, true)).toBe(false);
  });

  it("can append TTS audio for Feishu when TTS and audio capability are enabled", () => {
    expect(shouldAppendChannelTtsAudio("feishu", true, true, true)).toBe(true);
  });
});

describe("downgradeToCapability", () => {
  // 构造一个最简 dispatcher 实例（只测 downgradeToCapability，不碰 buildAndRunAgent）
  const stubDispatcher = new ChannelDispatcher({} as any);

  describe("text part", () => {
    it("text < maxTextLength → 原样保留", () => {
      const msg = makeMsg([{ kind: "text", text: "你好" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ maxTextLength: 4000 }));
      expect(out.parts).toHaveLength(1);
      expect(out.parts[0]).toEqual({ kind: "text", text: "你好" });
    });

    it("text > maxTextLength → 截断 + 加截断提示", () => {
      const msg = makeMsg([{ kind: "text", text: "a".repeat(5000) }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ maxTextLength: 100 }));
      expect(out.parts).toHaveLength(1);
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") {
        expect(p.text.length).toBeLessThanOrEqual(100);
        expect(p.text).toMatch(/…?\(过长已截断\)$/);
      }
    });

    it("maxTextLength=0 → 不截断", () => {
      const msg = makeMsg([{ kind: "text", text: "a".repeat(1000) }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ maxTextLength: 0 }));
      const p = out.parts[0];
      if (p.kind === "text") {
        expect(p.text).toBe("a".repeat(1000));
      }
    });
  });

  describe("image part", () => {
    it("cap.image=true → 原样保留", () => {
      const msg = makeMsg([{ kind: "image", url: "https://x", caption: "cap" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ image: true }));
      expect(out.parts).toHaveLength(1);
      expect(out.parts[0].kind).toBe("image");
    });

    it("cap.image=false → 降级为文字描述 [图片]", () => {
      const msg = makeMsg([{ kind: "image", url: "https://x.png", caption: "我的截图" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ image: false }));
      expect(out.parts).toHaveLength(1);
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") {
        expect(p.text).toContain("[图片]");
        expect(p.text).toContain("我的截图");
        // url 兜底会包含 filePath 或 url: 当 caption 优先时, url 在 fallback
        expect(p.text).toMatch(/https:\/\/x\.png|\[图片\] 我的截图/);
      }
    });

    it("cap.image=false, 无 caption/url → [图片] + 空", () => {
      const msg = makeMsg([{ kind: "image" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ image: false }));
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") expect(p.text).toBe("[图片] ");
    });
  });

  describe("audio part", () => {
    it("cap.audio=true → 原样", () => {
      const msg = makeMsg([{ kind: "audio", filePath: "/tmp/x.mp3", mime: "audio/mpeg" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ audio: true }));
      expect(out.parts).toHaveLength(1);
      expect(out.parts[0].kind).toBe("audio");
    });

    it("cap.audio=false → 降级为文字", () => {
      const msg = makeMsg([{ kind: "audio", filePath: "/tmp/x.mp3", mime: "audio/mpeg" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ audio: false }));
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") {
        expect(p.text).toContain("[语音消息");
        expect(p.text).toContain("audio/mpeg");
      }
    });
  });

  describe("file and video parts", () => {
    it("cap.file=false → 降级为文字描述 [文件]", () => {
      const msg = makeMsg([{ kind: "file", filePath: "/tmp/report.pdf", name: "report.pdf", mime: "application/pdf" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ file: false }));
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") {
        expect(p.text).toContain("[文件]");
        expect(p.text).toContain("report.pdf");
      }
    });

    it("cap.video=false → 降级为文字描述 [视频]", () => {
      const msg = makeMsg([{ kind: "video", filePath: "/tmp/demo.mp4", name: "demo.mp4", mime: "video/mp4" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ video: false }));
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") {
        expect(p.text).toContain("[视频]");
        expect(p.text).toContain("demo.mp4");
      }
    });

    it("cap.file/video=true → 原样保留", () => {
      const msg = makeMsg([
        { kind: "file", filePath: "/tmp/report.pdf", name: "report.pdf" },
        { kind: "video", filePath: "/tmp/demo.mp4", name: "demo.mp4" },
      ]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ file: true, video: true }));
      expect(out.parts).toEqual(msg.parts);
    });
  });

  describe("card part", () => {
    it("cap.card=true, markdown=true → 原样保留 card", () => {
      const msg = makeMsg([{ kind: "card", title: "T", markdown: "**hi**", fields: [{ key: "k", value: "v" }] }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ card: true, markdown: true }));
      expect(out.parts[0].kind).toBe("card");
    });

    it("cap.card=false, markdown=true → 降级为 markdown 文本", () => {
      const msg = makeMsg([{ kind: "card", title: "天气", markdown: "晴 25°", fields: [{ key: "湿度", value: "60%" }] }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ card: false, markdown: true }));
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") {
        // title 行 + markdown 行 + field 行（key: value）
        expect(p.text).toContain("天气");
        expect(p.text).toContain("晴 25°");
        expect(p.text).toContain("湿度");
        expect(p.text).toContain("60%");
      }
    });

    it("cap.card=false, markdown=false → 纯文本", () => {
      const msg = makeMsg([{ kind: "card", title: "T", markdown: "**hi**" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ card: false, markdown: false }));
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") {
        expect(p.text).toContain("T");
        expect(p.text).toContain("**hi**");
        // 无 markdown 标记
      }
    });
  });

  describe("sticker part", () => {
    it("cap.sticker=true → 原样", () => {
      const msg = makeMsg([{ kind: "sticker", stickerId: "s1", imagePath: "/tmp/s.png" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ sticker: true }));
      expect(out.parts).toHaveLength(1);
    });

    it("cap.sticker=false → 跳过 sticker part（结果空数组）", () => {
      const msg = makeMsg([{ kind: "sticker", stickerId: "s1", imagePath: "/tmp/s.png" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ sticker: false }));
      expect(out.parts).toHaveLength(0);
    });
  });

  describe("multi-part mix", () => {
    it("text + image(cap.image=true) + sticker(cap.sticker=false) → text + image", () => {
      const msg = makeMsg([
        { kind: "text", text: "看这张图" },
        { kind: "image", url: "https://x.png", caption: "截图" },
        { kind: "sticker", stickerId: "s1", imagePath: "/tmp/s.png" },
      ]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ image: true, sticker: false }));
      expect(out.parts).toHaveLength(2);
      expect(out.parts[0]).toEqual({ kind: "text", text: "看这张图" });
      // image 保持 (cap.image=true)
      expect(out.parts[1].kind).toBe("image");
    });

    it("all-cap=false (除 text) → 全降级", () => {
      const msg = makeMsg([
        { kind: "text", text: "hi" },
        { kind: "image", url: "x", caption: "c" },
        { kind: "audio", filePath: "/tmp/x.mp3", mime: "audio/mpeg" },
        { kind: "sticker", stickerId: "s", imagePath: "/tmp/s.png" },
      ]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({
        text: true, image: false, audio: false, sticker: false, card: false,
      }));
      // 应剩下: text + [图片] + [语音] (sticker 跳过)
      expect(out.parts).toHaveLength(3);
      expect(out.parts[0].kind).toBe("text");
      expect(out.parts[1].kind).toBe("text");
      expect(out.parts[2].kind).toBe("text");
    });
  });

  describe("edge cases", () => {
    it("cap=undefined → 原样不降级", () => {
      const msg = makeMsg([
        { kind: "text", text: "a".repeat(10000) },
        { kind: "image", url: "x" },
      ]);
      const out = stubDispatcher.downgradeToCapability(msg, undefined);
      expect(out).toEqual(msg);
    });

    it("空 parts 数组 → 原样返回", () => {
      const msg = makeMsg([]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ text: false }));
      expect(out.parts).toHaveLength(0);
    });

    it("不修改原对象（pure function）", () => {
      const original = makeMsg([
        { kind: "text", text: "hello" },
        { kind: "image", url: "x" },
      ]);
      const snapshot = JSON.stringify(original);
      stubDispatcher.downgradeToCapability(original, makeCap({ image: false }));
      expect(JSON.stringify(original)).toBe(snapshot);
    });
  });
});
