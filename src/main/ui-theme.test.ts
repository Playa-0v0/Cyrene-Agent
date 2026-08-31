import { describe, expect, it } from "vitest";
import { normalizeUiTheme } from "../shared/ui-theme";

describe("normalizeUiTheme", () => {
  it.each([
    ["pearl-white", "pearl-white"],
    ["classic", "pearl-white"],
    ["polished-pink", "pearl-white"],
    [undefined, "pearl-white"],
    ["unknown", "pearl-white"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeUiTheme(input)).toBe(expected);
  });
});
