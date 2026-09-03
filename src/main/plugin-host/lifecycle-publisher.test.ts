import { describe, expect, it, vi } from "vitest";
import { createLifecyclePublisher } from "./lifecycle-publisher";

function makeDeps() {
  const published: Array<{ event: string; payload: any }> = [];
  const publish = vi.fn(async (event: string, payload: unknown) => {
    published.push({ event, payload });
  });
  return { publish, published };
}

describe("createLifecyclePublisher", () => {
  it("轮次开始/结束与调度结束事件发布到对应事件名并盖章元数据", async () => {
    const { publish, published } = makeDeps();
    const publisher = createLifecyclePublisher({
      publish,
      eventId: () => "evt-1",
      now: () => new Date("2026-09-03T10:00:00Z"),
    });

    publisher.publishTurnStarted({
      source: "channel",
      channel: "telegram",
      conversationId: "session-1",
      runId: "run-1",
      mode: "chat",
    });
    publisher.publishTurnFinished({
      source: "scheduler",
      runId: "run-2",
      mode: "work",
      taskId: "task-1",
      schedulerRunId: "hist-1",
      status: "success",
      durationMs: 1200,
    });
    publisher.publishSchedulerFinished({
      taskId: "task-1",
      schedulerRunId: "hist-1",
      status: "success",
      durationMs: 1200,
    });

    await vi.waitFor(() => expect(published).toHaveLength(3));
    expect(published[0]).toEqual({
      event: "turn:started",
      payload: {
        source: "channel",
        channel: "telegram",
        conversationId: "session-1",
        runId: "run-1",
        mode: "chat",
        eventId: "evt-1",
        timestamp: "2026-09-03T10:00:00.000Z",
      },
    });
    expect(published[1].event).toBe("turn:finished");
    expect(published[1].payload).toMatchObject({
      source: "scheduler",
      status: "success",
      schedulerRunId: "hist-1",
      eventId: "evt-1",
    });
    expect(published[2].event).toBe("scheduler:finished");
    expect(published[2].payload).toMatchObject({
      taskId: "task-1",
      schedulerRunId: "hist-1",
      eventId: "evt-1",
    });
  });

  it("调用方输入无法覆盖 eventId 与 timestamp", async () => {
    const { publish, published } = makeDeps();
    const publisher = createLifecyclePublisher({
      publish,
      eventId: () => "host-event-id",
      now: () => new Date("2026-09-03T11:00:00Z"),
    });

    publisher.publishTurnFinished({
      source: "channel",
      channel: "telegram",
      conversationId: "session-1",
      runId: "run-1",
      mode: "chat",
      status: "success",
      durationMs: 0,
      eventId: "伪造事件id",
      timestamp: "伪造时间戳",
    } as any);

    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0].payload.eventId).toBe("host-event-id");
    expect(published[0].payload.timestamp).toBe("2026-09-03T11:00:00.000Z");
  });

  it("发布失败只记录告警，不向调用方抛出", async () => {
    const publish = vi.fn(async () => {
      throw new Error("总线不可用");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const publisher = createLifecyclePublisher({ publish });

    expect(() =>
      publisher.publishSchedulerFinished({
        taskId: "task-1",
        schedulerRunId: "hist-1",
        status: "runtime_error",
        durationMs: 5,
      }),
    ).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0][0]).toContain("scheduler:finished");
    warn.mockRestore();
  });

  it("默认使用随机 UUID 与当前时间生成元数据", async () => {
    const { publish, published } = makeDeps();
    const publisher = createLifecyclePublisher({ publish });

    publisher.publishTurnStarted({
      source: "channel",
      channel: "telegram",
      conversationId: "session-1",
      runId: "run-1",
      mode: "work",
    });

    await vi.waitFor(() => expect(published).toHaveLength(1));
    const { eventId, timestamp } = published[0].payload;
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
  });
});
