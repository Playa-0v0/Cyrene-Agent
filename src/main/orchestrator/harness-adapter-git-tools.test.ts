import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "./tool-registry";
import { filterToolsForConversationMode } from "./harness-adapter";

function tool(id: string): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "",
  };
}

describe("filterToolsForConversationMode", () => {
  it.each(["work", "chat", "learn"] as const)("hides Git tools from %s", (mode) => {
    expect(filterToolsForConversationMode(mode, [tool("read_file"), tool("git_commit")]).map((item) => item.id))
      .toEqual(["read_file"]);
  });

  it("keeps Git tools available to Code", () => {
    expect(filterToolsForConversationMode("code", [tool("read_file"), tool("git_commit")]).map((item) => item.id))
      .toEqual(["read_file", "git_commit"]);
  });
});
