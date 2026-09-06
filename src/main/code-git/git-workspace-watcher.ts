import * as fs from "node:fs";
import * as path from "node:path";
import chokidar, { type ChokidarOptions } from "chokidar";

export interface WorkspaceFsWatcher {
  on(event: "add" | "change" | "unlink" | "addDir" | "unlinkDir" | "error", listener: (value?: unknown) => void): WorkspaceFsWatcher;
  close(): Promise<unknown>;
}

export interface GitWorkspaceSubscription {
  sessionId: string;
  workspaceRoot: string;
  gitDir: string;
}

export interface GitWorkspaceWatcher {
  subscribe(input: GitWorkspaceSubscription): Promise<void>;
  unsubscribe(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface GitWorkspaceWatcherDeps {
  createWatcher?: (paths: string[], options: ChokidarOptions) => WorkspaceFsWatcher;
  onWorkspaceChanged(sessionIds: readonly string[]): void;
  onError(error: unknown, workspaceRoot: string): void;
  debounceMs?: number;
}

interface WatchedWorkspace {
  watcher: WorkspaceFsWatcher;
  sessionIds: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

export function createGitWorkspaceWatcher(deps: GitWorkspaceWatcherDeps): GitWorkspaceWatcher {
  const watched = new Map<string, WatchedWorkspace>();
  const sessions = new Map<string, { key: string; references: number }>();
  const debounceMs = deps.debounceMs ?? 300;
  const createWatcher = deps.createWatcher ?? createPlatformWatcher;

  const release = async (sessionId: string): Promise<void> => {
    const subscription = sessions.get(sessionId);
    if (!subscription) return;
    if (subscription.references > 1) {
      subscription.references -= 1;
      return;
    }
    sessions.delete(sessionId);
    const entry = watched.get(subscription.key);
    if (!entry) return;
    entry.sessionIds.delete(sessionId);
    if (entry.sessionIds.size > 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    watched.delete(subscription.key);
    await entry.watcher.close();
  };

  return {
    async subscribe(input) {
      const key = workspaceKey(input.workspaceRoot);
      const existing = sessions.get(input.sessionId);
      if (existing?.key === key) {
        existing.references += 1;
        return;
      }
      await release(input.sessionId);
      let entry = watched.get(key);
      if (!entry) {
        const schedule = () => {
          const current = watched.get(key);
          if (!current) return;
          if (current.timer) clearTimeout(current.timer);
          current.timer = setTimeout(() => {
            current.timer = undefined;
            deps.onWorkspaceChanged([...current.sessionIds]);
          }, debounceMs);
        };
        const watcher = createWatcher([
          input.workspaceRoot,
          path.join(input.gitDir, "HEAD"),
          path.join(input.gitDir, "index"),
          path.join(input.gitDir, "refs"),
        ], {
          ignoreInitial: true,
          atomic: true,
          awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
          ignored: createCodeGitIgnoredPredicate(input),
        });
        entry = { watcher, sessionIds: new Set() };
        watched.set(key, entry);
        for (const event of ["add", "change", "unlink", "addDir", "unlinkDir"] as const) watcher.on(event, schedule);
        watcher.on("error", (error) => deps.onError(error, input.workspaceRoot));
      }
      entry.sessionIds.add(input.sessionId);
      sessions.set(input.sessionId, { key, references: 1 });
    },
    unsubscribe: release,
    async dispose() {
      const entries = [...watched.values()];
      watched.clear();
      sessions.clear();
      for (const entry of entries) {
        if (entry.timer) clearTimeout(entry.timer);
        await entry.watcher.close();
      }
    },
  };
}

export function createCodeGitIgnoredPredicate({ workspaceRoot, gitDir }: { workspaceRoot: string; gitDir: string }): (candidate: string) => boolean {
  const root = normalizePath(workspaceRoot);
  const git = normalizePath(gitDir);
  return (candidate: string): boolean => {
    const value = normalizePath(candidate);
    if (value === normalizePath(path.join(gitDir, "HEAD")) || value === normalizePath(path.join(gitDir, "index")) || value.startsWith(`${normalizePath(path.join(gitDir, "refs"))}/`)) return false;
    // .git 目录自身的事件（Windows 下其内部增删子项时父目录也会收到 change）不携带有效信息，忽略；
    // objects/logs/hooks 目录自身及内部变化都是噪音（含目录创建事件），一律忽略
    if (value === git) return true;
    for (const part of ["objects", "logs", "hooks"]) {
      if (value === `${git}/${part}` || value.startsWith(`${git}/${part}/`)) return true;
    }
    if (value.endsWith(".lock")) return true;
    const relative = value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value;
    return /(^|\/)(node_modules|dist|build|coverage|\.cache|\.next|\.turbo|release[\w-]*|\.worktrees|tmp)(\/|$)/.test(relative);
  };
}

// 平台默认监视器工厂：Windows/macOS 用内核递归监视——根目录单个句柄覆盖整棵树，
// 挂载瞬时完成；chokidar 则需要递归扫描仓库并逐目录建立监视器，大仓库会把主进程冻结数秒。
// Linux 的 fs.watch 递归支持不成熟，保留 chokidar 方案；原生句柄创建失败时同样回落 chokidar。
function createPlatformWatcher(paths: string[], options: ChokidarOptions): WorkspaceFsWatcher {
  if (process.platform === "win32" || process.platform === "darwin") {
    try {
      return createNativeRecursiveWatcher(paths, options);
    } catch {
      return chokidar.watch(paths, options) as WorkspaceFsWatcher;
    }
  }
  return chokidar.watch(paths, options) as WorkspaceFsWatcher;
}

// 原生递归监视适配器：把 fs.watch 的内核事件转成 WorkspaceFsWatcher 接口。
// 事件在回调里按忽略谓词过滤（含 .git 元数据规则与忽略目录名单），被忽略的路径不产生通知；
// filename 为 null/Buffer（平台差异或编码异常）时无法判别路径，保守当作有变化，交给防抖合并。
function createNativeRecursiveWatcher(paths: string[], options: ChokidarOptions): WorkspaceFsWatcher {
  const ignored = typeof options.ignored === "function" ? (options.ignored as (candidate: string) => boolean) : undefined;
  const listeners = new Map<string, Set<(value?: unknown) => void>>();
  const handles: fs.FSWatcher[] = [];

  const emit = (event: string, value?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };

  const attach = (watchRoot: string): void => {
    const handle = fs.watch(watchRoot, { recursive: true, persistent: true }, (_eventType, filename) => {
      if (typeof filename !== "string") {
        emit("change");
        return;
      }
      const candidate = path.resolve(watchRoot, filename);
      if (ignored?.(candidate)) return;
      emit("change", candidate);
    });
    handle.once("error", (error) => emit("error", error));
    handles.push(handle);
  };

  const root = paths[0];
  attach(root);
  // worktree 场景：gitDir 在仓库根之外，根句柄覆盖不到 .git 元数据，单独补一个
  if (paths.slice(1).some((p) => !isUnder(p, root))) attach(path.dirname(paths[1]));

  const watcher: WorkspaceFsWatcher = {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return watcher;
    },
    async close() {
      for (const handle of handles) handle.close();
      handles.length = 0;
    },
  };
  return watcher;
}

function isUnder(candidate: string, root: string): boolean {
  const c = normalizePath(candidate);
  const r = normalizePath(root);
  return c === r || c.startsWith(`${r}/`);
}

function workspaceKey(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}
