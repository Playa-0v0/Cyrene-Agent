import { Minus, Plus, Volume1, Volume2, VolumeX } from "lucide-react";
import Slider from "./Slider";

interface VolumeControlProps {
  volume: number;
  isMuted: boolean;
  onSetVolume(volume: number): void;
  onToggleMute(): void;
}

const STEP = 5;

/**
 * 喇叭图标常亮，鼠标靠近（hover 感应区）时渐显出 ±5、滑条和数值。
 * 感应区通过 .volume 的 padding 扩大，靠近即触发。
 */
export default function VolumeControl({
  volume,
  isMuted,
  onSetVolume,
  onToggleMute,
}: VolumeControlProps) {
  const effective = isMuted ? 0 : volume;
  const Icon = isMuted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  return (
    <div className="volume">
      <button
        type="button"
        className="icon-btn volume-speaker"
        onClick={onToggleMute}
        title={isMuted ? "取消静音" : "静音"}
      >
        <Icon size={18} />
      </button>
      <div className="volume-extra">
        <button
          type="button"
          className="icon-btn"
          onClick={() => onSetVolume(volume - STEP)}
          title="音量 -5"
        >
          <Minus size={14} />
        </button>
        <div className="volume-slider">
          <Slider
            ratio={effective / 100}
            ariaLabel="音量"
            onChange={(r) => onSetVolume(r * 100)}
          />
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => onSetVolume(volume + STEP)}
          title="音量 +5"
        >
          <Plus size={14} />
        </button>
        <span className="volume-value">{effective}</span>
      </div>
    </div>
  );
}
