// 走 Chromium 网络栈（含代理）的 fetch —— 给"必须经过代理才能访问"的厂商用。
//
// 为什么不能直接用 Node 的全局 fetch：
//   Node 的 fetch（undici）完全无视 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY 和操作系统
//   的代理设置，请求一律直连出去。对 auth.openai.com / chatgpt.com 这类在部分地区
//   需要代理才能访问的域名，直连拿到的是：
//     HTTP 403 {"code":"unsupported_country_region_territory"}
//
//   而 OAuth 登录流程里"打开浏览器授权"那一步是成功的——浏览器走系统代理。于是现象
//   变成"浏览器能登录、回来换 token 却 403"，极容易误判成 OAuth 实现写错了。
//   这不是假想：本文件就是为修这个真实故障而加的（同一进程内实测对比：
//   net.fetch → 401（正常业务拒绝，说明打通了），全局 fetch → 403 地区封锁）。
//
// 为什么用 Electron 的 net.fetch：
//   - 走 Chromium 网络栈，自动沿用 session 的代理配置（系统代理 / PAC /
//     --proxy-server 开关），跟浏览器行为一致，用户不需要为本应用单独配一次代理。
//   - 返回标准 Response，body 是真正的 ReadableStream —— Codex 后端只说 SSE，
//     必须能流式读，这一点实测确认过。
//   - 不需要新增依赖。
//
// 为什么不用 undici 的 ProxyAgent：
//   undici 在本仓库只是 devDependency（electron / electron-builder）的传递依赖，
//   打包后的运行时里并没有这个包，直接 import 会在生产环境炸掉。
//   （另外 undici 的 ProxyAgent 也不支持 socks5，而用户的代理常是 socks + http 双端口。）
import { net } from "electron";

/** 只覆盖调用点实际用到的 fetch 形态，方便测试注入假实现。 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 必须在 app ready 之后调用。本仓库的调用点（用户点登录、桥处理请求）都在 ready 之后，
 * 所以这里不额外加 whenReady 等待——真在 ready 前调用了，Electron 会抛出明确错误，
 * 比静默排队更容易定位。
 */
export const proxyAwareFetch: FetchLike = (url, init) =>
  net.fetch(url, init as Parameters<typeof net.fetch>[1]);
