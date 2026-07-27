import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mock = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => mock.userData } }));

import { getAgentActivities, getAgentActivitySummary, recordAgentActivity } from "./agent-activity-store";

describe("agent activity store", () => {
  beforeEach(() => { mock.userData = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-activity-")); });
  afterEach(() => fs.rmSync(mock.userData, { recursive: true, force: true }));

  it("records bounded summaries and redacts credential fields", () => {
    recordAgentActivity({
      kind: "tool",
      name: "send_request",
      status: "success",
      durationMs: 123.7,
      args: { apiKey: "must-not-leak", query: "hello" },
      result: "ok",
    });
    const [event] = getAgentActivities();
    expect(event.name).toBe("send_request");
    expect(event.durationMs).toBe(124);
    expect(event.argsSummary).toContain("***");
    expect(event.argsSummary).not.toContain("must-not-leak");
    expect(getAgentActivitySummary()).toMatchObject({ total: 1, success: 1, failed: 0, denied: 0 });
  });
});
