import { describe, expect, it } from "vitest";
import {
  buildCodexImageWorkerArgs,
  buildOnDemandCodexImagePrompt,
  shouldUseCyreneAnimeStyleReference,
} from "./codex-image-worker";

describe("on-demand Codex image worker", () => {
  it("targets exactly one owner-bound Discord job", () => {
    const id = "e63c3ea6-dda6-4cc7-acf9-c2416a26db9f";
    const prompt = buildOnDemandCodexImagePrompt(id, "/tmp/cyrene-bridge");
    expect(prompt).toContain(`/tmp/cyrene-bridge/pending/${id}.json`);
    expect(prompt).toContain("不要掃描或處理其他任務");
    expect(prompt).toContain("798893182883463179");
    expect(prompt).toContain("使用內建圖片生成工具");
    expect(prompt).toContain("「白絲」指白色絲襪／半透明白色連褲襪");
    expect(prompt).toContain("兩者都不是內衣");
  });

  it("uses the black-tights reference for anime style only", () => {
    const id = "e63c3ea6-dda6-4cc7-acf9-c2416a26db9f";
    const reference = "/tmp/cyrene-black-tights-style.png";
    const prompt = buildOnDemandCodexImagePrompt(id, "/tmp/cyrene-bridge", reference);
    expect(prompt).toContain(reference);
    expect(prompt).toContain("完整半透明黑色連褲襪");
    expect(prompt).toContain("不可被固定成參考圖的樣子");
    expect(prompt).toContain("只作為高優先級的 2D 動漫畫風參考");
    expect(prompt).toContain("明確忽略參考圖的構圖、鏡位、透視、姿勢、服裝、場景與物件配置");
    expect(prompt).toContain("不得因附有此圖就固定為低視角");
    expect(prompt).toContain("純 2D 日系動漫插畫");
    expect(prompt).toContain("禁止厚塗筆觸");
    expect(prompt).toContain("華麗厚塗、半寫實、柔糊夢幻光影");
  });

  it("attaches the anime style reference to both black and white hosiery requests", () => {
    expect(shouldUseCyreneAnimeStyleReference("我想看你穿黑絲")).toBe(true);
    expect(shouldUseCyreneAnimeStyleReference("我想看白絲")).toBe(true);
    expect(shouldUseCyreneAnimeStyleReference("白色半透明連褲襪")).toBe(true);
    expect(shouldUseCyreneAnimeStyleReference("我想看你在咖啡廳喝茶")).toBe(false);
  });

  it("rejects malformed job IDs before constructing paths", () => {
    expect(() => buildOnDemandCodexImagePrompt("../../escape", "/tmp/cyrene-bridge")).toThrow(/ID 無效/);
  });

  it("places the variadic image option after the exec subcommand", () => {
    const args = buildCodexImageWorkerArgs("prompt", "/workspace", "/bridge", "/reference.png");
    expect(args.indexOf("exec")).toBeLessThan(args.indexOf("-i"));
    expect(args.indexOf("-i")).toBeLessThan(args.indexOf("--ephemeral"));
  });
});
