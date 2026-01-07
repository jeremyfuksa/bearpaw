import { WidgetCard } from './WidgetCard';
import type { HeatmapCell } from './types';

interface ActivityHeatmapWidgetProps {
  heatmap: HeatmapCell[];
  loading?: boolean;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ActivityHeatmapWidget({ heatmap, loading }: ActivityHeatmapWidgetProps) {
  if (loading) {
    return (
      <WidgetCard title="Activity Heatmap">
        <div className="dashboard-loading">Loading...</div>
      </WidgetCard>
    );
  }

  if (!heatmap || heatmap.length === 0) {
    return (
      <WidgetCard title="Activity Heatmap">
        <div className="dashboard-empty">No activity data yet</div>
      </WidgetCard>
    );
  }

  // Create a lookup map for quick access
  const heatmapMap = new Map<string, number>();
  let maxCount = 0;

  for (const cell of heatmap) {
    const key = `${cell.day}-${cell.hour}`;
    heatmapMap.set(key, cell.count);
    if (cell.count > maxCount) {
      maxCount = cell.count;
    }
  }

  const getIntensity = (count: number): string => {
    if (count === 0 || maxCount === 0) return 'intensity-0';
    const ratio = count / maxCount;
    if (ratio < 0.2) return 'intensity-1';
    if (ratio < 0.4) return 'intensity-2';
    if (ratio < 0.6) return 'intensity-3';
    if (ratio < 0.8) return 'intensity-4';
    return 'intensity-5';
  };

  return (
    <WidgetCard title="Activity Heatmap" className="heatmap-widget">
      <div className="activity-heatmap">
        <div className="heatmap-grid">
          {/* Hour labels */}
          <div className="heatmap-hour-labels">
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className="heatmap-hour-label">
                {hour % 6 === 0 ? `${hour}h` : ''}
              </div>
            ))}
          </div>

          {/* Days and cells */}
          {DAY_LABELS.map((dayLabel, day) => (
            <div key={day} className="heatmap-row">
              <div className="heatmap-day-label">{dayLabel}</div>
              <div className="heatmap-cells">
                {Array.from({ length: 24 }, (_, hour) => {
                  const key = `${day}-${hour}`;
                  const count = heatmapMap.get(key) || 0;
                  return (
                    <div
                      key={hour}
                      className={`heatmap-cell ${getIntensity(count)}`}
                      title={`${dayLabel} ${hour}:00 - ${count} hits`}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </WidgetCard>
  );
}
