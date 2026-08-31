import { describe, expect, test } from "vitest";
import { migrateLegacyMinimaxDefaults } from "./minimax-defaults";

describe("migrateLegacyMinimaxDefaults", () => {
  test("moves the shipped legacy auto config to the OpenAI endpoint", () => {
    expect(migrateLegacyMinimaxDefaults("MiniMax（稀宇科技）", {
      baseUrl: "https://api.minimaxi.com/anthropic",
      explicitTransport: "auto",
    })).toEqual({
      baseUrl: "https://api.minimaxi.com/v1",
      explicitTransport: "auto",
    });
  });

  test("preserves an explicit Anthropic choice", () => {
    const profile = {
      baseUrl: "https://api.minimaxi.com/anthropic",
      explicitTransport: "anthropic" as const,
    };
    expect(migrateLegacyMinimaxDefaults("MiniMax（稀宇科技）", profile)).toEqual(profile);
  });
});
