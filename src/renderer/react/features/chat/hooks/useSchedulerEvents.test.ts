// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSchedulerEvents } from "./useSchedulerEvents";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ChatMessage } from "../../../../../shared/chat-types";

type EventCallback = (event: unknown) => void;

let root: Root | null = null;
let host: HTMLElement | null = null;
let listener: EventCallback | null = null;
let activeSessionId: string | undefined = "session-a";
let appended: Array<{ sessionId: string; items: ChatMessageItem[] }> = [];
let patched: Array<{ sessionId: string; id: string; patch: Partial<ChatMessageItem> }> = [];
let persisted: Array<{ sessionId: string; message: ChatMessage }> = [];

function emit(event: unknown): void {
  act(() => {
    listener?.(event);
  });
}

beforeEach(() => {
  listener = null;
  activeSessionId = "session-a";
  appended = [];
  patched = [];
  persisted = [];
  (window as unknown as { schedulerEvents?: unknown }).schedulerEvents = {
    onEvent: (callback: EventCallback) => {
      listener = callback;
      return () => { listener = null; };
    },
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  function Probe() {
    useSchedulerEvents({
      getActiveSessionId: () => activeSessionId,
      appendMessages: (sessionId, items) => { appended.push({ sessionId, items }); },
      patchMessage: (sessionId, id, patch) => { patched.push({ sessionId, id, patch }); },
      persistMessage: (sessionId, message) => { persisted.push({ sessionId, message }); },
    });
    return null;
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(Probe));
  });
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (host) {
    host.remove();
    host = null;
  }
  delete (window as unknown as { schedulerEvents?: unknown }).schedulerEvents;
});

describe("useSchedulerEvents", () => {
  it("触发事件在当前会话插入提示消息与助手占位并落库提示", () => {
    emit({
      type: "CUSTOM",
      name: "scheduler.started",
      schedulerRunId: "hist-1",
      schedulerTaskId: "task-1",
      value: { taskId: "task-1", title: "每日摘要", manual: true, runId: "hist-1" },
    });

    expect(appended).toHaveLength(1);
    expect(appended[0].sessionId).toBe("session-a");
    const [notice, reply] = appended[0].items;
    expect(notice.content).toBe("定时任务「每日摘要」已触发");
    expect(notice.role).toBe("assistant");
    expect(reply.loading).toBe(true);
    expect(reply.waitingForFirstEvent).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].message.role).toBe("model");
    expect(persisted[0].message.content).toContain("每日摘要");
  });

  it("无激活会话时不插入消息且后续事件被忽略", () => {
    activeSessionId = undefined;
    emit({
      type: "CUSTOM",
      name: "scheduler.started",
      schedulerRunId: "hist-2",
      value: { title: "清理任务" },
    });
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: "hello", schedulerRunId: "hist-2" });
    emit({ type: "RUN_FINISHED", schedulerRunId: "hist-2" });

    expect(appended).toHaveLength(0);
    expect(patched).toHaveLength(0);
    expect(persisted).toHaveLength(0);
  });

  it("流式文本累积补丁到占位消息，终态落库完整回复", () => {
    emit({
      type: "CUSTOM",
      name: "scheduler.started",
      schedulerRunId: "hist-3",
      value: { title: "天气播报" },
    });
    emit({ type: "TEXT_MESSAGE_START", schedulerRunId: "hist-3" });
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: "今天", schedulerRunId: "hist-3" });
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: "晴天", schedulerRunId: "hist-3" });
    emit({ type: "TEXT_MESSAGE_END", schedulerRunId: "hist-3" });
    emit({ type: "RUN_FINISHED", schedulerRunId: "hist-3" });

    const contentPatches = patched.filter((entry) => entry.patch.content !== undefined);
    expect(contentPatches.at(-1)!.patch.content).toBe("今天晴天");
    const finalPatch = patched.at(-1)!;
    expect(finalPatch.patch.streaming).toBe(false);
    expect(finalPatch.patch.loading).toBe(false);
    expect(persisted.at(-1)!.message.content).toBe("今天晴天");
  });

  it("工具调用事件补丁 toolExecutions，无文本时终态汇总工具结果", () => {
    emit({
      type: "CUSTOM",
      name: "scheduler.started",
      schedulerRunId: "hist-4",
      value: { title: "磁盘巡检" },
    });
    emit({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "disk_usage", schedulerRunId: "hist-4" });
    emit({ type: "TOOL_CALL_RESULT", toolCallId: "t1", content: "C: 80%", status: "success", schedulerRunId: "hist-4" });
    emit({ type: "RUN_FINISHED", schedulerRunId: "hist-4" });

    const toolPatches = patched.filter((entry) => entry.patch.toolExecutions !== undefined);
    expect(toolPatches.at(-1)!.patch.toolExecutions).toEqual([
      { id: "t1", name: "disk_usage", status: "success", result: "C: 80%" },
    ]);
    const final = persisted.at(-1)!.message;
    expect(final.content).toBe("disk_usage：完成");
    expect(final.toolExecutions).toEqual([
      { id: "t1", name: "disk_usage", status: "success", result: "C: 80%" },
    ]);
  });

  it("RUN_ERROR 终态展示并落库失败信息", () => {
    emit({
      type: "CUSTOM",
      name: "scheduler.started",
      schedulerRunId: "hist-5",
      value: { title: "失败任务" },
    });
    emit({ type: "RUN_ERROR", message: "模型超时", schedulerRunId: "hist-5" });

    expect(patched.at(-1)!.patch.content).toBe("定时任务执行失败：模型超时");
    expect(persisted.at(-1)!.message.content).toBe("定时任务执行失败：模型超时");
  });

  it("卸载后解除监听：回调不再触发消息写入", () => {
    act(() => {
      root!.unmount();
    });
    root = null;
    listener?.({ type: "CUSTOM", name: "scheduler.started", schedulerRunId: "hist-6" });
    expect(appended).toHaveLength(0);
    expect(persisted).toHaveLength(0);
  });
});
