/**
 * app.ts: parse argv -> dispatch -> exit code.
 *
 * This is the unit the test suite imports. index.ts is a 3-line shim that
 * calls main() and process.exit().
 *
 * __CYRENE_VERSION__ is injected at build time by scripts/build/cli.mjs via
 * esbuild's `define`. In tests, main() accepts an optional version override
 * so the test suite does not depend on the build step.
 */
import { parseArgv, type Command } from "./argv.js";
import {
  cmdAbout,
  cmdDefault,
  cmdHello,
  cmdHelp,
  cmdPlaceholder,
  cmdUnknown,
  cmdVersion,
  type HandlerCtx,
} from "./commands/handlers.js";
import { cmdRun } from "./commands/run.js";

declare const __CYRENE_VERSION__: string;

function resolveVersion(override?: string): string {
  if (override !== undefined) return override;
  try {
    return typeof __CYRENE_VERSION__ === "string" ? __CYRENE_VERSION__ : "0.0.0";
  } catch {
    // __CYRENE_VERSION__ is undefined when run under vitest (no esbuild define).
    return "0.0.0";
  }
}

export async function main(argv: readonly string[], versionOverride?: string): Promise<number> {
  const ctx: HandlerCtx = { version: resolveVersion(versionOverride) };
  const cmd: Command = parseArgv(argv);
  switch (cmd.kind) {
    case "default":
      return cmdDefault(ctx);
    case "hello":
      return cmdHello();
    case "about":
      return cmdAbout();
    case "version":
      return cmdVersion(ctx);
    case "help":
      return cmdHelp();
    case "run":
      return cmdRun();
    case "placeholder":
      return cmdPlaceholder(cmd.name);
    case "unknown":
      return cmdUnknown(cmd.name);
  }
}
