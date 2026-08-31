import { useState } from "react";
import { formatTime } from "../types";
import Slider from "./Slider";

interface ProgressBarProps {
  positionMs: number;
  durationMs: number;
  onSeek(positionMs: number): void;
}

export default function ProgressBar({
  positionMs,
  durationMs,
  onSeek,
}: ProgressBarProps) {
  const [preview, setPreview] = useState<number | null>(null);
  const ratio = durationMs > 0 ? positionMs / durationMs : 0;
  const shownMs = preview !== null ? preview * durationMs : positionMs;

  return (
    <div className={`progress ${preview !== null ? "is-dragging" : ""}`}>
      <span className="progress-time">{formatTime(shownMs)}</span>
      <Slider
        ratio={ratio}
        ariaLabel="播放进度"
        onPreview={(r) => setPreview(r)}
        onChange={(r) => {
          setPreview(null);
          onSeek(r * durationMs);
        }}
      />
      <span className="progress-time">{formatTime(durationMs)}</span>
    </div>
  );
}
