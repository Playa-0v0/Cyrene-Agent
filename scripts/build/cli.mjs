/**
 * Bundle src/cli/index.ts -> dist/cli/index.js with esbuild.
 *
 * - CJS (Node bin requirement)
 * - #!/usr/bin/env node shebang banner
 * - __CYRENE_VERSION__ injected from package.json (no runtime file read)
 * - Zero runtime deps; no node_modules needed at runtime
 */
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const pkgPath = path.join(repoRoot, "package.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));

await build({
  entryPoints: [path.join(repoRoot, "src", "cli", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: path.join(repoRoot, "dist", "cli", "index.js"),
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __CYRENE_VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: "info",
});

console.log(`[cli] bundled dist/cli/index.js (v${pkg.version})`);
