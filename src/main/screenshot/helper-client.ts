import { randomUUID } from "node:crypto";
import {
  parseHelperEvent,
  resolveCompletedFile,
  type HelperEvent,
  type ScreenshotMode,
} from "./protocol";

export type { ScreenshotMode } from "./protocol";

export type HelperProcessState =
  | "stopped" | "starting" | "ready" | "restarting" | "unavailable" | "stopping";
export type CaptureState = "idle" | "freezing" | "selecting" | "selected" | "committing";
export type HelperInteractionState = Exclude<CaptureState, "idle" | "freezing">;

export interface PendingRequest {
  requestId: string;
  mode: ScreenshotMode;
  source: "hotkey" | "chat-button";
  startedAt: number;
  captureReleased: boolean;
}

export interface ScreenshotResult {
  requestId: string;
  filePath: string | null;
  width: number;
  height: number;
  mime: "image/png";
  clipboardWritten: boolean;
  hasAnnotations: boolean;
}

export interface ScreenshotHelperClient {
  readonly processState: HelperProcessState;
  readonly captureState: CaptureState;
  readonly pendingRequests: ReadonlyMap<string, PendingRequest>;
  ensureStarted(): Promise<void>;
  start(mode: ScreenshotMode, source: PendingRequest["source"]): Promise<ScreenshotResult>;
  cancel(requestId: string): void;
  shutdown(): Promise<void>;
}

type DataListener = (chunk: Buffer | string) => void;
type ProcessListener = (...args: unknown[]) => void;

export interface HelperChildProcess {
  stdin: { write(line: string): boolean };
  stdout: { on(event: "data", listener: DataListener): unknown };
  stderr?: { on(event: "data", listener: DataListener): unknown };
  on(event: "error" | "exit", listener: ProcessListener): unknown;
}

export interface ScreenshotHelperClientOptions {
  spawnImpl(command: string, args: string[]): HelperChildProcess;
  resolveHelperPath(): string;
  screenshotDirectory: string;
  parentProcessId?: number;
  now?: () => number;
  createRequestId?: () => string;
  logger?: Pick<Console, "debug" | "warn" | "error">;
}

interface DeferredRequest {
  request: PendingRequest;
  resolve(result: ScreenshotResult): void;
  reject(error: Error): void;
}

const PROTOCOL_VERSION = 1;

export class ElectronScreenshotHelperClient implements ScreenshotHelperClient {
  private state: HelperProcessState = "stopped";
  private currentCaptureState: CaptureState = "idle";
  private readonly requests = new Map<string, PendingRequest>();
  private readonly deferredRequests = new Map<string, DeferredRequest>();
  private child: HelperChildProcess | null = null;
  private currentInteractionRequestId: string | null = null;
  private stdoutBuffer = "";
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private didHandleExit = false;

  constructor(private readonly options: ScreenshotHelperClientOptions) {}

  get processState(): HelperProcessState {
    return this.state;
  }

  get captureState(): CaptureState {
    return this.currentCaptureState;
  }

  get pendingRequests(): ReadonlyMap<string, PendingRequest> {
    return this.requests;
  }

  ensureStarted(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "starting" && this.readyPromise) return this.readyPromise;

    this.state = "starting";
    this.didHandleExit = false;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    try {
      const command = this.options.resolveHelperPath();
      const child = this.options.spawnImpl(command, [
        "--output-dir", this.options.screenshotDirectory,
        "--protocol-version", String(PROTOCOL_VERSION),
        "--parent-pid", String(this.options.parentProcessId ?? process.pid),
      ]);
      this.child = child;
      child.stdout.on("data", (chunk) => this.handleStdout(chunk.toString()));
      child.stderr?.on("data", (chunk) => this.options.logger?.debug("[ScreenshotHelper stderr]", chunk.toString()));
      child.on("error", (error) => this.handleExit(error instanceof Error ? error : new Error("HELPER_PROCESS_ERROR")));
      child.on("exit", (code) => this.handleExit(new Error(`HELPER_EXITED${typeof code === "number" ? `:${code}` : ""}`)));
    } catch (error) {
      this.handleExit(error instanceof Error ? error : new Error("HELPER_START_FAILED"));
    }
    return this.readyPromise;
  }

  start(mode: ScreenshotMode, source: PendingRequest["source"]): Promise<ScreenshotResult> {
    if (this.state === "ready") return this.beginRequest(mode, source);
    return this.ensureStarted().then(() => this.beginRequest(mode, source));
  }

  cancel(requestId: string): void {
    if (!this.requests.has(requestId) || !this.child) return;
    this.writeCommand({ type: "cancel", requestId });
  }

  async shutdown(): Promise<void> {
    if (!this.child) {
      this.state = "stopped";
      return;
    }
    this.state = "stopping";
    this.writeCommand({ type: "shutdown" });
  }

  private beginRequest(mode: ScreenshotMode, source: PendingRequest["source"]): Promise<ScreenshotResult> {
    if (!this.child || this.state !== "ready") return Promise.reject(new Error("HELPER_NOT_READY"));

    const requestId = (this.options.createRequestId ?? randomUUID)();
    const request: PendingRequest = {
      requestId,
      mode,
      source,
      startedAt: (this.options.now ?? Date.now)(),
      captureReleased: false,
    };
    this.requests.set(requestId, request);
    this.currentInteractionRequestId = requestId;
    this.currentCaptureState = "freezing";

    const result = new Promise<ScreenshotResult>((resolve, reject) => {
      this.deferredRequests.set(requestId, { request, resolve, reject });
    });
    this.writeCommand({ type: "start", requestId, mode });
    return result;
  }

  private writeCommand(command: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        try {
          this.handleEvent(parseHelperEvent(line));
        } catch (error) {
          this.options.logger?.warn("[ScreenshotHelper] ignored invalid event", error);
        }
      }
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleEvent(event: HelperEvent): void {
    switch (event.type) {
      case "ready":
        if (event.protocolVersion !== PROTOCOL_VERSION) {
          this.handleExit(new Error("INCOMPATIBLE_HELPER_PROTOCOL"));
          return;
        }
        this.state = "ready";
        this.resolveReady?.();
        this.clearReadyDeferred();
        return;
      case "interaction-state":
        if (event.requestId === this.currentInteractionRequestId && this.requests.has(event.requestId)) {
          this.currentCaptureState = event.state;
        }
        return;
      case "capture-released": {
        const request = this.requests.get(event.requestId);
        if (!request) return;
        request.captureReleased = true;
        if (event.requestId === this.currentInteractionRequestId) {
          this.currentInteractionRequestId = null;
          this.currentCaptureState = "idle";
        }
        return;
      }
      case "completed":
        this.completeRequest(event);
        return;
      case "cancelled":
        this.failRequest(event.requestId, new Error(`SCREENSHOT_CANCELLED:${event.reason}`));
        return;
      case "error":
        if (event.requestId) this.failRequest(event.requestId, new Error(`${event.code}: ${event.message}`));
        else this.options.logger?.error("[ScreenshotHelper]", event.code, event.message);
        return;
      case "accepted":
      case "overlay-visible":
        return;
    }
  }

  private completeRequest(event: Extract<HelperEvent, { type: "completed" }>): void {
    const deferred = this.deferredRequests.get(event.requestId);
    if (!deferred) return;
    this.removeRequest(event.requestId);
    try {
      deferred.resolve({
        requestId: event.requestId,
        filePath: event.fileName === null ? null : resolveCompletedFile(this.options.screenshotDirectory, event.fileName),
        width: event.width,
        height: event.height,
        mime: event.mime,
        clipboardWritten: event.clipboardWritten,
        hasAnnotations: event.hasAnnotations,
      });
    } catch (error) {
      deferred.reject(error instanceof Error ? error : new Error("INVALID_SCREENSHOT_FILE_NAME"));
    }
  }

  private failRequest(requestId: string, error: Error): void {
    const deferred = this.deferredRequests.get(requestId);
    if (!deferred) return;
    this.removeRequest(requestId);
    deferred.reject(error);
  }

  private removeRequest(requestId: string): void {
    this.requests.delete(requestId);
    this.deferredRequests.delete(requestId);
    if (this.currentInteractionRequestId === requestId) {
      this.currentInteractionRequestId = null;
      this.currentCaptureState = "idle";
    }
  }

  private handleExit(error: Error): void {
    if (this.didHandleExit) return;
    this.didHandleExit = true;
    const wasStopping = this.state === "stopping";
    this.child = null;
    this.state = wasStopping ? "stopped" : "unavailable";
    this.currentInteractionRequestId = null;
    this.currentCaptureState = "idle";
    if (this.rejectReady) this.rejectReady(error);
    this.clearReadyDeferred();
    for (const requestId of [...this.deferredRequests.keys()]) {
      this.failRequest(requestId, error);
    }
  }

  private clearReadyDeferred(): void {
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
  }
}
