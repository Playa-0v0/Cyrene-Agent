import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type {
  PluginManagedProcess,
  PluginManagedProcessExit,
  PluginSubprocessService,
} from "../plugins/api";

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const MAX_STARTUP_TIMEOUT_MS = 60_000;
const SAFE_INHERITED_ENV = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
]);
const SECRET_ENV_RE = /(api[_-]?key|token|secret|password|credential|authorization|cookie)/i;

function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

export function buildSanitizedPluginEnvironment(
  inherited: NodeJS.ProcessEnv,
  explicit: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && SAFE_INHERITED_ENV.has(key.toUpperCase()) && !SECRET_ENV_RE.test(key)) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (!key || key.includes("=") || key.includes("\0")) throw new Error(`非法环境变量名: ${key}`);
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`环境变量 ${key} 必须是不含 NUL 的字符串`);
    env[key] = value;
  }
  return env;
}

async function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      });
      killer.once("error", () => {
        child.kill("SIGKILL");
        resolve();
      });
      killer.once("exit", () => resolve());
    });
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

class ManagedPluginProcess implements PluginManagedProcess {
  readonly pid: number;
  private readonly stdoutListeners = new Set<(line: string) => void>();
  private readonly stderrListeners = new Set<(line: string) => void>();
  private readonly exitPromise: Promise<PluginManagedProcessExit>;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly pendingStdout: string[] = [];
  private readonly pendingStderr: string[] = [];
  private outputBytes = 0;
  private stopping?: Promise<void>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly maxOutputBytes: number,
    private readonly onStopped: () => void,
  ) {
    if (!child.pid) throw new Error("子进程启动后未返回 pid");
    this.pid = child.pid;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume("stdout", chunk));
    child.stderr.on("data", (chunk: string) => this.consume("stderr", chunk));
    this.exitPromise = new Promise((resolve) => {
      child.once("exit", (exitCode, signal) => {
        this.flush("stdout");
        this.flush("stderr");
        this.onStopped();
        resolve({ exitCode, signal });
      });
    });
  }

  write(line: string): void {
    if (line.includes("\0") || line.includes("\r") || line.includes("\n")) {
      throw new Error("受管子进程 write 只接受单行文本");
    }
    if (!this.child.stdin.writable) throw new Error("受管子进程 stdin 已关闭");
    this.child.stdin.write(`${line}\n`, "utf8");
  }

  onStdoutLine(listener: (line: string) => void): () => void {
    this.stdoutListeners.add(listener);
    for (const line of this.pendingStdout.splice(0)) listener(line);
    return () => this.stdoutListeners.delete(listener);
  }

  onStderrLine(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    for (const line of this.pendingStderr.splice(0)) listener(line);
    return () => this.stderrListeners.delete(listener);
  }

  wait(): Promise<PluginManagedProcessExit> {
    return this.exitPromise;
  }

  stop(): Promise<void> {
    if (!this.stopping) this.stopping = killProcessTree(this.child);
    return this.stopping;
  }

  private consume(stream: "stdout" | "stderr", chunk: string): void {
    this.outputBytes += Buffer.byteLength(chunk);
    if (this.outputBytes > this.maxOutputBytes) {
      void this.stop();
      return;
    }
    const buffer = (stream === "stdout" ? this.stdoutBuffer : this.stderrBuffer) + chunk;
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES && !buffer.includes("\n")) {
      void this.stop();
      return;
    }
    const parts = buffer.split(/\r?\n/);
    const tail = parts.pop() ?? "";
    if (stream === "stdout") this.stdoutBuffer = tail;
    else this.stderrBuffer = tail;
    for (const line of parts) this.emit(stream, line);
  }

  private flush(stream: "stdout" | "stderr"): void {
    const line = stream === "stdout" ? this.stdoutBuffer : this.stderrBuffer;
    if (stream === "stdout") this.stdoutBuffer = "";
    else this.stderrBuffer = "";
    if (line) this.emit(stream, line);
  }

  private emit(stream: "stdout" | "stderr", line: string): void {
    const listeners = stream === "stdout" ? this.stdoutListeners : this.stderrListeners;
    if (listeners.size === 0) {
      const pending = stream === "stdout" ? this.pendingStdout : this.pendingStderr;
      pending.push(line);
      if (pending.length > 100) pending.shift();
      return;
    }
    for (const listener of listeners) {
      try { listener(line); } catch { /* Listener ownership stays with the plugin. */ }
    }
  }
}

export class PluginSubprocessHost {
  private readonly processes = new Map<string, Set<ManagedPluginProcess>>();

  forPlugin(pluginId: string, signal: AbortSignal): PluginSubprocessService {
    return {
      spawn: async (options) => {
        if (signal.aborted) {
          const error = new Error("插件已停止，不能启动子进程");
          error.name = "AbortError";
          throw error;
        }
        if (!path.isAbsolute(options.executable)) throw new Error("受管子进程 executable 必须是绝对路径");
        if (options.cwd && !path.isAbsolute(options.cwd)) throw new Error("受管子进程 cwd 必须是绝对路径");
        const args = options.args ?? [];
        if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
          throw new Error("受管子进程 args 必须是不含 NUL 的字符串数组");
        }
        const child = spawn(options.executable, args, {
          cwd: options.cwd,
          env: buildSanitizedPluginEnvironment(process.env, options.env),
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const startupTimeoutMs = bounded(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, MAX_STARTUP_TIMEOUT_MS);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`受管子进程启动超时（${startupTimeoutMs}ms）`)), startupTimeoutMs);
          child.once("spawn", () => { clearTimeout(timer); resolve(); });
          child.once("error", (error) => { clearTimeout(timer); reject(error); });
        }).catch(async (error) => {
          await killProcessTree(child);
          throw error;
        });
        let set = this.processes.get(pluginId);
        if (!set) {
          set = new Set();
          this.processes.set(pluginId, set);
        }
        let managed!: ManagedPluginProcess;
        let abortHandler: (() => void) | undefined;
        managed = new ManagedPluginProcess(
          child,
          bounded(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
          () => {
            if (abortHandler) signal.removeEventListener("abort", abortHandler);
            const current = this.processes.get(pluginId);
            current?.delete(managed);
            if (current?.size === 0) this.processes.delete(pluginId);
          },
        );
        set.add(managed);
        abortHandler = () => { void managed.stop(); };
        signal.addEventListener("abort", abortHandler, { once: true });
        return managed;
      },
    };
  }

  async stopPlugin(pluginId: string): Promise<void> {
    const processes = [...(this.processes.get(pluginId) ?? [])];
    await Promise.allSettled(processes.map((process) => process.stop()));
    this.processes.delete(pluginId);
  }
}
