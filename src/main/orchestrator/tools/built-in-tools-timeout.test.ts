import { EventEmitter } from "node:events";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { executeToolDefinition } from "./registry/tool-executor";
import { toolRegistry } from "./registry/tool-registry";

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

  function run(command = "npx serve . -l 3456", timeout_ms?: number) {
    const tool = toolRegistry.getById("run_shell");
    if (!tool) throw new Error("run_shell was not registered");
    return executeToolDefinition(
      tool,
      { command, ...(timeout_ms !== undefined ? { timeout_ms } : {}) },
      { permissionMode: "allow_all" } as never,
    );
  }

  async function start(command?: string, timeout_ms?: number) {
    const pending = run(command, timeout_ms);
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
  it("显式 timeout_ms=300000 禁用 idle：130 秒无输出不杀，只受 total 上限约束", async () => {
    let settled = false;
    const { pending } = await start("silent-long-task", 300_000);
    pending.finally(() => { settled = true; });

    // 默认 idle 窗口（120s）已过，但显式 deadline 下不做无输出检测 → 不杀
    await vi.advanceTimersByTimeAsync(130_000);
    expect(settled).toBe(false);

    // 推进到 300s 总上限 → 终止
    await vi.advanceTimersByTimeAsync(170_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({ status: "failed", errorCode: "E_TOOL_TIMEOUT", category: "timeout" });
    const parsed = JSON.parse(outcome.output);
    expect(parsed).toMatchObject({ timedOut: true, exitCode: null });
    expect(parsed.stderr).toContain("timeout_ms=300000 毫秒执行上限");
  });

  it("kill 后 close 先于宽限期到达：仍如实上报 timedOut=true 与终止原因（而非伪装成正常退出）", async () => {
    const { pending } = await start();
    await vi.advanceTimersByTimeAsync(121_000); // idle 触发 → killTree
    commandChild.emit("close", 1);              // taskkill 收尸快，close 在 2s 宽限内到达
    const outcome = await pending;

    expect(outcome).toMatchObject({ status: "failed", errorCode: "E_TOOL_TIMEOUT", category: "timeout" });
    const parsed = JSON.parse(outcome.output);
    expect(parsed).toMatchObject({ timedOut: true, exitCode: null });
    expect(parsed.stderr).toContain("[已终止]");
    expect(parsed.stderr).toContain("无任何输出");
  });
});
