import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC, type SpeechInputCommitRequest, type SpeechInputCommitResult } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import { createSpeechInputCommitBridge } from "./speech-input-commit-bridge";
import type { FrozenSpeechInputTarget } from "./speech-input-service";

type ResultListener = (event: unknown, payload: unknown) => void;

/** 假 IpcScope：只关心 commit-result 的 on 注册。 */
function fakeIpcScope() {
  const listeners = new Map<string, ResultListener>();
  const scope: IpcScope = {
    handle: () => {},
    removeHandler: () => {},
    on: (channel, listener) => {
      listeners.set(channel, listener as ResultListener);
    },
    dispose: () => {},
  };
  return {
    scope,
    emit: (channel: string, payload: unknown) => {
      listeners.get(channel)?.({}, payload);
    },
  };
}

function fakeWebContents() {
  const sent: unknown[] = [];
  return {
    id: 7,
    isDestroyed: () => false,
    send: (_channel: string, payload: unknown) => {
      sent.push(payload);
    },
    sent,
  };
}

const target: FrozenSpeechInputTarget = {
  sessionId: "s1",
  mode: "chat",
  rendererTargetId: "rt-1",
  webContentsId: 7,
};

function resultOf(
  request: SpeechInputCommitRequest,
  overrides: Partial<SpeechInputCommitResult>,
): SpeechInputCommitResult {
  return {
    requestId: request.requestId,
    rendererTargetId: request.rendererTargetId,
    ok: true,
    ...overrides,
  };
}

describe("createSpeechInputCommitBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("commit 发出携带冻结目标的请求，结果回显后 resolve", async () => {
    const ipc = fakeIpcScope();
    const wc = fakeWebContents();
    const bridge = createSpeechInputCommitBridge(ipc.scope, { lookupWebContents: () => wc });

    const promise = bridge.commit(target, "你好");
    expect(wc.sent).toHaveLength(1);
    const request = wc.sent[0] as SpeechInputCommitRequest;
    expect(request).toMatchObject({
      rendererTargetId: "rt-1",
      sessionId: "s1",
      mode: "chat",
      text: "你好",
    });

    ipc.emit(IPC.SPEECH_INPUT_COMMIT_RESULT, resultOf(request, {}));
    await expect(promise).resolves.toBeUndefined();
  });

  it("rendererTargetId 不匹配或 requestId 不匹配的迟到结果被忽略", async () => {
    const ipc = fakeIpcScope();
    const wc = fakeWebContents();
    const bridge = createSpeechInputCommitBridge(ipc.scope, { lookupWebContents: () => wc });

    const promise = bridge.commit(target, "你好");
    const request = wc.sent[0] as SpeechInputCommitRequest;

    // 错误渲染目标的回显被忽略
    ipc.emit(IPC.SPEECH_INPUT_COMMIT_RESULT, {
      ...resultOf(request, {}),
      rendererTargetId: "rt-other",
    });
    // 错误 requestId 被忽略
    ipc.emit(IPC.SPEECH_INPUT_COMMIT_RESULT, {
      ...resultOf(request, {}),
      requestId: "req-other",
    });
    // 非法负载被忽略
    ipc.emit(IPC.SPEECH_INPUT_COMMIT_RESULT, { nope: 1 });

    ipc.emit(IPC.SPEECH_INPUT_COMMIT_RESULT, resultOf(request, {}));
    await expect(promise).resolves.toBeUndefined();
  });

  it("失败结果以稳定错误码 reject，未知错误码归一化为 E_INTERNAL", async () => {
    const ipc = fakeIpcScope();
    const wc = fakeWebContents();
    const bridge = createSpeechInputCommitBridge(ipc.scope, { lookupWebContents: () => wc });

    const failed = bridge.commit(target, "A");
    const requestA = wc.sent[0] as SpeechInputCommitRequest;
    ipc.emit(IPC.SPEECH_INPUT_COMMIT_RESULT, resultOf(requestA, {
      ok: false,
      error: { code: "E_NOT_FOUND", message: "会话已删除" },
    }));
    await expect(failed).rejects.toMatchObject({ code: "E_NOT_FOUND" });

    const unknownCode = bridge.commit(target, "B");
    const requestB = wc.sent[1] as SpeechInputCommitRequest;
    ipc.emit(IPC.SPEECH_INPUT_COMMIT_RESULT, resultOf(requestB, {
      ok: false,
      error: { code: "SOMETHING_ELSE", message: "奇怪的错误" },
    }));
    await expect(unknownCode).rejects.toMatchObject({ code: "E_INTERNAL" });
  });

  it("目标 webContents 不存在或已销毁返回 E_NO_ACTIVE_INPUT_TARGET", async () => {
    const ipc = fakeIpcScope();
    const bridge = createSpeechInputCommitBridge(ipc.scope, {
      lookupWebContents: () => null,
    });
    await expect(bridge.commit(target, "你好")).rejects.toMatchObject({
      code: "E_NO_ACTIVE_INPUT_TARGET",
    });

    const destroyed = { id: 7, isDestroyed: () => true, send: vi.fn() };
    const bridge2 = createSpeechInputCommitBridge(ipc.scope, {
      lookupWebContents: () => destroyed as never,
    });
    await expect(bridge2.commit(target, "你好")).rejects.toMatchObject({
      code: "E_NO_ACTIVE_INPUT_TARGET",
    });
  });

  it("渲染页长时间未响应按超时失败", async () => {
    const ipc = fakeIpcScope();
    const wc = fakeWebContents();
    const bridge = createSpeechInputCommitBridge(ipc.scope, { lookupWebContents: () => wc });

    const promise = bridge.commit(target, "你好");
    const assertion = expect(promise).rejects.toMatchObject({ code: "E_INTERNAL" });
    vi.advanceTimersByTime(15_001);
    await assertion;

    // 超时后迟到的结果不会让 promise 二次结算
    const request = wc.sent[0] as SpeechInputCommitRequest;
    ipc.emit(IPC.SPEECH_INPUT_COMMIT_RESULT, resultOf(request, {}));
  });
});
