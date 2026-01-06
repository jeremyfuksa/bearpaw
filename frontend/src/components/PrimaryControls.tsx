interface PrimaryControlsProps {
  isHolding: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export function PrimaryControls({ isHolding, onToggle, disabled }: PrimaryControlsProps) {
  return (
    <div className="primary-controls" role="group" aria-label="Scanner controls">
      <button
        className={`btn-toggle ${isHolding ? "holding" : "scanning"}`}
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={isHolding}
        aria-label={isHolding ? "Holding, click to scan" : "Scanning, click to hold"}
      >
        {isHolding ? "Scan" : "Hold"}
      </button>
    </div>
  );
}
