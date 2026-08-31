import { useSyncExternalStore } from "react";
import {
  getTtsPlaybackSnapshot,
  subscribeTtsPlayback,
  toggleTtsPlayback,
  type TtsPlaybackStatus,
} from "./tts-playback";

interface TtsButtonProps {
  conversationId: string;
  messageId: string;
  text: string;
  speechMode?: "default" | "learn";
  preferredAddress?: string;
  onCacheKey?: (cacheKey: string, converterVersion: string) => void;
  size?: number;
  color?: string;
}

function buttonLabel(status: TtsPlaybackStatus): string {
  if (status === "synthesizing") return "正在生成语音";
  if (status === "playing") return "暂停朗读";
  if (status === "paused") return "继续朗读";
  if (status === "completed") return "重新朗读";
  if (status === "error") return "重新朗读";
  return "朗读";
}

export function TtsButton({
  conversationId,
  messageId,
  text,
  speechMode,
  preferredAddress,
  onCacheKey,
  size = 16,
  color = "#8e8e93",
}: TtsButtonProps) {
  const playback = useSyncExternalStore(
    subscribeTtsPlayback,
    getTtsPlaybackSnapshot,
    getTtsPlaybackSnapshot,
  );
  const status = playback.messageId === messageId ? playback.status : "idle";
  const label = buttonLabel(status);

  return (
    <button
      type="button"
      className={`cy-tts-button is-${status}`}
      onClick={() => void toggleTtsPlayback({
        conversationId,
        messageId,
        text,
        speechMode,
        preferredAddress,
        onCacheKey,
      })}
      aria-label={label}
      title={status === "error" ? playback.error ?? label : label}
      disabled={status === "synthesizing"}
      style={{ width: size, height: size, color }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M3 10V14H7L12 18V6L7 10H3Z" fill="currentColor" />
        <path
          className="cy-tts-button__wave cy-tts-button__wave--one"
          d="M15 9.5C16.2 10.8 16.2 13.2 15 14.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          className="cy-tts-button__wave cy-tts-button__wave--two"
          d="M18 7C20.7 9.7 20.7 14.3 18 17"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
