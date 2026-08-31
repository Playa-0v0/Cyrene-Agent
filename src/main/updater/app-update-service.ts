import type { AppUpdateState } from "../../shared/app-update";

type UpdaterEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

export interface AppUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  on(event: UpdaterEvent, listener: (payload?: any) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface AppUpdateService {
  getState(): AppUpdateState;
  check(): Promise<AppUpdateState>;
  download(): Promise<AppUpdateState>;
  install(): boolean;
  onStateChanged(listener: (state: AppUpdateState) => void): () => void;
}

interface CreateAppUpdateServiceOptions {
  updater: AppUpdaterLike;
  currentVersion: string;
  isPackaged: boolean;
  onStateChanged?: (state: AppUpdateState) => void;
}

export function createAppUpdateService(options: CreateAppUpdateServiceOptions): AppUpdateService {
  const { updater, currentVersion, isPackaged, onStateChanged } = options;
  let state: AppUpdateState = { phase: "idle", currentVersion };
  let checkPromise: Promise<unknown> | null = null;
  let downloadPromise: Promise<unknown> | null = null;
  const listeners = new Set<(state: AppUpdateState) => void>();

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;

  const publish = (patch: Partial<AppUpdateState> & Pick<AppUpdateState, "phase">): void => {
    const next: AppUpdateState = {
      currentVersion,
      availableVersion: state.availableVersion,
      releaseNotes: state.releaseNotes,
      ...patch,
    };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    onStateChanged?.({ ...state });
    for (const listener of listeners) listener({ ...state });
  };

  updater.on("checking-for-update", () => publish({ phase: "checking" }));
  updater.on("update-available", (info) => publish({
    phase: "available",
    availableVersion: typeof info?.version === "string" ? info.version : undefined,
    releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
  }));
  updater.on("update-not-available", () => publish({ phase: "not_available" }));
  updater.on("download-progress", (progress) => publish({
    phase: "downloading",
    percent: finiteNumber(progress?.percent),
    bytesPerSecond: finiteNumber(progress?.bytesPerSecond),
    transferred: finiteNumber(progress?.transferred),
    total: finiteNumber(progress?.total),
  }));
  updater.on("update-downloaded", (info) => publish({
    phase: "downloaded",
    availableVersion: typeof info?.version === "string" ? info.version : state.availableVersion,
    releaseNotes: normalizeReleaseNotes(info?.releaseNotes) ?? state.releaseNotes,
    percent: 100,
  }));
  updater.on("error", () => publish({
    phase: "error",
    error: "暂时无法检查更新，请稍后再试。",
  }));

  return {
    getState: () => ({ ...state }),
    async check() {
      if (!isPackaged) {
        publish({ phase: "not_available" });
        return { ...state };
      }
      if (!checkPromise) {
        publish({ phase: "checking" });
        checkPromise = updater.checkForUpdates().catch(() => {
          publish({ phase: "error", error: "暂时无法检查更新，请稍后再试。" });
        }).finally(() => {
          checkPromise = null;
        });
      }
      await checkPromise;
      return { ...state };
    },
    async download() {
      if (!isPackaged) return { ...state };
      if (!downloadPromise && state.phase !== "downloaded") {
        publish({ phase: "downloading", percent: state.percent ?? 0 });
        downloadPromise = updater.downloadUpdate().catch(() => {
          publish({ phase: "error", error: "更新下载失败，请稍后再试。" });
        }).finally(() => {
          downloadPromise = null;
        });
      }
      await downloadPromise;
      return { ...state };
    },
    install() {
      if (!isPackaged || state.phase !== "downloaded") return false;
      // 静默安装：跳过 NSIS 完整向导，不再让用户选"为所有人/仅为我"，
      // 避免 perMachine 切换导致安装目录漂移（旧目录被卸载器清空、新目录落到 C 盘）。
      // 升级时安装目录里的用户内容由 NSIS 脚本（installer.nsh）暂存保护。
      updater.quitAndInstall(true, true);
      return true;
    },
    onStateChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeReleaseNotes(value: unknown): string | null | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value === null ? null : undefined;
  const notes = value
    .map((item) => typeof item?.note === "string" ? item.note : "")
    .filter(Boolean);
  return notes.length ? notes.join("\n\n") : null;
}
