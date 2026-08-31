import { describe, expect, it, vi } from "vitest";
import { requestTrackPlayback } from "./music-playback";

describe("requestTrackPlayback", () => {
  it("reports a dispatched request as playing", async () => {
    const playTrack = vi.fn().mockResolvedValue({
      ok: true,
      data: { state: "dispatched", resourceType: "song", resourceId: "123" },
    });

    const result = await requestTrackPlayback({ playTrack }, { id: "123", name: "Song" });

    expect(playTrack).toHaveBeenCalledWith("123");
    expect(result).toEqual({ kind: "ok", message: "已开始播放：Song" });
  });

  it("explains when mpv is not ready (client_unavailable)", async () => {
    const playTrack = vi.fn().mockResolvedValue({
      ok: true,
      data: { state: "client_unavailable", resourceType: "song", resourceId: "123" },
    });

    const result = await requestTrackPlayback({ playTrack }, { id: "123", name: "Song" });

    expect(result.kind).toBe("err");
    expect(result.message).toContain("mpv 播放器未就绪");
  });

  it("reports launch_failed as mpv startup failure", async () => {
    const playTrack = vi.fn().mockResolvedValue({
      ok: true,
      data: { state: "launch_failed", resourceType: "song", resourceId: "123" },
    });

    const result = await requestTrackPlayback({ playTrack }, { id: "123", name: "Song" });

    expect(result.kind).toBe("err");
    expect(result.message).toContain("mpv 启动失败");
  });

  it("reports IPC failure with errorCode", async () => {
    const playTrack = vi.fn().mockResolvedValue({
      ok: false,
      errorCode: "E_BACKEND_NOT_READY",
    });

    const result = await requestTrackPlayback({ playTrack }, { id: "123", name: "Song" });

    expect(result.kind).toBe("err");
    expect(result.message).toContain("E_BACKEND_NOT_READY");
  });
});
