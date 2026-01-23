import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { motion } from "motion/react";
import { Search, Lock, Edit3 } from "lucide-react";

import { cn } from "../../../lib/utils";
import { useAPI } from "../../../api/useApi";
import { useStore } from "../../../store/useStore";
import type { ChannelData, ChannelDraft } from "../../../types";
import { ChannelEditSheet } from "./ChannelEditSheet";

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
    comments: "",
  };
}

export function ChannelsTab() {
  const api = useAPI();
  const channels = useStore((state) => state.channels) ?? [];
  const memoryDrafts = useStore((state) => state.memoryDrafts);
  const setMemoryDraft = useStore((state) => state.setMemoryDraft);
  const setChannels = useStore((state) => state.setChannels);

  const [activeBank, setActiveBank] = useState(1);
  const [searchTerm, setSearchTerm] = useState("");
  const [editingChannelIndex, setEditingChannelIndex] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);

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

  const editingChannel = editingChannelIndex !== null
    ? channels.find((ch) => ch.index === editingChannelIndex)
    : null;
  const editingDraft = editingChannelIndex !== null
    ? memoryDrafts[editingChannelIndex]
    : undefined;

  const handleOpenEditSheet = useCallback((channelIndex: number) => {
    const channel = channels.find((ch) => ch.index === channelIndex);
    if (!channel) return;

    setEditingChannelIndex(channelIndex);
    if (!memoryDrafts[channelIndex]) {
      setMemoryDraft(channelIndex, buildDraft(channel));
    }
  }, [channels, memoryDrafts, setMemoryDraft]);

  const handleCloseEditSheet = useCallback(() => {
    setEditingChannelIndex(null);
  }, []);

  const updateDraftField = (channelIndex: number, field: keyof ChannelDraft, value: string | boolean) => {
    const draft = memoryDrafts[channelIndex];
    if (draft) {
      setMemoryDraft(channelIndex, { ...draft, [field]: value });
    }
  };

  const handleSaveChannel = useCallback(async (channelIndex: number, draft: ChannelDraft) => {
    const channel = channels.find((entry) => entry.index === channelIndex);
    if (!channel) return;

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
      bank: deriveBankFromIndex(channelIndex),
    };

    try {
      const updated = await api.updateChannel(channelIndex, payload);
      setChannels((prev) =>
        prev.map((entry) => (entry.index === updated.index ? updated : entry)),
      );
      setMemoryDraft(updated.index, buildDraft(updated));
      toast.success(`Saved CH ${updated.index}`);
    } catch (error) {
      console.error("Failed to save channel", error);
      toast.error(`Failed to save CH ${channelIndex}`);
    }
  }, [api, channels, setChannels, setMemoryDraft]);

  const handleExportCSV = async () => {
    try {
      const response = await fetch('/api/v1/memory/export/csv');
      if (!response.ok) {
        throw new Error('Failed to export CSV');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'channels.csv';
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Channels exported successfully');
    } catch (error) {
      console.error('Failed to export CSV', error);
      toast.error('Failed to export channels');
    }
  };

  const handleImportCSV = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch('/api/v1/memory/import/csv', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          throw new Error('Failed to import CSV');
        }

        const result = await response.json();
        const { imported, errors } = result;

        if (errors.length > 0) {
          toast.error(`Imported ${imported} channels with ${errors.length} errors`, {
            description: `Failed: ${errors.slice(0, 3).map(e => (e.row as any).Index || 'unknown').join(', ')}${errors.length > 3 ? '...' : ''}`,
          });
        } else {
          toast.success(`Imported ${imported} channels successfully`);
        }

        const updatedChannels = await api.getChannels();
        setChannels(updatedChannels);
      } catch (error) {
        console.error('Failed to import CSV', error);
        toast.error('Failed to import channels');
      }
    };
    input.click();
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex h-full gap-6"
    >
      {/* Side Nav: Banks */}
      <div className="w-[160px] flex flex-col gap-1 bg-black/20 rounded-lg p-2 border border-white/5 h-full overflow-y-auto shrink-0">
        <h3 className="px-3 py-2 text-xs font-bold text-white/40 uppercase tracking-wider sticky top-0 bg-[#1c1f26]/90 backdrop-blur-sm z-10">
          Bank Select
        </h3>
        {bankTabs.map((bank) => (
          <button
            key={bank}
            onClick={() => setActiveBank(bank)}
            className={cn(
              "flex items-center justify-between px-3 py-2 text-xs font-medium rounded transition-all",
              activeBank === bank
                ? "bg-brand-primary/20 text-brand-primary shadow-brand-inset"
                : "text-white/60 hover:bg-white/5 hover:text-white",
            )}
          >
            <span>Bank {bank}</span>
            {activeBank === bank && (
              <div className="w-1.5 h-1.5 rounded-full bg-brand-primary shadow-glow" />
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
                className="w-full bg-black/40 border border-white/5 focus:border-brand-primary/50 rounded text-xs pl-8 pr-4 py-1.5 text-white placeholder:text-white/20 outline-none transition-colors"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-2 shrink-0">
            <button
              onClick={handleImportCSV}
              className="px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded text-xs font-medium uppercase tracking-wider border border-white/5 transition-colors text-white/70 hover:text-white"
            >
              Import CSV
            </button>
            <button
              onClick={handleExportCSV}
              className="px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded text-xs font-medium uppercase tracking-wider border border-white/5 transition-colors text-white/70 hover:text-white"
            >
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
                className="text-xs font-bold text-white/30 uppercase tracking-wider select-none text-center first:text-left"
              >
                {h}
              </div>
            ))}
          </div>

          {/* Rows */}
          <div className={cn(
            "overflow-y-auto flex-1 p-0",
            editingChannelIndex !== null && "opacity-50 pointer-events-none"
          )}>
            {filteredChannels.length === 0 ? (
              <div className="flex h-[240px] items-center justify-center text-xs text-white/50">
                No channels match your filters
              </div>
            ) : (
              filteredChannels.map((channel) => {
                const isEditing = editingChannelIndex === channel.index;
                const draft = memoryDrafts[channel.index];

                return (
                  <div
                    key={channel.index}
                    onClick={() => handleOpenEditSheet(channel.index)}
                    className={cn(
                      "grid grid-cols-[50px_90px_1fr_60px_60px_50px_50px_50px] gap-2 px-4 py-1.5 text-xs border-b border-white/5 items-center group transition-colors cursor-pointer min-h-[36px]",
                      isEditing ? "bg-brand-primary/20 border-brand-primary/30" : "hover:bg-white/5",
                      channel.lockout && "opacity-50 grayscale",
                    )}
                  >
                    <div className="font-mono text-white/30 text-xs pl-1">
                      {channel.index}
                    </div>

                    <div className="font-mono font-bold text-brand-primary group-hover:text-brand-light tracking-wide text-center">
                      {channel.frequency.toFixed(4)}
                    </div>
                    <div className="font-medium text-white/80 truncate pl-1">
                      {channel.alpha_tag || "—"}
                    </div>
                    <div className="flex justify-center">
                      <span className="text-white/40 text-xs font-medium bg-white/5 rounded px-1.5 py-0.5 w-fit uppercase border border-white/5">
                        {channel.modulation || "AUTO"}
                      </span>
                    </div>
                    <div className="text-white/30 text-xs text-center">
                      {channel.tone_squelch ?? "—"}
                    </div>
                    <div className="text-white/30 text-xs text-center">
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
                        <div className="w-1.5 h-1.5 bg-orange-500 rounded-full shadow-glow" />
                      ) : (
                        <div className="w-1 h-1 rounded-full bg-white/5" />
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {editingChannel && editingChannelIndex !== null && (
          <ChannelEditSheet
            channel={editingChannel}
            draft={editingDraft ?? buildDraft(editingChannel)}
            isOpen={editingChannelIndex !== null}
            onClose={handleCloseEditSheet}
            onSave={(draft) => handleSaveChannel(editingChannelIndex, draft)}
            onFieldChange={(field, value) => updateDraftField(editingChannelIndex, field, value)}
          />
        )}
      </div>
    </motion.div>
  );
}
