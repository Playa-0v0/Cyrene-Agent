import { defineConfig } from "vite";
import { extname, resolve, sep } from "node:path";
import { cpSync, existsSync, readFileSync, statSync } from "node:fs";

const ropeboundSource = resolve(__dirname, "src/renderer/public/ropebound-original");
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export default defineConfig({
  root: resolve(__dirname, "src/renderer/discord-activity"),
  base: "./",
  envDir: __dirname,
  publicDir: false,
  plugins: [{
    name: "copy-ropebound-activity-assets",
    configureServer(server) {
      server.middlewares.use("/ropebound-original", (request, response, next) => {
        const requestPath = decodeURIComponent((request.url ?? "/").split("?")[0]);
        const relativePath = requestPath === "/" ? "/index.html" : requestPath;
        const filePath = resolve(ropeboundSource, `.${relativePath}`);
        if (!filePath.startsWith(`${ropeboundSource}${sep}`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", contentTypes[extname(filePath)] ?? "application/octet-stream");
        response.end(readFileSync(filePath));
      });
    },
    closeBundle() {
      cpSync(
        ropeboundSource,
        resolve(__dirname, "dist/discord-activity/ropebound-original"),
        { recursive: true },
      );
    },
  }],
  build: {
    outDir: resolve(__dirname, "dist/discord-activity"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
});
