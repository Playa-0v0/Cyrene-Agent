import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-types";
import type { ResolvedLspServer } from "./server-discovery";

const INITIALIZE_TIMEOUT_MS = 45_000;

export interface LspChildProcess {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  on(event: "error" | "exit", listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface LspClientOptions {
  server: ResolvedLspServer;
  workspaceRoot: string;
  spawnImpl?: (command: string, args: string[], options: { cwd: string; shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"] }) => LspChildProcess;
}

interface OpenDocument {
  uri: string;
  version: number;
  content: string;
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"] },
): LspChildProcess {
  return spawn(command, args, options) as unknown as LspChildProcess;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
    new Promise<T>((_, reject) => {
      if (!signal) return;
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  });
}

function abortError(): Error {
  const error = new Error("LSP request cancelled");
  error.name = "AbortError";
  return error;
}

/** 一个工作区内单个外部 LSP 服务进程的 JSON-RPC 客户端。 */
export class LspClient {
  private readonly spawnImpl: NonNullable<LspClientOptions["spawnImpl"]>;
  private child: LspChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private initialized = false;
  private disposed = false;

  constructor(private readonly options: LspClientOptions) {
    this.spawnImpl = options.spawnImpl ?? defaultSpawn;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.disposed) throw new Error("LSP client has been disposed");

    const child = this.spawnImpl(this.options.server.executablePath, [...this.options.server.args], {
      cwd: this.options.workspaceRoot,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!child.stdin || !child.stdout) throw new Error("LSP server did not expose stdio pipes");

    const connection = createMessageConnection(child.stdout, child.stdin);
    connection.onNotification("textDocument/publishDiagnostics", (params: { uri?: string; diagnostics?: Diagnostic[] }) => {
      if (typeof params?.uri === "string") this.diagnostics.set(params.uri, [...(params.diagnostics ?? [])]);
    });
    connection.onRequest("workspace/configuration", () => []);
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.listen();

    child.on("exit", () => {
      if (!this.disposed) this.initialized = false;
    });
    child.on("error", () => {
      if (!this.disposed) this.initialized = false;
    });

    this.child = child;
    this.connection = connection;
    const rootUri = pathToFileURL(this.options.workspaceRoot).toString();
    await withTimeout(
      connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.options.workspaceRoot) }],
        capabilities: { workspace: { configuration: true }, textDocument: {} },
        initializationOptions: this.options.server.definition.initializationOptions,
      }),
      INITIALIZE_TIMEOUT_MS,
      "LSP_INITIALIZE_TIMEOUT",
    );
    connection.sendNotification("initialized", {});
    this.initialized = true;
  }

  async touchFile(filePath: string, languageId: string): Promise<void> {
    await this.initialize();
    const connection = this.requireConnection();
    const absolutePath = path.resolve(filePath);
    const content = fs.readFileSync(absolutePath, "utf8");
    const uri = pathToFileURL(absolutePath).toString();
    const existing = this.documents.get(uri);
    if (!existing) {
      this.documents.set(uri, { uri, version: 1, content });
      connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text: content },
      });
      return;
    }
    if (existing.content === content) return;
    const version = existing.version + 1;
    this.documents.set(uri, { uri, version, content });
    connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
  }

  async request<T>(method: string, params: unknown, timeoutMs = 10_000, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortError();
    await this.initialize();
    return withTimeout(this.requireConnection().sendRequest(method, params), timeoutMs, "LSP_REQUEST_TIMEOUT", signal) as Promise<T>;
  }

  getDiagnostics(filePath: string): Diagnostic[] {
    return [...(this.diagnostics.get(pathToFileURL(path.resolve(filePath)).toString()) ?? [])];
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.connection && this.initialized) {
        await withTimeout(this.connection.sendRequest("shutdown"), 2_000, "LSP shutdown timeout");
        this.connection.sendNotification("exit");
      }
    } catch {
      // 进程已退出时仍应继续释放本地资源。
    } finally {
      this.connection?.dispose();
      this.child?.kill();
      this.connection = null;
      this.child = null;
      this.initialized = false;
    }
  }

  private requireConnection(): MessageConnection {
    if (!this.connection) throw new Error("LSP server is not initialized");
    return this.connection;
  }
}
