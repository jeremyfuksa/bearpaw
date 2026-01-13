import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { motion } from "motion/react";
import { Search, Lock } from "lucide-react";

import { cn } from "../../../lib/utils";
import { useAPI } from "../../../api/useApi";
import { useStore } from "../../../store/useStore";
import type { ChannelData, ChannelDraft } from "../../../types";

const bankTabs = Array.from({ length: 10 }, (_, index) => index + 1);

function deriveBankFromIndex(index: number) {
  const normalized = Math.max(1, index);
  return Math.min(10, Math.ceil(normalized / 50));
}

function buildDraft(channel: ChannelData): ChannelDraft {
  return {
    frequency: channel.frequency.toFixed(4),
    alpha_tag: channel.alpha_tag || "",
    modulation: channel.modulation || "AUTO",
    tone_squelch: channel.tone_squelch?.toString() ?? "",
    delay: channel.delay.toString(),
    lockout: channel.lockout,
    priority: channel.priority,
  };
}

export function ChannelsTab() {
  const api = useAPI();
  const channels = useStore((state) => state.channels) ?? [];
  const memoryDrafts = useStore((state) => state.memoryDrafts);
  const memoryEditingIndex = useStore((state) => state.memoryEditingIndex);
  const setMemoryEditingIndex = useStore((state) => state.setMemoryEditingIndex);
  const setMemoryDraft = useStore((state) => state.setMemoryDraft);
  const setChannels = useStore((state) => state.setChannels);

  const [activeBank, setActiveBank] = useState(1);
  const [searchTerm, setSearchTerm] = useState("");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const previousEditingIndex = useRef<number | null>(null);

  const filteredChannels = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return channels.filter((channel) => {
      const matchesBank = deriveBankFromIndex(channel.index) === activeBank;
      const matchesSearch =
        query === "" ||
        channel.alpha_tag.toLowerCase().includes(query) ||
        channel.frequency.toString().includes(query);
      return matchesBank && matchesSearch;
    });
  }, [activeBank, channels, searchTerm]);

  const commitDraft = useCallback(
    async (channelIndex: number) => {
      const channel = channels.find((entry) => entry.index === channelIndex);
      const draft = memoryDrafts[channelIndex];
      if (!channel || !draft) return;

      const parsedFrequency = Number.parseFloat(draft.frequency);
      const parsedDelay = Number.parseInt(draft.delay, 10);
      const toneValue =
        draft.tone_squelch.trim() === ""
          ? null
          : Number.parseFloat(draft.tone_squelch);

      const payload = {
        frequency: Number.isFinite(parsedFrequency) ? parsedFrequency : channel.frequency,
        modulation: draft.modulation,
        alpha_tag: draft.alpha_tag,
        delay: Number.isFinite(parsedDelay) ? parsedDelay : channel.delay,
        lockout: draft.lockout,
        priority: draft.priority,
        tone_squelch: Number.isFinite(toneValue ?? NaN) ? toneValue : null,
        bank: deriveBankFromIndex(channel.index),
      };

      const normalizedTone = payload.tone_squelch ?? null;
      const originalTone = channel.tone_squelch ?? null;

      const hasChanges =
        payload.frequency !== channel.frequency ||
        payload.modulation !== channel.modulation ||
        payload.alpha_tag !== channel.alpha_tag ||
        payload.delay !== channel.delay ||
        payload.lockout !== channel.lockout ||
        payload.priority !== channel.priority ||
        normalizedTone !== originalTone;

      if (!hasChanges) return;

      try {
        const updated = await api.updateChannel(channel.index, payload);
        setChannels((prev) =>
          prev.map((entry) => (entry.index === updated.index ? updated : entry)),
        );
        setMemoryDraft(updated.index, buildDraft(updated));
        toast.success(`Saved CH ${updated.index}`);
      } catch (error) {
        console.error("Failed to save channel", error);
        toast.error(`Failed to save CH ${channel.index}`);
      }
    },
    [api, channels, memoryDrafts, setChannels, setMemoryDraft],
  );

  useEffect(() => {
    const previous = previousEditingIndex.current;
    if (previous !== null && previous !== memoryEditingIndex) {
      void commitDraft(previous);
    }
    previousEditingIndex.current = memoryEditingIndex;
  }, [commitDraft, memoryEditingIndex]);

  useEffect(() => {
    if (memoryEditingIndex === null) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (containerRef.current && target && containerRef.current.contains(target)) {
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
  }, [activeBank, setMemoryEditingIndex]);

  const handleRowClick = (channelIndex: number) => {
    if (memoryEditingIndex === channelIndex) return;
    setMemoryEditingIndex(channelIndex);
    if (!memoryDrafts[channelIndex]) {
      const channel = channels.find((ch) => ch.index === channelIndex);
      if (channel) {
        setMemoryDraft(channelIndex, buildDraft(channel));
      }
    }
  };

  const updateDraftField = (channelIndex: number, field: keyof ChannelDraft, value: string | boolean) => {
    const draft = memoryDrafts[channelIndex];
    if (draft) {
      setMemoryDraft(channelIndex, { ...draft, [field]: value });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex h-full gap-6"
    >
      {/* Side Nav: Banks */}
      <div className="w-[160px] flex flex-col gap-1 bg-black/20 rounded-lg p-2 border border-white/5 h-full overflow-y-auto shrink-0">
        <h3 className="px-3 py-2 text-[10px] font-bold text-white/40 uppercase tracking-wider sticky top-0 bg-[#1c1f26]/90 backdrop-blur-sm z-10">
          Bank Select
        </h3>
        {bankTabs.map((bank) => (
          <button
            key={bank}
            onClick={() => setActiveBank(bank)}
            className={cn(
              "flex items-center justify-between px-3 py-2 text-xs font-medium rounded transition-all",
              activeBank === bank
                ? "bg-[#ef991f]/20 text-[#ef991f] shadow-[inset_0_0_10px_rgba(239,153,31,0.1)]"
                : "text-white/60 hover:bg-white/5 hover:text-white",
            )}
          >
            <span>Bank {bank}</span>
            {activeBank === bank && (
              <div className="w-1.5 h-1.5 rounded-full bg-[#ef991f] shadow-[0_0_5px_currentColor]" />
            )}
          </button>
        ))}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col gap-4 overflow-hidden min-w-0">
        {/* Toolbar */}
        <div className="flex gap-4 items-center justify-between bg-black/20 p-3 rounded-lg border border-white/5 shrink-0">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <h2 className="text-sm font-bold text-white flex items-center gap-2 shrink-0">
              <span className="w-6 h-6 rounded bg-white/5 flex items-center justify-center text-xs font-mono text-white/50">
                {activeBank}
              </span>
              Bank Channels
            </h2>
            <div className="h-4 w-px bg-white/10 shrink-0" />
            <div className="relative max-w-[300px] flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30 w-3.5 h-3.5" />
              <input
                type="text"
                placeholder="Search frequency or tag..."
                className="w-full bg-black/40 border border-white/5 focus:border-[#ef991f]/50 rounded text-xs pl-8 pr-4 py-1.5 text-white placeholder:text-white/20 outline-none transition-colors"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-2 shrink-0">
            <button className="px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded text-[10px] font-medium uppercase tracking-wider border border-white/5 transition-colors text-white/70 hover:text-white">
              Import CSV
            </button>
            <button className="px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded text-[10px] font-medium uppercase tracking-wider border border-white/5 transition-colors text-white/70 hover:text-white">
              Export CSV
            </button>
          </div>
        </div>

        {/* Table */}
        <div
          className="flex-1 bg-black/20 rounded-lg border border-white/5 overflow-hidden flex flex-col shadow-inner min-h-0"
          ref={containerRef}
        >
          {/* Header */}
          <div className="grid grid-cols-[50px_90px_1fr_60px_60px_50px_50px_50px] gap-2 px-4 py-2 bg-white/5 border-b border-white/5 shrink-0">
            {["CH", "FREQ", "TAG", "MODE", "TONE", "DLY", "L/O", "PRIO"].map((h) => (
              <div
                key={h}
                className="text-[10px] font-bold text-white/30 uppercase tracking-wider select-none text-center first:text-left"
              >
                {h}
              </div>
            ))}
          </div>

          {/* Rows */}
          <div className="overflow-y-auto flex-1 p-0">
            {filteredChannels.length === 0 ? (
              <div className="flex h-[240px] items-center justify-center text-xs text-white/50">
                No channels match your filters
              </div>
            ) : (
              filteredChannels.map((channel) => {
                const isEditing = memoryEditingIndex === channel.index;
                const draft = memoryDrafts[channel.index] ?? buildDraft(channel);

                return (
                  <div
                    key={channel.index}
                    onClick={() => handleRowClick(channel.index)}
                    className={cn(
                      "grid grid-cols-[50px_90px_1fr_60px_60px_50px_50px_50px] gap-2 px-4 py-1.5 text-xs border-b border-white/5 items-center group transition-colors cursor-pointer min-h-[36px]",
                      isEditing ? "bg-[#ef991f]/10" : "hover:bg-white/5",
                      channel.lockout && "opacity-50 grayscale",
                    )}
                  >
                    <div className="font-mono text-white/30 text-[10px] pl-1">
                      {channel.index}
                    </div>

                    {isEditing ? (
                      <>
                        <input
                          className="bg-black/50 border border-[#ef991f] rounded px-1.5 py-0.5 text-[#ef991f] w-full outline-none font-mono font-bold"
                          value={draft.frequency}
                          onChange={(e) => updateDraftField(channel.index, "frequency", e.target.value)}
                          autoFocus
                        />
                        <input
                          className="bg-black/50 border border-[#ef991f] rounded px-1.5 py-0.5 text-white w-full outline-none font-bold"
                          value={draft.alpha_tag}
                          onChange={(e) => updateDraftField(channel.index, "alpha_tag", e.target.value)}
                        />
                        <select
                          className="bg-black/50 border border-[#ef991f] rounded px-1 py-0.5 text-white w-full outline-none"
                          value={draft.modulation}
                          onChange={(e) => updateDraftField(channel.index, "modulation", e.target.value)}
                        >
                          {["AUTO", "FM", "AM", "NFM"].map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                        <input
                          className="bg-black/50 border border-[#ef991f] rounded px-1 py-0.5 text-white w-full outline-none"
                          value={draft.tone_squelch}
                          onChange={(e) => updateDraftField(channel.index, "tone_squelch", e.target.value)}
                        />
                        <input
                          className="bg-black/50 border border-[#ef991f] rounded px-1 py-0.5 text-white w-full outline-none"
                          value={draft.delay}
                          onChange={(e) => updateDraftField(channel.index, "delay", e.target.value)}
                        />
                        <div className="flex justify-center">
                          <input
                            type="checkbox"
                            checked={draft.lockout}
                            onChange={(e) => updateDraftField(channel.index, "lockout", e.target.checked)}
                            className="accent-[#ef991f]"
                          />
                        </div>
                        <div className="flex justify-center">
                          <input
                            type="checkbox"
                            checked={draft.priority}
                            onChange={(e) => updateDraftField(channel.index, "priority", e.target.checked)}
                            className="accent-[#ef991f]"
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="font-mono font-bold text-[#ef991f] group-hover:text-[#ffb045] tracking-wide text-center">
                          {channel.frequency.toFixed(4)}
                        </div>
                        <div className="font-medium text-white/80 truncate pl-1">
                          {channel.alpha_tag || "—"}
                        </div>
                        <div className="flex justify-center">
                          <span className="text-white/40 text-[9px] font-medium bg-white/5 rounded px-1.5 py-0.5 w-fit uppercase border border-white/5">
                            {channel.modulation || "AUTO"}
                          </span>
                        </div>
                        <div className="text-white/30 text-[10px] text-center">
                          {channel.tone_squelch ?? "—"}
                        </div>
                        <div className="text-white/30 text-[10px] text-center">
                          {channel.delay}s
                        </div>
                        <div className="flex justify-center">
                          {channel.lockout ? (
                            <Lock size={10} className="text-red-400" />
                          ) : (
                            <div className="w-1 h-1 rounded-full bg-white/5" />
                          )}
                        </div>
                        <div className="flex justify-center">
                          {channel.priority ? (
                            <div className="w-1.5 h-1.5 bg-orange-500 rounded-full shadow-[0_0_5px_orange]" />
                          ) : (
                            <div className="w-1 h-1 rounded-full bg-white/5" />
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
