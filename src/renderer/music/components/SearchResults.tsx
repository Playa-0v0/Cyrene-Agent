import { Loader2, Play, SearchX } from "lucide-react";
import type { Track } from "../types";
import { formatTime } from "../types";

interface SearchResultsProps {
  results: Track[];
  isSearching: boolean;
  query: string;
  currentId?: string;
  onPlay(track: Track): void;
}

export default function SearchResults({
  results,
  isSearching,
  query,
  currentId,
  onPlay,
}: SearchResultsProps) {
  if (isSearching) {
    return (
      <div className="panel-empty">
        <Loader2 size={18} className="spin" />
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="panel-empty panel-empty-col">
        <SearchX size={22} />
        <span>没有找到「{query}」相关的歌曲</span>
      </div>
    );
  }
  return (
    <ul className="queue">
      {results.map((track, i) => {
        const active = track.encryptedId === currentId;
        const disabled = !track.visible;
        return (
          <li
            key={`${track.encryptedId}-${i}`}
            className={[
              "queue-item",
              active ? "is-active" : "",
              disabled ? "is-disabled" : "",
            ].join(" ")}
          >
            <button
              type="button"
              className="icon-btn result-play"
              disabled={disabled}
              onClick={() => onPlay(track)}
              title={disabled ? "该歌曲暂时无法播放" : "播放"}
            >
              <Play size={14} fill="currentColor" />
            </button>
            <div className="queue-main as-static">
              <span className="queue-name">{track.name}</span>
              <span className="queue-artist">
                {track.artists.join(" / ")}
                {track.album ? ` · ${track.album}` : ""}
              </span>
            </div>
            {disabled && <span className="queue-tag">无法播放</span>}
            <span className="queue-duration">
              {formatTime(track.durationMs ?? 0)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
