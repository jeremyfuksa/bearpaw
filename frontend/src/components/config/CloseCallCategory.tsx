const closeCallModeOptions = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'Priority' },
  { value: 2, label: 'DND' },
];

const closeCallBandLabels = [
  'VHF Low',
  'Air',
  'VHF High 1',
  'VHF High 2',
  'UHF',
];

interface CloseCallCategoryProps {
  closeCallMode: number;
  closeCallBand: boolean[];
  closeCallBeep: boolean;
  closeCallLight: boolean;
  closeCallLockout: boolean;
  connected: boolean;
  onModeChange: (value: number) => void;
  onBandToggle: (index: number) => void;
  onAlertToggle: (field: 'alert_beep' | 'alert_light' | 'lockout', value: boolean) => void;
}

export function CloseCallCategory({
  closeCallMode,
  closeCallBand,
  closeCallBeep,
  closeCallLight,
  closeCallLockout,
  connected,
  onModeChange,
  onBandToggle,
  onAlertToggle,
}: CloseCallCategoryProps) {
  return (
    <div className="category-section">
      <h2 className="category-title">Close Call</h2>

      <div className="config-row">
        <span className="config-label">Mode</span>
        <select
          className="config-select"
          value={closeCallMode}
          onChange={(event) => onModeChange(Number(event.target.value))}
          disabled={!connected}
        >
          {closeCallModeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="config-group">
        {closeCallBandLabels.map((label, index) => (
          <label key={label} className="config-toggle">
            <input
              type="checkbox"
              checked={closeCallBand[index] ?? false}
              onChange={() => onBandToggle(index)}
              disabled={!connected}
            />
            <span className="config-switch" aria-hidden="true" />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <div className="config-group">
        <label className="config-toggle">
          <input
            type="checkbox"
            checked={closeCallBeep}
            onChange={(event) => onAlertToggle('alert_beep', event.target.checked)}
            disabled={!connected}
          />
          <span className="config-switch" aria-hidden="true" />
          <span>Alert Beep</span>
        </label>

        <label className="config-toggle">
          <input
            type="checkbox"
            checked={closeCallLight}
            onChange={(event) => onAlertToggle('alert_light', event.target.checked)}
            disabled={!connected}
          />
          <span className="config-switch" aria-hidden="true" />
          <span>Alert Light</span>
        </label>

        <label className="config-toggle">
          <input
            type="checkbox"
            checked={closeCallLockout}
            onChange={(event) => onAlertToggle('lockout', event.target.checked)}
            disabled={!connected}
          />
          <span className="config-switch" aria-hidden="true" />
          <span>Lockout Hits While Scanning</span>
        </label>
      </div>
    </div>
  );
}
