// dispatcher.downgradeToCapability 全組合測試
// 重點驗證 8 個能力字段 × 5 個 part kind 的所有邊界條件
import { describe, it, expect } from "vitest";
import { ChannelDispatcher } from "./dispatcher";
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

describe("downgradeToCapability", () => {
  // 構造一個最簡 dispatcher 實例（只測 downgradeToCapability，不碰 buildAndRunAgent）
  const stubDispatcher = new ChannelDispatcher({} as any);

  describe("text part", () => {
    it("text < maxTextLength → 原樣保留", () => {
      const msg = makeMsg([{ kind: "text", text: "你好" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ maxTextLength: 4000 }));
      expect(out.parts).toHaveLength(1);
      expect(out.parts[0]).toEqual({ kind: "text", text: "你好" });
    });

    it("text > maxTextLength → 截斷 + 加截斷提示", () => {
      const msg = makeMsg([{ kind: "text", text: "a".repeat(5000) }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ maxTextLength: 100 }));
      expect(out.parts).toHaveLength(1);
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") {
        expect(p.text.length).toBeLessThanOrEqual(100);
        expect(p.text).toMatch(/…?\(過長已截斷\)$/);
      }
    });

    it("maxTextLength=0 → 不截斷", () => {
      const msg = makeMsg([{ kind: "text", text: "a".repeat(1000) }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ maxTextLength: 0 }));
      const p = out.parts[0];
      if (p.kind === "text") {
        expect(p.text).toBe("a".repeat(1000));
      }
    });
  });

  describe("image part", () => {
    it("cap.image=true → 原樣保留", () => {
      const msg = makeMsg([{ kind: "image", url: "https://x", caption: "cap" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ image: true }));
      expect(out.parts).toHaveLength(1);
      expect(out.parts[0].kind).toBe("image");
    });

    it("cap.image=false → 降級為文字描述 [圖片]", () => {
      const msg = makeMsg([{ kind: "image", url: "https://x.png", caption: "我的截圖" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ image: false }));
      expect(out.parts).toHaveLength(1);
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") {
        expect(p.text).toContain("[圖片]");
        expect(p.text).toContain("我的截圖");
        // url 兜底會包含 filePath 或 url: 當 caption 優先時, url 在 fallback
        expect(p.text).toMatch(/https:\/\/x\.png|\[圖片\] 我的截圖/);
      }
    });

    it("cap.image=false, 無 caption/url → [圖片] + 空", () => {
      const msg = makeMsg([{ kind: "image" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ image: false }));
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") expect(p.text).toBe("[圖片] ");
    });
  });

  describe("audio part", () => {
    it("cap.audio=true → 原樣", () => {
      const msg = makeMsg([{ kind: "audio", filePath: "/tmp/x.mp3", mime: "audio/mpeg" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ audio: true }));
      expect(out.parts).toHaveLength(1);
      expect(out.parts[0].kind).toBe("audio");
    });

    it("cap.audio=false → 降級為文字", () => {
      const msg = makeMsg([{ kind: "audio", filePath: "/tmp/x.mp3", mime: "audio/mpeg" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ audio: false }));
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") {
        expect(p.text).toContain("[語音消息");
        expect(p.text).toContain("audio/mpeg");
      }
    });
  });

  describe("card part", () => {
    it("cap.card=true, markdown=true → 原樣保留 card", () => {
      const msg = makeMsg([{ kind: "card", title: "T", markdown: "**hi**", fields: [{ key: "k", value: "v" }] }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ card: true, markdown: true }));
      expect(out.parts[0].kind).toBe("card");
    });

    it("cap.card=false, markdown=true → 降級為 markdown 文本", () => {
      const msg = makeMsg([{ kind: "card", title: "天氣", markdown: "晴 25°", fields: [{ key: "溼度", value: "60%" }] }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ card: false, markdown: true }));
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") {
        // title 行 + markdown 行 + field 行（key: value）
        expect(p.text).toContain("天氣");
        expect(p.text).toContain("晴 25°");
        expect(p.text).toContain("溼度");
        expect(p.text).toContain("60%");
      }
    });

    it("cap.card=false, markdown=false → 純文本", () => {
      const msg = makeMsg([{ kind: "card", title: "T", markdown: "**hi**" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ card: false, markdown: false }));
      const p = out.parts[0];
      expect(p.kind).toBe("text");
      if (p.kind === "text") {
        expect(p.text).toContain("T");
        expect(p.text).toContain("**hi**");
        // 無 markdown 標記
      }
    });
  });

  describe("sticker part", () => {
    it("cap.sticker=true → 原樣", () => {
      const msg = makeMsg([{ kind: "sticker", stickerId: "s1", imagePath: "/tmp/s.png" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ sticker: true }));
      expect(out.parts).toHaveLength(1);
    });

    it("cap.sticker=false → 跳過 sticker part（結果空數組）", () => {
      const msg = makeMsg([{ kind: "sticker", stickerId: "s1", imagePath: "/tmp/s.png" }]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ sticker: false }));
      expect(out.parts).toHaveLength(0);
    });
  });

  describe("multi-part mix", () => {
    it("text + image(cap.image=true) + sticker(cap.sticker=false) → text + image", () => {
      const msg = makeMsg([
        { kind: "text", text: "看這張圖" },
        { kind: "image", url: "https://x.png", caption: "截圖" },
        { kind: "sticker", stickerId: "s1", imagePath: "/tmp/s.png" },
      ]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ image: true, sticker: false }));
      expect(out.parts).toHaveLength(2);
      expect(out.parts[0]).toEqual({ kind: "text", text: "看這張圖" });
      // image 保持 (cap.image=true)
      expect(out.parts[1].kind).toBe("image");
    });

    it("all-cap=false (除 text) → 全降級", () => {
      const msg = makeMsg([
        { kind: "text", text: "hi" },
        { kind: "image", url: "x", caption: "c" },
        { kind: "audio", filePath: "/tmp/x.mp3", mime: "audio/mpeg" },
        { kind: "sticker", stickerId: "s", imagePath: "/tmp/s.png" },
      ]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({
        text: true, image: false, audio: false, sticker: false, card: false,
      }));
      // 應剩下: text + [圖片] + [語音] (sticker 跳過)
      expect(out.parts).toHaveLength(3);
      expect(out.parts[0].kind).toBe("text");
      expect(out.parts[1].kind).toBe("text");
      expect(out.parts[2].kind).toBe("text");
    });
  });

  describe("edge cases", () => {
    it("cap=undefined → 原樣不降級", () => {
      const msg = makeMsg([
        { kind: "text", text: "a".repeat(10000) },
        { kind: "image", url: "x" },
      ]);
      const out = stubDispatcher.downgradeToCapability(msg, undefined);
      expect(out).toEqual(msg);
    });

    it("空 parts 數組 → 原樣返回", () => {
      const msg = makeMsg([]);
      const out = stubDispatcher.downgradeToCapability(msg, makeCap({ text: false }));
      expect(out.parts).toHaveLength(0);
    });

    it("不修改原對象（pure function）", () => {
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