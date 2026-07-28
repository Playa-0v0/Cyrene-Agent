import { MusicInputError, type PlaybackDispatchResult } from "./types";

export function normalizeMcpPlaybackResult(
  raw: unknown,
  resourceType: "song" | "playlist",
  resourceId: string,
): PlaybackDispatchResult {
  if (typeof raw !== "string") throw new MusicInputError("E_PLAYBACK_RESULT_UNKNOWN");
  const text = raw.trim();
  if (text === `已发送播放指令: ${resourceType} ${resourceId}`) {
    return { state: "dispatched", resourceType, resourceId };
  }
  const webUrl = `https://music.163.com/#/${resourceType}?id=${resourceId}`;
  if (text === `⚠️ 未检测到客户端，已在浏览器中播放: ${webUrl}`) {
    return { state: "web_fallback", resourceType, resourceId };
  }
  if (text.startsWith("播放失败:")) {
    throw new MusicInputError("E_PLAYBACK_DISPATCH_FAILED", text);
  }
  throw new MusicInputError("E_PLAYBACK_RESULT_UNKNOWN");
}
