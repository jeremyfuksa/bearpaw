import { useRef, useEffect } from 'react';
import type { ChannelData } from '../../types';

interface LockedChannelsCategoryProps {
  channels: ChannelData[];
  selectedChannels: number[];
  connected: boolean;
  onToggleChannel: (channelId: number) => void;
  onSelectAll: () => void;
  onClearSelected: () => void;
}

export function LockedChannelsCategory({
  channels,
  selectedChannels,
  connected,
  onToggleChannel,
  onSelectAll,
  onClearSelected,
}: LockedChannelsCategoryProps) {
  const lockedChannels = channels.filter((channel) => channel.lockout);
  const allSelected =
    lockedChannels.length > 0 &&
    lockedChannels.every((channel) => selectedChannels.includes(channel.index));
  const anySelected = selectedChannels.length > 0;
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate = !allSelected && anySelected;
  }, [allSelected, anySelected]);

  return (
    <div className="category-section">
      <h2 className="category-title">Locked Channels</h2>
      <p className="config-note">Select channels to unlock.</p>

      {lockedChannels.length === 0 ? (
        <p className="config-note">No locked channels.</p>
      ) : (
        <div className="locked-list">
          <label className="locked-selectAll">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={onSelectAll}
              disabled={!connected}
              ref={selectAllRef}
            />
            <span>Select all</span>
          </label>
          <ul className="locked-items" role="list">
            {lockedChannels.map((channel) => (
              <li key={channel.index} className="locked-item">
                <label className="locked-itemLabel">
                  <input
                    type="checkbox"
                    checked={selectedChannels.includes(channel.index)}
                    onChange={() => onToggleChannel(channel.index)}
                    disabled={!connected}
                  />
                  <span className="locked-text">
                    {channel.frequency.toFixed(4)}{" "}
                    {channel.alpha_tag || "—"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="config-actions">
        <button
          className="mvp-actionButton"
          type="button"
          disabled={!connected || selectedChannels.length === 0}
          onClick={onClearSelected}
        >
          Clear Selected Channels
        </button>
      </div>
    </div>
  );
}
