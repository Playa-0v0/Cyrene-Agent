import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { handle } = vi.hoisted(() => ({
  handle: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "C:/tmp/cyrene-test") },
  ipcMain: { handle },
}));

import {
  cancelPendingChoicesForRun,
  registerChoiceIpc,
  requestUserClarification,
  setChoiceCardSender,
} from "./user-choice";
import type { AskCardPayload, AskCardSubmission } from "../shared/ask-clarification";

describe("requestUserClarification", () => {
  beforeEach(() => {
    handle.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a structured multi-field answer through the existing choice IPC", async () => {
    let sent: AskCardPayload | undefined;
    setChoiceCardSender((card) => {
      if ("interactionId" in card) sent = card;
    });
    registerChoiceIpc();

    const pending = requestUserClarification({
      intro: "伙伴，还需要确认两件事呀。",
      questions: [{
        field: "topic",
        question: "这份文档主要写什么？",
        type: "text",
        options: [],
        allowCustom: false,
        freeTextPlaceholder: "例如：项目说明",
      }],
      deferredFields: [],
    });
    const answer: AskCardSubmission = {
      interactionId: sent!.interactionId,
      runId: sent!.runId,
      revision: sent!.revision,
      answers: [{ questionId: sent!.questions[0].id, source: "custom", text: "项目说明" }],
    };
    const ipcHandler = handle.mock.calls[0]?.[1] as (
      event: unknown,
      payload: { id: string; answer: AskCardSubmission },
    ) => unknown;
    ipcHandler({}, { id: sent!.interactionId, answer });

    await expect(pending).resolves.toEqual({
      requestId: sent!.interactionId,
      answers: [{ field: "topic", customText: "项目说明" }],
    });
  });

  it("uses the current AG-UI run sender instead of the legacy global window sender when provided", async () => {
    const legacySender = vi.fn();
    const runSender = vi.fn();
    setChoiceCardSender(legacySender);

    const pending = requestUserClarification({
      intro: "还需要确认一下。",
      questions: [{
        field: "format",
        question: "需要什么格式？",
        type: "single_select",
        options: [{ value: "docx", label: "Word" }],
        allowCustom: false,
        freeTextPlaceholder: "",
      }],
      deferredFields: [],
    }, runSender);

    expect(legacySender).not.toHaveBeenCalled();
    expect(runSender).toHaveBeenCalledOnce();
    const card = runSender.mock.calls[0]?.[0] as AskCardPayload;
    const answer: AskCardSubmission = {
      interactionId: card.interactionId,
      runId: card.runId,
      revision: card.revision,
      answers: [{
        questionId: card.questions[0].id,
        source: "option",
        optionId: card.questions[0].options[0].id,
      }],
    };
    registerChoiceIpc();
    const ipcHandler = handle.mock.calls.at(-1)?.[1] as (
      event: unknown,
      payload: { id: string; answer: AskCardSubmission },
    ) => unknown;
    ipcHandler({}, { id: card.interactionId, answer });

    await expect(pending).resolves.toEqual({
      requestId: card.interactionId,
      answers: [{ field: "format", selectedValues: ["docx"] }],
    });
  });

  it("notifies the scoped sender when a structured clarification times out", async () => {
    vi.useFakeTimers();
    const runSender = vi.fn();
    const onSettled = vi.fn();
    const pending = requestUserClarification({
      intro: "还需要确认一下。",
      questions: [],
      deferredFields: [],
    }, runSender, onSettled);

    const card = runSender.mock.calls[0]?.[0] as AskCardPayload;
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(pending).resolves.toEqual({ requestId: card.interactionId, answers: [] });
    expect(onSettled).toHaveBeenCalledWith({
      id: card.interactionId,
      runId: card.runId,
      revision: card.revision,
      reason: "timeout",
    });
  });

  it("accepts one current opaque submission and rejects stale or duplicate submissions", async () => {
    const runSender = vi.fn();
    const onSettled = vi.fn();
    const pending = requestUserClarification({
      intro: "选择报告格式。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "docx", label: "Word" },
          { value: "pdf", label: "PDF" },
        ],
        allowCustom: false,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    }, runSender, onSettled, { runId: "run-1", revision: 3 });
    const payload = runSender.mock.calls[0]?.[0] as AskCardPayload;
    expect(payload).toMatchObject({ interactionId: expect.any(String), runId: "run-1", revision: 3 });
    expect(JSON.stringify(payload)).not.toContain("docx");

    registerChoiceIpc();
    const ipcHandler = handle.mock.calls.at(-1)?.[1] as (
      event: unknown,
      payload: { id: string; answer: AskCardSubmission },
    ) => { ok: boolean };
    const answer: AskCardSubmission = {
      interactionId: payload.interactionId,
      runId: "run-1",
      revision: 3,
      answers: [{
        questionId: payload.questions[0].id,
        source: "option",
        optionId: payload.questions[0].options[0].id,
      }],
    };

    expect(ipcHandler({}, {
      id: payload.interactionId,
      answer: { ...answer, revision: 2 },
    })).toEqual({ ok: false });
    expect(ipcHandler({}, { id: payload.interactionId, answer })).toEqual({ ok: true });
    expect(ipcHandler({}, { id: payload.interactionId, answer })).toEqual({ ok: false });
    await expect(pending).resolves.toEqual({
      requestId: payload.interactionId,
      answers: [{ field: "format", selectedValues: ["docx"] }],
    });
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith({
      id: payload.interactionId,
      runId: "run-1",
      revision: 3,
      reason: "answered",
    });
  });

  it("settles a structured clarification exactly once when its run is cancelled", async () => {
    vi.useFakeTimers();
    const sender = vi.fn();
    const onSettled = vi.fn();
    let outcome: unknown;

    void requestUserClarification({
      intro: "还需要确认一下。",
      questions: [],
      deferredFields: [],
    }, sender, onSettled, { runId: "run-abort", revision: 1 }).then(
      (value) => { outcome = { status: "resolved", value }; },
      (error) => { outcome = { status: "rejected", name: (error as Error).name }; },
    );

    cancelPendingChoicesForRun("run-abort");
    await Promise.resolve();

    expect(outcome).toEqual({ status: "rejected", name: "AbortError" });
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-abort",
      reason: "cancelled",
    }));

    await vi.advanceTimersByTimeAsync(120_000);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("settles only choices belonging to the cancelled run", async () => {
    const firstSettled = vi.fn();
    const secondSettled = vi.fn();
    let firstOutcome: unknown;
    let secondOutcome: unknown;

    void requestUserClarification({ intro: "first", questions: [], deferredFields: [] }, vi.fn(), firstSettled, {
      runId: "run-first",
      revision: 1,
    }).then(
      (value) => { firstOutcome = { status: "resolved", value }; },
      (error) => { firstOutcome = { status: "rejected", name: (error as Error).name }; },
    );
    void requestUserClarification({ intro: "second", questions: [], deferredFields: [] }, vi.fn(), secondSettled, {
      runId: "run-second",
      revision: 1,
    }).then(
      (value) => { secondOutcome = { status: "resolved", value }; },
      (error) => { secondOutcome = { status: "rejected", name: (error as Error).name }; },
    );

    cancelPendingChoicesForRun("run-first");
    await Promise.resolve();

    expect(firstOutcome).toEqual({ status: "rejected", name: "AbortError" });
    expect(firstSettled).toHaveBeenCalledWith(expect.objectContaining({ reason: "cancelled" }));
    expect(secondOutcome).toBeUndefined();
    expect(secondSettled).not.toHaveBeenCalled();

    cancelPendingChoicesForRun("run-second");
  });
});
