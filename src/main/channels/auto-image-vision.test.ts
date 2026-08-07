import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildAutomaticImageContext, buildDurablePhotoMemory } from "./auto-image-vision";

const config = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "test", model: "openrouter/free" };

describe("Discord 圖片自動辨識", () => {
  it("下載 Discord 圖片並注入直接回答提示", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("image"), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "5" },
    })) as unknown as typeof fetch;
    const caption = vi.fn(async () => "這是一隻微笑的金毛幼犬。\n");

    const context = await buildAutomaticImageContext([
      { kind: "image", url: "https://cdn.discordapp.com/puppy.png", mime: "image/png", caption: "puppy.png" },
    ], "這是什麼呀", config, { fetchImpl, caption });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(caption).toHaveBeenCalledOnce();
    expect(context).toContain("這是一隻微笑的金毛幼犬");
    expect(context).toContain("不要反問圖片主題");
  });

  it("沒有圖片或沒有視覺設定時不注入內容", async () => {
    expect(await buildAutomaticImageContext([], "看看", config)).toBe("");
    expect(await buildAutomaticImageContext([{ kind: "image", url: "https://x/a.png" }], "看看", null)).toBe("");
  });

  it("把視覺結果整理成不依賴原圖網址的永久照片記憶", () => {
    const memory = buildDurablePhotoMemory([
      "【系統已自動辨識本輪圖片附件】",
      "圖片 1：桌上有一杯紫色飲料，杯身寫著 CYRENE。",
      "請直接根據以上圖片內容回答使用者，不要反問圖片主題，也不要聲稱自己看不到圖片。",
    ].join("\n"), "這是我今天喝的", [
      { kind: "image", url: "https://cdn.discordapp.com/temporary.png", caption: "drink.png" },
    ]);

    expect(memory).toContain("【照片內容永久記憶】");
    expect(memory).toContain("這是我今天喝的");
    expect(memory).toContain("drink.png");
    expect(memory).toContain("紫色飲料");
    expect(memory).not.toContain("cdn.discordapp.com");
    expect(memory).not.toContain("不要反問圖片主題");
  });

  it("可辨識 Electron 聊天選取的本機午餐照片", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lunch-"));
    const filePath = path.join(dir, "lunch.jpg");
    fs.writeFileSync(filePath, Buffer.from("fake-jpeg"));
    const caption = vi.fn(async () => "照片裡是一碗牛肉麵，旁邊有小菜。看起來是午餐。 ");

    try {
      const context = await buildAutomaticImageContext([
        { kind: "image", filePath, mime: "image/jpeg", caption: "lunch.jpg" },
      ], "午餐吃這個，你覺得如何？", config, { caption });

      expect(caption).toHaveBeenCalledWith(
        expect.objectContaining({ mime: "image/jpeg", base64: Buffer.from("fake-jpeg").toString("base64") }),
        "午餐吃這個，你覺得如何？",
        config,
      );
      expect(context).toContain("牛肉麵");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("依使用者設定限制每次辨識的圖片數量", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("image"), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "5" },
    })) as unknown as typeof fetch;
    const caption = vi.fn(async () => "圖片內容");

    await buildAutomaticImageContext([
      { kind: "image", url: "https://cdn.discordapp.com/1.png" },
      { kind: "image", url: "https://cdn.discordapp.com/2.png" },
      { kind: "image", url: "https://cdn.discordapp.com/3.png" },
    ], "看看", config, { fetchImpl, caption, maxImages: 2 });

    expect(caption).toHaveBeenCalledTimes(2);
  });

  it("依使用者設定在下載前拒絕過大的圖片", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("image"), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(2 * 1024 * 1024) },
    })) as unknown as typeof fetch;
    const caption = vi.fn(async () => "不應執行");

    const context = await buildAutomaticImageContext([
      { kind: "image", url: "https://cdn.discordapp.com/large.png" },
    ], "看看", config, { fetchImpl, caption, maxImageBytes: 1024 * 1024 });

    expect(context).toBe("");
    expect(caption).not.toHaveBeenCalled();
  });
});
