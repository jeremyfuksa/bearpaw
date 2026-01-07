import type { DeviceInfo, LiveState } from '../../types';
import { ConnectionStatus } from '../ConnectionStatus';

interface DeviceStatusHeaderProps {
  deviceInfo: DeviceInfo | null;
  firmware: string | null;
  liveState: LiveState | null;
}

export function DeviceStatusHeader({
  firmware,
}: DeviceStatusHeaderProps) {
  return (
    <div className="device-status-header">
      <div className="device-status-item device-status-item--connection">
        <ConnectionStatus />
      </div>
      {/* removed model. duplicate with connection status */}
      <div className="device-status-item">
        <span className="device-status-label">Firmware:</span>
        <span className="device-status-value">{firmware || "—"}</span>
      </div>
      {/* mode and squelch removed. do not re-add. */}
    </div>
  );
}
