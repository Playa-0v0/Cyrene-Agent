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

function voiceRequest(senderId: string): IncomingMessage {
  return {
    channel: "discord",
    senderId,
    chatId: "text-channel",
    text: "能傳一段介紹妳自己的語音嗎",
    at: new Date(),
  };
}

describe("Discord 文字頻道語音回答", () => {
  it("把朗讀任務交給模型，TTS 成功後只回音訊", async () => {
    let agentInput = "";
    const dispatcher = new ChannelDispatcher({
      manager: { getAdapter: () => ({ capability }) } as any,
      buildAndRunAgent: async (msg) => {
        agentInput = msg.text;
        return "你好呀，我是昔漣，很高興用聲音陪你聊天。";
      },
      synthesizeTts: async () => ({ audio: Buffer.from("RIFF-audio"), format: "wav" }),
    });

    const outgoing = await dispatcher.handleIncoming(voiceRequest("voice-success"));

    expect(agentInput).toContain("自動合成並成功發送");
    expect(outgoing?.parts).toHaveLength(1);
    expect(outgoing?.parts[0]).toMatchObject({ kind: "audio", mime: "audio/wav" });
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
});
