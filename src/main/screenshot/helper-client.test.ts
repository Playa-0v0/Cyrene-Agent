import { describe, expect, it } from "vitest";
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
