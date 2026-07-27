/**
 * Renderer 資源路徑 helper
 *
 * 問題：vite base './' + electron loadFile → file:// 協議下
 *   fetch("/models/cyrene/...") 解析到磁盤根目錄，不是 dist/renderer/。
 *
 * 方案：用 document.baseURI + import.meta.env.BASE_URL 計算 renderer 根目錄，
 *   然後拼路徑。dev 模式和子目錄窗口都能正確解析。
 */

let cachedBase = "";

function computeRendererBase(): string {
  const viteBase = import.meta.env.BASE_URL; // dev: "/"  生產: "./"
  const docBase = document.baseURI;          // 當前 HTML 文件的 URL

  // 用 URL.resolve 計算：new URL(relative, base)
  // dev 模式：new URL("/", "http://localhost:5173/chat/index.html")
  //   → http://localhost:5173/  ✅ renderer 根
  // 生產根窗口：new URL("./", "file:///.../dist/renderer/index.html")
  //   → file:///.../dist/renderer/  ✅
  // 生產 chat 窗口：new URL("./", "file:///.../dist/renderer/chat/index.html")
  //   → file:///.../dist/renderer/chat/  ❌ 要再往上
  let root = new URL(viteBase, docBase).href;

  // 生產模式下 vite base 是 "./"，子目錄窗口需要往上走一級
  // 檢測：如果 root 末尾是 chat/ sidebar/ tasks/ settings/ call/ sticker-manager/，往上走
  if (viteBase === "./") {
    const subDirs = ["chat/", "sidebar/", "tasks/", "settings/", "call/", "sticker-manager/"];
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
 * 返回 renderer 根目錄的 URL（末尾帶 /）。
 * 第一次調用時計算，之後緩存。
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
  const clean = assetPath.replace(/^\/+/, ""); // 去掉前導 /
  return getRendererBase() + clean;
}
