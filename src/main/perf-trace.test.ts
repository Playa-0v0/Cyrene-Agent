import { afterEach, describe, expect, it, vi } from "vitest";
import { perf } from "./perf-trace";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("perf trace visibility", () => {
  it("hides performance timing by default", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    perf.beginTurn("test");
    perf.mark("checkpoint");
    perf.dump();

    expect(log).not.toHaveBeenCalled();
  });

  it("restores performance timing when debug logging is enabled", () => {
    vi.stubEnv("CYRENE_DEBUG_LOGS", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    perf.beginTurn("test");
    perf.mark("checkpoint");
    perf.dump();

    expect(log.mock.calls.flat().join("\n")).toContain("[Perf]");
  });
});
