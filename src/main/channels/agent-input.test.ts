import { describe, expect, it } from "vitest";
import { buildChannelAttachmentInputs } from "./agent-input";
import type { IncomingMessage } from "./types";

describe("buildChannelAttachmentInputs", () => {
  it("maps downloaded channel images to direct image attachments and files to context attachments", async () => {
    const msg: IncomingMessage = {
      channel: "wechat",
      senderId: "wx-user-1",
      chatId: "wx-user-1",
      text: "看看这些",
      attachments: [
        { kind: "image", filePath: "C:/cache/pic.png", mime: "image/png", caption: "微信图片" },
        { kind: "file", filePath: "C:/cache/report.pdf", mime: "application/pdf", caption: "report.pdf" },
      ],
      at: new Date(0),
    };

    await expect(buildChannelAttachmentInputs(msg, { imageMode: "direct" })).resolves.toEqual({
      attachments: [
        { name: "report.pdf", text: "用户通过微信发送了文件：C:/cache/report.pdf" },
      ],
      imageAttachments: [
        { name: "微信图片", filePath: "C:/cache/pic.png", mime: "image/png" },
      ],
    });
  });

  it("captions channel images instead of sending image_url blocks when direct image mode is disabled", async () => {
    const msg: IncomingMessage = {
      channel: "wechat",
      senderId: "wx-user-1",
      chatId: "wx-user-1",
      text: "看看这个",
      attachments: [
        { kind: "image", filePath: "C:/cache/pic.png", mime: "image/png", caption: "微信图片" },
      ],
      at: new Date(0),
    };

    await expect(buildChannelAttachmentInputs(msg, {
      imageMode: "caption",
      captionImage: async () => ({ ok: true, caption: "画面里是一张聊天截图" }),
    })).resolves.toEqual({
      attachments: [
        {
          name: "微信图片",
          text: "【图片视觉信息】\n用户通过微信发送了图片：微信图片\n画面里是一张聊天截图",
        },
      ],
      imageAttachments: undefined,
    });
  });
});
