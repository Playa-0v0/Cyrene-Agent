import { describe, expect, it } from "vitest";
import { TtsSessionService } from "./tts-session-service";
import type { StartTtsRequest, TtsStartResult } from "../../shared/tts-session";

function request(requestId: string): StartTtsRequest {
  return { requestId, conversationId: "c1", messageId: "m1", speechText: "hello", converterVersion: "raw-v1" };
}

describe("TtsSessionService", () => {
  it("returns cancelled when an in-flight request is cancelled", async () => {
    let resolve!: (result: TtsStartResult) => void;
    const service = new TtsSessionService(() => new Promise((next) => { resolve = next; }));
    const pending = service.start(request("r1"));

    expect(service.cancel("r1")).toBe(true);
    resolve({ requestId: "r1", status: "ready", base64: "audio", cacheKey: "key", format: "mp3", cached: false });

    await expect(pending).resolves.toEqual({ requestId: "r1", status: "cancelled" });
  });

  it("isolates concurrent requests by requestId", async () => {
    const resolvers = new Map<string, (result: TtsStartResult) => void>();
    const service = new TtsSessionService((input) => new Promise((resolve) => resolvers.set(input.requestId, resolve)));
    const first = service.start(request("r1"));
    const second = service.start(request("r2"));
    resolvers.get("r2")!({ requestId: "r2", status: "ready", base64: "two", cacheKey: "k2", format: "mp3", cached: false });
    resolvers.get("r1")!({ requestId: "r1", status: "ready", base64: "one", cacheKey: "k1", format: "mp3", cached: false });

    await expect(first).resolves.toMatchObject({ requestId: "r1", base64: "one" });
    await expect(second).resolves.toMatchObject({ requestId: "r2", base64: "two" });
  });

  it("keeps a streaming request cancellable until its completion settles", async () => {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const service = new TtsSessionService(async () => ({
      result: { requestId: "r-stream", status: "streaming", cacheKey: "key", format: "mp3" },
      completion,
    }));

    await expect(service.start(request("r-stream"))).resolves.toMatchObject({ status: "streaming" });
    expect(service.cancel("r-stream")).toBe(true);
    finish();
    await completion;
    expect(service.cancel("r-stream")).toBe(false);
  });

  it("drops late events from a cancelled stream", async () => {
    let emitLate!: () => void;
    const received: string[] = [];
    const service = new TtsSessionService(async (_input, _signal, emit) => {
      emitLate = () => emit({ requestId: "r-late", type: "audio-chunk", base64: "late", format: "mp3" });
      return {
        result: { requestId: "r-late", status: "streaming", cacheKey: "key", format: "mp3" },
        completion: new Promise<void>(() => undefined),
      };
    });

    await service.start(request("r-late"), (event) => received.push(event.type));
    service.cancel("r-late");
    emitLate();
    expect(received).toEqual([]);
  });
});
