const searchDelayOptions = [
  { value: -10, label: '-10' },
  { value: -5, label: '-5' },
  { value: 0, label: '0' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
  { value: 5, label: '5' },
];

interface SearchCategoryProps {
  searchDelay: number;
  searchCode: boolean;
  connected: boolean;
  onSearchDelayChange: (value: number) => void;
  onSearchCodeChange: (value: boolean) => void;
}

export function SearchCategory({
  searchDelay,
  searchCode,
  connected,
  onSearchDelayChange,
  onSearchCodeChange,
}: SearchCategoryProps) {
  return (
    <div className="category-section">
      <h2 className="category-title">Search</h2>

      <div className="config-row">
        <span className="config-label">Search Delay</span>
        <select
          className="config-select"
          value={searchDelay}
          onChange={(event) => onSearchDelayChange(Number(event.target.value))}
          disabled={!connected}
        >
          {searchDelayOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <label className="config-toggle">
        <input
          type="checkbox"
          checked={searchCode}
          onChange={(event) => onSearchCodeChange(event.target.checked)}
          disabled={!connected}
        />
        <span className="config-switch" aria-hidden="true" />
        <span>CTCSS/DCS Search</span>
      </label>
    </div>
  );
}
