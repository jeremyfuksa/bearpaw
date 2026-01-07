import type { DeviceInfo, LiveState } from '../../types';
import { ConnectionStatus } from '../ConnectionStatus';

interface DeviceStatusHeaderProps {
  deviceInfo: DeviceInfo | null;
  firmware: string | null;
  liveState: LiveState | null;
}

export function DeviceStatusHeader({
  deviceInfo,
  firmware,
  liveState,
}: DeviceStatusHeaderProps) {
  return (
    <div className="device-status-header">
      <div className="device-status-item device-status-item--connection">
        <ConnectionStatus />
      </div>
      <div className="device-status-item">
        <span className="device-status-label">Model:</span>
        <span className="device-status-value">{deviceInfo?.model || "—"}</span>
      </div>
      <div className="device-status-item">
        <span className="device-status-label">Firmware:</span>
        <span className="device-status-value">{firmware || "—"}</span>
      </div>
      <div className="device-status-item">
        <span className="device-status-label">Mode:</span>
        <span className="device-status-value">{liveState?.mode || "—"}</span>
      </div>
      <div className="device-status-item">
        <span className="device-status-label">Squelch:</span>
        <span className="device-status-value">
          {liveState ? (liveState.squelch_open ? "Open" : "Closed") : "—"}
        </span>
      </div>
    </div>
  );
}
