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
  const createWatcher = deps.createWatcher ?? ((paths, options) => chokidar.watch(paths, options) as WorkspaceFsWatcher);

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
    if (value.startsWith(`${git}/objects/`) || value.startsWith(`${git}/logs/`) || value.startsWith(`${git}/hooks/`) || value.endsWith(".lock")) return true;
    const relative = value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value;
    return /(^|\/)(node_modules|dist|build|coverage|\.cache|\.next|\.turbo)(\/|$)/.test(relative);
  };
}

function workspaceKey(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}
