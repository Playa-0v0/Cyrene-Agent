import { beforeEach, describe, expect, it, vi } from "vitest";

const { handle } = vi.hoisted(() => ({
  handle: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle },
}));

import {
  registerChoiceIpc,
  requestUserClarification,
  setChoiceCardSender,
} from "./user-choice";
import type { AskUserAnswer } from "../shared/ask-clarification";

describe("requestUserClarification", () => {
  beforeEach(() => {
    handle.mockReset();
  });

  it("round-trips a structured multi-field answer through the existing choice IPC", async () => {
    let sent: { id: string } | undefined;
    setChoiceCardSender((card) => {
      sent = card;
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
    const answer: AskUserAnswer = {
      requestId: sent!.id,
      answers: [{ field: "topic", customText: "项目说明" }],
    };
    const ipcHandler = handle.mock.calls[0]?.[1] as (
      event: unknown,
      payload: { id: string; answer: AskUserAnswer },
    ) => unknown;
    ipcHandler({}, { id: sent!.id, answer });

    await expect(pending).resolves.toEqual(answer);
  });
});
