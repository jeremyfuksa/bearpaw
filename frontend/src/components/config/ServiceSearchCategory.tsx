const serviceSearchLabels = [
  'Police',
  'Fire/Emergency',
  'Ham',
  'Marine',
  'Railroad',
  'Civil Air',
  'Military Air',
  'CB',
  'FRS/GMRS/MURS',
  'Racing',
];

interface ServiceSearchCategoryProps {
  serviceSearchGroups: boolean[];
  connected: boolean;
  onToggle: (index: number) => void;
}

export function ServiceSearchCategory({
  serviceSearchGroups,
  connected,
  onToggle,
}: ServiceSearchCategoryProps) {
  return (
    <div className="category-section">
      <h2 className="category-title">Service Search</h2>

      <div className="config-group">
        {serviceSearchLabels.map((label, index) => (
          <label key={label} className="config-toggle">
            <input
              type="checkbox"
              checked={serviceSearchGroups[index] ?? false}
              onChange={() => onToggle(index)}
              disabled={!connected}
            />
            <span className="config-switch" aria-hidden="true" />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
