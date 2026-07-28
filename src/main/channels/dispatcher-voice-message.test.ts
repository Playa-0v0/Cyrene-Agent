import { describe, expect, it, vi } from "vitest";
import * as os from "node:os";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import { ChannelDispatcher } from "./dispatcher";
import type { ChannelCapability, IncomingMessage } from "./types";

const capability: ChannelCapability = {
  text: true,
  image: true,
  audio: true,
  file: true,
  video: true,
  markdown: true,
  card: true,
  sticker: true,
  maxTextLength: 2_000,
};

function voiceRequest(senderId: string, text = "能傳一段介紹妳自己的語音嗎"): IncomingMessage {
  return {
    channel: "discord",
    senderId,
    chatId: "text-channel",
    text,
    at: new Date(),
  };
}

describe("Discord 文字頻道語音回答", () => {
  it("把朗讀任務交給模型，TTS 成功後回音訊並保留貼圖", async () => {
    let agentInput = "";
    const dispatcher = new ChannelDispatcher({
      manager: { getAdapter: () => ({ capability }) } as any,
      buildAndRunAgent: async (msg) => {
        agentInput = msg.text;
        return {
          text: "你好呀，我是昔漣，很高興用聲音陪你聊天。",
          sticker: { id: "happy", imagePath: "/tmp/happy.png" },
        };
      },
      synthesizeTts: async () => ({ audio: Buffer.from("RIFF-audio"), format: "wav" }),
    });

    const outgoing = await dispatcher.handleIncoming(voiceRequest("voice-success"));

    expect(agentInput).toContain("自動合成並成功發送");
    expect(outgoing?.parts).toHaveLength(2);
    expect(outgoing?.parts[0]).toMatchObject({ kind: "audio", mime: "audio/wav" });
    expect(outgoing?.parts[1]).toEqual({ kind: "sticker", stickerId: "happy", imagePath: "/tmp/happy.png" });
    expect(outgoing?.parts.some((part) => part.kind === "text")).toBe(false);
  });

  it("TTS 沒有產生音訊時保留模型文字，避免靜默", async () => {
    const dispatcher = new ChannelDispatcher({
      manager: { getAdapter: () => ({ capability }) } as any,
      buildAndRunAgent: async () => "這次先用文字陪你。",
      synthesizeTts: async () => null,
    });

    const outgoing = await dispatcher.handleIncoming(voiceRequest("voice-fallback"));

    expect(outgoing?.parts).toEqual([{ kind: "text", text: "這次先用文字陪你。" }]);
  });

  it("「只說句」強制 TTS 逐字朗讀指定短句，並傳入標點語氣", async () => {
    let synthesizedText = "";
    let stylePrompt = "";
    const dispatcher = new ChannelDispatcher({
      manager: { getAdapter: () => ({ capability }) } as any,
      buildAndRunAgent: async () => "當然可以！鳴潮牛逼！希望你每天都開心！",
      synthesizeTts: async (text, context) => {
        synthesizedText = text;
        stylePrompt = context?.stylePrompt ?? "";
        return { audio: Buffer.from("RIFF-exact"), format: "wav" };
      },
    });

    const outgoing = await dispatcher.handleIncoming(voiceRequest("voice-exact", "能只說句鳴潮牛逼！嗎"));

    expect(synthesizedText).toBe("鳴潮牛逼！");
    expect(stylePrompt).toContain("興奮");
    expect(outgoing?.parts).toHaveLength(1);
    expect(outgoing?.parts[0]?.kind).toBe("audio");
  });

  it("語音附件合成期間不阻塞同時進來的一般聊天", async () => {
    let startSynthesis: (() => void) | undefined;
    let finishSynthesis: (() => void) | undefined;
    const synthesisStarted = new Promise<void>((resolve) => { startSynthesis = resolve; });
    const synthesisGate = new Promise<void>((resolve) => { finishSynthesis = resolve; });
    const dispatcher = new ChannelDispatcher({
      manager: { getAdapter: () => ({ capability }) } as any,
      buildAndRunAgent: async (msg) => msg.text.includes("自動合成並成功發送")
        ? "這是一段正在合成的語音。"
        : "一般聊天已經回覆。",
      synthesizeTts: async () => {
        startSynthesis?.();
        await synthesisGate;
        return { audio: Buffer.from("RIFF-concurrent"), format: "wav" };
      },
    });

    const voiceReply = dispatcher.handleIncoming(voiceRequest("voice-concurrent", "能傳一段晚安的語音嗎"));
    await synthesisStarted;

    const chatReply = await dispatcher.handleIncoming({
      channel: "discord",
      senderId: "voice-concurrent",
      chatId: "text-channel",
      text: "播歌的同時可以陪我聊天嗎？",
      at: new Date(),
    });

    expect(chatReply?.parts).toEqual([{ kind: "text", text: "一般聊天已經回覆。" }]);
    finishSynthesis?.();
    expect((await voiceReply)?.parts[0]?.kind).toBe("audio");
  });
});
