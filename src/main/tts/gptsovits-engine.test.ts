import { describe, it, expect } from "vitest";
import { synthesize } from "./gptsovits-engine";

describe("gptsovits-engine synthesize 输入校验", () => {
  it("缺 baseUrl 时抛错", async () => {
    await expect(synthesize({
      baseUrl: "",
      refAudioPath: "C:/x.wav",
      promptText: "hi",
      text: "hello",
    })).rejects.toThrow(/API 地址/);
  });

  it("缺 refAudioPath 时抛错", async () => {
    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath: "",
      promptText: "hi",
      text: "hello",
    })).rejects.toThrow(/参考音频/);
  });

  it("缺 promptText 时抛错", async () => {
    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath: "C:/nonexistent.wav",
      promptText: "",
      text: "hello",
    })).rejects.toThrow(/参考音频.*文本|参考文本/);
  });

  it("缺 text 时抛错", async () => {
    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath: "C:/nonexistent.wav",
      promptText: "hi",
      text: "",
    })).rejects.toThrow(/合成文本|text/);
  });
});
