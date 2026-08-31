/**
 * Renderer 资源路径 helper
 *
 * 问题：vite base './' + electron loadFile → file:// 协议下
 *   fetch("/models/cyrene/...") 解析到磁盘根目录，不是 dist/renderer/。
 *
 * 方案：用 document.baseURI + import.meta.env.BASE_URL 计算 renderer 根目录，
 *   然后拼路径。dev 模式和子目录窗口都能正确解析。
 */

let cachedBase = "";

function computeRendererBase(): string {
  const viteBase = import.meta.env.BASE_URL; // dev: "/"  生产: "./"
  const docBase = document.baseURI;          // 当前 HTML 文件的 URL

  // 用 URL.resolve 计算：new URL(relative, base)
  // dev 模式：new URL("/", "http://localhost:5173/chat/index.html")
  //   → http://localhost:5173/  ✅ renderer 根
  // 生产根窗口：new URL("./", "file:///.../dist/renderer/index.html")
  //   → file:///.../dist/renderer/  ✅
  // 生产 chat 窗口：new URL("./", "file:///.../dist/renderer/chat/index.html")
  //   → file:///.../dist/renderer/chat/  ❌ 要再往上
  let root = new URL(viteBase, docBase).href;

  // 生产模式下 vite base 是 "./"，子目录窗口需要往上走一级
  // 检测：如果 root 末尾是 react/ sidebar/ tasks/ settings/ call/ sticker-manager/，往上走
  if (viteBase === "./") {
    const subDirs = ["react/", "sidebar/", "tasks/", "settings/", "call/", "sticker-manager/"];
    for (const sub of subDirs) {
      if (root.endsWith("/" + sub)) {
        root = root.replace(/[^/]+\/$/, "");
        break;
      }
    }
  }

  return root;
}

/**
 * 返回 renderer 根目录的 URL（末尾带 /）。
 * 第一次调用时计算，之后缓存。
 */
export function getRendererBase(): string {
  if (!cachedBase) {
    cachedBase = computeRendererBase();
  }
  return cachedBase;
}

/**
 * 把 "models/cyrene/Cyrene.model3.json" 或 "/models/cyrene/Cyrene.model3.json"
 * 解析成完整的 file:// 或 http:// URL。
 */
export function resolveAsset(assetPath: string): string {
  const clean = assetPath.replace(/^\/+/, ""); // 去掉前导 /
  return getRendererBase() + clean;
}
