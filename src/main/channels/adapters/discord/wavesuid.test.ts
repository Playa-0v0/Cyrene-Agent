import { describe, expect, it } from "vitest";
import {
  isSensitiveWavesUidCommand,
  isLocalOnlyWavesUidCommand,
  isWavesUidLoginCommand,
  isWavesUidCommand,
  normalizeWavesUidCommand,
  parseWavesUidResponse,
} from "./wavesuid";

describe("WutheringWavesUID Discord bridge", () => {
  it("only captures explicit ww commands", () => {
    expect(isWavesUidCommand("ww幫助")).toBe(true);
    expect(isWavesUidCommand("ww 今汐面板")).toBe(true);
    expect(isWavesUidCommand("wwfx")).toBe(true);
    expect(isWavesUidCommand("我想聊聊鳴潮")).toBe(false);
    expect(normalizeWavesUidCommand("今汐面板")).toBe("ww今汐面板");
    expect(normalizeWavesUidCommand("ww幫助")).toBe("ww帮助");
    expect(normalizeWavesUidCommand("查詢體力")).toBe("ww查询体力");
    expect(normalizeWavesUidCommand("ww綁定710189324")).toBe("ww绑定710189324");
    expect(normalizeWavesUidCommand("ww上傳秧秧玄翎面板圖")).toBe("ww上传秧秧玄翎面板图");
    expect(normalizeWavesUidCommand("ww刪除全部秧秧玄翎面板圖")).toBe("ww删除全部秧秧玄翎面板图");
    expect(normalizeWavesUidCommand("ww練度")).toBe("ww练度统计");
    expect(normalizeWavesUidCommand("練度")).toBe("ww练度统计");
    expect(normalizeWavesUidCommand("")).toBe("ww帮助");
  });

  it("treats QQ-style wwfx as local screenshot analysis", () => {
    expect(normalizeWavesUidCommand("wwfx")).toBe("wwfx");
    expect(isLocalOnlyWavesUidCommand("wwfx")).toBe(true);
    expect(isLocalOnlyWavesUidCommand("ww分析")).toBe(true);
    expect(normalizeWavesUidCommand("ww卡片分析")).toBe("wwfx");
    expect(normalizeWavesUidCommand("ww面板分析")).toBe("wwfx");
    expect(normalizeWavesUidCommand("ww幫我辨識這張角色卡")).toBe("wwfx");
    expect(normalizeWavesUidCommand("ww幫我看這張照片")).toBe("wwfx");
    expect(isLocalOnlyWavesUidCommand("ww今汐面板")).toBe(false);
  });

  it("requires private messages for credentials", () => {
    expect(isSensitiveWavesUidCommand("ww登入")).toBe(true);
    expect(isSensitiveWavesUidCommand("ww添加token abc")).toBe(true);
    expect(isSensitiveWavesUidCommand("ww今汐面板")).toBe(false);
    expect(isWavesUidLoginCommand("ww登入")).toBe(true);
    expect(isWavesUidLoginCommand("ww 登录")).toBe(true);
    expect(isWavesUidLoginCommand("登入")).toBe(true);
    expect(isWavesUidLoginCommand("ww體力")).toBe(false);
  });

  it("parses text, base64 images, nodes, and button hints", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const reply = parseWavesUidResponse({
      status_code: 200,
      data: {
        content: [
          { type: "text", data: "查詢完成" },
          { type: "image", data: `base64://${png}` },
          { type: "node", data: [{ type: "text", data: "第二段" }] },
          { type: "buttons", data: [[{ text: "體力", data: "ww體力" }]] },
        ],
      },
    });
    expect(reply.text).toContain("查詢完成");
    expect(reply.text).toContain("第二段");
    expect(reply.text).toContain("體力：ww體力");
    expect(reply.attachments).toHaveLength(1);
    expect(reply.attachments[0].name).toBe("wavesuid-1.png");
  });

  it("returns a useful hint when GsCore has no matching command", () => {
    expect(parseWavesUidResponse({ status_code: -100, data: null }).text).toContain("ww幫助");
  });

  it("formats card analysis results for Discord", () => {
    const reply = parseWavesUidResponse({
      status_code: 200,
      data: {
        content: [{
          type: "text",
          data: "[鸣潮]uid:710189324的dc卡片数据提取成功！识别套装使用默认配置(影响伤害计算不影响声骸评分)\n可使用：\n【ww秧秧玄翎面板】查看您的角色面板\n【ww改秧秧玄翎套装<合鸣效果>】 (可使用如 ww改秧秧玄翎套装高天3不绝2 改为3+2套装) 修改声骸套装\n【ww改秧秧玄翎声骸】修改当前套装的首位声骸",
        }],
      },
    });

    expect(reply.text).toContain("✅ **鳴潮卡片分析完成**");
    expect(reply.text).toContain("**UID：** `710189324`");
    expect(reply.text).toContain("- `ww秧秧玄翎面板` — 查看角色面板");
    expect(reply.text).toContain("- `ww改秧秧玄翎套裝<合鳴效果>` — 修改聲骸套裝");
    expect(reply.text).not.toContain("[鳴潮]uid:");
  });
});
