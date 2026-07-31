import { describe, expect, it, vi } from "vitest";
import {
  ElectronScreenshotHelperClient,
  type HelperChildProcess,
  type ScreenshotMode,
} from "./helper-client";

type Listener = (...args: any[]) => void;

class FakeChild implements HelperChildProcess {
  readonly stdinWrites: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  readonly stdin = {
    write: (line: string): boolean => {
      this.stdinWrites.push(line);
      return true;
    },
  };

  on(event: "error" | "exit", listener: Listener): this {
    this.addListener(event, listener);
    return this;
  }

  stdout = {
    on: (event: "data", listener: Listener) => {
      this.addListener(`stdout:${event}`, listener);
      return this.stdout;
    },
  };

  stderr = {
    on: (event: "data", listener: Listener) => {
      this.addListener(`stderr:${event}`, listener);
      return this.stderr;
    },
  };

  emitStdout(line: string): void {
    this.emit("stdout:data", Buffer.from(`${line}\n`));
  }

  exit(code = 1): void {
    this.emit("exit", code, null);
  }

  private addListener(event: string, listener: Listener): void {
    const entries = this.listeners.get(event) ?? [];
    entries.push(listener);
    this.listeners.set(event, entries);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function createHarness(): { client: ElectronScreenshotHelperClient; child: FakeChild; startReady(): Promise<void> } {
  const child = new FakeChild();
  let sequence = 0;
  const client = new ElectronScreenshotHelperClient({
    spawnImpl: () => child,
    resolveHelperPath: () => "C:\\helper\\cyrene-screenshot.exe",
    screenshotDirectory: "C:\\shots",
    parentProcessId: 42,
    now: () => 1000,
    createRequestId: () => `r${++sequence}`,
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  return {
    client,
    child,
    async startReady(): Promise<void> {
      const pending = client.ensureStarted();
      child.emitStdout('{"type":"ready","protocolVersion":1}');
      await pending;
    },
  };
}

function start(client: ElectronScreenshotHelperClient, mode: ScreenshotMode, source: "hotkey" | "chat-button") {
  return client.start(mode, source);
}

describe("ElectronScreenshotHelperClient", () => {
  it("keeps process readiness separate from an idle capture", async () => {
    const { client, startReady } = createHarness();

    await startReady();

    expect(client.processState).toBe("ready");
    expect(client.captureState).toBe("idle");
  });

  it("sends only Rust protocol fields and tracks interaction states", async () => {
    const { client, child, startReady } = createHarness();
    await startReady();

    const result = start(client, "clipboard-only", "hotkey");
    expect(client.captureState).toBe("freezing");
    expect(JSON.parse(child.stdinWrites.at(-1)!)).toEqual({
      type: "start",
      requestId: "r1",
      mode: "clipboard-only",
    });
    expect(client.pendingRequests.get("r1")).toMatchObject({ source: "hotkey", captureReleased: false });

    child.emitStdout('{"type":"interaction-state","requestId":"r1","state":"selecting"}');
    expect(client.captureState).toBe("selecting");
    child.emitStdout('{"type":"interaction-state","requestId":"r1","state":"selected"}');
    expect(client.captureState).toBe("selected");
    child.emitStdout('{"type":"interaction-state","requestId":"r1","state":"committing"}');
    expect(client.captureState).toBe("committing");
    child.emitStdout('{"type":"completed","requestId":"r1","fileName":null,"width":10,"height":20,"mime":"image/png","clipboardWritten":true,"hasAnnotations":true}');

    await expect(result).resolves.toMatchObject({ requestId: "r1", filePath: null, width: 10, height: 20, hasAnnotations: true });
    expect(client.pendingRequests.size).toBe(0);
    expect(client.captureState).toBe("idle");
  });

  it("keeps a released clipboard-and-file request pending until encoding completes", async () => {
    const { client, child, startReady } = createHarness();
    await startReady();

    const result = start(client, "clipboard-and-file", "chat-button");
    child.emitStdout('{"type":"capture-released","requestId":"r1","clipboardWritten":true,"width":800,"height":600}');

    expect(client.captureState).toBe("idle");
    expect(client.pendingRequests.get("r1")).toMatchObject({ captureReleased: true, source: "chat-button" });

    child.emitStdout('{"type":"completed","requestId":"r1","fileName":"00000000-0000-4000-8000-000000000001.png","width":800,"height":600,"mime":"image/png","clipboardWritten":true,"hasAnnotations":false}');
    await expect(result).resolves.toMatchObject({ filePath: "C:\\shots\\00000000-0000-4000-8000-000000000001.png" });
    expect(client.pendingRequests.size).toBe(0);
  });

  it("does not let a released request's encoding error overwrite a new capture", async () => {
    const { client, child, startReady } = createHarness();
    await startReady();

    const first = start(client, "clipboard-and-file", "chat-button");
    child.emitStdout('{"type":"capture-released","requestId":"r1","clipboardWritten":true,"width":10,"height":10}');
    const second = start(client, "clipboard-only", "hotkey");
    expect(client.captureState).toBe("freezing");

    child.emitStdout('{"type":"error","requestId":"r1","code":"encode-failed","message":"disk full","recoverable":true}');
    await expect(first).rejects.toThrow("encode-failed");
    expect(client.captureState).toBe("freezing");

    child.emitStdout('{"type":"completed","requestId":"r2","fileName":null,"width":1,"height":1,"mime":"image/png","clipboardWritten":true,"hasAnnotations":false}');
    await expect(second).resolves.toMatchObject({ requestId: "r2" });
  });

  it("rejects every pending request when the helper exits", async () => {
    const { client, child, startReady } = createHarness();
    await startReady();

    const first = start(client, "clipboard-and-file", "chat-button");
    child.emitStdout('{"type":"capture-released","requestId":"r1","clipboardWritten":true,"width":10,"height":10}');
    const second = start(client, "clipboard-only", "hotkey");
    child.exit();

    await expect(first).rejects.toThrow("HELPER_EXITED");
    await expect(second).rejects.toThrow("HELPER_EXITED");
    expect(client.pendingRequests.size).toBe(0);
    expect(client.captureState).toBe("idle");
  });
});

// ── 回归：helper 先退出时，往断掉的 stdin 写入不许把主进程炸掉 ──────────────
//
// 线上故障：helper 进程一旦先于主进程退出，stdin 管道**立刻**断开，而 'exit' 事件
// 要到下一个 tick 才送达 —— handleExit 把 this.child 置空也就跟着晚一步。
// before-quit 里同步调用的 shutdown() 正好落在这个空档，写进断掉的管道后拿到异步
// EPIPE；stdin 上没有 'error' 监听器时 Node 会升级成 uncaughtException，在 Electron
// 里就是那个 "A JavaScript error occurred in the main process" 弹窗。
//
// 修复分三层（同步守卫 / try-catch / 异步 error 监听器），下面一条用例钉一层，
// 每一条都验证过：去掉对应那层修复，它就会失败。
describe("ElectronScreenshotHelperClient —— helper 先退出时的 stdin 写入", () => {
  interface StdinStub {
    write: ReturnType<typeof vi.fn>;
    on?: ReturnType<typeof vi.fn>;
    destroyed?: boolean;
  }

  function createClientWith(stdin: StdinStub): ElectronScreenshotHelperClient {
    const noopOn = () => undefined;
    const child = {
      stdin,
      stdout: { on: noopOn },
      stderr: { on: noopOn },
      on: noopOn,
    } as unknown as HelperChildProcess;
    return new ElectronScreenshotHelperClient({
      spawnImpl: () => child,
      resolveHelperPath: () => "C:\helper\cyrene-screenshot.exe",
      screenshotDirectory: "C:\shots",
      logger: { debug: () => {}, warn: () => {}, error: () => {} },
    });
  }

  it("第一层：stdin 已 destroyed 时根本不再写入", async () => {
    const stdin: StdinStub = { write: vi.fn(() => true), on: vi.fn(), destroyed: true };
    const client = createClientWith(stdin);
    void client.ensureStarted();

    await expect(client.shutdown()).resolves.toBeUndefined();

    expect(stdin.write, "管道已断还去写，就是 EPIPE 的来源").not.toHaveBeenCalled();
  });

  it("第二层：write 同步抛出时 shutdown 不把异常抛给调用方", async () => {
    const stdin: StdinStub = {
      write: vi.fn(() => {
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      }),
      on: vi.fn(),
      destroyed: false,
    };
    const client = createClientWith(stdin);
    void client.ensureStarted();

    // before-quit 里没人 catch 这个 promise，抛出去就是未捕获异常
    await expect(client.shutdown()).resolves.toBeUndefined();
    expect(stdin.write).toHaveBeenCalled();
  });

  it("第三层：spawn 时必须给 stdin 挂 error 监听器（异步 EPIPE 的唯一出口）", async () => {
    const stdin: StdinStub = { write: vi.fn(() => true), on: vi.fn(), destroyed: false };
    const client = createClientWith(stdin);
    void client.ensureStarted();

    // 异步 EPIPE 是 emit 出来的，try/catch 拦不住，只有监听器能兜住
    expect(stdin.on, "没有 error 监听器时 Node 会把 EPIPE 升级成 uncaughtException").toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
    // 监听器本身必须能安全吞掉错误，不能再抛
    const handler = stdin.on!.mock.calls.find(c => c[0] === "error")?.[1] as (e: Error) => void;
    expect(() => handler(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
  });
});
