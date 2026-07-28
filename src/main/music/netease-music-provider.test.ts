import { describe, expect, it, vi } from "vitest";
import { NeteaseMusicProvider } from "./netease-music-provider";

function clientReturning(value: unknown) {
  return { callDataTool: vi.fn().mockResolvedValue(value) };
}

describe("NeteaseMusicProvider MCP playback", () => {
  it("plays a track through cloud_music_play with the upstream schema", async () => {
    const client = clientReturning("已发送播放指令: song 255667");
    const provider = new NeteaseMusicProvider(client as never);

    await expect(provider.playTrack("255667")).resolves.toEqual({
      state: "dispatched",
      resourceType: "song",
      resourceId: "255667",
    });
    expect(client.callDataTool).toHaveBeenCalledWith("cloud_music_play", {
      id: "255667",
      type: "song",
    });
  });

  it("normalizes the upstream browser fallback without claiming client dispatch", async () => {
    const client = clientReturning(
      "⚠️ 未检测到客户端，已在浏览器中播放: https://music.163.com/#/playlist?id=456",
    );
    const provider = new NeteaseMusicProvider(client as never);

    await expect(provider.playPlaylist("456")).resolves.toEqual({
      state: "web_fallback",
      resourceType: "playlist",
      resourceId: "456",
    });
  });

  it.each([
    ["播放失败: access denied", "E_PLAYBACK_DISPATCH_FAILED"],
    ["上游返回了从未见过的内容", "E_PLAYBACK_RESULT_UNKNOWN"],
  ])("rejects a failed or unknown upstream result: %s", async (raw, code) => {
    const provider = new NeteaseMusicProvider(clientReturning(raw) as never);
    await expect(provider.playTrack("123")).rejects.toMatchObject({ code });
  });
});
