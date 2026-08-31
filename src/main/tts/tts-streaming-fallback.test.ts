import { describe, expect, it, vi } from "vitest";
import type { TtsSessionEvent } from "../../shared/tts-session";
import { runTtsStreamingWithFallback } from "./tts-streaming-fallback";

describe("runTtsStreamingWithFallback", () => {
  it("streams chunks, persists the complete result, and completes once", async () => {
    const events: TtsSessionEvent[] = [];
    const persist = vi.fn();
    await runTtsStreamingWithFallback({
      requestId: "r1",
      cacheKey: `minimax-${"a".repeat(64)}`,
      format: "mp3",
      signal: new AbortController().signal,
      stream: async (onChunk) => {
        onChunk("YQ==");
        onChunk("Yg==");
        return Buffer.from("ab");
      },
      fallback: vi.fn(),
      persist,
      emit: (event) => events.push(event),
    });

    expect(events.map((event) => event.type)).toEqual(["audio-chunk", "audio-chunk", "stream-completed"]);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("resets partial streaming playback before returning one complete fallback", async () => {
    const events: TtsSessionEvent[] = [];
    await runTtsStreamingWithFallback({
      requestId: "r2",
      cacheKey: `minimax-${"b".repeat(64)}`,
      format: "mp3",
      signal: new AbortController().signal,
      stream: async (onChunk) => {
        onChunk("cGFydGlhbA==");
        throw new Error("stream failed");
      },
      fallback: async () => Buffer.from("complete"),
      persist: vi.fn(),
      emit: (event) => events.push(event),
    });

    expect(events.map((event) => event.type)).toEqual([
      "audio-chunk",
      "fallback-started",
      "fallback-ready",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "fallback-ready", base64: Buffer.from("complete").toString("base64") });
  });

  it("emits nothing after cancellation and never starts fallback", async () => {
    const controller = new AbortController();
    const events: TtsSessionEvent[] = [];
    const fallback = vi.fn(async () => Buffer.from("fallback"));
    await runTtsStreamingWithFallback({
      requestId: "r3",
      cacheKey: `minimax-${"c".repeat(64)}`,
      format: "mp3",
      signal: controller.signal,
      stream: async (onChunk) => {
        controller.abort();
        onChunk("bGF0ZQ==");
        throw new Error("aborted");
      },
      fallback,
      persist: vi.fn(),
      emit: (event) => events.push(event),
    });

    expect(events).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
  });
});
