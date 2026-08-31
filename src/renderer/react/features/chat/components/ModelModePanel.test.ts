import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("ModelModePanel", () => {
  it("lists saved models and offers default and deletion actions", () => {
    const source = fs.readFileSync(path.join(__dirname, "ModelModePanel.tsx"), "utf8");
    expect(source).toContain("listModelProfiles");
    expect(source).toContain("setDefaultModelProfile");
    expect(source).toContain("deleteModelProfile");
  });

  it("uses a file-protocol-safe relative path for provider icons", () => {
    const source = fs.readFileSync(path.join(__dirname, "ModelModePanel.tsx"), "utf8");
    expect(source).toContain('`../icons/providers/${key}.svg`');
    expect(source).not.toContain('`/icons/providers/${key}.svg`');
  });
});
