import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { motion } from 'motion/react';
import { Search, Lock, Edit3, GripVertical, ChevronDown } from 'lucide-react';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
// TouchBackend, not HTML5Backend: the app ships in Tauri's WKWebView, where
// react-dnd's HTML5 backend never fires dragover/drop — rows show the (+)
// cursor but won't reorder (#195). TouchBackend drives DnD from pointer
// events; enableMouseEvents makes it respond to a desktop mouse, and
// delayMouseStart lets a plain click still open the edit sheet.
import { TouchBackend } from 'react-dnd-touch-backend';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { cn } from '../../../lib/utils';
import { getAPI, API_BASE } from '../../../api/useApi';
import { useStore } from '../../../store/useStore';
import { confirmDialog, saveExport, pickAndReadFile } from '../../../tauri-shell';
import type { ChannelData, ChannelDraft } from '../../../types';
import { ChannelEditSheet } from './ChannelEditSheet';

const bankTabs = Array.from({ length: 10 }, (_, index) => index + 1);

const DND_ITEM_TYPE = 'channel-row';

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
        'group grid min-h-[var(--size-panel-stat-min-height)] cursor-pointer grid-cols-[36px_28px_44px_84px_1fr_60px_60px_50px_50px_50px] items-center gap-2 border-b border-white/5 px-4 py-1.5 text-xs transition-colors',
        isEditing ? 'bg-brand-primary/20 border-brand-primary/30' : 'hover:bg-white/5',
        isPending && 'bg-brand-primary/10 border-l-2 border-brand-primary/60',
        isDragging && 'opacity-60',
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
        <GripVertical size={12} className={cn(disableDrag && 'opacity-30')} />
      </div>
      <div className="font-mono text-white/30 text-xs pl-1">{displayIndex}</div>

      <div className="font-mono font-bold text-brand-primary group-hover:text-brand-light tracking-wide text-center">
        {displayFrequency}
      </div>
      <div className="font-medium text-white/80 truncate pl-1">{displayAlpha}</div>
      <div className="flex justify-center">
        <span className="text-white/40 text-xs font-medium bg-white/5 rounded px-1.5 py-0.5 w-fit uppercase border border-white/5">
          {displayModulation}
        </span>
      </div>
      <div className="text-white/30 text-xs text-center">{displayTone}</div>
      <div className="text-white/30 text-xs text-center">{displayDelay}s</div>
      <div className="flex justify-center">
        {displayLockout ? (
          <Lock size={10} className="text-red-400" />
        ) : (
          <div className="w-1 h-1 rounded-full bg-white/5" />
        )}
      </div>
      <div className="flex justify-center">
        {displayPriority ? (
          <div className="h-1.5 w-1.5 rounded-full bg-orange-500 bg-brand-primary shadow-glow" />
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
    alpha_tag: channel.alpha_tag?.trim() || '',
    modulation: channel.modulation || 'AUTO',
    tone_squelch: channel.tone_squelch?.toString() ?? '',
    delay: channel.delay.toString(),
    lockout: channel.lockout,
    priority: channel.priority,
    comments: '',
  };
}

function buildEmptyDraft(): ChannelDraft {
  return {
    frequency: '0',
    alpha_tag: '',
    modulation: 'AUTO',
    tone_squelch: '',
    delay: '0',
    lockout: false,
    priority: false,
    comments: '',
  };
}

export function ChannelsTab() {
  const api = getAPI();
  const channels = useStore((state) => state.channels) ?? [];
  const memoryDrafts = useStore((state) => state.memoryDrafts);
  const setMemoryDraft = useStore((state) => state.setMemoryDraft);
  const clearMemoryDrafts = useStore((state) => state.clearMemoryDrafts);
  const setChannels = useStore((state) => state.setChannels);
  const setImportProgress = useStore((state) => state.setImportProgress);

  const [activeBank, setActiveBank] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingChannelIndex, setEditingChannelIndex] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isExportingSs, setIsExportingSs] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
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
        ? ''
        : (draft?.alpha_tag ?? channel.alpha_tag ?? '').trim().toLowerCase();
      const displayFrequency = Number.isFinite(draftFrequency) ? draftFrequency : channel.frequency;
      const matchesSearch =
        query === '' || displayTag.includes(query) || displayFrequency.toString().includes(query);
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
    // Reconcile the cached order with reality instead of freezing at first
    // sight (#146). The old `prev[activeBank] ?? bankChannels` seeding meant:
    // mount this tab before channels load (deep link during the initial
    // 30-45s sync) and the bank order froze at [] — "No channels match your
    // filters" forever; channels added later (CSV import) were silently
    // dropped. Keep the user's drag order for surviving indexes, drop stale
    // ones, append newcomers in index order.
    setBankOrders((prev) => {
      const existing = prev[activeBank];
      if (!existing) {
        return { ...prev, [activeBank]: bankChannels };
      }
      const current = new Set(bankChannels);
      const kept = existing.filter((idx) => current.has(idx));
      const keptSet = new Set(kept);
      const added = bankChannels.filter((idx) => !keptSet.has(idx));
      const next = [...kept, ...added];
      const unchanged = next.length === existing.length && next.every((v, i) => v === existing[i]);
      return unchanged ? prev : { ...prev, [activeBank]: next };
    });
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
    return currentBankOrder.reduce(
      (acc, channelIndex, position) => {
        acc[channelIndex] = bankBase + position + 1;
        return acc;
      },
      {} as Record<number, number>,
    );
  }, [bankBase, currentBankOrder]);

  const moveRow = useCallback(
    (fromIndex: number, toIndex: number) => {
      setBankOrders((prev) => {
        const order = [...(prev[activeBank] ?? bankChannels)];
        const [moved] = order.splice(fromIndex, 1);
        order.splice(toIndex, 0, moved);
        return { ...prev, [activeBank]: order };
      });
    },
    [activeBank, bankChannels],
  );

  const editingChannel =
    editingChannelIndex !== null ? channels.find((ch) => ch.index === editingChannelIndex) : null;
  const editingDraft = editingChannelIndex !== null ? memoryDrafts[editingChannelIndex] : undefined;

  const draftChanges = useMemo(() => {
    return channels.reduce(
      (acc, channel) => {
        const channelIndex = channel.index;
        const draft = memoryDrafts[channelIndex];

        const parsedFrequency = Number.parseFloat(draft?.frequency ?? channel.frequency.toString());
        const parsedDelay = Number.parseInt(draft?.delay ?? channel.delay.toString(), 10);
        const parsedTone =
          (draft?.tone_squelch ?? '').trim() === ''
            ? null
            : Number.parseFloat(draft?.tone_squelch ?? '');

        const toneHz = Number.isFinite(parsedTone ?? NaN) ? parsedTone : null;
        // Tone discriminator (#132): the edit sheet's tone field is
        // CTCSS-only. A typed value means CTCSS; an empty field means "keep
        // the channel's DCS/Search squelch" (the sheet never displayed a
        // value for those kinds, so empty is not a clear) but means "cleared"
        // when the original kind was CTCSS. Omitting the kind entirely would
        // deserialize as 'none' on the backend and erase DCS on every edit.
        const originalKind = channel.tone_squelch_kind ?? (channel.tone_squelch ? 'ctcss' : 'none');
        const toneKind =
          toneHz !== null
            ? ('ctcss' as const)
            : originalKind === 'dcs' || originalKind === 'search'
              ? originalKind
              : ('none' as const);

        const normalized = {
          frequency: Number.isFinite(parsedFrequency) ? parsedFrequency : channel.frequency,
          alpha_tag: draft?.alpha_tag ?? channel.alpha_tag ?? '',
          modulation: draft?.modulation ?? channel.modulation ?? 'AUTO',
          delay: Number.isFinite(parsedDelay) ? parsedDelay : channel.delay,
          tone_squelch: toneHz,
          tone_squelch_kind: toneKind,
          tone_dcs_code: toneKind === 'dcs' ? (channel.tone_dcs_code ?? null) : null,
          lockout: draft?.lockout ?? channel.lockout,
          priority: draft?.priority ?? channel.priority,
        };

        const lockoutChanged = normalized.lockout !== channel.lockout;
        const priorityChanged = normalized.priority !== channel.priority;
        const targetIndex = reorderTargets[channelIndex] ?? channelIndex;
        const hasChanges =
          normalized.frequency !== channel.frequency ||
          normalized.alpha_tag !== (channel.alpha_tag ?? '') ||
          normalized.modulation !== (channel.modulation ?? 'AUTO') ||
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
      },
      [] as Array<{
        channelIndex: number;
        channel: ChannelData;
        draft: ChannelDraft | undefined;
        payload: Omit<ChannelData, 'index'>;
        lockoutChanged: boolean;
        priorityChanged: boolean;
        targetIndex: number;
      }>,
    );
  }, [channels, memoryDrafts, reorderTargets]);

  const handleOpenEditSheet = useCallback(
    (channelIndex: number) => {
      const channel = channels.find((ch) => ch.index === channelIndex);
      if (!channel) return;

      setEditingChannelIndex(channelIndex);
      if (!memoryDrafts[channelIndex]) {
        setMemoryDraft(channelIndex, buildDraft(channel));
      }
    },
    [channels, memoryDrafts, setMemoryDraft],
  );

  const handleCloseEditSheet = useCallback(() => {
    setEditingChannelIndex(null);
  }, []);

  // The edit sheet keeps its own local working copy (#146) — the store draft
  // is only written here, on an explicit Save. Cancel discards by simply
  // never calling this.
  const handleSaveDraft = useCallback(
    async (channelIndex: number, draft: ChannelDraft) => {
      setMemoryDraft(channelIndex, draft);
      toast.success(`Draft saved for CH ${channelIndex}`);
    },
    [setMemoryDraft],
  );

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

  const handleClearSelected = useCallback(async () => {
    if (selectedChannelIds.length === 0) return;
    const confirmed = await confirmDialog(
      `Clear ${selectedChannelIds.length} selected channels?`,
      'Clear channels',
    );
    if (!confirmed) return;
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
              console.warn('Failed to refresh channel before upload', refreshError);
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
          console.error('Channel upload failed', {
            channelIndex: change.channelIndex,
            detail,
            error: apiError,
          });
          if (detail === 'channel_write_mismatch') {
            try {
              const refreshed = await api.getChannel(change.channelIndex);
              const matchesPrimaryFields =
                refreshed.frequency === change.payload.frequency &&
                refreshed.alpha_tag === change.payload.alpha_tag &&
                refreshed.modulation === change.payload.modulation &&
                refreshed.delay === change.payload.delay &&
                (refreshed.tone_squelch ?? null) === (change.payload.tone_squelch ?? null);
              console.error('Channel write mismatch details', {
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
                    detail: 'Lockout/Priority did not apply',
                  });
                }
                continue;
              }
            } catch (refreshError) {
              console.error('Failed to refresh channel after mismatch', refreshError);
            }
          }

          failed.push({ index: change.channelIndex, detail });
        }
      }
    } catch (error) {
      console.error('Failed to upload channel edits', error);
      toast.error('Failed to upload channel edits');
    } finally {
      try {
        await api.endProgramMode();
      } catch (error) {
        console.warn('Failed to exit program mode', error);
      }
      setIsUploading(false);
    }

    try {
      const refreshedChannels = await api.getChannels();
      setChannels(refreshedChannels);
      // Reset reorder state from the refetch (#146). Keeping old->new
      // mappings after an upload left moved channels permanently "pending",
      // and a second Upload Changes re-wrote each channel's CURRENT content
      // to its already-shifted slot — scrambling channel memory. Rebuild the
      // drafts of every index that participated so they compare clean
      // against the refetched truth; untouched pending drafts survive.
      const byIndex = new Map(refreshedChannels.map((c) => [c.index, c]));
      const participating = new Set<number>();
      for (const change of draftChanges) {
        participating.add(change.channelIndex);
        participating.add(change.targetIndex ?? change.channelIndex);
      }
      for (const idx of participating) {
        const refreshed = byIndex.get(idx);
        if (refreshed) {
          setMemoryDraft(idx, buildDraft(refreshed));
        }
      }
      setBankOrders({});
    } catch (error) {
      console.warn('Failed to refresh channels after upload', error);
    }

    if (failed.length === 0 && warnings.length === 0) {
      toast.success(`Uploaded ${draftChanges.length} channel edits`);
    } else if (failed.length === 0 && warnings.length > 0) {
      toast.error(`Uploaded with ${warnings.length} warnings (lockout/priority not applied)`);
    } else if (failed.length > 0) {
      const firstFailure = failed[0];
      const detailText = firstFailure.detail ? ` (${firstFailure.detail})` : '';
      console.error('Upload failed', { failed });
      toast.error(
        `Failed to upload ${failed.length} channel edits. First failure: CH ${firstFailure.index}${detailText}`,
      );
    }
  }, [api, draftChanges, isUploading, setChannels, setMemoryDraft]);

  const handleDiscardDrafts = useCallback(async () => {
    if (draftChanges.length === 0 || isUploading) return;
    const confirmed = await confirmDialog('Discard all pending channel edits?', 'Discard drafts');
    if (!confirmed) return;

    // Pending state has two independent surfaces: field edits in memoryDrafts
    // and drag-reorder in bankOrders. isPending fires on Boolean(draft) OR a
    // shifted position, so discard must wipe BOTH. Rebuilding drafts from the
    // channel (the old approach) left a non-null draft in place — Boolean(draft)
    // stayed true and rows stayed lit (#195). Remove the drafts outright.
    clearMemoryDrafts();
    setBankOrders({});
    toast.success('Drafts discarded');
  }, [draftChanges, isUploading, clearMemoryDrafts, setBankOrders]);

  const handleExportCSV = async () => {
    try {
      const response = await fetch(`${API_BASE}/memory/export/csv`);
      if (!response.ok) {
        throw new Error('Failed to export CSV');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const where = await saveExport('channels.csv', bytes);
      if (where === 'cancelled') return;
      toast.success(where === 'saved' ? 'Channels saved' : 'Channels exported successfully');
    } catch (error) {
      console.error('Failed to export CSV', error);
      toast.error('Failed to export channels');
    }
  };

  const handleExportBc125atSs = async () => {
    if (isExportingSs) return;
    // The .ss export reads live scanner settings (~5s), so show a loading
    // toast that resolves in place — otherwise the UI looks idle until the
    // success toast lands.
    setIsExportingSs(true);
    const toastId = toast.loading('Exporting BC125AT format…');
    try {
      const response = await fetch(`${API_BASE}/memory/export/bc125at_ss`);
      if (!response.ok) {
        throw new Error('Failed to export BC125AT format');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const where = await saveExport('scanner.bc125at_ss', bytes);
      if (where === 'cancelled') {
        toast.dismiss(toastId);
        return;
      }
      toast.success(
        where === 'saved' ? 'BC125AT format saved' : 'BC125AT format exported successfully',
        { id: toastId },
      );
    } catch (error) {
      console.error('Failed to export BC125AT format', error);
      toast.error('Failed to export BC125AT format', { id: toastId });
    } finally {
      setIsExportingSs(false);
    }
  };

  const handleImport = async () => {
    if (isImporting) return;
    // Accept both formats. In Tauri a synthetic <input type=file> opens the
    // picker but its change event never fires, so pickAndReadFile uses the
    // native dialog + fs there, and the input element in a browser.
    const picked = await pickAndReadFile(['csv', 'bc125at_ss']);
    if (!picked) return;

    // A .ss file restores the WHOLE config (channels + all settings), so it's
    // more destructive than a CSV channel import — confirm first.
    const isSs = picked.name.toLowerCase().endsWith('.bc125at_ss');
    if (isSs) {
      const ok = await confirmDialog(
        'Restore full config from this file? This overwrites all channels and settings.',
        'Restore config',
      );
      if (!ok) return;
    }

    setIsImporting(true);
    // A full import is ~80s of wire writes. Show the blocking progress overlay
    // (driven live by the backend's import-* WS messages) rather than a static
    // toast. The overlay's `active` flag is owned here; percent/message come
    // over the WS. Cleared in `finally`.
    setImportProgress({
      active: true,
      percent: 0,
      message: isSs ? 'Restoring config…' : 'Importing channels…',
    });
    try {
      const endpoint = isSs
        ? `${API_BASE}/memory/import/bc125at_ss`
        : `${API_BASE}/memory/import/csv`;
      const formData = new FormData();
      formData.append('file', new File([picked.bytes as BlobPart], picked.name));

      const response = await fetch(endpoint, { method: 'POST', body: formData });
      if (!response.ok) {
        throw new Error('Failed to import');
      }

      const result = await response.json();
      const { imported, errors } = result;

      if (errors && errors.length > 0) {
        toast.error(`Imported ${imported} — ${errors.length} item(s) failed`);
      } else if (isSs) {
        toast.success(`Config restored (${imported} channels)`);
      } else {
        toast.success(`Imported ${imported} channels successfully`);
      }

      const updatedChannels = await api.getChannels();
      setChannels(updatedChannels);
    } catch (error) {
      console.error('Failed to import', error);
      toast.error('Failed to import');
    } finally {
      setIsImporting(false);
      setImportProgress({ active: false, percent: 0, message: '' });
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex h-full gap-6">
      {/* Side Nav: Banks */}
      <div className="scanner-surface h-full w-[var(--layout-sidebar-channels-width)] shrink-0 overflow-y-auto p-2">
        <h3 className="sticky top-0 z-10 bg-scanner-bg-dark/90 px-3 py-2 text-xs font-bold uppercase tracking-wider text-white/40 backdrop-blur-sm">
          Bank Select
        </h3>
        {bankTabs.map((bank) => (
          <button
            key={bank}
            onClick={() => setActiveBank(bank)}
            className={cn(
              'flex items-center justify-between px-3 py-2 text-xs font-medium rounded transition-all',
              activeBank === bank
                ? 'bg-brand-primary/20 text-brand-primary shadow-brand-inset'
                : 'text-white/60 hover:bg-white/5 hover:text-white',
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
            <div className="relative max-w-[var(--layout-search-max-width)] flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30 w-3.5 h-3.5" />
              <input
                type="text"
                placeholder="Search frequency or tag..."
                className="scanner-input w-full border-white/5 py-1.5 pl-8 pr-4 text-xs placeholder:text-white/20 focus:border-brand-primary/50"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-2 shrink-0">
            <button
              onClick={handleClearSelected}
              disabled={selectedChannelIds.length === 0}
              className="scanner-button-muted px-3 py-1.5 text-xs font-medium uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear Selected
            </button>
            <button
              onClick={handleImport}
              disabled={isImporting}
              className="scanner-button-muted px-3 py-1.5 text-xs font-medium uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isImporting ? 'Importing…' : 'Import'}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={isExportingSs}
                className="scanner-button-primary flex items-center gap-1.5 px-3 py-1.5 text-xs uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isExportingSs ? 'Exporting…' : 'Export'}
                <ChevronDown className="size-3.5" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={handleExportCSV}>CSV</DropdownMenuItem>
                <DropdownMenuItem onSelect={handleExportBc125atSs}>BC125AT</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex items-center justify-between bg-black/10 p-3 rounded-lg border border-white/5 shrink-0">
          <div className="text-xs text-white/60">
            {draftChanges.length > 0
              ? `Edits are saved as drafts. ${draftChanges.length} pending.`
              : 'Edits are saved as drafts. No pending changes.'}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleDiscardDrafts}
              disabled={draftChanges.length === 0 || isUploading}
              className="scanner-button-muted px-3 py-1.5 text-xs font-medium uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-40"
            >
              Discard Changes
            </button>
            <button
              onClick={handleUploadDrafts}
              disabled={draftChanges.length === 0 || isUploading}
              className="scanner-button-primary px-3 py-1.5 text-xs uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isUploading ? 'Uploading...' : 'Upload Changes'}
            </button>
          </div>
        </div>

        {/* Table */}
        <DndProvider
          backend={TouchBackend}
          options={{ enableMouseEvents: true, delayMouseStart: 100 }}
        >
          <div
            className="flex-1 bg-black/20 rounded-lg border border-white/5 overflow-hidden flex flex-col shadow-inner min-h-0"
            ref={containerRef}
          >
            {/* Header */}
            <div className="grid grid-cols-[36px_28px_44px_84px_1fr_60px_60px_50px_50px_50px] gap-2 px-4 py-2 bg-white/5 border-b border-white/5 shrink-0">
              <div className="flex items-center justify-center">
                <input
                  type="checkbox"
                  checked={
                    orderedFilteredChannels.length > 0 &&
                    orderedFilteredChannels.every((channel) =>
                      selectedChannelIds.includes(channel.index),
                    )
                  }
                  onChange={handleToggleSelectAll}
                  className="form-checkbox h-3.5 w-3.5 text-brand-primary bg-black/40 border-white/20 rounded"
                />
              </div>
              <div />
              {['CH', 'FREQ', 'TAG', 'MODE', 'TONE', 'DLY', 'L/O', 'PRIO'].map((h) => (
                <div
                  key={h}
                  className="text-xs font-bold text-white/30 uppercase tracking-wider select-none text-center first:text-left"
                >
                  {h}
                </div>
              ))}
            </div>

            {/* Rows */}
            <div
              className={cn(
                'overflow-y-auto flex-1 p-0',
                editingChannelIndex !== null && 'opacity-50 pointer-events-none',
              )}
            >
              {orderedFilteredChannels.length === 0 ? (
                <div className="flex h-[var(--layout-empty-state-height)] items-center justify-center text-xs text-white/50">
                  No channels match your filters
                </div>
              ) : (
                orderedFilteredChannels.map((channel, rowIndex) => {
                  const isEditing = editingChannelIndex === channel.index;
                  const draft = memoryDrafts[channel.index];
                  const displayIndex = reorderTargets[channel.index] ?? channel.index;
                  const draftFrequency = draft
                    ? Number.parseFloat(draft.frequency)
                    : channel.frequency;
                  const isCleared = Number.isFinite(draftFrequency) && draftFrequency === 0;
                  const displayAlpha = isCleared
                    ? '—'
                    : (draft?.alpha_tag ?? channel.alpha_tag ?? '—').trim() || '—';
                  const displayFrequency = isCleared
                    ? '–'
                    : Number.isFinite(draftFrequency)
                      ? draftFrequency.toFixed(4)
                      : channel.frequency.toFixed(4);
                  const displayModulation = isCleared
                    ? 'AUTO'
                    : (draft?.modulation ?? channel.modulation ?? 'AUTO');
                  const displayTone = isCleared
                    ? '—'
                    : draft?.tone_squelch || (channel.tone_squelch ?? '—');
                  const displayDelay = isCleared
                    ? 0
                    : Number.parseInt(draft?.delay ?? channel.delay.toString(), 10);
                  const displayLockout = isCleared ? false : (draft?.lockout ?? channel.lockout);
                  const displayPriority = isCleared ? false : (draft?.priority ?? channel.priority);
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
          />
        )}
      </div>
    </motion.div>
  );
}
