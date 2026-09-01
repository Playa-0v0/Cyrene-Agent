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

  it("routes a local config to the local FunASR batch transcription", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      calls.push(String(url));
      const u = String(url);
      if (u.endsWith("/status")) {
        return new Response(JSON.stringify({ model_loaded: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ text: "本地识别" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const finals: string[] = [];
    const stream = createAsrStream(
      { engine: "local" },
      () => {},
      (text) => finals.push(text),
    );

    await stream.start();
    stream.sendAudio(Buffer.from([0, 0]));

    await expect(stream.stop()).resolves.toBe("本地识别");
    expect(finals).toEqual(["本地识别"]);
    expect(calls.some((u) => u.endsWith("/status"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/v1/audio/transcriptions"))).toBe(true);
  });
});
