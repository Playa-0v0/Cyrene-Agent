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
import { installFileLogSink } from "./log-sink-file";

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

// 打包版 stdout 不可见：把日志同步落盘到 userData/logs/cyrene.log（滚动 3 份×5MB），
// 用户/issue 上报可直接附日志文件。dev 下同样落盘，便于本地排查。
try {
  installFileLogSink(app.getPath("userData"));
} catch {
  // userData 不可用时静默跳过，日志落盘只是增强项
}

export { logger, setLogLevel, LogTag } from "../shared/logger";
export type { LogLevel } from "../shared/logger";
