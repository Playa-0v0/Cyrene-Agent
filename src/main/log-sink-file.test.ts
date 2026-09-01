import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setLogLevel, logger, type LogEntry } from "../shared/logger";
import {
  formatTs,
  rotateIfNeeded,
  createFileLogSink,
  installFileLogSink,
} from "./log-sink-file";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-log-sink-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(partial: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: new Date(2026, 8, 1, 9, 32, 24, 123).getTime(),
    level: "info",
    tag: "Cyrene",
    message: "hello",
    line: "INFO  Cyrene         hello",
    ...partial,
  };
}

describe("formatTs", () => {
  it("formats epoch ms as local YYYY-MM-DD HH:MM:SS.mmm", () => {
    // 2026-09-01 09:32:24.123（本地时区）
    const ts = new Date(2026, 8, 1, 9, 32, 24, 123).getTime();
    expect(formatTs(ts)).toBe("2026-09-01 09:32:24.123");
  });

  it("zero-pads month/day/hour/minute/second/millisecond", () => {
    const ts = new Date(2026, 0, 5, 7, 8, 9, 10).getTime();
    expect(formatTs(ts)).toBe("2026-01-05 07:08:09.010");
  });
});

describe("createFileLogSink", () => {
  it("appends a timestamped line to the file", () => {
    const logPath = path.join(tmpDir, "cyrene.log");
    const sink = createFileLogSink(logPath);
    sink(makeEntry());
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("2026-09-01 09:32:24.123");
    expect(content).toContain("INFO  Cyrene         hello");
  });

  it("appends multiple entries in order", () => {
    const logPath = path.join(tmpDir, "cyrene.log");
    const sink = createFileLogSink(logPath);
    sink(makeEntry({ message: "first", line: "INFO  Cyrene         first" }));
    sink(makeEntry({ message: "second", line: "INFO  Cyrene         second" }));
    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });

  it("survives append failures without throwing", () => {
    // 指向一个不存在的目录：appendFileSync 会抛，sink 必须静默吞掉
    const logPath = path.join(tmpDir, "no-such-dir", "cyrene.log");
    const sink = createFileLogSink(logPath);
    expect(() => sink(makeEntry())).not.toThrow();
  });
});

describe("rotateIfNeeded", () => {
  it("rotates when the current file exceeds maxBytes", () => {
    const logPath = path.join(tmpDir, "cyrene.log");
    fs.writeFileSync(logPath, "x".repeat(100));
    rotateIfNeeded(logPath, 50);
    expect(fs.existsSync(logPath + ".1")).toBe(true);
    expect(fs.readFileSync(logPath + ".1", "utf8").length).toBe(100);
  });

  it("keeps at most MAX_FILES generations", () => {
    const logPath = path.join(tmpDir, "cyrene.log");
    for (let gen = 1; gen <= 5; gen++) {
      fs.writeFileSync(logPath, "g".repeat(100));
      rotateIfNeeded(logPath, 50);
    }
    expect(fs.existsSync(logPath + ".1")).toBe(true);
    expect(fs.existsSync(logPath + ".2")).toBe(true);
    expect(fs.existsSync(logPath + ".3")).toBe(false); // 只保留 .1/.2 两代
  });

  it("does nothing when the file does not exist", () => {
    const logPath = path.join(tmpDir, "cyrene.log");
    expect(() => rotateIfNeeded(logPath, 50)).not.toThrow();
    expect(fs.existsSync(logPath + ".1")).toBe(false);
  });
});

describe("installFileLogSink", () => {
  it("writes to <userData>/logs/cyrene.log and returns an uninstall fn", () => {
    const uninstall = installFileLogSink(tmpDir);
    try {
      setLogLevel("info");
      logger.info("Cyrene", "sink-e2e");
      const logPath = path.join(tmpDir, "logs", "cyrene.log");
      expect(fs.existsSync(logPath)).toBe(true);
      expect(fs.readFileSync(logPath, "utf8")).toContain("sink-e2e");
    } finally {
      uninstall();
      // 卸载后不再写入
      const logPath = path.join(tmpDir, "logs", "cyrene.log");
      const before = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
      logger.info("Cyrene", "after-uninstall");
      const after = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
      expect(after).toBe(before);
    }
  });
});
