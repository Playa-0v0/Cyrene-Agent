type PlaybackState = "dispatched" | "web_fallback" | "client_unavailable" | "launch_failed";

interface PlaybackIpcResult {
  ok: boolean;
  data?: { state: PlaybackState };
  errorCode?: string;
}

export async function requestTrackPlayback(
  api: { playTrack: (trackId: string) => Promise<PlaybackIpcResult> },
  track: { id: string; name: string },
): Promise<{ kind: "ok" | "err"; message: string }> {
  const result = await api.playTrack(track.id);
  if (!result.ok) {
    return { kind: "err", message: `播放请求失败：${result.errorCode ?? "E_UNKNOWN"}` };
  }
  if (result.data?.state === "dispatched") {
    return { kind: "ok", message: `已向网易云发送播放请求：${track.name}` };
  }
  if (result.data?.state === "web_fallback") {
    return { kind: "ok", message: `网易云桌面客户端不可用，已在浏览器中打开：${track.name}` };
  }
  if (result.data?.state === "client_unavailable") {
    return { kind: "err", message: `已找到《${track.name}》，但播放需要安装网易云音乐桌面客户端。` };
  }
  return { kind: "err", message: `未能向网易云发送播放请求：${track.name}` };
}
