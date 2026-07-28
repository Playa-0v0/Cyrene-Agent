import { describe, expect, it, vi } from "vitest";
import { buildAutomaticImageContext } from "./auto-image-vision";

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
});
