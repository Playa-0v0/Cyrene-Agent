import { describe, expect, it } from "vitest";
import { splitForEarlySpeech } from "./tts-segmentation";

describe("call TTS segmentation", () => {
  it("returns short replies as one segment", () => {
    expect(splitForEarlySpeech("好呀，我在這裡。")) .toEqual(["好呀，我在這裡。"]);
  });

  it("splits a long reply early at Chinese punctuation", () => {
    const chunks = splitForEarlySpeech("今天確實有一點冷，你出門時記得多穿一件外套。回家後也可以喝點熱飲。", 34);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe("今天確實有一點冷，你出門時記得多穿一件外套。回家後也可以喝點熱飲。");
    expect(Array.from(chunks[0]).length).toBeLessThanOrEqual(34);
  });

  it("removes standalone stage directions before creating speech segments", () => {
    expect(splitForEarlySpeech("（輕聲笑了笑）我一直都在這裡。"))
      .toEqual(["我一直都在這裡。"]);
  });
});
