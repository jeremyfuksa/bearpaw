import type { SessionStats } from './types';

interface SessionStatsWidgetProps {
  stats: SessionStats | null;
  loading?: boolean;
}

export function SessionStatsWidget({ stats, loading }: SessionStatsWidgetProps) {
  if (loading || !stats) {
    return null;
  }

  const activeMinutes = Math.floor(stats.active_time_seconds / 60);
  const activeSeconds = Math.floor(stats.active_time_seconds % 60);

  return (
    <div className="session-stats-chips">
      <div className="session-stat-chip">
        <span className="session-stat-chip-value">{stats.total_hits}</span>
        <span className="session-stat-chip-label">Hits</span>
      </div>
      <div className="session-stat-chip">
        <span className="session-stat-chip-value">{stats.avg_rssi.toFixed(0)}</span>
        <span className="session-stat-chip-label">Signal</span>
      </div>
      <div className="session-stat-chip">
        <span className="session-stat-chip-value">
          {activeMinutes}:{activeSeconds.toString().padStart(2, '0')}
        </span>
        <span className="session-stat-chip-label">Active</span>
      </div>
      <div className="session-stat-chip">
        <span className="session-stat-chip-value">{stats.unique_channels}</span>
        <span className="session-stat-chip-label">Channels</span>
      </div>
    </div>
  );
}
