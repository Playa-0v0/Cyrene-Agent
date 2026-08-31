import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesize } from "./custom-cloud-engine";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("custom-cloud-engine synthesize", () => {
  it("rejects missing endpointUrl", async () => {
    await expect(synthesize({ endpointUrl: "", text: "hello" })).rejects.toThrow(/自定义云端 TTS 地址/);
  });

  it("rejects missing text", async () => {
    await expect(synthesize({ endpointUrl: "https://tts.example.com", text: "" })).rejects.toThrow(/合成文本/);
  });

  it("parses binary audio responses", async () => {
    const audio = Buffer.from("ID3fake");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(audio, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    })));

    const result = await synthesize({
      endpointUrl: "https://tts.example.com",
      apiKey: "k",
      text: "hi",
      format: "mp3",
    });

    expect(result.audio.equals(audio)).toBe(true);
    expect(result.format).toBe("mp3");
  });

  it("sends voiceId in the standard request body", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(Buffer.from("ID3fake"), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await synthesize({
      endpointUrl: "https://tts.example.com",
      text: "hi",
      voiceId: "cyrene-voice",
      format: "mp3",
    });

    const request = fetchMock.mock.calls[0]?.[1];
    if (!request) throw new Error("missing fetch request init");
    expect(JSON.parse(String(request.body))).toMatchObject({
      text: "hi",
      voiceId: "cyrene-voice",
      format: "mp3",
    });
  });

  it("parses JSON base64 responses", async () => {
    const audio = Buffer.from("RIFFfake");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      audioBase64: audio.toString("base64"),
      format: "wav",
    })));

    const result = await synthesize({
      endpointUrl: "https://tts.example.com",
      text: "hi",
      format: "mp3",
    });

    expect(result.audio.equals(audio)).toBe(true);
    expect(result.format).toBe("wav");
  });

  it("reports HTTP errors with response preview", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 400 })));

    await expect(synthesize({
      endpointUrl: "https://tts.example.com",
      text: "hi",
    })).rejects.toThrow(/400 bad request/);
  });
});
