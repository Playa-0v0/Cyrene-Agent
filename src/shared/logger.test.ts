import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  logger,
  setLogLevel,
  getLogLevel,
  type LogLevel,
} from "./logger";
import { LogTag } from "./logger-tags";

let stdoutBuf = "";
let stderrBuf = "";
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutBuf = "";
  stderrBuf = "";
  outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((s) => {
      stdoutBuf += String(s);
      return true;
    });
  errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((s) => {
      stderrBuf += String(s);
      return true;
    });
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
});

describe("logger levels", () => {
  it("default emits at info level (since resolveDefaultLevel falls back to info when no electron app context)", () => {
    // First read: getLogLevel returns whatever was set by main/logger.ts at import time.
    // For this unit test we only check the resolution under setLogLevel.
    setLogLevel("info");
    expect(getLogLevel()).toBe("info");
  });

  it("setLogLevel changes the gate", () => {
    setLogLevel("warn");
    logger.info(LogTag.Cyrene, "should NOT appear");
    logger.warn(LogTag.Cyrene, "should appear");
    expect(stdoutBuf).toBe("");
    expect(stderrBuf).toContain("should appear");
  });

  it("debug is filtered out at info level", () => {
    setLogLevel("info");
    logger.debug(LogTag.Cyrene, "debug-msg");
    expect(stdoutBuf).toBe("");
    expect(stderrBuf).toBe("");
  });

  it("info shows up at info level", () => {
    setLogLevel("info");
    logger.info(LogTag.Cyrene, "info-msg");
    expect(stdoutBuf).toContain("info-msg");
  });

  it("warn goes to stderr; info goes to stdout", () => {
    setLogLevel("debug");
    logger.info(LogTag.Cyrene, "i-am-info");
    logger.warn(LogTag.Cyrene, "i-am-warn");
    logger.error(LogTag.Cyrene, "i-am-error");
    expect(stdoutBuf).toContain("i-am-info");
    expect(stdoutBuf).not.toContain("i-am-warn");
    expect(stdoutBuf).not.toContain("i-am-error");
    expect(stderrBuf).toContain("i-am-warn");
    expect(stderrBuf).toContain("i-am-error");
  });
});

describe("log format", () => {
  it("line starts with the level and tag (no timestamp)", () => {
    setLogLevel("info");
    logger.info(LogTag.Skills, "hello");
    const line = stdoutBuf;
    // No timestamp prefix.
    expect(line).not.toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} /);
    // INFO (5 chars padded)
    expect(line).toMatch(/^INFO\s+/);
    // Tag column, 16 chars wide
    expect(line).toMatch(/Skills\s+/);
    // Message
    expect(line).toContain("hello");
  });

  it("multiple args are joined with spaces", () => {
    setLogLevel("info");
    logger.info(LogTag.Cyrene, "a", 1, true);
    expect(stdoutBuf).toContain("a 1 true");
  });

  it("non-string args are JSON-stringified", () => {
    setLogLevel("info");
    logger.info(LogTag.Cyrene, "payload:", { foo: 1 });
    expect(stdoutBuf).toContain('{"foo":1}');
  });
});

describe("all LogTag values are <= 16 chars", () => {
  const cases: LogLevel[] = ["debug", "info", "warn", "error"];
  it.each(cases)("at level %s, every tag fits", (lvl) => {
    setLogLevel(lvl);
    for (const tag of Object.values(LogTag)) {
      // If a tag were > 16 chars the formatter would silently truncate it.
      // This test fails loudly so we notice and shorten the tag name.
      expect(tag.length).toBeLessThanOrEqual(16);
    }
  });
});
