import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { synthesize } from "./mimo-engine";

afterEach(() => {
  vi.restoreAllMocks();
});

function writeTempVoiceFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-voice-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from(content));
  return filePath;
}

describe("mimo-engine synthesize", () => {
  it("rejects missing apiKey", async () => {
    await expect(synthesize({ apiKey: "", text: "hello" })).rejects.toThrow(/MiMo API Key/);
  });

  it("rejects missing text", async () => {
    await expect(synthesize({ apiKey: "k", text: "" })).rejects.toThrow(/合成文本/);
  });

  it("sends Xiaomi MiMo voiceclone payload with the selected Cyrene voice sample", async () => {
    const voiceAudioPath = writeTempVoiceFile("cyrene.mp3", "cyrene voice sample");
    const audio = Buffer.from("RIFFmimo");
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => Response.json({
      choices: [{
        message: {
          audio: {
            data: audio.toString("base64"),
          },
        },
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesize({
      apiKey: "mimo-key",
      text: "你好呀",
      voiceAudioPath,
      stylePrompt: "温柔、自然，像近距离聊天。",
    });

    expect(result.audio.equals(audio)).toBe(true);
    expect(result.format).toBe("wav");
    expect(fetchMock).toHaveBeenCalledWith("https://api.xiaomimimo.com/v1/chat/completions", expect.objectContaining({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": "mimo-key",
      },
    }));
    const request = fetchMock.mock.calls[0]?.[1];
    if (!request) throw new Error("missing fetch request init");
    expect(JSON.parse(String(request.body))).toEqual({
      model: "mimo-v2.5-tts-voiceclone",
      messages: [
        { role: "user", content: "温柔、自然，像近距离聊天。" },
        { role: "assistant", content: "你好呀" },
      ],
      audio: {
        format: "wav",
        voice: "data:audio/mpeg;base64,Y3lyZW5lIHZvaWNlIHNhbXBsZQ==",
      },
    });
  });

  it("rejects missing voice sample path", async () => {
    await expect(synthesize({ apiKey: "k", text: "hello", stylePrompt: "  " }))
      .rejects.toThrow(/克隆音频/);
  });

  it("omits empty style prompts", async () => {
    const voiceAudioPath = writeTempVoiceFile("cyrene.wav", "wav sample");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      choices: [{ message: { audio: { data: Buffer.from("RIFF").toString("base64") } } }],
    })));

    await synthesize({ apiKey: "k", text: "hello", voiceAudioPath, stylePrompt: "  " });

    const request = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    if (!request) throw new Error("missing fetch request init");
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: "mimo-v2.5-tts-voiceclone",
      messages: [{ role: "assistant", content: "hello" }],
      audio: { format: "wav", voice: "data:audio/wav;base64,d2F2IHNhbXBsZQ==" },
    });
  });
});
