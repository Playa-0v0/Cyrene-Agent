import { describe, expect, it } from "vitest";
import { policyFor, type AgentFileAccessLevel, type ToolRiskLevel } from "./permission-policy";

const LEVELS: AgentFileAccessLevel[] = [
  "project-read-only",
  "read-only",
  "scoped",
  "per-action",
  "full",
];

describe("policyFor — shell risk routed to sandbox, allowed at every level", () => {
  it.each(LEVELS.filter((l) => l !== "per-action"))(
    "allows shell at %s (sandbox enforces fs boundary)",
    (level) => {
      expect(policyFor(level, "shell")).toBe("allow");
    },
  );

  it("asks for shell at per-action (each action needs approval)", () => {
    expect(policyFor("per-action", "shell")).toBe("ask");
  });
});

describe("policyFor — non-shell risks unchanged", () => {
  it("allows safe at every level", () => {
    for (const level of LEVELS) {
      expect(policyFor(level, "safe")).toBe("allow");
    }
  });

  it("project-read-only denies fs-write, allows fs-read and network", () => {
    expect(policyFor("project-read-only", "fs-write")).toBe("deny");
    expect(policyFor("project-read-only", "fs-read")).toBe("allow");
    expect(policyFor("project-read-only", "network")).toBe("allow");
    expect(policyFor("project-read-only", "input-control")).toBe("deny");
  });

  it("read-only denies fs-write, allows fs-read and network", () => {
    expect(policyFor("read-only", "fs-write")).toBe("deny");
    expect(policyFor("read-only", "fs-read")).toBe("allow");
    expect(policyFor("read-only", "network")).toBe("allow");
  });

  it("scoped allows fs-read/fs-write/network, denies input-control", () => {
    expect(policyFor("scoped", "fs-read")).toBe("allow");
    expect(policyFor("scoped", "fs-write")).toBe("allow");
    expect(policyFor("scoped", "network")).toBe("allow");
    expect(policyFor("scoped", "input-control")).toBe("deny");
  });

  it("per-action asks for every non-safe risk", () => {
    const risks: ToolRiskLevel[] = ["fs-read", "fs-write", "network", "input-control"];
    for (const risk of risks) {
      expect(policyFor("per-action", risk)).toBe("ask");
    }
  });

  it("full allows every risk", () => {
    const risks: ToolRiskLevel[] = ["fs-read", "fs-write", "network", "input-control", "shell"];
    for (const risk of risks) {
      expect(policyFor("full", risk)).toBe("allow");
    }
  });
});
