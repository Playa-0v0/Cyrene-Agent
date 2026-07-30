// 回归测试：钉住"Codex 的出网请求绝不能落到 Node 的全局 fetch"这条不变量。
//
// 背景（真实故障）：Node 的全局 fetch（undici）无视 HTTP_PROXY / 系统代理，一律直连。
// auth.openai.com / chatgpt.com 在部分地区直连会被回
//   403 {"code":"unsupported_country_region_territory"}
// 而 OAuth 的浏览器授权那一步是通的（浏览器走系统代理），于是症状伪装成
// "OAuth 实现有 bug"，非常费时间。修法是改用 Electron 的 net.fetch（Chromium 网络栈）。
//
// 这个文件不测代理本身能不能连通（那取决于跑测试的机器），只测更重要的一件事：
// 如果哪天有人把某个调用点改回裸 fetch()，测试会失败。
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const VENDOR_DIR = __dirname;

describe("Codex 出网请求不得使用 Node 全局 fetch", () => {
  // 静态检查：这两个文件里不允许出现裸 fetch( 调用。
  // 它们必须把 fetch 当依赖注入（fetchImpl），生产环境由 proxy-fetch.ts 提供 net.fetch。
  for (const file of ["codex-oauth-auth.ts", "codex-bridge.ts"]) {
    it(`${file} 里没有裸 fetch( 调用`, () => {
      const source = fs.readFileSync(path.join(VENDOR_DIR, file), "utf8");
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // 允许 fetchImpl(...) / proxyAwareFetch，不允许 fetch(...) 或 globalThis.fetch
      const bareFetch = withoutComments.match(/(?<![A-Za-z0-9_$.])fetch\s*\(/g);
      expect(
        bareFetch,
        `${file} 出现了裸 fetch( 调用。Node 的全局 fetch 不走代理，` +
          `auth.openai.com / chatgpt.com 会返回 403 地区封锁。请改用注入的 fetchImpl。`,
      ).toBeNull();
      expect(withoutComments).not.toMatch(/globalThis\s*\.\s*fetch/);
    });
  }

  it("proxy-fetch 用的是 Electron net.fetch，而不是全局 fetch", async () => {
    const netFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.doMock("electron", () => ({ net: { fetch: netFetch } }));
    // 让全局 fetch 一旦被误用就立刻暴露
    const globalFetchSpy = vi.fn(async () => new Response("SHOULD NOT BE USED", { status: 500 }));
    vi.stubGlobal("fetch", globalFetchSpy);

    try {
      const { proxyAwareFetch } = await import("./proxy-fetch");
      const res = await proxyAwareFetch("https://auth.openai.com/oauth/token", { method: "POST" });

      expect(await res.text()).toBe("ok");
      expect(netFetch).toHaveBeenCalledOnce();
      expect(globalFetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock("electron");
      vi.resetModules();
    }
  });
});
