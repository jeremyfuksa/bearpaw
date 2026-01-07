interface PowerKeysCategoryProps {
  keyBeepLevel: number;
  keyLock: boolean;
  batteryChargeTime: number;
  connected: boolean;
  onKeyBeepChange: (value: number) => void;
  onKeyLockChange: (value: boolean) => void;
  onBatteryChargeChange: (value: number) => void;
  onBatteryChargeCommit: (value: number) => void;
}

export function PowerKeysCategory({
  keyBeepLevel,
  keyLock,
  batteryChargeTime,
  connected,
  onKeyBeepChange,
  onKeyLockChange,
  onBatteryChargeChange,
  onBatteryChargeCommit,
}: PowerKeysCategoryProps) {
  return (
    <div className="category-section">
      <h2 className="category-title">Power & Keys</h2>

      <div className="config-row">
        <span className="config-label">Beep Level</span>
        <select
          className="config-select"
          value={keyBeepLevel}
          onChange={(event) => onKeyBeepChange(Number(event.target.value))}
          disabled={!connected}
        >
          <option value={0}>Auto</option>
          {Array.from({ length: 15 }, (_, index) => (
            <option key={index + 1} value={index + 1}>
              {index + 1}
            </option>
          ))}
          <option value={99}>Off</option>
        </select>
      </div>

      <label className="config-toggle">
        <input
          type="checkbox"
          checked={keyLock}
          onChange={(event) => onKeyLockChange(event.target.checked)}
          disabled={!connected}
        />
        <span className="config-switch" aria-hidden="true" />
        <span>Key Lock</span>
      </label>

      <div className="config-row">
        <span className="config-label">Battery Saver (hrs)</span>
        <div className="config-slider">
          <input
            type="range"
            min={1}
            max={16}
            value={batteryChargeTime}
            onChange={(event) => onBatteryChargeChange(Number(event.target.value))}
            onMouseUp={(event) =>
              onBatteryChargeCommit(Number((event.target as HTMLInputElement).value))
            }
            onTouchEnd={(event) =>
              onBatteryChargeCommit(Number((event.target as HTMLInputElement).value))
            }
            disabled={!connected}
          />
          <span className="config-value">{batteryChargeTime}</span>
        </div>
      </div>
    </div>
  );
}
