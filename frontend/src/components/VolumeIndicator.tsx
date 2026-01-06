import { useStore } from "../store/useStore";

export function VolumeIndicator() {
  const volume = useStore((state) => state.liveState?.volume ?? 0);

  return (
    <div className="volume-indicator" aria-label={`Volume ${volume} out of 15`}>
      <span className="volume-label">VOL</span>
      <span className="volume-value">{volume}/15</span>
    </div>
  );
}
