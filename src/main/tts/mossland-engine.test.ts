import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMosslandCacheKey } from "./tts-cache";
import { cloneVoice, listVoices, streamSynthesize, synthesize } from "./mossland-engine";

describe("Mossland TTS current API contract", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the current flash model and only documented synchronous fields", async () => {
    fetchMock.mockResolvedValue(new Response(Buffer.from("ID3audio"), { status: 200 }));

    await synthesize({
      apiKey: "moss-key",
      voiceId: "voice-1",
      text: "你好",
      speed: 1.2,
      volume: 0.8,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.mosi.cn/v1/audio/speech");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer moss-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "moss-tts-1.5-flash",
      input: "你好",
      voice_id: "voice-1",
      response_format: "mp3",
      delivery_method: "audio",
    });
  });

  it("rejects pcm that the current synchronous playback path cannot decode", async () => {
    await expect(synthesize({
      apiKey: "moss-key",
      voiceId: "voice-1",
      text: "你好",
      format: "pcm",
    })).rejects.toThrow("当前客户端的同步播放链路不支持 pcm");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the documented voice-list cursor metadata", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: "list",
      data: [{ id: "voice-1", name: "昔涟", created_at: 1_710_000_000 }],
      has_more: true,
      next_cursor: "voice-cursor-2",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await listVoices({
      apiKey: "moss-key",
      limit: 150,
      after: "voice-cursor-1",
      status: "ready",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.mosi.cn/v1/audio/voices?limit=150&after=voice-cursor-1&status=ready",
    );
    expect(result).toEqual({
      voices: [{ id: "voice-1", name: "昔涟", createdAt: 1_710_000_000 }],
      hasMore: true,
      nextCursor: "voice-cursor-2",
    });
  });

  it("uses the documented Flash PCM SSE contract for streaming synthesis", async () => {
    const audio = Buffer.from("pcm-stream");
    fetchMock.mockResolvedValue(new Response([
      'data: {"type":"speech.created","format":"pcm","sample_rate":48000,"channels":1,"bit_depth":16}\n\n',
      `data: ${JSON.stringify({ type: "speech.audio.delta", audio: audio.toString("base64") })}\n\n`,
      'data: {"type":"speech.audio.done"}\n\n',
    ].join(""), { headers: { "Content-Type": "text/event-stream" } }));
    const onAudio = vi.fn();

    const result = await streamSynthesize({
      apiKey: "moss-key",
      voiceId: "voice-1",
      text: "欢迎使用",
      speed: 1.25,
      language: "zh",
      expectedDurationSec: 3,
      onAudio,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.mosi.cn/v1/audio/speech");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "moss-tts-1.5-flash",
      input: "欢迎使用",
      voice_id: "voice-1",
      language: "zh",
      speed: 1.25,
      expected_duration_sec: 3,
      stream: true,
      response_format: "pcm",
      stream_format: "sse",
    });
    expect(onAudio).toHaveBeenCalledWith(audio);
    expect(result).toMatchObject({ format: "pcm", sampleRate: 48_000 });
  });

  it("rejects non-Flash streaming models before making a request", async () => {
    await expect(streamSynthesize({
      apiKey: "moss-key",
      voiceId: "voice-1",
      text: "欢迎使用",
      model: "moss-tts-1.0-pro",
    })).rejects.toThrow("仅支持 moss-tts-1.5-flash");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps voice cloning on multipart audio_sample instead of the files endpoint", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-mossland-test-"));
    const samplePath = path.join(tempDir, "sample.wav");
    fs.writeFileSync(samplePath, Buffer.from("RIFFsample"));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: "voice-new",
      object: "audio.voice",
      name: "Cyrene",
      created_at: 1_710_000_001,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    try {
      const result = await cloneVoice({
        apiKey: "moss-key",
        filePath: samplePath,
        name: "Cyrene",
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.mosi.cn/v1/audio/voices");
      expect(new Headers(init?.headers).get("Content-Type")).toContain("multipart/form-data; boundary=");
      expect(Buffer.from(init?.body as ArrayBuffer).toString("utf8")).toContain('name="audio_sample"');
      expect(result).toMatchObject({ voiceId: "voice-new", name: "Cyrene" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the current model in cache identity", () => {
    const shared = { voiceId: "voice-1", text: "你好", format: "mp3" as const };
    expect(buildMosslandCacheKey(shared)).toBe(buildMosslandCacheKey({
      ...shared,
      model: "moss-tts-1.5-flash",
    }));
  });
});
