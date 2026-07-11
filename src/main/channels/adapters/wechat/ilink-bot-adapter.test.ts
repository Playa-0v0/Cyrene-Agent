import { describe, expect, it, vi } from "vitest";
import { ILinkBotAdapter } from "./ilink-bot-adapter";
import type { OutgoingMessage } from "../../types";

vi.mock("electron", () => ({
  app: {
    getPath: () => "C:/tmp/cyrene-test-user-data",
  },
}));

function message(parts: OutgoingMessage["parts"]): OutgoingMessage {
  return {
    channel: "wechat",
    targetId: "wx-user-1",
    parts,
  };
}

describe("ILinkBotAdapter.send", () => {
  it("sends text replies through the protocol client with the cached context token", async () => {
    const adapter = new ILinkBotAdapter();
    const sendText = vi.fn(async () => ({ ok: true }));
    (adapter as any).client = { sendText };
    (adapter as any).replyContextByTarget.set("wx-user-1", "ctx-1");

    const result = await adapter.send(message([{ kind: "text", text: "你好" }]));

    expect(result).toEqual({ ok: true });
    expect(sendText).toHaveBeenCalledWith("wx-user-1", "你好", "ctx-1");
  });

  it("uploads image and sticker parts as image items in one sendmessage payload", async () => {
    const adapter = new ILinkBotAdapter();
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const uploadMedia = vi.fn(async (_client, _userId, filePath: string) => ({
      encrypt_query_param: `encrypted:${filePath}`,
      aes_key: "encoded-key",
      encrypt_type: 1,
    }));
    (adapter as any).client = { sendMessage };
    (adapter as any).uploadMedia = uploadMedia;
    (adapter as any).replyContextByTarget.set("wx-user-1", "ctx-1");

    const result = await adapter.send(message([
      { kind: "text", text: "看图" },
      { kind: "image", filePath: "C:/tmp/pic.png", caption: "图片" },
      { kind: "sticker", stickerId: "happy", imagePath: "C:/tmp/sticker.png" },
    ]));

    expect(result).toEqual({ ok: true });
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    expect(uploadMedia).toHaveBeenNthCalledWith(1, expect.anything(), "wx-user-1", "C:/tmp/pic.png", 1);
    expect(uploadMedia).toHaveBeenNthCalledWith(2, expect.anything(), "wx-user-1", "C:/tmp/sticker.png", 1);
    expect(sendMessage).toHaveBeenCalledWith("wx-user-1", [
      { type: 1, text_item: { text: "看图" } },
      {
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: "encrypted:C:/tmp/pic.png",
            aes_key: "encoded-key",
            encrypt_type: 1,
          },
        },
      },
      {
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: "encrypted:C:/tmp/sticker.png",
            aes_key: "encoded-key",
            encrypt_type: 1,
          },
        },
      },
    ], "ctx-1");
  });

  it("uploads file and video parts as file and video items", async () => {
    const adapter = new ILinkBotAdapter();
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const uploadMedia = vi.fn(async (_client, _userId, filePath: string) => ({
      encrypt_query_param: `encrypted:${filePath}`,
      aes_key: "encoded-key",
      encrypt_type: 1,
    }));
    (adapter as any).client = { sendMessage };
    (adapter as any).uploadMedia = uploadMedia;
    (adapter as any).replyContextByTarget.set("wx-user-1", "ctx-1");

    const result = await adapter.send(message([
      { kind: "file", filePath: "C:/tmp/report.pdf", name: "report.pdf", mime: "application/pdf" },
      { kind: "video", filePath: "C:/tmp/demo.mp4", name: "demo.mp4", mime: "video/mp4" },
    ]));

    expect(result).toEqual({ ok: true });
    expect(uploadMedia).toHaveBeenNthCalledWith(1, expect.anything(), "wx-user-1", "C:/tmp/report.pdf", 3);
    expect(uploadMedia).toHaveBeenNthCalledWith(2, expect.anything(), "wx-user-1", "C:/tmp/demo.mp4", 2);
    expect(sendMessage).toHaveBeenCalledWith("wx-user-1", [
      {
        type: 4,
        file_item: {
          file_name: "report.pdf",
          media: {
            encrypt_query_param: "encrypted:C:/tmp/report.pdf",
            aes_key: "encoded-key",
            encrypt_type: 1,
          },
        },
      },
      {
        type: 5,
        video_item: {
          media: {
            encrypt_query_param: "encrypted:C:/tmp/demo.mp4",
            aes_key: "encoded-key",
            encrypt_type: 1,
          },
        },
      },
    ], "ctx-1");
  });
});
