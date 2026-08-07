import { EventEmitter } from "events";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  WUWA_TASKS,
  findWuwaTask,
  formatWuwaTaskList,
  createWuwaTaskHandler,
  createWuwaTaskTool,
  wuwaTaskManager,
} from "./wuwa-tool";

describe("wuwa-tool", () => {
  beforeEach(() => {
    wuwaTaskManager.clearQueue();
  });

  it("formats task list correctly without parentheses or English names", () => {
    const list = formatWuwaTaskList();
    expect(list).toContain("每日任務 — 登入、領月卡、刷聲骸與領每日獎勵");
    expect(list).toContain("4C 聲骸 — 副本與大世界刷 4C 聲骸");
    expect(list).toContain("9. 周常樂園 — 自動周常樂園點擊");
    expect(list).not.toContain("(");
    expect(list).not.toContain(")");
    expect(list).not.toContain("（");
    expect(list).not.toContain("）");
  });

  it("finds task by index", () => {
    expect(findWuwaTask(1)?.name).toBe("每日任務");
    expect(findWuwaTask(8)?.taskClass).toBe("MergeEchoTask");
    expect(findWuwaTask(10)).toBeUndefined();
    expect(findWuwaTask(0)).toBeUndefined();
  });

  it("finds task by name, string index, or '鳴潮的xxx' keyphrases", () => {
    expect(findWuwaTask(undefined, "1")?.name).toBe("每日任務");
    expect(findWuwaTask(undefined, "每日")?.name).toBe("每日任務");
    expect(findWuwaTask(undefined, "打鳴潮的每日")?.name).toBe("每日任務");
    expect(findWuwaTask(undefined, "鳴潮的每日任務")?.name).toBe("每日任務");
    expect(findWuwaTask(undefined, "做鳴潮的4C")?.name).toBe("4C 聲骸");
    expect(findWuwaTask(undefined, "刷鳴潮的無音區")?.name).toBe("無音區");
    expect(findWuwaTask(undefined, "周常樂園")?.index).toBe(9);
    expect(findWuwaTask(undefined, "non_existent")).toBeUndefined();
  });

  it("handles 'list' action", async () => {
    const handler = createWuwaTaskHandler({ wuwaDir: "/tmp/fake_wuwa" });
    const result = await handler({ action: "list" });
    expect(result).toContain("好呀！請問今天想讓我幫你打哪一個鳴潮任務呢？");
    expect(result).toContain("1. 每日任務");
  });

  it("queues task if another task is currently running", async () => {
    class FakeChildProcess extends EventEmitter {
      unref() {}
    }

    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    let spawnCount = 0;

    const mockSpawn = vi.fn().mockImplementation(() => {
      spawnCount++;
      return spawnCount === 1 ? child1 : child2;
    });

    const handler = createWuwaTaskHandler({
      wuwaDir: "/Users/clark/wuwa",
      pythonPath: "/Users/clark/wuwa/.venv/bin/python",
      spawnFn: mockSpawn as any,
    });

    const res1 = await handler({ action: "run", taskIndex: 1 });
    expect(res1).toBe("好的，現在就去幫你打每日任務囉！請夥伴安心休息 ✨");
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const res2 = await handler({ action: "run", taskIndex: 2 });
    expect(res2).toBe("好的！等我打完每日任務，就去幫你打4C 聲骸喔！✨");
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    child1.emit("exit", 0);

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const [cmd, args] = mockSpawn.mock.calls[1];
    expect(cmd).toBe("/Users/clark/wuwa/.venv/bin/python");
    expect(args).toEqual(["main.py", "-h", "-t", "2"]);
  });

  it("returns error on invalid task selection during 'run'", async () => {
    const handler = createWuwaTaskHandler({ wuwaDir: "/Users/clark/wuwa" });
    const result = await handler({ action: "run", taskIndex: 99 });
    expect(result).toContain("[錯誤] 未能識別要執行的鳴潮任務。");
  });

  it("creates valid tool definition", () => {
    const tool = createWuwaTaskTool();
    expect(tool.id).toBe("wuwa_task");
    expect(tool.enabled).toBe(true);
    expect(tool.inputSchema.required).toContain("action");
  });
});
