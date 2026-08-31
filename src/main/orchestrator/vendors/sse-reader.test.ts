import { describe, expect, test } from "vitest";
import { createSseReader } from "./index";
import type { ChatVendorAdapter, StreamEvent } from "./types";

const unusedAdapter = {} as ChatVendorAdapter;

function bodyFrom(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function read(parts: string[]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of createSseReader(unusedAdapter, bodyFrom(parts))) events.push(event);
  return events;
}

describe("createSseReader", () => {
  test("supports CRLF event boundaries", async () => {
    await expect(read([
      "data: {\"n\":1}\r\n\r\ndata: {\"n\":2}\r\n\r\n",
    ])).resolves.toEqual([
      { eventType: "data", data: '{"n":1}' },
      { eventType: "data", data: '{"n":2}' },
    ]);
  });

  test("keeps a boundary split across byte chunks", async () => {
    await expect(read(["data: one\r", "\n\r", "\ndata: two\n", "\n"]))
      .resolves.toEqual([
        { eventType: "data", data: "one" },
        { eventType: "data", data: "two" },
      ]);
  });

  test("skips keep-alive comments and joins multiple data lines", async () => {
    await expect(read([
      ": keep-alive\n\ndata: first\ndata: second\n\n",
    ])).resolves.toEqual([{ eventType: "data", data: "first\nsecond" }]);
  });
});
