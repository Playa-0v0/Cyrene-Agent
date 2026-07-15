import { app } from "electron";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { resolveMusicPaths } from "./paths";
import { bootstrapMusicService } from "./bootstrap";
import { sanitizeLogLine } from "./log-sanitizer";
import {
  SMOKE_OK, SMOKE_ELECTRON_INIT_FAILED, SMOKE_MCP_START_FAILED, SMOKE_MCP_INCOMPATIBLE,
  SMOKE_SEARCH_FAILED, SMOKE_PLAYBACK_FAILED, SMOKE_SHUTDOWN_FAILED,
} from "./smoke-codes";
import type { PlaybackDispatchResult } from "./types";

const log = (line: string) => console.log(`[music-smoke] ${line}`);

async function main(): Promise<number> {
  // 1. Isolated userData BEFORE app.whenReady()
  const runId = `cyrene-music-smoke-${Date.now()}-${process.pid}`;
  const smokeUserDataDir = path.join(os.tmpdir(), runId);
  await fs.mkdir(smokeUserDataDir, { recursive: true });
  app.setPath("userData", smokeUserDataDir);
  log(`userData=${smokeUserDataDir}`);

  await app.whenReady();
  log("app_ready");

  const cleanup = async () => {
    try { await fs.rm(smokeUserDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  let code = SMOKE_OK;
  try {
    code = await runPhases(smokeUserDataDir);
  } catch (err) {
    console.error("[music-smoke] fatal", sanitizeLogLine(String(err)));
    code = SMOKE_SHUTDOWN_FAILED;
  } finally {
    await cleanup();
  }
  return code;
}

async function runPhases(smokeUserDataDir: string): Promise<number> {
  const paths = resolveMusicPaths();
  const bootstrap = bootstrapMusicService(paths);
  log("backend_starting");

  // 2. Wait for backend to be ready (or fail)
  const start = Date.now();
  while (bootstrap.service.getBackendState() === "starting") {
    if (Date.now() - start > 15000) {
      log(`backend_failed timeout errorCode=E_BACKEND_TIMEOUT`);
      await shutdown(bootstrap);
      return SMOKE_MCP_START_FAILED;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const backend = bootstrap.service.getBackendState();
  if (backend === "incompatible") {
    log("backend_incompatible");
    await shutdown(bootstrap);
    return SMOKE_MCP_INCOMPATIBLE;
  }
  if (backend !== "ready") {
    log(`backend_failed state=${backend}`);
    await shutdown(bootstrap);
    return SMOKE_MCP_START_FAILED;
  }
  log("backend_ready");
  log("contract_ok");

  // 3. Search (default: empty array is OK; strict: must be non-empty)
  const strict = process.env.CYRENE_MUSIC_SMOKE_STRICT === "1";
  const searchResult = await bootstrap.service.searchTracks("花海 周杰伦", "smoke");
  if (!Array.isArray(searchResult.tracks)) {
    log("search_failed errorCode=E_SEARCH_INVALID_RESPONSE");
    await shutdown(bootstrap);
    return SMOKE_SEARCH_FAILED;
  }
  if (searchResult.tracks.length === 0) {
    if (strict) {
      log("search_empty_strict errorCode=E_SEARCH_EMPTY_STRICT");
      await shutdown(bootstrap);
      return SMOKE_SEARCH_FAILED;
    }
    log("search_empty count=0");
  } else {
    log(`search_ok count=${searchResult.tracks.length}`);
  }

  // 4. Optional playback test
  if (process.env.CYRENE_MUSIC_SMOKE_ALLOW_EXTERNAL === "1") {
    const trackId = process.env.CYRENE_MUSIC_SMOKE_TRACK_ID;
    if (!trackId) {
      log("playback_skipped reason=no_track_id");
    } else {
      const dispatch: PlaybackDispatchResult = await bootstrap.service.playTrack(trackId);
      if (dispatch.state === "dispatched") {
        log(`playback_ok trackId=${trackId}`);
      } else if (dispatch.state === "client_unavailable") {
        log(`playback_unavailable trackId=${trackId}`);
      } else {
        log(`playback_failed state=${dispatch.state} errorCode=${dispatch.errorCode ?? "?"}`);
        await shutdown(bootstrap);
        return SMOKE_PLAYBACK_FAILED;
      }
    }
  } else {
    log("playback_skipped");
  }

  // 5. Optional login test (manual mode only)
  if (process.env.CYRENE_MUSIC_SMOKE_LOGIN === "1") {
    await runLoginPhase(bootstrap, smokeUserDataDir);
  }

  // 6. Shutdown + report
  return await shutdown(bootstrap);
}

async function shutdown(bootstrap: ReturnType<typeof bootstrapMusicService>): Promise<number> {
  const report = await bootstrap.shutdown();
  log(`shutdown report rootProcessPid=${report.rootProcessPid ?? "?"} transportClosed=${report.transportClosed} processTreeExited=${report.processTreeExited} runtimeRemoved=${report.runtimeRemoved}`);

  // Independent PID-precise re-verification in the smoke entry itself
  let pidAliveAfterShutdown = false;
  if (report.rootProcessPid !== undefined) {
    try {
      process.kill(report.rootProcessPid, 0);
      pidAliveAfterShutdown = true;  // kill 0 succeeded → process still alive
    } catch {
      pidAliveAfterShutdown = false;  // ESRCH or EPERM → process has exited
    }
  }

  // Build the success/failure verdict from ALL the report fields
  const allGood =
    report.transportClosed &&
    report.runtimeRemoved &&
    !pidAliveAfterShutdown;

  if (allGood) {
    if (report.rootProcessPid !== undefined) {
      log("process_tree_clean");
    } else {
      log("process_tree_clean no_pid");
    }
    return SMOKE_OK;
  } else {
    if (pidAliveAfterShutdown) {
      log(`process_tree_dirty root_pid=${report.rootProcessPid}`);
    } else if (!report.transportClosed) {
      log("shutdown_failed reason=transport_not_closed");
    } else if (!report.runtimeRemoved) {
      log("shutdown_failed reason=runtime_not_removed");
    }
    return SMOKE_SHUTDOWN_FAILED;
  }
}

async function runLoginPhase(
  bootstrap: ReturnType<typeof bootstrapMusicService>,
  smokeUserDataDir: string,
): Promise<void> {
  log("login_starting");
  const begin = await bootstrap.service.beginLogin();
  if (!("qrContent" in begin)) {
    log(`login_skipped status=${(begin as { status: string }).status}`);
    return;
  }
  const qrPngPath = path.join(smokeUserDataDir, "login_qrcode.png");
  const qrTxtPath = path.join(smokeUserDataDir, "login_qrcode.txt");
  await fs.writeFile(qrTxtPath, begin.qrContent, "utf8");
  log(`login_qr_text=${qrTxtPath}`);

  // Generate PNG via qrcode package (already a project dep). We use a
  // require() + minimal local shape instead of importing the package
  // directly because qrcode ships no .d.ts and we must not add @types.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const QRCode = require("qrcode") as { toFile(path: string, text: string): Promise<void> };
    await QRCode.toFile(qrPngPath, begin.qrContent);
    log(`login_qr_png=${qrPngPath}`);
  } catch {
    log(`login_qr_png_failed errorCode=E_QR_PNG_FAILED`);
  }

  // Poll up to 5 minutes
  const loginStart = Date.now();
  let final = "timeout";
  while (Date.now() - loginStart < 5 * 60 * 1000) {
    const flow = bootstrap.service.getLoginFlowState();
    if (flow === "authorized" || flow === "expired" || flow === "cancelled" || flow === "failed") {
      final = flow;
      break;
    }
    if (typeof (bootstrap.service as { pollOnce?: () => Promise<unknown> }).pollOnce === "function") {
      await (bootstrap.service as { pollOnce?: () => Promise<unknown> }).pollOnce?.();
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log(`login_done state=${final}`);

  // Clean up QR files
  await fs.rm(qrPngPath, { force: true }).catch(() => {});
  await fs.rm(qrTxtPath, { force: true }).catch(() => {});
}

void main()
  .then((code) => app.exit(code))
  .catch((err) => {
    // Synchronous init failure (e.g. setPath throws, whenReady rejects, etc.)
    console.error("[music-smoke] init_failed", sanitizeLogLine(String(err)));
    app.exit(SMOKE_ELECTRON_INIT_FAILED);
  });
