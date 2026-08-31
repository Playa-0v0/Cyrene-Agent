/**
 * cyrene CLI entry. The real work is in app.ts so tests can import main().
 *
 * The #!/usr/bin/env node shebang is added by scripts/build/cli.mjs via
 * esbuild's banner option, so this file stays shebang-free for vitest.
 */
import { main } from "./app.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`cyrene: ${err?.stack ?? String(err)}\n`);
    process.exit(1);
  },
);
