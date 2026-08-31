import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readState, statePath, writeState, type FirstLaunchRecord } from "./state";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), "cyrene-cli-test-"));
  process.env.CYRENE_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.CYRENE_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

const sample: FirstLaunchRecord = {
  firstSeenAt: "2026-08-04T12:00:00.000Z",
  version: "0.9.0",
};

function writeRaw(contents: string): void {
  const file = statePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

describe("statePath", () => {
  it("points at <CYRENE_HOME>/.cyrene/state.json", () => {
    expect(statePath()).toBe(path.join(tmpHome, ".cyrene", "state.json"));
  });
});

describe("readState", () => {
  it("returns missing when the file does not exist", () => {
    expect(readState()).toEqual({ kind: "missing" });
  });

  it("returns present after writeState", () => {
    writeState({ firstLaunch: sample });
    expect(readState()).toEqual({ kind: "present", record: sample });
  });

  it("returns corrupt for invalid JSON", () => {
    writeRaw("{not json");
    expect(readState().kind).toBe("corrupt");
  });

  it("returns corrupt when top-level value is not an object", () => {
    writeRaw('"a string"');
    expect(readState().kind).toBe("corrupt");
  });

  it("returns corrupt when firstLaunch is missing", () => {
    writeRaw(JSON.stringify({ lastSeenAt: "x" }));
    expect(readState().kind).toBe("corrupt");
  });

  it("returns corrupt when firstLaunch.version is missing", () => {
    writeRaw(JSON.stringify({ firstLaunch: { firstSeenAt: "x" } }));
    expect(readState().kind).toBe("corrupt");
  });

  it("returns corrupt when firstLaunch fields are wrong type", () => {
    writeRaw(JSON.stringify({ firstLaunch: { firstSeenAt: 1, version: 2 } }));
    expect(readState().kind).toBe("corrupt");
  });

  it("ignores extra top-level keys", () => {
    writeRaw(JSON.stringify({ firstLaunch: sample, lastSeenAt: "whenever" }));
    expect(readState()).toEqual({ kind: "present", record: sample });
  });
});

describe("writeState", () => {
  it("creates the .cyrene directory if it does not exist", () => {
    expect(() => writeState({ firstLaunch: sample })).not.toThrow();
    expect(readState()).toEqual({ kind: "present", record: sample });
  });
});
