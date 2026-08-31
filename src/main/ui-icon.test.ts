import { describe, expect, it } from "vitest";
import { normalizeUiIcon } from "../shared/ui-icon";

describe("ui icon settings", () => {
  it.each([
    ["cyrene-pink", "cyrene-pink"],
    ["cyrene-sun", "cyrene-sun"],
    ["classic", "cyrene-sun"],
    ["unknown", "cyrene-sun"],
    [undefined, "cyrene-sun"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeUiIcon(input)).toBe(expected);
  });
});
