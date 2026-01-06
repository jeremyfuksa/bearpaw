import { useMemo, useState } from "react";

import { useAPI } from "../api/useApi";
import { useStore } from "../store/useStore";

interface CurrentBankViewProps {
  onBrowseAll: () => void;
}

export function CurrentBankView({ onBrowseAll }: CurrentBankViewProps) {
  const api = useAPI();
  const liveState = useStore((state) => state.liveState);
  const channels = useStore((state) => state.channels);
  const connected = useStore((state) => state.connected);

  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window === "undefined") return true;
    return !window.matchMedia("(max-width: 768px)").matches;
  });

  const currentChannel = useMemo(() => {
    if (!liveState?.channel) return null;
    return channels.find((channel) => channel.index === liveState.channel) ?? null;
  }, [channels, liveState]);

  const currentBank = currentChannel?.bank ?? null;
  const bankChannels = useMemo(() => {
    if (!currentBank) return [];
    return channels.filter((channel) => channel.bank === currentBank && !channel.lockout);
  }, [channels, currentBank]);

  if (!currentBank) {
    return null;
  }

  return (
    <section id="current-bank" className="current-bank-view" aria-label="Current bank channels">
      <button
        className="bank-header"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
        type="button"
      >
        <h3>Current Bank (BANK {currentBank})</h3>
        <span className="toggle-icon" aria-hidden="true">
          {isExpanded ? "▼" : "▶"}
        </span>
      </button>

      {isExpanded && (
        <div className="bank-channels">
          {bankChannels.length === 0 ? (
            <div>
              <p className="bank-empty">No channels in this bank.</p>
              <button className="browse-all" type="button" onClick={onBrowseAll}>
                Browse All Channels →
              </button>
            </div>
          ) : (
            <>
              {bankChannels.map((channel) => (
                <button
                  key={channel.index}
                  className={`bank-channel${channel.index === liveState?.channel ? " active" : ""}`}
                  type="button"
                  onClick={() => api.setFrequency(channel.frequency)}
                  disabled={!connected}
                  aria-label={`Channel ${channel.index}: ${channel.frequency.toFixed(4)} MHz, ${
                    channel.alpha_tag || "no name"
                  }`}
                >
                  <span className="ch-num">{channel.index}</span>
                  <span className="ch-freq">{channel.frequency.toFixed(4)}</span>
                  <span className="ch-tag">{channel.alpha_tag || "—"}</span>
                  {channel.index === liveState?.channel && (
                    <span className="ch-indicator" aria-hidden="true">
                      ●
                    </span>
                  )}
                </button>
              ))}
              <button className="browse-all" type="button" onClick={onBrowseAll}>
                Browse All Channels →
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
