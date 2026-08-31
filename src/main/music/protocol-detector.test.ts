import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProtocolDetector } from "./protocol-detector";

const { getAppInfo } = vi.hoisted(() => ({
  getAppInfo: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getApplicationInfoForProtocol: getAppInfo },
}));

beforeEach(() => {
  getAppInfo.mockReset();
  vi.useRealTimers();
});

describe("ProtocolDetector", () => {
  it("returns true when Electron returns a path", async () => {
    getAppInfo.mockResolvedValue({ path: "C:/NetEase/CloudMusic.exe", name: "网易云", icon: {} });
    const d = new ProtocolDetector();
    expect(await d.isRegistered("orpheus")).toBe(true);
  });

  it("returns false when Electron returns null", async () => {
    getAppInfo.mockResolvedValue(null);
    const d = new ProtocolDetector();
    expect(await d.isRegistered("orpheus")).toBe(false);
  });

  it("caches the result for cacheTtlMs", async () => {
    getAppInfo.mockResolvedValueOnce({ path: "x" });
    const d = new ProtocolDetector();
    expect(await d.isRegistered()).toBe(true);
    getAppInfo.mockResolvedValueOnce(null);
    expect(await d.isRegistered()).toBe(true);  // cached
  });

  it("invalidate forces re-check", async () => {
    getAppInfo.mockResolvedValueOnce({ path: "x" });
    const d = new ProtocolDetector();
    expect(await d.isRegistered()).toBe(true);
    d.invalidate();
    getAppInfo.mockResolvedValueOnce(null);
    expect(await d.isRegistered()).toBe(false);
  });
});