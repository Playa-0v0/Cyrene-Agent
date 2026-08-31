import { useEffect, useMemo, useRef } from "react";
import type { Track } from "../types";

interface LyricsViewProps {
  track: Track | null;
  positionMs: number;
}

export default function LyricsView({ track, positionMs }: LyricsViewProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const lyrics = track?.lyrics ?? [];

  const activeIndex = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < lyrics.length; i++) {
      if (lyrics[i].timeMs <= positionMs) idx = i;
      else break;
    }
    return idx;
  }, [lyrics, positionMs]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `.lyric-line[data-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex]);

  if (!track) {
    return <div className="panel-empty">暂无播放</div>;
  }
  if (lyrics.length === 0) {
    return <div className="panel-empty">暂无歌词</div>;
  }
  return (
    <div className="lyrics" ref={listRef}>
      {lyrics.map((line, i) => (
        <p
          key={i}
          data-index={i}
          className={`lyric-line ${i === activeIndex ? "is-active" : ""}`}
        >
          {line.text}
          {line.translation && (
            <span className="lyric-trans">{line.translation}</span>
          )}
        </p>
      ))}
    </div>
  );
}
