import { describe, expect, it } from "vitest";
import { parseHelperEvent, resolveCompletedFile } from "./protocol";

describe("screenshot helper protocol", () => {
  it("accepts capture-released as a non-terminal event", () => {
    expect(parseHelperEvent(
      '{"type":"capture-released","requestId":"r1","clipboardWritten":true,"width":800,"height":600}',
    )).toMatchObject({ type: "capture-released", requestId: "r1" });
  });

  it("validates every helper event shape at runtime", () => {
    const validEvents = [
      '{"type":"ready","protocolVersion":1}',
      '{"type":"accepted","requestId":"r1"}',
      '{"type":"overlay-visible","requestId":"r1","freezeDurationMs":0}',
      '{"type":"interaction-state","requestId":"r1","state":"selecting"}',
      '{"type":"capture-released","requestId":"r1","clipboardWritten":true,"width":1,"height":1}',
      '{"type":"completed","requestId":"r1","fileName":null,"width":1,"height":1,"mime":"image/png","clipboardWritten":true,"hasAnnotations":false}',
      '{"type":"cancelled","requestId":"r1","reason":"escape"}',
      '{"type":"error","requestId":null,"code":"capture-failed","message":"no display","recoverable":false}',
    ];

    for (const line of validEvents) {
      expect(parseHelperEvent(line)).toHaveProperty("type");
    }

    expect(() => parseHelperEvent('{"type":"completed","requestId":"r1","fileName":7,"width":0,"height":1,"mime":"image/jpeg","clipboardWritten":"yes"}'))
      .toThrow("INVALID_HELPER_EVENT");
    expect(() => parseHelperEvent('{"type":"interaction-state","requestId":"r1","state":"drawing"}'))
      .toThrow("INVALID_HELPER_EVENT");
    expect(() => parseHelperEvent('{"type":"completed","requestId":"r1","fileName":"..\\\\evil.png","width":1,"height":1,"mime":"image/png","clipboardWritten":true}'))
      .toThrow("INVALID_HELPER_EVENT");
    expect(parseHelperEvent(
      '{"type":"completed","requestId":"r1","fileName":null,"width":1,"height":1,"mime":"image/png","clipboardWritten":true,"hasAnnotations":true}',
    )).toMatchObject({ type: "completed", hasAnnotations: true });
  });

  it("rejects path traversal file names", () => {
    expect(() => resolveCompletedFile("C:\\shots", "..\\evil.png")).toThrow("INVALID_SCREENSHOT_FILE_NAME");
  });

  it("accepts only UUID v4 png names", () => {
    expect(resolveCompletedFile(
      "C:\\shots",
      "00000000-0000-4000-8000-000000000001.png",
    )).toBe("C:\\shots\\00000000-0000-4000-8000-000000000001.png");
    expect(() => resolveCompletedFile("C:\\shots", "00000000-0000-1000-8000-000000000001.png"))
      .toThrow("INVALID_SCREENSHOT_FILE_NAME");
  });
});
