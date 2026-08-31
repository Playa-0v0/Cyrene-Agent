import { describe, expect, it } from "vitest";
import {
  buildUnsupportedWechatFilePrompt,
  buildWechatSaveIntentPrompt,
  buildWechatVideoPrompt,
  describeInboundWechatMedia,
  getWechatDisplayName,
  isAnalyzableWechatFile,
  isWechatSaveIntent,
} from "./inbound-media";

describe("wechat inbound media classification", () => {
  it("only treats text-like and office files as analyzable", () => {
    expect(isAnalyzableWechatFile("report.pdf")).toBe(true);
    expect(isAnalyzableWechatFile("notes.md")).toBe(true);
    expect(isAnalyzableWechatFile("debug.log")).toBe(true);
    expect(isAnalyzableWechatFile("archive.zip")).toBe(false);
    expect(isAnalyzableWechatFile("setup.exe")).toBe(false);
    expect(isAnalyzableWechatFile("movie.mp4")).toBe(false);
  });

  it("describes file and video items without downloading them", () => {
    expect(describeInboundWechatMedia([
      { type: 4, file_item: { file_name: "report.pdf" } },
      { type: 5, video_item: { file_name: "clip.mp4" } },
    ])).toEqual([
      { kind: "file", fileName: "report.pdf", extension: ".pdf", analyzable: true },
      { kind: "video", fileName: "clip.mp4", extension: ".mp4", analyzable: false },
    ]);
  });

  it("recognizes save intent phrases", () => {
    expect(isWechatSaveIntent("保存到桌面")).toBe(true);
    expect(isWechatSaveIntent("帮我代收一下")).toBe(true);
    expect(isWechatSaveIntent("你好呀")).toBe(false);
  });

  it("uses partner when preferred name is blank", () => {
    expect(getWechatDisplayName("  ")).toBe("伙伴");
    expect(getWechatDisplayName("小王")).toBe("小王");
  });

  it("formats Cyrene-style prompts", () => {
    expect(buildUnsupportedWechatFilePrompt("伙伴")).toBe("伙伴，这个文件人家还分析不了呢。如果伙伴你是想让我帮你代收一下，请在 5 分钟内回复“保存到桌面”哦~~");
    expect(buildWechatVideoPrompt("小王")).toBe("小王，视频人家现在还看不了呢。如果小王你只是想让我帮你代收，请在 5 分钟内回复“保存到桌面”哦~~");
    expect(buildWechatSaveIntentPrompt("伙伴")).toBe("好呀，伙伴，尽管把文件发过来吧。我会帮你放到桌面的“Cyrene 收件箱”里哦~~");
  });
});
