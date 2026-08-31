import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../orchestrator/tool-registry";
import { filterToolsForTask } from "./tool-filter";
import type { ScheduledTask } from "./types";

function tool(id: string, enabled = true): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    enabled,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "ok",
  };
}

function task(toolMode: ScheduledTask["toolMode"], allowedToolIds: string[]): ScheduledTask {
  return {
    id: "task-1",
    title: "Task",
    prompt: "Run",
    enabled: true,
    schedule: { kind: "daily", timeOfDay: "08:00" },
    nextFireAt: "2026-06-22T08:00:00.000Z",
    toolMode,
    allowedToolIds,
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  };
}

describe("filterToolsForTask", () => {
  it("returns all enabled tools when toolMode is all-enabled", () => {
    const tools = [tool("safe"), tool("disabled", false)];
    expect(filterToolsForTask(task("all-enabled", []), tools).map(t => t.id)).toEqual(["safe"]);
  });

  it("intersects allow-list with enabled tools", () => {
    const tools = [tool("read_file"), tool("write_file", false), tool("weather")];
    const result = filterToolsForTask(task("allow-list", ["write_file", "weather", "missing"]), tools);
    expect(result.map(t => t.id)).toEqual(["weather"]);
  });
});
