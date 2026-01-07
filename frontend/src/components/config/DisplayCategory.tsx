const backlightOptions = [
  { value: 'AO', label: 'Always On' },
  { value: 'AF', label: 'Always Off' },
  { value: 'KY', label: 'Keypress' },
  { value: 'SQ', label: 'Squelch' },
  { value: 'KS', label: 'Key + Squelch' },
];

interface DisplayCategoryProps {
  backlight: string;
  contrast: number;
  connected: boolean;
  onBacklightChange: (value: string) => void;
  onContrastChange: (value: number) => void;
  onContrastCommit: (value: number) => void;
}

export function DisplayCategory({
  backlight,
  contrast,
  connected,
  onBacklightChange,
  onContrastChange,
  onContrastCommit,
}: DisplayCategoryProps) {
  return (
    <div className="category-section">
      <h2 className="category-title">Display</h2>

      <div className="config-row">
        <span className="config-label">Backlight</span>
        <select
          className="config-select"
          value={backlight}
          onChange={(event) => onBacklightChange(event.target.value)}
          disabled={!connected}
        >
          {backlightOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="config-row">
        <span className="config-label">Contrast</span>
        <div className="config-slider">
          <input
            type="range"
            min={1}
            max={15}
            value={contrast}
            onChange={(event) => onContrastChange(Number(event.target.value))}
            onMouseUp={(event) =>
              onContrastCommit(Number((event.target as HTMLInputElement).value))
            }
            onTouchEnd={(event) =>
              onContrastCommit(Number((event.target as HTMLInputElement).value))
            }
            disabled={!connected}
          />
          <span className="config-value">{contrast}</span>
        </div>
      </div>
    </div>
  );
}
