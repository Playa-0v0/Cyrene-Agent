/**
 * Integration-ish tests for app.main(). Drives the real dispatch logic with
 * a temporary CYRENE_HOME so first-launch state is isolated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "./app";
import { readState } from "./state/state";

const VERSION = "0.9.0-test";

let tmpHome: string;
let stdoutBuf: string;
let stderrBuf: string;
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), "cyrene-cli-app-"));
  process.env.CYRENE_HOME = tmpHome;
  stdoutBuf = "";
  stderrBuf = "";
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdoutBuf += String(s);
    return true;
  });
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderrBuf += String(s);
    return true;
  });
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  delete process.env.CYRENE_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("main: hello", () => {
  it("prints the banner and exits 0", async () => {
    const code = await main(["hello"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("Every memory has a place.");
    // hello does NOT print the "bringing me home" line (that's default only)
    expect(stdoutBuf).not.toContain("Thank you for bringing me home.");
  });
});

describe("main: about", () => {
  it("prints banner + GitHub URL", async () => {
    const code = await main(["about"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("https://github.com/Playa-0v0/Cyrene-Agent");
  });
});

describe("main: version", () => {
  it("prints just the version", async () => {
    const code = await main(["version"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf.trim()).toBe(VERSION);
  });

  it("--version flag maps to version", async () => {
    const code = await main(["--version"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf.trim()).toBe(VERSION);
  });

  it("-v flag maps to version", async () => {
    const code = await main(["-v"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf.trim()).toBe(VERSION);
  });
});

describe("main: help", () => {
  it("prints usage and exits 0", async () => {
    const code = await main(["--help"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("Usage: cyrene");
  });
});

describe("main: default (first meeting)", () => {
  it("prints the banner and the greeting line", async () => {
    const code = await main([], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("Every memory has a place.");
    expect(stdoutBuf).toContain("Thank you for bringing me home.");
  });

  it("writes state.json with firstLaunch", async () => {
    await main([], VERSION);
    const result = readState();
    expect(result.kind).toBe("present");
    if (result.kind === "present") {
      expect(result.record.version).toBe(VERSION);
    }
  });
});

describe("main: default (subsequent)", () => {
  it("prints only the Ready line and no banner", async () => {
    // first run
    await main([], VERSION);
    // reset buffer (keep the same spy so the mock impl still captures)
    stdoutBuf = "";
    // second run
    const code = await main([], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain(`Cyrene Agent v${VERSION}`);
    expect(stdoutBuf).toContain("Ready.");
    expect(stdoutBuf).not.toContain("Every memory has a place.");
  });
});

describe("main: placeholder", () => {
  it("doctor prints the planned line", async () => {
    const code = await main(["doctor"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("planned for a future release");
  });
});

describe("main: unknown", () => {
  it("prints to stderr and exits 2", async () => {
    const code = await main(["bogus"], VERSION);
    expect(code).toBe(2);
    expect(stderrBuf).toContain("unknown command 'bogus'");
    expect(stdoutBuf).toBe("");
  });
});
