import { useStore } from "../store/useStore";

export function ConnectionStatus() {
  const connected = useStore((state) => state.connected);
  const connecting = useStore((state) => state.connecting);
  const deviceInfo = useStore((state) => state.deviceInfo);
  const isStale = useStore((state) => Boolean(state.liveState?.stale));
  const socketDisconnected = !connected && !connecting;

  const deviceConnection = deviceInfo?.connection_status;
  const status =
    socketDisconnected || isStale || deviceConnection === "disconnected"
      ? "disconnected"
      : deviceConnection === "connecting"
        ? "connecting"
        : deviceConnection === "connected"
          ? "connected"
          : connected
            ? "connected"
            : connecting
              ? "connecting"
              : "disconnected";
  const label = status === "disconnected" ? "Disconnected" : deviceInfo?.model || "Scanner";

  return (
    <div
      className="connection-status"
      role="status"
      aria-live="polite"
      aria-label={`${label} to scanner`}
    >
      <span
        className={`status-dot ${status}`}
        aria-hidden="true"
      />
      <div className="status-text">
        <span className="status-label">{label}</span>
      </div>
    </div>
  );
}
