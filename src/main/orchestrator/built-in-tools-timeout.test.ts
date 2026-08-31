import { EventEmitter } from "node:events";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { executeToolDefinition } from "./tool-executor";
import { toolRegistry } from "./tool-registry";

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("child_process", () => ({ spawn: childProcessMock.spawn }));

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn();

  constructor(readonly pid: number) {
    super();
  }
}

describe.runIf(process.platform === "win32")("run_shell timeout lifecycle", () => {
  let commandChild: FakeChildProcess;
  let nextPid = 4100;

  beforeAll(async () => {
    await import("./built-in-tools");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    childProcessMock.spawn.mockReset();
    childProcessMock.spawn.mockImplementation((command: string) => {
      const child = new FakeChildProcess(nextPid++);
      if (command.toLowerCase() !== "taskkill") commandChild = child;
      return child;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function run(command = "npx serve . -l 3456") {
    const tool = toolRegistry.getById("run_shell");
    if (!tool) throw new Error("run_shell was not registered");
    return executeToolDefinition(
      tool,
      { command },
      { permissionMode: "allow_all" } as never,
    );
  }

  async function start(command?: string) {
    const pending = run(command);
    await vi.advanceTimersByTimeAsync(0);
    expect(commandChild).toBeDefined();
    return { pending };
  }

  it("settles as failed after the idle timeout even when close never arrives", async () => {
    let settled = false;
    const { pending } = await start();
    pending.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const outcome = await pending;

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", String(commandChild.pid), "/T", "/F"],
      expect.objectContaining({ shell: false }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorCode: "E_TOOL_TIMEOUT",
      category: "timeout",
      effectState: "unknown",
    });
    expect(JSON.parse(outcome.output)).toMatchObject({
      command: "npx serve . -l 3456",
      exitCode: null,
      timedOut: true,
    });
  });

  it("resets the idle deadline whenever the command produces output", async () => {
    let settled = false;
    const { pending } = await start("long-build");
    pending.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(119_999);
    commandChild.stdout.emit("data", Buffer.from("still working"));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBe(false);

    commandChild.emit("close", 0);
    const outcome = await pending;

    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(JSON.parse(outcome.output)).toMatchObject({
      exitCode: 0,
      stdout: "still working",
      timedOut: false,
    });
  });

  it("enforces the total limit even when output keeps the idle timer alive", async () => {
    const { pending } = await start("endless-progress");
    const progressTimer = setInterval(() => {
      commandChild.stdout.emit("data", Buffer.from("."));
    }, 60_000);

    await vi.advanceTimersByTimeAsync(1_800_000);
    clearInterval(progressTimer);
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({
      status: "failed",
      errorCode: "E_TOOL_TIMEOUT",
      category: "timeout",
    });
    expect(JSON.parse(outcome.output)).toMatchObject({ timedOut: true, exitCode: null });
  });
});
