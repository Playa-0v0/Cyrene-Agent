import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  logger,
  setLogLevel,
  getLogLevel,
  addLogSink,
  removeLogSink,
  type LogLevel,
  type LogEntry,
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

describe("log sinks", () => {
  const received: LogEntry[] = [];
  const collect = (entry: LogEntry): void => {
    received.push(entry);
  };

  beforeEach(() => {
    received.length = 0;
  });

  it("sink receives entries that pass the level gate, with plain line", () => {
    setLogLevel("info");
    const unsub = addLogSink(collect);
    try {
      logger.info(LogTag.Cyrene, "sink-msg", { k: 1 });
      expect(received).toHaveLength(1);
      expect(received[0].level).toBe("info");
      expect(received[0].tag).toBe(LogTag.Cyrene);
      expect(received[0].message).toBe('sink-msg {"k":1}');
      // line 无 ANSI 色码、无时间戳前缀，与 stdout 纯文本格式一致
      expect(received[0].line).toContain("INFO ");
      expect(received[0].line).toContain("sink-msg");
      expect(received[0].line).not.toContain("\x1b[");
      expect(typeof received[0].ts).toBe("number");
    } finally {
      unsub();
    }
  });

  it("filtered levels do not reach sinks", () => {
    setLogLevel("warn");
    const unsub = addLogSink(collect);
    try {
      logger.info(LogTag.Cyrene, "should-not-reach-sink");
      expect(received).toHaveLength(0);
    } finally {
      unsub();
    }
  });

  it("unsubscribe stops delivery", () => {
    setLogLevel("info");
    const unsub = addLogSink(collect);
    unsub();
    logger.info(LogTag.Cyrene, "after-unsub");
    expect(received).toHaveLength(0);
  });

  it("removeLogSink stops delivery", () => {
    setLogLevel("info");
    addLogSink(collect);
    removeLogSink(collect);
    logger.info(LogTag.Cyrene, "after-remove");
    expect(received).toHaveLength(0);
  });

  it("a throwing sink does not break stdout output or other sinks", () => {
    setLogLevel("info");
    const boom = (): void => {
      throw new Error("sink boom");
    };
    const unsubBoom = addLogSink(boom);
    const unsubCollect = addLogSink(collect);
    try {
      expect(() => logger.info(LogTag.Cyrene, "still-works")).not.toThrow();
      expect(received).toHaveLength(1);
      expect(stdoutBuf).toContain("still-works");
    } finally {
      unsubBoom();
      unsubCollect();
    }
  });
});
