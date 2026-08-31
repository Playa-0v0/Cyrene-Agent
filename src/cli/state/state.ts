/**
 * Persistent CLI state at ~/.cyrene/state.json.
 *
 * v0.9 only reads/writes the `firstLaunch` field. The file is a JSON object
 * so v1.x can add sibling fields (lastSeenAt, lastVersion, sessionId, …)
 * without renaming the file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export interface FirstLaunchRecord {
  firstSeenAt: string; // ISO 8601 UTC
  version: string; // e.g. "0.9.0"
}

export interface StateFile {
  firstLaunch?: FirstLaunchRecord;
  // future: lastSeenAt?, lastVersion?, sessionId?, …
}

export type FirstLaunchState =
  | { kind: "missing" }
  | { kind: "present"; record: FirstLaunchRecord }
  | { kind: "corrupt"; raw: string };

/**
 * Absolute path to ~/.cyrene/state.json.
 *
 * Honors CYRENE_HOME if set (used by tests to isolate state). In production
 * this is never set and we use os.homedir().
 */
export function statePath(): string {
  const home = process.env.CYRENE_HOME ?? os.homedir();
  return path.join(home, ".cyrene", "state.json");
}

function isRecord(v: unknown): v is FirstLaunchRecord {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as FirstLaunchRecord).firstSeenAt === "string" &&
    typeof (v as FirstLaunchRecord).version === "string"
  );
}

/** Read firstLaunch from state.json. Never throws. */
export function readState(): FirstLaunchState {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath(), "utf8");
  } catch {
    return { kind: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", raw };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "corrupt", raw };
  }
  const firstLaunch = (parsed as StateFile).firstLaunch;
  if (!isRecord(firstLaunch)) {
    return { kind: "corrupt", raw };
  }
  return { kind: "present", record: firstLaunch };
}

/** Write state.json, creating ~/.cyrene/ if needed. Throws on I/O error. */
export function writeState(s: StateFile): void {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n", "utf8");
}
