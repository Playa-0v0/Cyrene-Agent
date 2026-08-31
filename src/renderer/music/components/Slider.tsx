import { useCallback, useRef, useState } from "react";

interface SliderProps {
  ratio: number;
  onChange(ratio: number): void;
  onPreview?(ratio: number): void;
  ariaLabel: string;
}

/** 通用横向滑条：支持点击跳转 + 拖拽，拖拽中走 onPreview */
export default function Slider({
  ratio,
  onChange,
  onPreview,
  ariaLabel,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);

  const ratioFromEvent = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const r = ratioFromEvent(e.clientX);
    setDragRatio(r);
    onPreview?.(r);

    const move = (ev: PointerEvent) => {
      const nr = ratioFromEvent(ev.clientX);
      setDragRatio(nr);
      onPreview?.(nr);
    };
    const up = (ev: PointerEvent) => {
      const nr = ratioFromEvent(ev.clientX);
      setDragRatio(null);
      onChange(nr);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const shown = dragRatio ?? ratio;

  return (
    <div
      ref={trackRef}
      className="slider"
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      onPointerDown={handlePointerDown}
    >
      <div className="slider-rail" />
      <div className="slider-fill" style={{ width: `${shown * 100}%` }} />
      <div className="slider-thumb" style={{ left: `${shown * 100}%` }} />
    </div>
  );
}
