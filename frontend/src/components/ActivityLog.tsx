import { useMemo, useState } from "react";

import { useAPI } from "../api/useApi";
import { useStore } from "../store/useStore";

interface ActivityLogProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatTimestamp(ts: number) {
  const now = Date.now() / 1000;
  const diff = now - ts;

  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return new Date(ts * 1000).toLocaleTimeString();
}

export function ActivityLog({ isOpen, onClose }: ActivityLogProps) {
  const entries = useStore((state) => state.activityLog);
  const connected = useStore((state) => state.connected);
  const api = useAPI();
  const [isCollapsed, setIsCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 768px)").matches;
  });

  const latestEntry = useMemo(() => entries[0], [entries]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Activity log"
    >
      <section
        className="activity-panel"
        aria-label="Activity log"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sr-only" aria-live="polite" aria-atomic="false">
          {latestEntry
            ? `New activity: ${latestEntry.frequency.toFixed(4)} megahertz${
                latestEntry.alpha_tag ? `, ${latestEntry.alpha_tag}` : ""
              }`
            : ""}
        </div>
        <header className="activity-header">
          <button
            className="activity-toggle"
            type="button"
            onClick={() => setIsCollapsed((prev) => !prev)}
            aria-expanded={!isCollapsed}
          >
            <span className="activity-title">
              <span className="section-label">Activity Log</span>
              <span className="section-subtitle">{entries.length} recent hits</span>
            </span>
            <span className="toggle-icon" aria-hidden="true">
              {isCollapsed ? "▶" : "▼"}
            </span>
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close activity log"
          >
            ×
          </button>
        </header>
        {!isCollapsed && (
          <div className="activity-entries" role="log" aria-label="Scanner activity history">
            {entries.length === 0 && (
              <div className="activity-empty">No recent activity. Start scanning to see hits.</div>
            )}
            {entries.map((entry) => (
              <button
                key={entry.id}
                className="activity-entry"
                type="button"
                onClick={() => api.setFrequency(entry.frequency)}
                disabled={!connected}
              >
                <span className="time">{formatTimestamp(entry.timestamp)}</span>
                <span className="freq">{entry.frequency.toFixed(4)} MHz</span>
                <span className="tag">{entry.alpha_tag || "—"}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
