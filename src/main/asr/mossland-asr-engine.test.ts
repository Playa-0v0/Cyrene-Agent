import { afterEach, describe, expect, it, vi } from "vitest";
import { MosslandAsrStream, encodePcm16MonoWav } from "./mossland-asr-engine";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encodePcm16MonoWav", () => {
  it("writes a valid 16 kHz mono PCM WAV header around the captured samples", () => {
    const wav = encodePcm16MonoWav(Buffer.from([0x34, 0x12, 0x78, 0x56]));

    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(40);
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(4);
    expect([...wav.subarray(44)]).toEqual([0x34, 0x12, 0x78, 0x56]);
  });
});

describe("MosslandAsrStream", () => {
  it("uploads all captured frames as one WAV file and returns the transcript", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response(JSON.stringify({ text: "hello" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const finals: string[] = [];
    const stream = new MosslandAsrStream("moss-key", (text) => finals.push(text));
    await stream.start();
    stream.sendAudio(Buffer.from([0x34, 0x12]));
    stream.sendAudio(Buffer.from([0x78, 0x56]));

    await expect(stream.stop()).resolves.toBe("hello");
    expect(finals).toEqual(["hello"]);
    expect(requestUrl).toBe("https://api.mosi.cn/v1/audio/transcriptions");
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("Authorization")).toBe("Bearer moss-key");

    const body = requestInit?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("model")).toBe("moss-transcribe");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("speech.wav");
    expect((file as File).type).toBe("audio/wav");
    const uploaded = Buffer.from(await (file as File).arrayBuffer());
    expect([...uploaded.subarray(44)]).toEqual([0x34, 0x12, 0x78, 0x56]);
  });

  it("does not call the service when the turn contains no audio", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const stream = new MosslandAsrStream("moss-key", () => {});

    await expect(stream.stop()).resolves.toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces Mossland authentication errors with the shared friendly message", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      error: {
        message: "invalid api key",
        type: "authentication_error",
        param: null,
        code: "authentication_error",
      },
    }), { status: 401, headers: { "Content-Type": "application/json" } }));
    const stream = new MosslandAsrStream("bad-key", () => {});
    stream.sendAudio(Buffer.from([0, 0]));

    await expect(stream.stop()).rejects.toThrow(
      "Mossland 转写失败：API Key 无效，请检查 Authorization 头 (HTTP 401, code: authentication_error)",
    );
  });
});
