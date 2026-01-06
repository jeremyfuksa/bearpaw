import { useMemo, useState } from "react";

import { useAPI } from "../api/useApi";
import { useStore } from "../store/useStore";

interface MemoryBrowserPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MemoryBrowserPanel({ isOpen, onClose }: MemoryBrowserPanelProps) {
  const api = useAPI();
  const channels = useStore((state) => state.channels);
  const connected = useStore((state) => state.connected);
  const [bankFilter, setBankFilter] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredChannels = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return channels.filter((channel) => {
      const matchesBank = bankFilter === null || channel.bank === bankFilter;
      const matchesSearch =
        query === "" ||
        channel.alpha_tag.toLowerCase().includes(query) ||
        channel.frequency.toString().includes(query);
      return matchesBank && matchesSearch;
    });
  }, [bankFilter, channels, searchQuery]);

  if (!isOpen) return null;

  return (
    <div className="panel-overlay" role="dialog" aria-modal="true" aria-label="Memory browser">
      <aside className="memory-panel">
        <header>
          <div>
            <div className="section-label">Memory Channels</div>
            <div className="section-subtitle">{channels.length} channels</div>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close memory browser"
          >
            ×
          </button>
        </header>

        <div className="panel-controls">
          <label className="field-label" htmlFor="bank-filter">
            Bank
          </label>
          <select
            id="bank-filter"
            value={bankFilter ?? ""}
            onChange={(event) =>
              setBankFilter(event.target.value ? Number(event.target.value) : null)
            }
          >
            <option value="">All Banks</option>
            {Array.from({ length: 10 }, (_, index) => index + 1).map((bank) => (
              <option key={bank} value={bank}>
                Bank {bank}
              </option>
            ))}
          </select>

          <label className="field-label" htmlFor="memory-search">
            Search
          </label>
          <input
            id="memory-search"
            type="search"
            placeholder="Tag or frequency"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>

        <div className="channel-table">
          <div className="channel-row header">
            <span>CH</span>
            <span>Frequency</span>
            <span>Tag</span>
            <span>Bank</span>
            <span></span>
          </div>
          {filteredChannels.map((channel) => (
            <div className="channel-row" key={channel.index}>
              <span>{channel.index}</span>
              <span>{channel.frequency.toFixed(4)} MHz</span>
              <span>{channel.alpha_tag || "—"}</span>
              <span>{channel.bank}</span>
              <span>
                <button
                  className="btn btn-tertiary"
                  type="button"
                  onClick={() => {
                    api.setFrequency(channel.frequency);
                    onClose();
                  }}
                  disabled={!connected}
                >
                  Tune
                </button>
              </span>
            </div>
          ))}
          {filteredChannels.length === 0 && (
            <div className="channel-empty">No channels match your search.</div>
          )}
        </div>
      </aside>
    </div>
  );
}
