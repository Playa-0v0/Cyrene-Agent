import { describe, expect, it } from "vitest";
import { resolveSandboxSessionFilesystem } from "./sandbox-exec";

describe("resolveSandboxSessionFilesystem", () => {
  it("limits scoped Windows grants to the active workspace instead of the app or home directory", () => {
    expect(resolveSandboxSessionFilesystem("scoped", "E:\\user-workspace")).toEqual({
      allowWrite: ["E:\\user-workspace"],
      denyRead: [],
      denyWrite: [],
    });
  });

  it("keeps project-read-only session access read-only at the project root", () => {
    expect(resolveSandboxSessionFilesystem("project-read-only", "E:\\user-workspace")).toEqual({
      allowRead: ["E:\\user-workspace"],
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
    });
  });

  it("grants an approved action only to its active workspace", () => {
    expect(resolveSandboxSessionFilesystem("per-action", "E:\\user-workspace")).toEqual({
      allowWrite: ["E:\\user-workspace"],
      denyRead: [],
      denyWrite: [],
    });
  });
});
