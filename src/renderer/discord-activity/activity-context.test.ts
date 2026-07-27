import { describe, expect, it } from "vitest";
import { isDiscordActivity, resolveActivityClientId } from "./activity-context";

describe("Discord Activity context", () => {
  it("detects Discord's iframe query parameters", () => {
    expect(isDiscordActivity({ search: "?frame_id=one&instance_id=two" })).toBe(true);
    expect(isDiscordActivity({ search: "?frame_id=one" })).toBe(false);
  });

  it("accepts Discord as an ancestor and rejects unrelated embeds", () => {
    expect(isDiscordActivity({ search: "", ancestorOrigins: ["https://discord.com"] })).toBe(true);
    expect(isDiscordActivity({ search: "", ancestorOrigins: ["https://example.com"] })).toBe(false);
  });

  it("requires a Discord snowflake-shaped client id", () => {
    expect(resolveActivityClientId("123456789012345678")).toBe("123456789012345678");
    expect(resolveActivityClientId("replace-me")).toBeNull();
    expect(resolveActivityClientId(undefined)).toBeNull();
  });
});
