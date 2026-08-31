import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsrStream } from "./asr-dispatcher";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAsrStream", () => {
  it("routes a Mossland config to batch transcription behavior", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ text: "微信语音" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const finals: string[] = [];
    const stream = createAsrStream(
      { engine: "mossland", apiKey: "moss-key" },
      () => {},
      (text) => finals.push(text),
    );

    await stream.start();
    stream.sendAudio(Buffer.from([0, 0]));

    await expect(stream.stop()).resolves.toBe("微信语音");
    expect(finals).toEqual(["微信语音"]);
  });
});
