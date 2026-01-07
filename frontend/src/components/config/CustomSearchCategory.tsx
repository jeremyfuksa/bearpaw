import type { CustomSearchRange } from '../../types';

interface CustomSearchCategoryProps {
  customSearchGroups: boolean[];
  customSearchRanges: CustomSearchRange[];
  connected: boolean;
  onGroupToggle: (index: number) => void;
  onRangeChange: (index: number, field: 'lower' | 'upper', value: number) => void;
  onRangeCommit: (index: number) => void;
}

export function CustomSearchCategory({
  customSearchGroups,
  customSearchRanges,
  connected,
  onGroupToggle,
  onRangeChange,
  onRangeCommit,
}: CustomSearchCategoryProps) {
  return (
    <div className="category-section">
      <h2 className="category-title">Custom Search</h2>

      <h3 className="category-subtitle">Search Groups</h3>
      <div className="config-group config-group--grid">
        {customSearchGroups.map((enabled, index) => (
          <label key={`custom-group-${index + 1}`} className="config-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={() => onGroupToggle(index)}
              disabled={!connected}
            />
            <span className="config-switch" aria-hidden="true" />
            <span>Range {index + 1}</span>
          </label>
        ))}
      </div>

      <h3 className="category-subtitle">Frequency Ranges</h3>
      <div className="config-table">
        <div className="config-tableHeader">
          <span>Range</span>
          <span>Lower (MHz)</span>
          <span>Upper (MHz)</span>
          <span></span>
        </div>
        {customSearchRanges.map((range) => (
          <div key={`range-${range.index}`} className="config-tableRow">
            <span>#{range.index}</span>
            <input
              type="number"
              min={25}
              max={512}
              step={0.0001}
              value={Number.isFinite(range.lower) ? range.lower : 0}
              onChange={(event) => onRangeChange(range.index, 'lower', Number(event.target.value))}
              disabled={!connected}
            />
            <input
              type="number"
              min={25}
              max={512}
              step={0.0001}
              value={Number.isFinite(range.upper) ? range.upper : 0}
              onChange={(event) => onRangeChange(range.index, 'upper', Number(event.target.value))}
              disabled={!connected}
            />
            <button
              type="button"
              className="mvp-actionButton mvp-actionButton--ghost"
              onClick={() => onRangeCommit(range.index)}
              disabled={!connected}
            >
              Set
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
