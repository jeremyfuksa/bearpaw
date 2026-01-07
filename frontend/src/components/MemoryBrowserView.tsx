import { useEffect, useMemo, useRef, useState } from "react";

import { useStore } from "../store/useStore";
import type { ChannelData, ChannelDraft } from "../types";

export function MemoryBrowserView() {
  const channels = useStore((state) => state.channels);
  const memoryDrafts = useStore((state) => state.memoryDrafts);
  const memoryEditingIndex = useStore((state) => state.memoryEditingIndex);
  const setMemoryEditingIndex = useStore((state) => state.setMemoryEditingIndex);
  const setMemoryDraft = useStore((state) => state.setMemoryDraft);
  const [bankFilter, setBankFilter] = useState<number>(1);
  const [searchQuery, setSearchQuery] = useState("");
  const tableRef = useRef<HTMLDivElement | null>(null);

  const bankTabs = useMemo(
    () => Array.from({ length: 10 }, (_, index) => index + 1),
    []
  );

  const getDerivedBank = (index: number) => {
    const normalized = Math.max(1, index);
    return Math.min(10, Math.ceil(normalized / 50));
  };

  const getDraft = (channel: ChannelData) =>
    memoryDrafts[channel.index] ?? {
      frequency: channel.frequency.toFixed(4),
      alpha_tag: channel.alpha_tag || "",
      modulation: channel.modulation || "AUTO",
      tone_squelch: channel.tone_squelch?.toString() ?? "",
      delay: channel.delay.toString(),
      lockout: channel.lockout,
      priority: channel.priority,
      comments: "",
    };

  useEffect(() => {
    if (memoryEditingIndex === null) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (tableRef.current && target && tableRef.current.contains(target)) {
        return;
      }
      setMemoryEditingIndex(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMemoryEditingIndex(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [memoryEditingIndex, setMemoryEditingIndex]);

  useEffect(() => {
    setMemoryEditingIndex(null);
  }, [bankFilter, setMemoryEditingIndex]);

  const filteredChannels = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return channels.filter((channel) => {
      const matchesBank = getDerivedBank(channel.index) === bankFilter;
      const matchesSearch =
        query === "" ||
        channel.alpha_tag.toLowerCase().includes(query) ||
        channel.frequency.toString().includes(query);
      return matchesBank && matchesSearch;
    });
  }, [bankFilter, channels, searchQuery]);

  return (
    <section
      className="memory-panel"
      aria-label="Memory browser"
      onClick={() => setEditingIndex(null)}
    >
      <div className="panel-controls" onClick={(event) => event.stopPropagation()}>
        <div className="bank-tabs" role="tablist" aria-label="Channel banks">
          {bankTabs.map((bank) => (
            <button
              key={bank}
              className={`bank-tab${bankFilter === bank ? " is-active" : ""}`}
              type="button"
              role="tab"
              aria-selected={bankFilter === bank}
              onClick={() => setBankFilter(bank)}
            >
              Bank {bank}
            </button>
          ))}
        </div>

        <div className="panel-search">
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
      </div>

      <div className="channel-table" ref={tableRef}>
        <div className="channel-row header">
          <span>CH</span>
          <span>Frequency</span>
          <span>Tag</span>
          <span>Mode</span>
          <span>PL/DPL</span>
          <span>Delay</span>
          <span>Lock</span>
          <span>Prio</span>
          <span>Comments</span>
        </div>
        {filteredChannels.map((channel) => {
          const isEditing = memoryEditingIndex === channel.index;
          const draft = getDraft(channel);

          return (
            <div
              className={`channel-row${isEditing ? " is-editing" : ""}${
                channel.lockout ? " is-locked" : ""
              }`}
              key={channel.index}
              onClick={(event) => {
                event.stopPropagation();
                setMemoryEditingIndex(channel.index);
                if (!memoryDrafts[channel.index]) {
                  setMemoryDraft(channel.index, draft);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <span>{channel.index}</span>
              {isEditing ? (
                <input
                  type="number"
                  step="0.0001"
                  value={draft.frequency}
                  onChange={(event) =>
                    setMemoryDraft(channel.index, {
                      ...draft,
                      frequency: event.target.value,
                    })
                  }
                />
              ) : (
                <span>{channel.frequency.toFixed(4)} MHz</span>
              )}
              {isEditing ? (
                <input
                  type="text"
                  value={draft.alpha_tag}
                  onChange={(event) =>
                    setMemoryDraft(channel.index, {
                      ...draft,
                      alpha_tag: event.target.value,
                    })
                  }
                />
              ) : (
                <span className="channel-tag">
                  <span className="channel-tagText">{channel.alpha_tag || "—"}</span>
                <span className="channel-badges" />
                </span>
              )}
              {isEditing ? (
                <select
                  value={draft.modulation}
                  onChange={(event) =>
                    setMemoryDraft(channel.index, {
                      ...draft,
                      modulation: event.target.value,
                    })
                  }
                >
                  {["AUTO", "FM", "AM", "NFM"].map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <span>{channel.modulation || "AUTO"}</span>
              )}
              {isEditing ? (
                <input
                  type="text"
                  placeholder="—"
                  value={draft.tone_squelch}
                  onChange={(event) =>
                    setMemoryDraft(channel.index, {
                      ...draft,
                      tone_squelch: event.target.value,
                    })
                  }
                />
              ) : (
                <span>{channel.tone_squelch ?? "—"}</span>
              )}
              {isEditing ? (
                <input
                  type="number"
                  min="0"
                  max="9"
                  value={draft.delay}
                  onChange={(event) =>
                    setMemoryDraft(channel.index, {
                      ...draft,
                      delay: event.target.value,
                    })
                  }
                />
              ) : (
                <span>{channel.delay}</span>
              )}
              {isEditing ? (
                <input
                  type="checkbox"
                  checked={draft.lockout}
                  onChange={(event) =>
                    setMemoryDraft(channel.index, {
                      ...draft,
                      lockout: event.target.checked,
                    })
                  }
                />
              ) : (
                <span>{channel.lockout ? "On" : "Off"}</span>
              )}
              {isEditing ? (
                <input
                  type="checkbox"
                  checked={draft.priority}
                  onChange={(event) =>
                    setMemoryDraft(channel.index, {
                      ...draft,
                      priority: event.target.checked,
                    })
                  }
                />
              ) : (
                <span>{channel.priority ? "On" : "Off"}</span>
              )}
              {isEditing ? (
                <input
                  type="text"
                  placeholder="—"
                  value={draft.comments}
                  onChange={(event) =>
                    setMemoryDraft(channel.index, {
                      ...draft,
                      comments: event.target.value,
                    })
                  }
                />
              ) : (
                <span className="channel-comments">—</span>
              )}
            </div>
          );
        })}
        {filteredChannels.length === 0 && (
          <div className="channel-empty">No channels match your search.</div>
        )}
      </div>
    </section>
  );
}
