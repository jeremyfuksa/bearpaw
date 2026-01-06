import { useAPI } from "../api/useApi";
import { useStore } from "../store/useStore";

interface PrimaryControlsProps {
  disabled?: boolean;
}

export function PrimaryControls({ disabled }: PrimaryControlsProps) {
  const api = useAPI();
  const mode = useStore((state) => state.liveState?.mode ?? "");
  const isHolding = mode === "HOLD";

  const handleToggle = () => {
    if (isHolding) {
      api.sendScan();
    } else {
      api.sendHold();
    }
  };

  return (
    <div className="primary-controls" role="group" aria-label="Scanner controls">
      <button
        className={`btn-toggle ${isHolding ? "holding" : "scanning"}`}
        onClick={handleToggle}
        disabled={disabled}
        aria-pressed={!isHolding}
        aria-label={isHolding ? "Holding, click to scan" : "Scanning, click to hold"}
      >
        {isHolding ? "🔄 Scan" : "⏸ Hold"}
      </button>
    </div>
  );
}
