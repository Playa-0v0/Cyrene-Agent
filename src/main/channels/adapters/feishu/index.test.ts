import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FeishuAdapter, transcodeAudioFileToFeishuOpus } from "./index";

const temporaryFiles: string[] = [];

afterEach(() => {
  for (const filePath of temporaryFiles.splice(0)) {
    fs.rmSync(filePath, { force: true });
  }
});

describe("FeishuAdapter outgoing media", () => {
  it("uploads a local sticker through the SDK image input", async () => {
    const send = vi.fn(async () => ({ messageId: "om_1" }));
    const adapter = new FeishuAdapter();
    (adapter as any).channel = { send };

    const result = await adapter.send({
      channel: "feishu",
      targetId: "oc_chat",
      parts: [{
        kind: "sticker",
        stickerId: "hello",
        imagePath: "C:/stickers/hello.jpg",
      }],
    });

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith("oc_chat", {
      image: { source: "C:/stickers/hello.jpg" },
    });
  });

  it("transcodes an audio file to Ogg Opus with mpv", async () => {
    const inputPath = path.join(os.tmpdir(), `cyrene-feishu-input-${Date.now()}.wav`);
    fs.writeFileSync(inputPath, Buffer.from("RIFF-test-audio"));
    temporaryFiles.push(inputPath);

    const calls: Array<{ executable: string; args: string[] }> = [];
    const outputPath = await transcodeAudioFileToFeishuOpus(inputPath, {
      resolveMpvBinary: () => "C:/Cyrene/mpv.exe",
      runMpv: async (executable: string, args: string[]) => {
        calls.push({ executable, args });
        const outputArg = args.find((arg) => arg.startsWith("--o="));
        if (!outputArg) throw new Error("missing output argument");
        fs.writeFileSync(outputArg.slice("--o=".length), Buffer.from("OggS-opus-audio"));
      },
    });
    temporaryFiles.push(outputPath);

    expect(fs.readFileSync(outputPath).subarray(0, 4).toString("ascii")).toBe("OggS");
    expect(path.extname(outputPath)).toBe(".opus");
    expect(calls).toEqual([{
      executable: "C:/Cyrene/mpv.exe",
      args: expect.arrayContaining([
        "--no-config",
        "--no-video",
        "--of=opus",
        "--oac=libopus",
        inputPath,
      ]),
    }]);
  });

  it("rejects and removes output when mpv does not produce Ogg Opus", async () => {
    const inputPath = path.join(os.tmpdir(), `cyrene-feishu-invalid-${Date.now()}.wav`);
    fs.writeFileSync(inputPath, Buffer.from("RIFF-test-audio"));
    temporaryFiles.push(inputPath);
    let generatedPath = "";

    await expect(transcodeAudioFileToFeishuOpus(inputPath, {
      resolveMpvBinary: () => "C:/Cyrene/mpv.exe",
      runMpv: async (_executable: string, args: string[]) => {
        const outputArg = args.find((arg) => arg.startsWith("--o="));
        if (!outputArg) throw new Error("missing output argument");
        generatedPath = outputArg.slice("--o=".length);
        fs.writeFileSync(generatedPath, Buffer.from("not-opus"));
      },
    })).rejects.toThrow("不是有效的 Ogg Opus 音频");

    expect(fs.existsSync(generatedPath)).toBe(false);
  });

  it("lets the SDK resolve duration from the converted Opus file", async () => {
    const opusPath = path.join(os.tmpdir(), `cyrene-feishu-${Date.now()}.opus`);
    fs.writeFileSync(opusPath, Buffer.from("OggS-opus-audio"));
    temporaryFiles.push(opusPath);
    const send = vi.fn(async () => ({ messageId: "om_audio" }));
    const adapter = new FeishuAdapter();
    (adapter as any).channel = { send };

    const result = await adapter.send({
      channel: "feishu",
      targetId: "oc_chat",
      parts: [{ kind: "audio", filePath: opusPath, mime: "audio/ogg" }],
    });

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith("oc_chat", {
      audio: { source: opusPath },
    });
  });
});
