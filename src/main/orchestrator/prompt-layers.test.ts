import { describe, expect, it } from "vitest";
import {
  buildStableCacheFingerprint,
  composePromptLayers,
  normalizeToolSpecsForCache,
  projectCacheRelevantChatRequest,
} from "./prompt-layers";

describe("prompt layers", () => {
  it("keeps the system prefix identical when only runtime Todo changes", () => {
    const first = composePromptLayers(
      { stablePrefix: "RULES", sessionPrefix: "WORKSPACE", runtimeContext: "TODO A" },
      [{ role: "user", content: "inspect" }],
    );
    const second = composePromptLayers(
      { stablePrefix: "RULES", sessionPrefix: "WORKSPACE", runtimeContext: "TODO B" },
      [{ role: "user", content: "inspect" }],
    );

    expect(first.messages[0]).toEqual(second.messages[0]);
    expect(first.messages.at(-1)?.content).toContain("TODO A");
    expect(second.messages.at(-1)?.content).toContain("TODO B");
  });

  it("does not mutate persisted history when injecting runtime context", () => {
    const history = [{ role: "user" as const, content: "hello" }];

    composePromptLayers({ stablePrefix: "RULES", runtimeContext: "TEMP" }, history);

    expect(history).toEqual([{ role: "user", content: "hello" }]);
  });

  it("normalizes tool order and object key order before fingerprinting", () => {
    const tools = normalizeToolSpecsForCache([
      { name: "z_tool", description: "z", parameters: { type: "object", properties: { z: { type: "string" } } } },
      { name: "a_tool", description: "a", parameters: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" } },
    ]);

    expect(tools.map((tool) => tool.name)).toEqual(["a_tool", "z_tool"]);
    expect(buildStableCacheFingerprint({
      provider: "kimi",
      model: "kimi-k2.7-code",
      mode: "code",
      promptVersion: "v1",
      stablePrefix: "RULES",
      sessionPrefix: "WORKSPACE",
      tools,
    })).toMatch(/^[a-f0-9]{16}$/);
  });

  it("projects only cache-relevant fields from a composed chat request", () => {
    expect(projectCacheRelevantChatRequest({
      model: "model-a",
      stream: true,
      messages: [
        { role: "system", content: "RULES" },
        { role: "user", content: "inspect", visibility: "internal", internal: {
          kind: "run_start", revision: 1, digest: "private", id: "private", runId: "private", createdAt: 1,
        } },
      ],
      tools: [{ name: "z", description: "z", parameters: { type: "object" } }],
    })).toEqual({
      stableSystem: "RULES",
      tools: [{ name: "z", description: "z", parameters: { type: "object" } }],
      messages: [{ role: "user", content: "inspect" }],
    });
  });
});
