interface AudioCategoryProps {
  volumeLevel: number;
  squelchLevel: number;
  connected: boolean;
  onVolumeChange: (value: number) => void;
  onSquelchChange: (value: number) => void;
  onVolumeCommit: (value: number) => void;
  onSquelchCommit: (value: number) => void;
}

export function AudioCategory({
  volumeLevel,
  squelchLevel,
  connected,
  onVolumeChange,
  onSquelchChange,
  onVolumeCommit,
  onSquelchCommit,
}: AudioCategoryProps) {
  return (
    <div className="category-section">
      <h2 className="category-title">Audio</h2>

      <div className="config-row config-row--stack">
        <span className="config-label">Volume</span>
        <div className="config-slider">
          <input
            type="range"
            min={0}
            max={15}
            value={volumeLevel}
            onChange={(event) => onVolumeChange(Number(event.target.value))}
            onMouseUp={(event) =>
              onVolumeCommit(Number((event.target as HTMLInputElement).value))
            }
            onTouchEnd={(event) =>
              onVolumeCommit(Number((event.target as HTMLInputElement).value))
            }
            disabled={!connected}
          />
          <span className="config-value">{volumeLevel}</span>
        </div>
      </div>

      <div className="config-row config-row--stack">
        <span className="config-label">Squelch</span>
        <div className="config-slider">
          <input
            type="range"
            min={0}
            max={15}
            value={squelchLevel}
            onChange={(event) => onSquelchChange(Number(event.target.value))}
            onMouseUp={(event) =>
              onSquelchCommit(Number((event.target as HTMLInputElement).value))
            }
            onTouchEnd={(event) =>
              onSquelchCommit(Number((event.target as HTMLInputElement).value))
            }
            disabled={!connected}
          />
          <span className="config-value">{squelchLevel}</span>
        </div>
      </div>
    </div>
  );
}
