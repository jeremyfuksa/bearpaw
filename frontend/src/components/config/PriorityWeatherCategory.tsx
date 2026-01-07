const priorityOptions = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'On' },
  { value: 2, label: 'Plus' },
  { value: 3, label: 'DND' },
];

interface PriorityWeatherCategoryProps {
  priorityMode: number;
  weatherPriority: boolean;
  connected: boolean;
  onPriorityChange: (value: number) => void;
  onWeatherPriorityChange: (value: boolean) => void;
}

export function PriorityWeatherCategory({
  priorityMode,
  weatherPriority,
  connected,
  onPriorityChange,
  onWeatherPriorityChange,
}: PriorityWeatherCategoryProps) {
  return (
    <div className="category-section">
      <h2 className="category-title">Priority & Weather</h2>

      <div className="config-row">
        <span className="config-label">Priority Mode</span>
        <select
          className="config-select"
          value={priorityMode}
          onChange={(event) => onPriorityChange(Number(event.target.value))}
          disabled={!connected}
        >
          {priorityOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <label className="config-toggle">
        <input
          type="checkbox"
          checked={weatherPriority}
          onChange={(event) => onWeatherPriorityChange(event.target.checked)}
          disabled={!connected}
        />
        <span className="config-switch" aria-hidden="true" />
        <span>Weather Alert Priority</span>
      </label>
    </div>
  );
}
