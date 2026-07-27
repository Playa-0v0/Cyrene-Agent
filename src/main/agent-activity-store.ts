import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export type AgentActivityStatus = "success" | "failed" | "denied" | "running";

export interface AgentActivityEvent {
  id: string;
  at: string;
  kind: "tool" | "permission" | "system";
  name: string;
  status: AgentActivityStatus;
  durationMs: number;
  argsSummary?: string;
  resultSummary?: string;
  error?: string;
}

const MAX_EVENTS = 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
let sequence = 0;

function filePath(): string {
  return path.join(app.getPath("userData"), "agent-activity.jsonl");
}

function truncate(value: unknown, max = 240): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").replace(/\s+/g, " ").slice(0, max);
}

function redact(value: unknown, key = ""): unknown {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  if (normalized.includes("key") || normalized.includes("secret") || normalized.includes("token") || normalized.includes("password") || normalized.endsWith("pass")) return "***";
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  return value;
}

function readLines(): AgentActivityEvent[] {
  try {
    if (!fs.existsSync(filePath())) return [];
    return fs.readFileSync(filePath(), "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as AgentActivityEvent]; } catch { return []; }
    });
  } catch { return []; }
}

function prune(): void {
  const target = filePath();
  try {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    const events = readLines();
    if (stat.size <= MAX_FILE_BYTES && events.length <= MAX_EVENTS) return;
    fs.writeFileSync(target, events.slice(-MAX_EVENTS).map((event) => JSON.stringify(event)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  } catch (error) { console.warn("[AgentActivity] prune failed:", error); }
}

export function recordAgentActivity(input: Omit<AgentActivityEvent, "id" | "at" | "argsSummary" | "resultSummary"> & { args?: unknown; result?: unknown }): AgentActivityEvent {
  const event: AgentActivityEvent = {
    id: `${Date.now()}-${++sequence}`,
    at: new Date().toISOString(),
    kind: input.kind,
    name: truncate(input.name, 80),
    status: input.status,
    durationMs: Math.max(0, Math.round(input.durationMs || 0)),
    ...(input.args !== undefined ? { argsSummary: truncate(redact(input.args)) } : {}),
    ...(input.result !== undefined ? { resultSummary: truncate(redact(input.result)) } : {}),
    ...(input.error ? { error: truncate(input.error, 300) } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.appendFileSync(filePath(), JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
    prune();
  } catch (error) { console.warn("[AgentActivity] write failed:", error); }
  return event;
}

export function getAgentActivities(limit = 100): AgentActivityEvent[] {
  return readLines().slice(-Math.max(1, Math.min(500, limit))).reverse();
}

export function getAgentActivitySummary(): { total: number; success: number; failed: number; denied: number; avgDurationMs: number } {
  const events = readLines();
  const completed = events.filter((event) => event.kind === "tool" && event.status !== "running");
  return {
    total: completed.length,
    success: completed.filter((event) => event.status === "success").length,
    failed: completed.filter((event) => event.status === "failed").length,
    denied: completed.filter((event) => event.status === "denied").length,
    avgDurationMs: completed.length ? Math.round(completed.reduce((sum, event) => sum + event.durationMs, 0) / completed.length) : 0,
  };
}
