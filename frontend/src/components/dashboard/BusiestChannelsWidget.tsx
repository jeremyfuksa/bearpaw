import { useState } from 'react';
import { WidgetCard } from './WidgetCard';
import { Tooltip } from './Tooltip';
import type { BusiestChannel } from './types';

interface BusiestChannelsWidgetProps {
  channels: BusiestChannel[];
  loading?: boolean;
}

export function BusiestChannelsWidget({
  channels,
  loading,
}: BusiestChannelsWidgetProps) {
  const [timeWindow, setTimeWindow] = useState<number>(24);

  if (loading) {
    return (
      <WidgetCard title="Busiest Channels">
        <div className="dashboard-loading">Loading...</div>
      </WidgetCard>
    );
  }

  if (!channels || channels.length === 0) {
    return (
      <WidgetCard title="Busiest Channels">
        <div className="dashboard-empty">No hits recorded yet</div>
      </WidgetCard>
    );
  }

  // Find max hit count for scaling bars
  const maxHits = Math.max(...channels.map(ch => ch.hit_count));

  return (
    <WidgetCard title="Busiest Channels">
      <div className="busiest-channels">
        <div className="time-window-selector">
          <button
            className={timeWindow === 1 ? 'active' : ''}
            onClick={() => setTimeWindow(1)}
          >
            1h
          </button>
          <button
            className={timeWindow === 24 ? 'active' : ''}
            onClick={() => setTimeWindow(24)}
          >
            24h
          </button>
          <button
            className={timeWindow === 168 ? 'active' : ''}
            onClick={() => setTimeWindow(168)}
          >
            7d
          </button>
          <button
            className={timeWindow === 720 ? 'active' : ''}
            onClick={() => setTimeWindow(720)}
          >
            30d
          </button>
        </div>
        <div className="busiest-channels-chart">
          {channels.map((channel) => {
            const barWidth = (channel.hit_count / maxHits) * 100;
            return (
              <Tooltip
                key={channel.rank}
                content={
                  <div className="tooltip-content">
                    <div className="tooltip-row">
                      <span className="tooltip-label">Frequency:</span>
                      <span className="tooltip-value">{channel.frequency.toFixed(4)} MHz</span>
                    </div>
                    <div className="tooltip-row">
                      <span className="tooltip-label">Avg Duration:</span>
                      <span className="tooltip-value">{channel.avg_duration.toFixed(1)}s</span>
                    </div>
                  </div>
                }
              >
                <div className="chart-bar">
                  <div className="chart-label">
                    <span className="chart-tag">{channel.alpha_tag || '—'}</span>
                  </div>
                  <div className="chart-bar-container">
                    <div
                      className="chart-bar-fill"
                      style={{ width: `${barWidth}%` }}
                    />
                    <span className="chart-value">{channel.hit_count}</span>
                  </div>
                </div>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </WidgetCard>
  );
}
