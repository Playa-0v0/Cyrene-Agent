import { describe, expect, it } from "vitest";
import { compactPetReply, PET_CHAT_REPLY_MAX_CHARS } from "./pet-chat";

describe("compactPetReply", () => {
  it("keeps a short reply unchanged", () => {
    expect(compactPetReply("我在呀，今天想聊什麼？")).toBe("我在呀，今天想聊什麼？");
  });

  it("flattens line breaks into one paragraph", () => {
    expect(compactPetReply("第一句。\n\n第二句。")) .toBe("第一句。 第二句。");
  });

  it("prefers complete sentences under the bubble limit", () => {
    const input = "這是第一句，內容完整。這是第二句，也很完整。" + "這是會讓氣泡超框的額外內容。".repeat(8);
    const result = compactPetReply(input, 30);
    expect(result).toBe("這是第一句，內容完整。這是第二句，也很完整。");
  });

  it("hard-limits a single overlong sentence without splitting Unicode", () => {
    const result = compactPetReply("🌸".repeat(120));
    expect(Array.from(result)).toHaveLength(PET_CHAT_REPLY_MAX_CHARS);
    expect(result.endsWith("…")).toBe(true);
  });

  it("removes a leading stage direction", () => {
    expect(compactPetReply("（輕輕眨眼）我在這裡陪你。")) .toBe("我在這裡陪你。");
  });
});
