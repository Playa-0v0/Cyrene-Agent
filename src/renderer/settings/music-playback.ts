// 设置面板搜索结果「点击播放」的反馈文案。
//
// 新架构（mpv 后端）下 PlaybackDispatchResult.state 只剩两种实际取值：
//   - "dispatched"        → mpv 已加载音轨
//   - "client_unavailable" → mpv 未启动 / 未就绪（启动失败、binary 缺失等）
// 旧 orpheus:// 时代的 "web_fallback" / "launch_failed" 已不再产生，但保留
// 分支以兼容历史 IPC 返回值，避免渲染端对未知 state 直接崩成「未知错误」。
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
    return { kind: "ok", message: `已开始播放：${track.name}` };
  }
  if (result.data?.state === "client_unavailable") {
    return {
      kind: "err",
      message: `已找到《${track.name}》，但 mpv 播放器未就绪。请重启应用，或确认 resources/bin/mpv/mpv.exe 存在。`,
    };
  }
  if (result.data?.state === "launch_failed") {
    return { kind: "err", message: `mpv 启动失败，无法播放《${track.name}》。` };
  }
  if (result.data?.state === "web_fallback") {
    // 兼容旧 IPC 返回值；新架构不应到达此分支。
    return { kind: "ok", message: `已在浏览器中打开：${track.name}` };
  }
  return { kind: "err", message: `未能播放《${track.name}》：${result.data?.state ?? "unknown"}` };
}
