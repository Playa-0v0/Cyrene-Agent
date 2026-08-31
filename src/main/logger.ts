/**
 * Main-process wrapper around the shared logger.
 *
 * Responsibilities on top of src/shared/logger.ts:
 *   - Apply the dev-vs-release default level (info when unpackaged, warn
 *     when packaged) by calling setLogLevel() at module init.
 *   - Re-export LogTag from the shared location so call sites can
 *     `import { LogTag } from "../logger"`.
 */
import { app } from "electron";
import { setLogLevel, type LogLevel } from "../shared/logger";
import { logger } from "../shared/logger";

function resolveDefaultLevel(): LogLevel {
  // env wins
  const env = process.env.CYRENE_LOG_LEVEL?.toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") {
    return env;
  }
  // Both dev and release: warn by default. Startup prints the banner plus
  // whatever warn/error fires during init; set CYRENE_LOG_LEVEL=info to see
  // the full startup trace.
  return "warn";
}

setLogLevel(resolveDefaultLevel());

export { logger, setLogLevel, LogTag } from "../shared/logger";
export type { LogLevel } from "../shared/logger";
