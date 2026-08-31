import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileToolOutputStore,
  ToolOutputCorruptError,
  ToolOutputInvalidInputError,
  toolOutputRecordId,
} from "./file-tool-output-store";

const roots: string[] = [];

async function makeStore(): Promise<{ root: string; store: FileToolOutputStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "cyrene-tool-output-"));
  roots.push(root);
  return { root, store: new FileToolOutputStore(root, { now: () => 1234 }) };
}

function input(output = "完整工具输出"): Parameters<FileToolOutputStore["put"]>[0] {
  return {
    conversationId: "conversation-a",
    runId: "run-a",
    toolCallId: "call-a",
    toolName: "search_code",
    outcome: "success",
    output,
    truncatedForModel: output.length > 8_192,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileToolOutputStore", () => {
  it("uses a deterministic opaque record id for one logical invocation", () => {
    expect(toolOutputRecordId("conversation-a", "run-a", "call-a"))
      .toBe(createHash("sha256").update("conversation-a\0run-a\0call-a").digest("hex"));
    expect(toolOutputRecordId("conversation-a", "run-a", "call-a"))
      .toBe(toolOutputRecordId("conversation-a", "run-a", "call-a"));
    expect(toolOutputRecordId("conversation-a", "run-b", "call-a"))
      .not.toBe(toolOutputRecordId("conversation-a", "run-a", "call-a"));
  });

  it("persists the full output and returns the same record for a replay", async () => {
    const { store } = await makeStore();
    const first = await store.put(input("HEAD😀MIDDLE昔涟TAIL"));
    const replay = await store.put(input("different retry output must not replace the first fact"));

    expect(replay).toEqual(first);
    expect(first.resultRef).toBe(`tool-result://v1/${first.recordId}`);
    expect(first.bytes).toBe(Buffer.byteLength("HEAD😀MIDDLE昔涟TAIL", "utf8"));
    expect(first.codePoints).toBe(Array.from("HEAD😀MIDDLE昔涟TAIL").length);

    await expect(store.read({
      conversationId: "conversation-a",
      resultRef: first.resultRef,
      offset: 0,
      length: 8_192,
    })).resolves.toMatchObject({ content: "HEAD😀MIDDLE昔涟TAIL", totalCodePoints: 17 });
  });

  it("does not let another conversation resolve an opaque result ref", async () => {
    const { store } = await makeStore();
    const ref = await store.put(input());

    await expect(store.read({
      conversationId: "conversation-b",
      resultRef: ref.resultRef,
      offset: 0,
      length: 100,
    })).resolves.toBeNull();
  });

  it("finds and reads with the same Unicode code-point coordinate system", async () => {
    const { store } = await makeStore();
    const ref = await store.put(input("AAA😀BBB昔涟CCC"));
    const found = await store.find({
      conversationId: "conversation-a",
      resultRef: ref.resultRef,
      query: "昔涟",
    });

    expect(found?.matches).toHaveLength(1);
    const offset = found!.matches[0].offset;
    expect(offset).toBe(7);

    await expect(store.read({
      conversationId: "conversation-a",
      resultRef: ref.resultRef,
      offset,
      length: 2,
    })).resolves.toMatchObject({ content: "昔涟" });
  });

  it("rejects an invalid range and detects corrupted output", async () => {
    const { root, store } = await makeStore();
    const ref = await store.put(input("safe output"));

    await expect(store.read({
      conversationId: "conversation-a",
      resultRef: ref.resultRef,
      offset: -1,
      length: 10,
    })).rejects.toBeInstanceOf(ToolOutputInvalidInputError);

    const conversationHash = createHash("sha256").update("conversation-a").digest("hex");
    const outputPath = path.join(root, "cyrene-runs", "tool-results", conversationHash, "records", ref.recordId, "output.txt");
    await writeFile(outputPath, "tampered", "utf8");

    await expect(store.read({
      conversationId: "conversation-a",
      resultRef: ref.resultRef,
      offset: 0,
      length: 10,
    })).rejects.toBeInstanceOf(ToolOutputCorruptError);
  });

  it("writes metadata only after the complete output is available", async () => {
    const { root, store } = await makeStore();
    const ref = await store.put(input("durable enough for process recovery"));
    const conversationHash = createHash("sha256").update("conversation-a").digest("hex");
    const recordDir = path.join(root, "cyrene-runs", "tool-results", conversationHash, "records", ref.recordId);
    const meta = JSON.parse(await readFile(path.join(recordDir, "meta.json"), "utf8"));

    expect(meta).toMatchObject({
      schemaVersion: 1,
      recordId: ref.recordId,
      toolCallId: "call-a",
      sha256: createHash("sha256").update("durable enough for process recovery", "utf8").digest("hex"),
    });
  });
});
