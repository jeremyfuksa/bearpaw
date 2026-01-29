import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { motion } from "motion/react";
import { Search, Lock, Edit3, GripVertical } from "lucide-react";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";

import { cn } from "../../../lib/utils";
import { useAPI } from "../../../api/useApi";
import { useStore } from "../../../store/useStore";
import type { ChannelData, ChannelDraft } from "../../../types";
import { ChannelEditSheet } from "./ChannelEditSheet";

const bankTabs = Array.from({ length: 10 }, (_, index) => index + 1);

const DND_ITEM_TYPE = "channel-row";

interface ChannelRowProps {
  channelIndex: number;
  displayIndex: number;
  rowIndex: number;
  isEditing: boolean;
  isPending: boolean;
  isSelected: boolean;
  disableDrag: boolean;
  displayFrequency: string;
  displayAlpha: string;
  displayModulation: string;
  displayTone: string | number;
  displayDelay: number;
  displayLockout: boolean;
  displayPriority: boolean;
  onSelect: () => void;
  onClick: () => void;
  onMove: (fromIndex: number, toIndex: number) => void;
}

function ChannelRow({
  channelIndex,
  displayIndex,
  rowIndex,
  isEditing,
  isPending,
  isSelected,
  disableDrag,
  displayFrequency,
  displayAlpha,
  displayModulation,
  displayTone,
  displayDelay,
  displayLockout,
  displayPriority,
  onSelect,
  onClick,
  onMove,
}: ChannelRowProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  const [{ isDragging }, drag] = useDrag({
    type: DND_ITEM_TYPE,
    item: { rowIndex },
    canDrag: !disableDrag,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  const [, drop] = useDrop({
    accept: DND_ITEM_TYPE,
    hover: (item: { rowIndex: number }) => {
      if (!ref.current) return;
      if (item.rowIndex === rowIndex) return;
      onMove(item.rowIndex, rowIndex);
      item.rowIndex = rowIndex;
    },
  });

  drag(drop(ref));

  return (
    <div
      ref={ref}
      onClick={onClick}
      className={cn(
        "grid grid-cols-[36px_50px_90px_1fr_60px_60px_50px_50px_50px_50px] gap-2 px-4 py-1.5 text-xs border-b border-white/5 items-center group transition-colors cursor-pointer min-h-[36px]",
        isEditing ? "bg-brand-primary/20 border-brand-primary/30" : "hover:bg-white/5",
        isPending && "bg-brand-primary/10 border-l-2 border-brand-primary/60",
        isDragging && "opacity-60",
      )}
    >
      <div className="flex items-center justify-center">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          onClick={(event) => event.stopPropagation()}
          className="form-checkbox h-3.5 w-3.5 text-brand-primary bg-black/40 border-white/20 rounded"
        />
      </div>
      <div className="flex items-center justify-center text-white/40">
        <GripVertical size={12} className={cn(disableDrag && "opacity-30")} />
      </div>
      <div className="font-mono text-white/30 text-xs pl-1">
        {displayIndex}
      </div>

      <div className="font-mono font-bold text-brand-primary group-hover:text-brand-light tracking-wide text-center">
        {displayFrequency}
      </div>
      <div className="font-medium text-white/80 truncate pl-1">
        {displayAlpha}
      </div>
      <div className="flex justify-center">
        <span className="text-white/40 text-xs font-medium bg-white/5 rounded px-1.5 py-0.5 w-fit uppercase border border-white/5">
          {displayModulation}
        </span>
      </div>
      <div className="text-white/30 text-xs text-center">
        {displayTone}
      </div>
      <div className="text-white/30 text-xs text-center">
        {displayDelay}s
      </div>
      <div className="flex justify-center">
        {displayLockout ? (
          <Lock size={10} className="text-red-400" />
        ) : (
          <div className="w-1 h-1 rounded-full bg-white/5" />
        )}
      </div>
      <div className="flex justify-center">
        {displayPriority ? (
          <div className="w-1.5 h-1.5 bg-orange-500 rounded-full shadow-glow" />
        ) : (
          <div className="w-1 h-1 rounded-full bg-white/5" />
        )}
      </div>
    </div>
  );
}

function deriveBankFromIndex(index: number) {
  const normalized = Math.max(1, index);
  return Math.min(10, Math.ceil(normalized / 50));
}

function buildDraft(channel: ChannelData): ChannelDraft {
  if (channel.frequency === 0) {
    return buildEmptyDraft();
  }
  return {
    frequency: channel.frequency.toFixed(4),
    alpha_tag: channel.alpha_tag?.trim() || "",
    modulation: channel.modulation || "AUTO",
    tone_squelch: channel.tone_squelch?.toString() ?? "",
    delay: channel.delay.toString(),
    lockout: channel.lockout,
    priority: channel.priority,
    comments: "",
  };
}

function buildEmptyDraft(): ChannelDraft {
  return {
    frequency: "0",
    alpha_tag: "",
    modulation: "AUTO",
    tone_squelch: "",
    delay: "0",
    lockout: false,
    priority: false,
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
  const [isUploading, setIsUploading] = useState(false);
  const [selectedChannelIds, setSelectedChannelIds] = useState<number[]>([]);
  const [bankOrders, setBankOrders] = useState<Record<number, number[]>>({});

  const containerRef = useRef<HTMLDivElement | null>(null);

  const filteredChannels = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return channels.filter((channel) => {
      const matchesBank = deriveBankFromIndex(channel.index) === activeBank;
      const draft = memoryDrafts[channel.index];
      const draftFrequency = draft ? Number.parseFloat(draft.frequency) : channel.frequency;
      const isCleared = Number.isFinite(draftFrequency) && draftFrequency === 0;
      const displayTag = isCleared
        ? ""
        : (draft?.alpha_tag ?? channel.alpha_tag ?? "").trim().toLowerCase();
      const displayFrequency = Number.isFinite(draftFrequency) ? draftFrequency : channel.frequency;
      const matchesSearch =
        query === "" ||
        displayTag.includes(query) ||
        displayFrequency.toString().includes(query);
      return matchesBank && matchesSearch;
    });
  }, [activeBank, channels, memoryDrafts, searchTerm]);

  const bankChannels = useMemo(() => {
    return channels
      .filter((channel) => deriveBankFromIndex(channel.index) === activeBank)
      .map((channel) => channel.index)
      .sort((a, b) => a - b);
  }, [activeBank, channels]);

  useEffect(() => {
    setBankOrders((prev) => ({
      ...prev,
      [activeBank]: prev[activeBank] ?? bankChannels,
    }));
  }, [activeBank, bankChannels]);

  const currentBankOrder = bankOrders[activeBank] ?? bankChannels;
  const bankBase = (activeBank - 1) * 50;

  const orderedFilteredChannels = useMemo(() => {
    if (filteredChannels.length === 0) return [];
    const channelMap = new Map(filteredChannels.map((channel) => [channel.index, channel]));
    return currentBankOrder
      .map((channelIndex) => channelMap.get(channelIndex))
      .filter((channel): channel is ChannelData => Boolean(channel));
  }, [currentBankOrder, filteredChannels]);

  const reorderTargets = useMemo(() => {
    return currentBankOrder.reduce((acc, channelIndex, position) => {
      acc[channelIndex] = bankBase + position + 1;
      return acc;
    }, {} as Record<number, number>);
  }, [bankBase, currentBankOrder]);

  const moveRow = useCallback((fromIndex: number, toIndex: number) => {
    setBankOrders((prev) => {
      const order = [...(prev[activeBank] ?? bankChannels)];
      const [moved] = order.splice(fromIndex, 1);
      order.splice(toIndex, 0, moved);
      return { ...prev, [activeBank]: order };
    });
  }, [activeBank, bankChannels]);

  const editingChannel = editingChannelIndex !== null
    ? channels.find((ch) => ch.index === editingChannelIndex)
    : null;
  const editingDraft = editingChannelIndex !== null
    ? memoryDrafts[editingChannelIndex]
    : undefined;

  const draftChanges = useMemo(() => {
    return channels.reduce((acc, channel) => {
      const channelIndex = channel.index;
      const draft = memoryDrafts[channelIndex];

      const parsedFrequency = Number.parseFloat(draft?.frequency ?? channel.frequency.toString());
      const parsedDelay = Number.parseInt(draft?.delay ?? channel.delay.toString(), 10);
      const parsedTone =
        (draft?.tone_squelch ?? "").trim() === ""
          ? null
          : Number.parseFloat(draft?.tone_squelch ?? "");

      const normalized = {
        frequency: Number.isFinite(parsedFrequency) ? parsedFrequency : channel.frequency,
        alpha_tag: draft?.alpha_tag ?? channel.alpha_tag ?? "",
        modulation: draft?.modulation ?? channel.modulation ?? "AUTO",
        delay: Number.isFinite(parsedDelay) ? parsedDelay : channel.delay,
        tone_squelch: Number.isFinite(parsedTone ?? NaN) ? parsedTone : null,
        lockout: draft?.lockout ?? channel.lockout,
        priority: draft?.priority ?? channel.priority,
      };

      const lockoutChanged = normalized.lockout !== channel.lockout;
      const priorityChanged = normalized.priority !== channel.priority;
      const targetIndex = reorderTargets[channelIndex] ?? channelIndex;
      const hasChanges =
        normalized.frequency !== channel.frequency ||
        normalized.alpha_tag !== (channel.alpha_tag ?? "") ||
        normalized.modulation !== (channel.modulation ?? "AUTO") ||
        normalized.delay !== channel.delay ||
        normalized.tone_squelch !== (channel.tone_squelch ?? null) ||
        lockoutChanged ||
        priorityChanged ||
        targetIndex !== channelIndex;

      if (!hasChanges) return acc;

      const bankValue = channel.bank > 0 ? channel.bank : deriveBankFromIndex(channelIndex);

      acc.push({
        channelIndex,
        channel,
        draft,
        payload: {
          ...normalized,
          bank: bankValue,
        },
        lockoutChanged,
        priorityChanged,
        targetIndex,
      });

      return acc;
    }, [] as Array<{
      channelIndex: number;
      channel: ChannelData;
      draft: ChannelDraft | undefined;
      payload: Omit<ChannelData, "index">;
      lockoutChanged: boolean;
      priorityChanged: boolean;
      targetIndex: number;
    }>);
  }, [channels, memoryDrafts, reorderTargets]);

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

  const handleSaveDraft = useCallback(async (channelIndex: number, draft: ChannelDraft) => {
    setMemoryDraft(channelIndex, draft);
    toast.success(`Draft saved for CH ${channelIndex}`);
  }, [setMemoryDraft]);

  const handleClearDraft = useCallback((channelIndex: number) => {
    setMemoryDraft(channelIndex, buildEmptyDraft());
    toast.success(`Cleared CH ${channelIndex}`);
  }, [setMemoryDraft]);

  const handleToggleSelectAll = useCallback(() => {
    const visibleIds = orderedFilteredChannels.map((channel) => channel.index);
    const allSelected = visibleIds.every((id) => selectedChannelIds.includes(id));
    setSelectedChannelIds(allSelected ? [] : visibleIds);
  }, [orderedFilteredChannels, selectedChannelIds]);

  const handleToggleSelect = useCallback((channelIndex: number) => {
    setSelectedChannelIds((prev) =>
      prev.includes(channelIndex)
        ? prev.filter((id) => id !== channelIndex)
        : [...prev, channelIndex],
    );
  }, []);

  const handleClearSelected = useCallback(() => {
    if (selectedChannelIds.length === 0) return;
    if (!window.confirm(`Clear ${selectedChannelIds.length} selected channels?`)) return;
    for (const channelIndex of selectedChannelIds) {
      setMemoryDraft(channelIndex, buildEmptyDraft());
    }
    toast.success(`Cleared ${selectedChannelIds.length} channels`);
    setSelectedChannelIds([]);
  }, [selectedChannelIds, setMemoryDraft]);

  const handleUploadDrafts = useCallback(async () => {
    if (draftChanges.length === 0 || isUploading) return;
    setIsUploading(true);
    const failed: Array<{ index: number; detail?: string }> = [];
    const warnings: Array<{ index: number; detail: string }> = [];

    try {
      await api.startProgramMode();
      for (const change of draftChanges) {
        try {
          let payload = change.payload;
          const targetIndex = change.targetIndex ?? change.channelIndex;
          const targetBank = deriveBankFromIndex(targetIndex);
          payload = {
            ...payload,
            bank: targetBank,
          };
          if (!change.lockoutChanged && !change.priorityChanged) {
            try {
              const latest = await api.getChannel(change.channelIndex);
              payload = {
                ...payload,
                lockout: latest.lockout,
                priority: latest.priority,
                bank: latest.bank || payload.bank,
              };
            } catch (refreshError) {
              console.warn("Failed to refresh channel before upload", refreshError);
            }
          }

          if (payload.frequency === 0) {
            const preUpdatePayload = {
              ...payload,
              frequency: change.channel.frequency,
              alpha_tag: change.channel.alpha_tag,
            };
            await api.updateChannel(targetIndex, preUpdatePayload);
          }

          const updated = await api.updateChannel(targetIndex, payload);
          setChannels((prev) =>
            prev.map((entry) => (entry.index === updated.index ? updated : entry)),
          );
          setMemoryDraft(updated.index, buildDraft(updated));
        } catch (error) {
          const apiError = error as { message?: string; payload?: { detail?: string } };
          const detail = apiError?.payload?.detail ?? apiError?.message;
          console.error("Channel upload failed", {
            channelIndex: change.channelIndex,
            detail,
            error: apiError,
          });
          if (detail === "channel_write_mismatch") {
            try {
              const refreshed = await api.getChannel(change.channelIndex);
              const matchesPrimaryFields =
                refreshed.frequency === change.payload.frequency &&
                refreshed.alpha_tag === change.payload.alpha_tag &&
                refreshed.modulation === change.payload.modulation &&
                refreshed.delay === change.payload.delay &&
                (refreshed.tone_squelch ?? null) === (change.payload.tone_squelch ?? null);
              console.error("Channel write mismatch details", {
                channelIndex: change.channelIndex,
                payload: change.payload,
                refreshed,
                matchesPrimaryFields,
              });
              const lockoutApplied = refreshed.lockout === change.payload.lockout;
              const priorityApplied = refreshed.priority === change.payload.priority;
              setChannels((prev) =>
                prev.map((entry) => (entry.index === refreshed.index ? refreshed : entry)),
              );
              setMemoryDraft(refreshed.index, buildDraft(refreshed));
              if (matchesPrimaryFields) {
                if (
                  (change.lockoutChanged && !lockoutApplied) ||
                  (change.priorityChanged && !priorityApplied)
                ) {
                  warnings.push({
                    index: change.channelIndex,
                    detail: "Lockout/Priority did not apply",
                  });
                }
                continue;
              }
            } catch (refreshError) {
              console.error("Failed to refresh channel after mismatch", refreshError);
            }
          }

          failed.push({ index: change.channelIndex, detail });
        }
      }

    } catch (error) {
      console.error("Failed to upload channel edits", error);
      toast.error("Failed to upload channel edits");
    } finally {
      try {
        await api.endProgramMode();
      } catch (error) {
        console.warn("Failed to exit program mode", error);
      }
      setIsUploading(false);
    }

    try {
      const refreshedChannels = await api.getChannels();
      setChannels(refreshedChannels);
    } catch (error) {
      console.warn("Failed to refresh channels after upload", error);
    }

    if (failed.length === 0 && warnings.length === 0) {
      toast.success(`Uploaded ${draftChanges.length} channel edits`);
    } else if (failed.length === 0 && warnings.length > 0) {
      toast.error(`Uploaded with ${warnings.length} warnings (lockout/priority not applied)`);
    } else if (failed.length > 0) {
      const firstFailure = failed[0];
      const detailText = firstFailure.detail ? ` (${firstFailure.detail})` : "";
      console.error("Upload failed", { failed });
      toast.error(
        `Failed to upload ${failed.length} channel edits. First failure: CH ${firstFailure.index}${detailText}`,
      );
    }
  }, [api, draftChanges, isUploading, setChannels, setMemoryDraft]);

  const handleDiscardDrafts = useCallback(() => {
    if (draftChanges.length === 0 || isUploading) return;
    if (!window.confirm("Discard all pending channel edits?")) return;

    for (const change of draftChanges) {
      setMemoryDraft(change.channelIndex, buildDraft(change.channel));
    }
    toast.success("Drafts discarded");
  }, [draftChanges, isUploading, setMemoryDraft]);

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

  const handleExportBc125atSs = async () => {
    try {
      const response = await fetch('/api/v1/memory/export/bc125at_ss');
      if (!response.ok) {
        throw new Error('Failed to export BC125AT format');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'scanner.ss';
      a.click();
      URL.revokeObjectURL(url);
      toast.success('BC125AT format exported successfully');
    } catch (error) {
      console.error('Failed to export BC125AT format', error);
      toast.error('Failed to export BC125AT format');
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
              onClick={handleClearSelected}
              disabled={selectedChannelIds.length === 0}
              className="px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded text-xs font-medium uppercase tracking-wider border border-white/5 transition-colors text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Clear Selected
            </button>
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
            <button
              onClick={handleExportBc125atSs}
              className="px-3 py-1.5 rounded bg-brand-primary hover:bg-brand-hover text-black font-bold uppercase tracking-wider border border-brand-primary/40 transition-colors"
            >
              BC125AT (.ss)
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between bg-black/10 p-3 rounded-lg border border-white/5 shrink-0">
          <div className="text-xs text-white/60">
            {draftChanges.length > 0
              ? `Edits are saved as drafts. ${draftChanges.length} pending.`
              : "Edits are saved as drafts. No pending changes."}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleDiscardDrafts}
              disabled={draftChanges.length === 0 || isUploading}
              className="px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded text-xs font-medium uppercase tracking-wider border border-white/5 transition-colors text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Discard Changes
            </button>
            <button
              onClick={handleUploadDrafts}
              disabled={draftChanges.length === 0 || isUploading}
              className="px-3 py-1.5 bg-brand-primary hover:bg-brand-hover rounded text-xs font-bold uppercase tracking-wider border border-brand-primary/40 transition-colors text-black disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isUploading ? "Uploading..." : "Upload Changes"}
            </button>
          </div>
        </div>

        {/* Table */}
        <DndProvider backend={HTML5Backend}>
          <div
            className="flex-1 bg-black/20 rounded-lg border border-white/5 overflow-hidden flex flex-col shadow-inner min-h-0"
            ref={containerRef}
          >
            {/* Header */}
            <div className="grid grid-cols-[36px_50px_90px_1fr_60px_60px_50px_50px_50px_50px] gap-2 px-4 py-2 bg-white/5 border-b border-white/5 shrink-0">
              <div className="flex items-center justify-center">
                <input
                  type="checkbox"
                  checked={
                    orderedFilteredChannels.length > 0 &&
                    orderedFilteredChannels.every((channel) => selectedChannelIds.includes(channel.index))
                  }
                  onChange={handleToggleSelectAll}
                  className="form-checkbox h-3.5 w-3.5 text-brand-primary bg-black/40 border-white/20 rounded"
                />
              </div>
              <div />
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
              {orderedFilteredChannels.length === 0 ? (
                <div className="flex h-[240px] items-center justify-center text-xs text-white/50">
                  No channels match your filters
                </div>
              ) : (
                orderedFilteredChannels.map((channel, rowIndex) => {
                  const isEditing = editingChannelIndex === channel.index;
                  const draft = memoryDrafts[channel.index];
                  const displayIndex = reorderTargets[channel.index] ?? channel.index;
                  const draftFrequency = draft ? Number.parseFloat(draft.frequency) : channel.frequency;
                  const isCleared = Number.isFinite(draftFrequency) && draftFrequency === 0;
                  const displayAlpha = isCleared
                    ? "—"
                    : (draft?.alpha_tag ?? channel.alpha_tag ?? "—").trim() || "—";
                  const displayFrequency = isCleared
                    ? "–"
                    : Number.isFinite(draftFrequency)
                      ? draftFrequency.toFixed(4)
                      : channel.frequency.toFixed(4);
                const displayModulation = isCleared
                  ? "AUTO"
                  : draft?.modulation ?? channel.modulation ?? "AUTO";
                  const displayTone = isCleared
                    ? "—"
                    : draft?.tone_squelch || (channel.tone_squelch ?? "—");
                  const displayDelay = isCleared
                    ? 0
                    : Number.parseInt(draft?.delay ?? channel.delay.toString(), 10);
                  const displayLockout = isCleared
                    ? false
                    : draft?.lockout ?? channel.lockout;
                  const displayPriority = isCleared
                    ? false
                    : draft?.priority ?? channel.priority;
                  const isPending = Boolean(draft) || displayIndex !== channel.index;

                  return (
                    <ChannelRow
                      key={channel.index}
                      channelIndex={channel.index}
                      displayIndex={displayIndex}
                      isEditing={isEditing}
                      isPending={isPending}
                      isSelected={selectedChannelIds.includes(channel.index)}
                      onSelect={() => handleToggleSelect(channel.index)}
                      onClick={() => handleOpenEditSheet(channel.index)}
                      onMove={moveRow}
                      rowIndex={rowIndex}
                      disableDrag={searchTerm.trim().length > 0}
                      displayFrequency={displayFrequency}
                      displayAlpha={displayAlpha}
                      displayModulation={displayModulation}
                      displayTone={displayTone}
                      displayDelay={displayDelay}
                      displayLockout={displayLockout}
                      displayPriority={displayPriority}
                    />
                  );
                })
              )}
            </div>
          </div>
        </DndProvider>

        {editingChannel && editingChannelIndex !== null && (
          <ChannelEditSheet
            channel={editingChannel}
            draft={editingDraft ?? buildDraft(editingChannel)}
            isOpen={editingChannelIndex !== null}
            onClose={handleCloseEditSheet}
            onSave={(draft) => handleSaveDraft(editingChannelIndex, draft)}
            onFieldChange={(field, value) => updateDraftField(editingChannelIndex, field, value)}
            onClear={() => handleClearDraft(editingChannelIndex)}
          />
        )}
      </div>
    </motion.div>
  );
}
