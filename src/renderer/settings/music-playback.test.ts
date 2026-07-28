import { describe, expect, it, vi } from "vitest";
import { requestTrackPlayback } from "./music-playback";

describe("requestTrackPlayback", () => {
  it("calls the formal music preload API and reports a dispatched request precisely", async () => {
    const playTrack = vi.fn().mockResolvedValue({
      ok: true,
      data: { state: "dispatched", resourceType: "song", resourceId: "123" },
    });

    const result = await requestTrackPlayback({ playTrack }, { id: "123", name: "Song" });

    expect(playTrack).toHaveBeenCalledWith("123");
    expect(result).toEqual({ kind: "ok", message: "已向网易云发送播放请求：Song" });
  });

  it("explains when the NetEase desktop client is unavailable", async () => {
    const playTrack = vi.fn().mockResolvedValue({
      ok: true,
      data: { state: "client_unavailable", resourceType: "song", resourceId: "123" },
    });

    const result = await requestTrackPlayback({ playTrack }, { id: "123", name: "Song" });

    expect(result.kind).toBe("err");
    expect(result.message).toContain("需要安装网易云音乐桌面客户端");
  });

  it("reports the MCP browser fallback without claiming desktop dispatch", async () => {
    const playTrack = vi.fn().mockResolvedValue({
      ok: true,
      data: { state: "web_fallback", resourceType: "song", resourceId: "123" },
    });

    const result = await requestTrackPlayback({ playTrack }, { id: "123", name: "Song" });

    expect(result).toEqual({ kind: "ok", message: "网易云桌面客户端不可用，已在浏览器中打开：Song" });
  });
});
