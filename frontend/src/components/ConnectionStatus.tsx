import { useStore } from "../store/useStore";

export function ConnectionStatus() {
  const connected = useStore((state) => state.connected);
  const connecting = useStore((state) => state.connecting);
  const deviceInfo = useStore((state) => state.deviceInfo);

  let label = "Disconnected";
  if (connecting) {
    label = "Connecting";
  } else if (connected) {
    label = "Connected";
  }

  return (
    <div
      className="connection-status"
      role="status"
      aria-live="polite"
      aria-label={`${label} to scanner`}
    >
      <span
        className={`status-dot ${connected ? "connected" : connecting ? "connecting" : "disconnected"}`}
        aria-hidden="true"
      />
      <div className="status-text">
        <span className="status-label">{label}</span>
        <span className="status-device">{deviceInfo?.model || "Scanner"}</span>
      </div>
    </div>
  );
}
