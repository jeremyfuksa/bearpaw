import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { motion } from 'motion/react';
import { Search, Lock, GripVertical, ChevronDown, RefreshCw } from 'lucide-react';
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
import { useScannerCapabilities } from '../../../hooks/useScannerCapabilities';
import { confirmDialog, saveExport, pickAndReadFile } from '../../../tauri-shell';
import type { ChannelData, ChannelDraft } from '../../../types';
import { ChannelEditSheet } from './ChannelEditSheet';
import { formatSyncedAt } from '../ScannerUI';

const bankTabs = Array.from({ length: 10 }, (_, index) => index + 1);

const DND_ITEM_TYPE = 'channel-row';

interface ChannelRowProps {
  displayIndex: number;
  rowIndex: number;
  rowCount: number;
  isEditing: boolean;
  isPending: boolean;
  isClearPending: boolean;
  isSelected: boolean;
  isGrabbed: boolean;
  disableDrag: boolean;
  displayFrequency: string;
  columns: ChannelColumn[];
  validDelays: number[];
  displayAlpha: string;
  displayModulation: string;
  displayTone: string | number;
  displayDelay: number;
  displayLockout: boolean;
  displayPriority: boolean;
  onSelect: () => void;
  onClick: () => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onToggleGrab: () => void;
  onKeyboardMove: (direction: -1 | 1) => void;
  onReleaseGrab: () => void;
}

function ChannelRow({
  displayIndex,
  rowIndex,
  rowCount,
  isEditing,
  isPending,
  isClearPending,
  isSelected,
  isGrabbed,
  disableDrag,
  displayFrequency,
  columns,
  validDelays,
  displayAlpha,
  displayModulation,
  displayTone,
  displayDelay,
  displayLockout,
  displayPriority,
  onSelect,
  onClick,
  onMove,
  onToggleGrab,
  onKeyboardMove,
  onReleaseGrab,
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

  // react-dnd's connector API: `drag`/`drop` are connector functions that
  // attach the DND behavior to the row element, and composing them onto the
  // ref during render is how the library (v16) is meant to be wired.
  // react-hooks/refs is suppressed rather than worked around — the connectors
  // have no post-commit call site, and restructuring this into callback refs
  // would rewrite the drag path that the #236 keyboard-reorder guard below
  // depends on for no behavioral gain.
  // eslint-disable-next-line react-hooks/refs
  drag(drop(ref));

  const shows = (key: ChannelColumnKey) => columns.some((c) => c.key === key);

  // The BC75XLT's CIN delay field is a boolean (`0:OFF / 1:ON` per the vendor
  // spec), not the BC125AT family's signed seconds. Rendering "1s" there states
  // a unit the hardware does not have.
  const delayIsBoolean = validDelays.length === 2 && validDelays[0] === 0 && validDelays[1] === 1;

  // Without a tag to read, every row on a BC75XLT would announce identically
  // ("unnamed"), which is worse than useless in a 300-row list. Fall back to
  // the frequency, which is the only thing that distinguishes the rows.
  const rowLabel = shows('alpha')
    ? `Edit channel ${displayIndex}, ${displayAlpha === '—' ? 'unnamed' : displayAlpha}, ${displayFrequency} MHz`
    : `Edit channel ${displayIndex}, ${displayFrequency} MHz`;

  return (
    <div
      ref={ref}
      role="row"
      // Tailwind arbitrary values are static strings, so a per-scanner column
      // set has to come through an inline style. Header and row share
      // `channelGridTemplate(columns)` — these are grid children, not table
      // cells, so a mismatch misaligns silently rather than failing.
      style={{ gridTemplateColumns: channelGridTemplate(columns) }}
      aria-rowindex={rowIndex + 2}
      aria-selected={isSelected}
      tabIndex={0}
      aria-label={rowLabel}
      onClick={onClick}
      // REGRESSION GUARD (a11y C1): Enter/Space on the row opens the edit sheet
      // (the row's primary action). The target===currentTarget guard means a
      // Space press on the inner checkbox still toggles the checkbox rather than
      // opening the sheet. Guarded by ChannelsTab.test.tsx.
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      data-grabbed={isGrabbed || undefined}
      // #272: a staged clear is destructive but was styled identically to an
      // ordinary edit (both merely `isPending`), so clearing rows was the least
      // noticeable action in the table. Rows with a clear STAGED take an amber
      // treatment instead of the brand one, and data-cleared drives a one-shot
      // flash so the user sees WHICH rows the clear hit. The flash is decoration
      // only — the persistent amber plus the "—"/"–" placeholder values carry
      // the meaning for reduced-motion users (theme.css disables the animation).
      // Both clear once the upload lands: see the isClearPending note at the
      // call site for why this tracks pending state, not "frequency is 0".
      data-cleared={isClearPending || undefined}
      className={cn(
        'group grid min-h-[var(--size-panel-stat-min-height)] cursor-pointer items-center gap-2 border-b border-white/5 px-4 py-1.5 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-primary',
        isEditing ? 'bg-brand-primary/20 border-brand-primary/30' : 'hover:bg-white/5',
        isPending && !isClearPending && 'bg-brand-primary/10 border-l-2 border-brand-primary/60',
        isClearPending &&
          'channel-row--cleared bg-amber-500/10 border-l-2 border-amber-400/60 text-white/45',
        isDragging && 'opacity-60',
        isGrabbed && 'bg-brand-primary/25 ring-1 ring-inset ring-brand-primary/70',
      )}
    >
      <div role="cell" className="flex items-center justify-center">
        <input
          type="checkbox"
          aria-label={`Select channel ${displayIndex}`}
          checked={isSelected}
          onChange={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          onClick={(event) => event.stopPropagation()}
          className="form-checkbox h-5 w-5 text-brand-primary bg-black/40 border-white/20 rounded"
        />
      </div>
      <div role="cell" className="flex items-center justify-center text-white/40">
        {/* REGRESSION GUARD (#236): the grip is a real button, not a decorative
            icon, so a keyboard-only user can enter "grabbed" mode and nudge the
            row with the arrow keys. react-dnd's TouchBackend has no keyboard
            interaction, so this is the ONLY keyboard reorder path (WCAG 2.1.1,
            Level A) — reverting it to a plain <GripVertical> removes the
            capability with no visible change. It deliberately lives on its own
            focusable control rather than overloading the row's Enter/Space,
            which the a11y C1 guard above already claims (opens the sheet).
            Pointer DnD is untouched: the row is still the drag source.
            Guarded by ChannelsTab.test.tsx :: Keyboard reordering (#236). */}
        <button
          type="button"
          disabled={disableDrag}
          aria-label={`Reorder channel ${displayIndex}, position ${rowIndex + 1} of ${rowCount}`}
          aria-pressed={isGrabbed}
          aria-describedby="channel-reorder-hint"
          onClick={(event) => {
            event.stopPropagation();
            onToggleGrab();
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              if (!isGrabbed) return;
              event.preventDefault();
              event.stopPropagation();
              onKeyboardMove(event.key === 'ArrowUp' ? -1 : 1);
              return;
            }
            if (event.key === 'Escape' && isGrabbed) {
              event.preventDefault();
              event.stopPropagation();
              onReleaseGrab();
            }
          }}
          className={cn(
            'flex items-center justify-center rounded p-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-30',
            isGrabbed ? 'text-brand-primary' : 'text-white/40 hover:text-white/70',
          )}
        >
          <GripVertical size={20} aria-hidden />
        </button>
      </div>
      <div role="cell" className="font-mono text-white/60 text-xs pl-1">
        {displayIndex}
      </div>

      <div
        role="cell"
        className="font-mono font-bold text-brand-primary group-hover:text-brand-light tracking-wide text-center"
      >
        {displayFrequency}
      </div>
      {shows('alpha') && (
        <div role="cell" className="font-medium text-white/80 truncate pl-1">
          {displayAlpha}
        </div>
      )}
      {shows('modulation') && (
        <div role="cell" className="flex justify-center">
          <span className="text-white/60 text-xs font-medium bg-white/5 rounded px-1.5 py-0.5 w-fit uppercase border border-white/5">
            {displayModulation}
          </span>
        </div>
      )}
      {shows('tone') && (
        <div role="cell" className="text-white/60 text-xs text-center">
          {displayTone}
        </div>
      )}
      <div role="cell" className="text-white/60 text-xs text-center">
        {delayIsBoolean ? (displayDelay ? 'ON' : 'OFF') : `${displayDelay}s`}
      </div>
      <div role="cell" className="flex justify-center">
        {displayLockout ? (
          <Lock size={20} aria-label="Locked out" className="text-red-400" />
        ) : (
          <div className="w-1 h-1 rounded-full bg-white/5" aria-hidden />
        )}
      </div>
      <div role="cell" className="flex justify-center">
        {displayPriority ? (
          <div
            aria-label="Priority channel"
            role="img"
            className="h-1.5 w-1.5 rounded-full bg-orange-500 bg-brand-primary shadow-glow"
          />
        ) : (
          <div className="w-1 h-1 rounded-full bg-white/5" aria-hidden />
        )}
      </div>
    </div>
  );
}

/**
 * Which columns the channel table shows, for a scanner with the given
 * capabilities.
 *
 * The BC75XLT reserves the CIN alpha-tag, modulation, and tone fields — they
 * exist on the wire but are always empty. A permanently blank column, or one
 * filled with a fabricated default, tells the user something untrue about
 * their hardware: `parse_cin_response` defaults a blank modulation to "FM",
 * and the live `GLG` frame reports NFM for the very channels whose CIN
 * modulation is empty.
 *
 * Hidden rather than disabled. A user whose scanner has never had alpha tags
 * has no use for a greyed-out column explaining their absence on 300 rows.
 *
 * Header labels, grid track widths, and row cells all derive from this one
 * list. They were three parallel literals before — a column added to one and
 * missed in another silently shifted every cell after it, because these are
 * grid children rather than table cells and nothing fails visibly.
 *
 * Exported for tests (#404), for the same reason recorded on `buildDraft`.
 */
export type ChannelColumnKey =
  | 'select'
  | 'grip'
  | 'index'
  | 'frequency'
  | 'alpha'
  | 'modulation'
  | 'tone'
  | 'delay'
  | 'lockout'
  | 'priority';

export type ChannelColumn = {
  key: ChannelColumnKey;
  /** Header text, or null for the checkbox and grip columns. */
  label: string | null;
  width: string;
};

const ALL_CHANNEL_COLUMNS: ChannelColumn[] = [
  { key: 'select', label: null, width: '36px' },
  { key: 'grip', label: null, width: '28px' },
  { key: 'index', label: 'CH', width: '44px' },
  { key: 'frequency', label: 'FREQ', width: '84px' },
  { key: 'alpha', label: 'TAG', width: '1fr' },
  { key: 'modulation', label: 'MODE', width: '60px' },
  { key: 'tone', label: 'TONE', width: '60px' },
  { key: 'delay', label: 'DLY', width: '50px' },
  { key: 'lockout', label: 'L/O', width: '50px' },
  { key: 'priority', label: 'PRIO', width: '50px' },
];

type ColumnCapabilities = {
  has_alpha_tags: boolean;
  has_per_channel_modulation: boolean;
  has_tone_squelch: boolean;
};

export function visibleChannelColumns(caps: ColumnCapabilities): ChannelColumn[] {
  return ALL_CHANNEL_COLUMNS.filter((col) => {
    if (col.key === 'alpha') return caps.has_alpha_tags;
    if (col.key === 'modulation') return caps.has_per_channel_modulation;
    if (col.key === 'tone') return caps.has_tone_squelch;
    return true;
  });
}

/**
 * Grid template for a column set.
 *
 * The header row and every channel row must use the SAME string. When the
 * table always had ten columns this was a literal repeated in two places;
 * deriving it means they cannot drift.
 */
export function channelGridTemplate(columns: ChannelColumn[]): string {
  return columns.map((c) => c.width).join(' ');
}

/**
 * REGRESSION GUARD: the `deriveBankFromIndex` suite in ChannelsTab.test.tsx,
 * paired with `channels_with_banks_derives_per_model` on the backend. See the
 * third-rail table in CLAUDE.md — if the two halves disagree, the UI files a
 * channel in one bank while the scanner is told another.
 *
 * Bank holding a channel index, for a scanner with the given layout.
 *
 * Bank width is model-dependent: 50 channels on the BC125AT family, 30 on the
 * BC75XLT. This used to hardcode 50, which misfiled every BC75XLT channel above
 * 30 — measured on hardware, channel 31 showed in bank 1 when it belongs in
 * bank 2, and channel 300 in bank 6 rather than 10.
 *
 * Exported for tests (#401): the guard must assert the real function, matching
 * the reasoning already recorded for `buildEmptyDraft` above.
 */
export function deriveBankFromIndex(index: number, channelsPerBank: number, bankCount: number) {
  const normalized = Math.max(1, index);
  return Math.min(bankCount, Math.ceil(normalized / channelsPerBank));
}

// Exported for tests only (#272). The guard on buildEmptyDraft has to assert
// the REAL function's output — earlier attempts asserted a hand-built copy in
// the test file and passed happily with the bug reintroduced.
/**
 * Prefer the scanner's value for any field the user did NOT edit.
 *
 * A `CIN` write is all-or-nothing: every field goes out on every write. So
 * "leave this field alone" can only be expressed as "send its current value",
 * and the question is current according to WHOM. It should always have been
 * the scanner. It was the cache, which was harmless only while the cache was
 * re-read every launch -- #413 made channel memory persist, and the latent
 * assumption became a bug: editing an alpha tag on a channel whose frequency
 * was changed at the radio's keypad wrote the stale frequency back, silently
 * reverting the user's work.
 *
 * `base` is the pre-edit channel the draft was built from, so a field where
 * `payload` and `base` agree is one the user did not touch. Only those adopt
 * the scanner's value; an edited field always wins, because that edit is the
 * entire point of the upload.
 *
 * Normalisation mirrors `draftChanges`' own `hasChanges` comparison exactly --
 * `?? ''` for alpha, `|| 'AUTO'` for modulation, `?? null` for tone. Getting
 * that wrong in either direction marks untouched fields as edited (#272) or
 * edited fields as untouched, and the second silently discards user input.
 *
 * Tone is reconciled as a UNIT, never field by field: kind, Hz and DCS code
 * interlock (#132), and adopting one without the others produces a combination
 * the scanner never reported.
 *
 * Exported for its test: asserting the real function is the point (see
 * CLAUDE.md "Third-rail flows" on guards that hand-rebuilt the shape they meant
 * to check and passed while the bug was live).
 */
export function reconcileUntouchedFields(
  payload: Omit<ChannelData, 'index'>,
  base: ChannelData,
  latest: ChannelData,
): { payload: Omit<ChannelData, 'index'>; reconciled: string[] } {
  const reconciled: string[] = [];
  const next = { ...payload };

  if (next.frequency === base.frequency && latest.frequency !== next.frequency) {
    next.frequency = latest.frequency;
    reconciled.push('frequency');
  }

  const baseAlpha = base.alpha_tag ?? '';
  const latestAlpha = latest.alpha_tag ?? '';
  if (next.alpha_tag === baseAlpha && latestAlpha !== next.alpha_tag) {
    next.alpha_tag = latestAlpha;
    reconciled.push('alpha_tag');
  }

  const baseMod = base.modulation || 'AUTO';
  const latestMod = latest.modulation || 'AUTO';
  if (next.modulation === baseMod && latestMod !== next.modulation) {
    next.modulation = latestMod;
    reconciled.push('modulation');
  }

  if (next.delay === base.delay && latest.delay !== next.delay) {
    next.delay = latest.delay;
    reconciled.push('delay');
  }

  // Tone as one unit. `tone_squelch` is the only tone field the edit sheet
  // exposes, so it alone decides whether the user touched the group.
  const baseTone = base.tone_squelch ?? null;
  const latestTone = latest.tone_squelch ?? null;
  const latestKind = latest.tone_squelch_kind ?? 'none';
  const latestDcs = latest.tone_dcs_code ?? null;
  // Both sides normalised. Comparing a normalised scanner value against a raw
  // draft value made 'none' !== undefined fire a reconcile on every channel
  // that had no tone at all -- caught by `reports nothing when the scanner
  // agrees with the cache`.
  const nextKind = next.tone_squelch_kind ?? 'none';
  const nextDcs = next.tone_dcs_code ?? null;
  if (
    next.tone_squelch === baseTone &&
    (latestTone !== next.tone_squelch || latestKind !== nextKind || latestDcs !== nextDcs)
  ) {
    next.tone_squelch = latestTone;
    next.tone_squelch_kind = latestKind;
    next.tone_dcs_code = latestDcs;
    reconciled.push('tone');
  }

  return { payload: next, reconciled };
}

export function buildDraft(channel: ChannelData, clearedDelay = 2): ChannelDraft {
  if (channel.frequency === 0) {
    return buildEmptyDraft(clearedDelay);
  }
  return {
    frequency: channel.frequency.toFixed(4),
    alpha_tag: channel.alpha_tag?.trim() || '',
    modulation: channel.modulation || 'AUTO',
    tone_squelch: channel.tone_squelch?.toString() ?? '',
    delay: channel.delay.toString(),
    lockout: channel.lockout,
    comments: '',
  };
}

// REGRESSION GUARD (#272): this must describe a cleared channel AS THE SCANNER
// REPORTS IT, not "everything zeroed". buildDraft short-circuits to
// buildEmptyDraft for any channel whose frequency is 0, so after a clear is
// uploaded the rebuilt draft is diffed against the refetched channel by
// draftChanges' hasChanges. Every field that disagrees keeps the channel
// permanently in pendingChannelIds — the row never loses its pending/cleared
// styling, and Upload Changes stays lit and rewrites those channels on every
// upload.
//
// Two fields were wrong. Verified against real hardware — all 150 cleared
// channels on the dev unit report delay 2 (the firmware default the backend
// also falls back to in protocol/mod.rs) and lockout TRUE (the BC125AT locks a
// slot out when it is emptied), with modulation AUTO, an empty tag and no tone.
// Neither is a "zero it" case: 0 is a valid delay, and lockout false is a real,
// different state. Replaying hasChanges over that live set: 150/150 stuck
// pending with the old shape, 0/150 with this one.
//
// Exported so the guard asserts THIS function rather than a copy of it.
// Guarded by ChannelsTab.test.tsx :: buildEmptyDraft matches a cleared channel.
//
// #404: the cleared-slot delay is MODEL-DEPENDENT and now comes from
// ScannerCapabilities.cleared_delay. The BC125AT family reports 2; a BC75XLT
// reports 0 (measured on hardware 2026-08-26 — `CIN,299 -> CIN,299,,00000000,,,0,1,0`).
// Hardcoding either value reproduces this exact bug on the other scanner: all
// 300 cleared BC75XLT channels would sit permanently pending. Lockout is true
// on both, so it stays a literal.
//
// The default of 2 preserves the BC125AT-family behaviour for callers that
// have no capabilities yet, matching useScannerCapabilities' fallback.
export function buildEmptyDraft(clearedDelay = 2): ChannelDraft {
  return {
    frequency: '0',
    alpha_tag: '',
    modulation: 'AUTO',
    tone_squelch: '',
    delay: clearedDelay.toString(),
    lockout: true,
    comments: '',
  };
}

export function ChannelsTab() {
  const api = getAPI();
  // The `?? []` fallback is memoized rather than applied inline: a bare
  // `useStore(...) ?? []` allocates a fresh array on every render while
  // channels is null, and that identity feeds five downstream memos/callbacks
  // (filteredChannels, bankChannels, channelStats, buildDraft, and the
  // duplicate-frequency check), defeating all of them
  // (react-hooks/exhaustive-deps).
  const storedChannels = useStore((state) => state.channels);
  const channels = useMemo(() => storedChannels ?? [], [storedChannels]);
  const memoryDrafts = useStore((state) => state.memoryDrafts);
  const setMemoryDraft = useStore((state) => state.setMemoryDraft);
  const clearMemoryDrafts = useStore((state) => state.clearMemoryDrafts);
  const setChannels = useStore((state) => state.setChannels);
  // How old this channel list is, and whether a re-read is already running.
  // The scanner has no change notification -- it answers questions and never
  // volunteers that something moved (the same reasoning DeviceTab records for
  // its own Refresh). Since #413 the list can be a cache of arbitrary age, so
  // the page that edits channels is the page that has to show that age and
  // offer to fix it.
  const syncedAt = useStore((state) => state.sync.syncedAt);
  const syncInProgress = useStore((state) => state.sync.inProgress);
  const updateSync = useStore((state) => state.updateSync);
  const syncedLabel = formatSyncedAt(syncedAt);

  const handleRefreshChannels = useCallback(async () => {
    try {
      const result = await api.syncMemory();
      if (result.status === 'started' || result.status === 'already_running') {
        // Mirror App.tsx's own start path so the shared overlay comes up. The
        // sync is ~5 s and holds the radio in program mode throughout, so the
        // blocking overlay is the honest report -- not a thing to route around.
        updateSync({
          inProgress: true,
          taskId: result.task_id || null,
          message: 'Syncing scanner memory...',
        });
      }
    } catch (error) {
      console.warn('Failed to start memory sync', error);
      toast.error('Unable to refresh channels');
    }
  }, [api, updateSync]);
  const setImportProgress = useStore((state) => state.setImportProgress);

  const capabilities = useScannerCapabilities();
  const { channels_per_bank: channelsPerBank, bank_count: bankCount } = capabilities;
  // Memoized on the capability object, which useScannerCapabilities already
  // keeps referentially stable — so this does not churn on every device_info
  // broadcast.
  const columns = useMemo(() => visibleChannelColumns(capabilities), [capabilities]);
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
      const matchesBank =
        deriveBankFromIndex(channel.index, channelsPerBank, bankCount) === activeBank;
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
  }, [activeBank, bankCount, channels, channelsPerBank, memoryDrafts, searchTerm]);

  const bankChannels = useMemo(() => {
    return channels
      .filter(
        (channel) => deriveBankFromIndex(channel.index, channelsPerBank, bankCount) === activeBank,
      )
      .map((channel) => channel.index)
      .sort((a, b) => a - b);
  }, [activeBank, bankCount, channels, channelsPerBank]);

  useEffect(() => {
    // Reconcile the cached order with reality instead of freezing at first
    // sight (#146). The old `prev[activeBank] ?? bankChannels` seeding meant:
    // mount this tab before channels load (deep link during the initial
    // 30-45s sync) and the bank order froze at [] — "No channels match your
    // filters" forever; channels added later (CSV import) were silently
    // dropped. Keep the user's drag order for surviving indexes, drop stale
    // ones, append newcomers in index order.
    //
    // set-state-in-effect is suppressed, not fixed: the rule's remedy is to
    // derive during render, but bank order carries history — the user's drag
    // sequence — so it is state, not a function of the current channel list.
    // The updater is already a no-op when the reconciled order matches
    // (`unchanged ? prev : ...` below), so this cannot cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
  // Bank width is model-dependent — 30 on a BC75XLT, where bank 2 starts at
  // channel 31, not 51. Last hardcoded 50 in this file after #401.
  const bankBase = (activeBank - 1) * channelsPerBank;

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

  // Keyboard reorder (#236). `grabbedChannelIndex` holds the channel index —
  // not the row position — so the grab survives the reorder that arrow keys
  // cause: the row moves out from under its old position on every nudge.
  const [grabbedChannelIndex, setGrabbedChannelIndex] = useState<number | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');

  const releaseGrab = useCallback(() => setGrabbedChannelIndex(null), []);

  // Drop the grab whenever the grabbed row can no longer be seen or moved:
  // switching banks unmounts it, and typing a search term disables reorder
  // (it's filter-unsafe — rowIndex is a position in the filtered list, but
  // moveRow splices the unfiltered bank order). Derived during render rather
  // than synced in an effect, which would cost a cascading re-render.
  const isReorderable = searchTerm.trim().length === 0;
  const grabbedRowIndex = isReorderable
    ? orderedFilteredChannels.findIndex((channel) => channel.index === grabbedChannelIndex)
    : -1;
  const activeGrabIndex = grabbedRowIndex === -1 ? null : grabbedChannelIndex;

  const keyboardMoveRow = useCallback(
    (rowIndex: number, direction: -1 | 1, rows: ChannelData[]) => {
      const toIndex = rowIndex + direction;
      const channel = rows[rowIndex];
      if (!channel) return;
      if (toIndex < 0 || toIndex >= rows.length) {
        setReorderAnnouncement(
          `Channel ${bankBase + rowIndex + 1} is already at the ${direction === -1 ? 'top' : 'bottom'} of the bank.`,
        );
        return;
      }
      moveRow(rowIndex, toIndex);
      setReorderAnnouncement(
        `Moved to position ${toIndex + 1} of ${rows.length}. Press Escape or Enter to drop.`,
      );
    },
    [bankBase, moveRow],
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
          // `|| 'AUTO'`, not `?? 'AUTO'`. A BC75XLT reserves the CIN
          // modulation field, so the backend reports an EMPTY STRING, and `??`
          // only falls through on null/undefined -- '' survives it. The
          // comparison below already uses `||` for exactly this reason, so
          // this side normalised to '' while that side normalised to 'AUTO'
          // and every channel on that model compared as changed. All 300 sat
          // permanently in pendingChannelIds, and Upload Changes would have
          // rewritten every one of them.
          modulation: draft?.modulation ?? (channel.modulation || 'AUTO'),
          delay: Number.isFinite(parsedDelay) ? parsedDelay : channel.delay,
          tone_squelch: toneHz,
          tone_squelch_kind: toneKind,
          tone_dcs_code: toneKind === 'dcs' ? (channel.tone_dcs_code ?? null) : null,
          lockout: draft?.lockout ?? channel.lockout,
          // Priority does not ride the plain-CIN upload path (Task 6): it has
          // its own immediate endpoint (setChannelPriority) because a plain CIN
          // write can't clear priority and would trigger false
          // channel_write_mismatch warnings. The API payload still carries the
          // field, so mirror the channel's live value — it is never a draft
          // diff, which is why ChannelDraft has no `priority` (#250).
          priority: channel.priority,
        };

        const lockoutChanged = normalized.lockout !== channel.lockout;
        const targetIndex = reorderTargets[channelIndex] ?? channelIndex;
        const hasChanges =
          normalized.frequency !== channel.frequency ||
          normalized.alpha_tag !== (channel.alpha_tag ?? '') ||
          // `||` not `??`: a BC75XLT reserves the CIN modulation field, so the
          // backend reports an empty string rather than null. `??` would leave
          // '' here while the draft says 'AUTO', marking every cleared channel
          // permanently pending — the #272 failure on the other scanner.
          // Matches what `buildDraft` already does for a programmed channel.
          normalized.modulation !== (channel.modulation || 'AUTO') ||
          normalized.delay !== channel.delay ||
          normalized.tone_squelch !== (channel.tone_squelch ?? null) ||
          lockoutChanged ||
          targetIndex !== channelIndex;

        if (!hasChanges) return acc;

        const bankValue =
          channel.bank > 0
            ? channel.bank
            : deriveBankFromIndex(channelIndex, channelsPerBank, bankCount);

        acc.push({
          channelIndex,
          channel,
          draft,
          payload: {
            ...normalized,
            bank: bankValue,
          },
          lockoutChanged,
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
        targetIndex: number;
      }>,
    );
  }, [bankCount, channels, channelsPerBank, memoryDrafts, reorderTargets]);

  // Rows that have REAL pending changes. isPending (the row's "modified"
  // highlight) is derived from this, not from Boolean(draft): a draft object
  // can exist without representing any change — e.g. the sheet's Save writes a
  // draft even when only an immediate-action field (priority/lockout, #206)
  // was toggled, or when nothing changed at all. draftChanges is the value-diff
  // that already gates Upload/Discard and already folds in drag-reorder
  // (targetIndex !== channelIndex), so a no-op draft never lights a row.
  const pendingChannelIds = useMemo(
    () => new Set(draftChanges.map((c) => c.channelIndex)),
    [draftChanges],
  );

  const handleOpenEditSheet = useCallback(
    (channelIndex: number) => {
      const channel = channels.find((ch) => ch.index === channelIndex);
      if (!channel) return;

      // Don't seed a store draft here. The sheet keeps its own local working
      // copy (#146) and falls back to buildDraft when no store draft exists,
      // so opening never needs to write one. Seeding an identical-copy draft
      // lit the row's isPending (`Boolean(draft)`) "modified" style on open,
      // and Cancel — which only clears editingChannelIndex — never removed it,
      // leaving a cancelled row styled modified. The store draft is written
      // only on an explicit Save (handleSaveDraft).
      setEditingChannelIndex(channelIndex);
    },
    [channels],
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

  // Priority is an immediate action (Task 6), not a batched draft field: the
  // scanner only allows one priority channel per bank, so toggling it fires
  // the priority endpoint right away rather than waiting for Upload Changes.
  const handlePriorityChange = useCallback(
    async (channelIndex: number, next: boolean) => {
      const bank = deriveBankFromIndex(channelIndex, channelsPerBank, bankCount);
      if (next) {
        const existing = channels.find(
          (c) =>
            c.priority &&
            deriveBankFromIndex(c.index, channelsPerBank, bankCount) === bank &&
            c.index !== channelIndex,
        );
        if (existing) {
          const ok = await confirmDialog(
            `CH${existing.index} "${existing.alpha_tag || 'unnamed'}" is the priority channel for Bank ${bank}. Move priority to CH${channelIndex}?`,
            'Move priority',
          );
          if (!ok) return;
        }
      } else {
        const ok = await confirmDialog(
          `Clear priority on CH${channelIndex}? The channel is rewritten in place.`,
          'Clear priority',
        );
        if (!ok) return;
      }
      try {
        const changed = await getAPI().setChannelPriority(channelIndex, next);
        const byIndex = new Map(changed.map((c) => [c.index, c]));
        setChannels(channels.map((c) => byIndex.get(c.index) ?? c));
      } catch {
        toast.error(`Failed to ${next ? 'set' : 'clear'} priority on CH${channelIndex}`);
      }
    },
    [bankCount, channels, channelsPerBank, setChannels],
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
      setMemoryDraft(channelIndex, buildEmptyDraft(capabilities.cleared_delay));
    }
    toast.success(`Cleared ${selectedChannelIds.length} channels`);
    setSelectedChannelIds([]);
  }, [capabilities.cleared_delay, selectedChannelIds, setMemoryDraft]);

  const handleUploadDrafts = useCallback(async () => {
    if (draftChanges.length === 0 || isUploading) return;
    setIsUploading(true);
    const failed: Array<{ index: number; detail?: string }> = [];
    const warnings: Array<{ index: number; detail: string }> = [];
    // Channels where the scanner's value replaced the draft's for a field the
    // user never touched. Reported rather than applied silently: this changes
    // which side wins a conflict, and an invisible reconciliation trades a bug
    // you can describe for one you cannot.
    const reconciledChannels: number[] = [];

    try {
      await api.startProgramMode();
      for (const change of draftChanges) {
        try {
          let payload = change.payload;
          const targetIndex = change.targetIndex ?? change.channelIndex;
          const targetBank = deriveBankFromIndex(targetIndex, channelsPerBank, bankCount);
          payload = {
            ...payload,
            bank: targetBank,
          };
          if (!change.lockoutChanged) {
            try {
              const latest = await api.getChannel(change.channelIndex);
              payload = {
                ...payload,
                lockout: latest.lockout,
                priority: latest.priority,
                bank: latest.bank || payload.bank,
              };
              // Every OTHER field the user did not edit also comes from the
              // scanner, not from the draft's cached basis. See
              // `reconcileUntouchedFields`. Only reachable when the read
              // succeeded: the catch below leaves `payload` on the draft, so a
              // marginal read degrades to today's behaviour rather than
              // reverting a staged edit.
              const outcome = reconcileUntouchedFields(payload, change.channel, latest);
              payload = outcome.payload;
              if (outcome.reconciled.length > 0) {
                reconciledChannels.push(change.channelIndex);
              }
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
          setMemoryDraft(updated.index, buildDraft(updated, capabilities.cleared_delay));
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
              setChannels((prev) =>
                prev.map((entry) => (entry.index === refreshed.index ? refreshed : entry)),
              );
              setMemoryDraft(refreshed.index, buildDraft(refreshed, capabilities.cleared_delay));
              if (matchesPrimaryFields) {
                if (change.lockoutChanged && !lockoutApplied) {
                  warnings.push({
                    index: change.channelIndex,
                    detail: 'Lockout did not apply',
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
          setMemoryDraft(idx, buildDraft(refreshed, capabilities.cleared_delay));
        }
      }
      setBankOrders({});
    } catch (error) {
      console.warn('Failed to refresh channels after upload', error);
    }

    const reconciledNote =
      reconciledChannels.length > 0 ? ` (${reconciledChannels.length} refreshed from scanner)` : '';

    if (failed.length === 0 && warnings.length === 0) {
      toast.success(`Uploaded ${draftChanges.length} channel edits${reconciledNote}`);
    } else if (failed.length === 0 && warnings.length > 0) {
      toast.error(`Uploaded with ${warnings.length} warnings (lockout not applied)`);
    } else if (failed.length > 0) {
      const firstFailure = failed[0];
      const detailText = firstFailure.detail ? ` (${firstFailure.detail})` : '';
      console.error('Upload failed', { failed });
      toast.error(
        `Failed to upload ${failed.length} channel edits. First failure: CH ${firstFailure.index}${detailText}`,
      );
    }
  }, [
    api,
    bankCount,
    capabilities.cleared_delay,
    channelsPerBank,
    draftChanges,
    isUploading,
    setChannels,
    setMemoryDraft,
  ]);

  const handleDiscardDrafts = useCallback(async () => {
    if (draftChanges.length === 0 || isUploading) return;
    const confirmed = await confirmDialog('Discard all pending channel edits?', 'Discard drafts');
    if (!confirmed) return;

    // Pending state has two independent surfaces: field edits in memoryDrafts
    // and drag-reorder in bankOrders. Both feed draftChanges (which drives
    // isPending), so discard must wipe BOTH. Rebuilding drafts from the channel
    // (the old approach) left a non-null draft in place; back when isPending was
    // Boolean(draft) that kept rows lit (#195). isPending is now value-based, but
    // an outright removal is still the correct discard — a leftover no-op draft
    // is pointless state. Remove the drafts outright.
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

  const handleExportBc75xltSs = async () => {
    if (isExportingSs) return;
    setIsExportingSs(true);
    const toastId = toast.loading('Exporting BC75XLT format…');
    try {
      const response = await fetch(`${API_BASE}/memory/export/bc75xlt_ss`);
      if (!response.ok) throw new Error(String(response.status));
      const bytes = new Uint8Array(await response.arrayBuffer());
      const where = await saveExport('scanner.bc75xlt_ss', bytes);
      toast.dismiss(toastId);
      if (where !== 'cancelled') {
        toast.success('Exported BC75XLT settings file');
      }
    } catch (error) {
      console.error('Failed to export BC75XLT settings file', error);
      toast.dismiss(toastId);
      toast.error('Failed to export BC75XLT settings file');
    } finally {
      setIsExportingSs(false);
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
    const picked = await pickAndReadFile(['csv', 'bc125at_ss', 'bc75xlt_ss']);
    if (!picked) return;

    // A .ss file restores the WHOLE config (channels + all settings), so it's
    // more destructive than a CSV channel import — confirm first.
    const lower = picked.name.toLowerCase();
    const isBc125atSs = lower.endsWith('.bc125at_ss');
    const isBc75xltSs = lower.endsWith('.bc75xlt_ss');
    const isSs = isBc125atSs || isBc75xltSs;
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
        ? `${API_BASE}/memory/import/${isBc75xltSs ? 'bc75xlt_ss' : 'bc125at_ss'}`
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
        <h3 className="sticky top-0 z-10 bg-scanner-bg-dark/90 px-3 py-2 text-xs font-bold uppercase tracking-wider text-white/60 backdrop-blur-sm">
          Bank Select
        </h3>
        {bankTabs.map((bank) => (
          <button
            key={bank}
            onClick={() => setActiveBank(bank)}
            className={cn(
              'flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium rounded transition-all',
              activeBank === bank
                ? 'bg-brand-primary/20 text-brand-primary shadow-brand-inset'
                : 'text-white/60 hover:bg-white/5 hover:text-white',
            )}
          >
            <span>Bank {bank}</span>
            {activeBank === bank && (
              <div className="w-1.5 h-1.5 shrink-0 rounded-full bg-brand-primary shadow-glow" />
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
              <Search
                aria-hidden
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30 w-3.5 h-3.5"
              />
              <input
                type="search"
                aria-label="Search channels by frequency or tag"
                placeholder={
                  columns.some((c) => c.key === 'alpha')
                    ? 'Search frequency or tag...'
                    : 'Search frequency...'
                }
                className="scanner-input w-full border-white/5 py-1.5 pl-8 pr-4 text-xs placeholder:text-white/20 focus:border-brand-primary/50"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            {syncedLabel && (
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs font-normal text-white/40 text-nowrap">{syncedLabel}</span>
                <button
                  type="button"
                  onClick={handleRefreshChannels}
                  disabled={syncInProgress}
                  className="flex items-center gap-1.5 rounded border border-white/5 bg-black/20 px-2.5 py-1 text-xs font-normal text-white/70 transition-colors hover:bg-black/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw
                    size={12}
                    aria-hidden
                    className={cn(syncInProgress && 'animate-spin')}
                  />
                  {syncInProgress ? 'Reading…' : 'Refresh'}
                </button>
              </div>
            )}
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
                <ChevronDown className="size-5" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={handleExportCSV}>CSV</DropdownMenuItem>
                {/* Hidden, not disabled, when the scanner has no `.bc125at_ss`
                  format — the same rule the channel columns follow. The
                  BC75XLT has its own settings-file layout that Bearpaw has no
                  spec for, so offering the item would produce a file its own
                  software would reject. The backend refuses it too. */}
                {capabilities.ss_format === 'bc75xlt' && (
                  <DropdownMenuItem onSelect={handleExportBc75xltSs}>BC75XLT</DropdownMenuItem>
                )}
                {capabilities.ss_format === 'bc125at' && (
                  <DropdownMenuItem onSelect={handleExportBc125atSs}>BC125AT</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex items-center justify-between bg-black/10 p-3 rounded-lg border border-white/5 shrink-0">
          <div role="status" aria-live="polite" className="text-xs text-white/60">
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

        {/* Keyboard-reorder announcements (#236). Separate from the drafts
            status region above so a grab/move/drop doesn't clobber the pending
            -changes count, and vice versa. */}
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {reorderAnnouncement}
        </div>

        {/* Table */}
        <DndProvider
          backend={TouchBackend}
          options={{ enableMouseEvents: true, delayMouseStart: 100 }}
        >
          <div
            role="table"
            aria-label="Bank channels"
            className="flex-1 bg-black/20 rounded-lg border border-white/5 overflow-hidden flex flex-col shadow-inner min-h-0"
            ref={containerRef}
          >
            {/* Header */}
            <div
              role="row"
              className="grid gap-2 px-4 py-2 bg-white/5 border-b border-white/5 shrink-0"
              style={{ gridTemplateColumns: channelGridTemplate(columns) }}
            >
              <div role="columnheader" className="flex items-center justify-center">
                <input
                  type="checkbox"
                  aria-label="Select all visible channels"
                  checked={
                    orderedFilteredChannels.length > 0 &&
                    orderedFilteredChannels.every((channel) =>
                      selectedChannelIds.includes(channel.index),
                    )
                  }
                  onChange={handleToggleSelectAll}
                  className="form-checkbox h-5 w-5 text-brand-primary bg-black/40 border-white/20 rounded"
                />
              </div>
              <div role="columnheader" aria-label="Reorder">
                <span id="channel-reorder-hint" className="sr-only">
                  Press Enter or Space to grab this channel, then use the up and down arrow keys to
                  move it and Escape to drop it.
                </span>
              </div>
              {columns
                .filter((col) => col.label !== null)
                .map((col) => col.label as string)
                .map((h) => (
                  <div
                    key={h}
                    role="columnheader"
                    className="text-xs font-bold text-white/60 uppercase tracking-wider select-none text-center first:text-left"
                  >
                    {h}
                  </div>
                ))}
            </div>

            {/* Rows */}
            <div
              role="rowgroup"
              aria-hidden={editingChannelIndex !== null}
              className={cn(
                'overflow-y-auto flex-1 p-0',
                editingChannelIndex !== null && 'opacity-50 pointer-events-none',
              )}
            >
              {orderedFilteredChannels.length === 0 ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex h-[var(--layout-empty-state-height)] items-center justify-center text-xs text-white/50"
                >
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
                  // Lockout and priority are NOT the same kind of field, and
                  // #206 originally treated them as one.
                  //
                  // PRIORITY is an immediate action: `ChannelDraft` has no
                  // `priority` field at all (#250), it is never diffed, and
                  // `draftChanges` mirrors the channel's live value. Its truth
                  // is always `channel.priority` — reading a draft here let a
                  // snapshot frozen with priority=true keep the LED lit after
                  // an immediate clear zeroed the channel.
                  //
                  // LOCKOUT is a batched draft field: it lives on
                  // `ChannelDraft`, `lockoutChanged` is part of `hasChanges`,
                  // and it ships in the upload payload. So a staged lockout
                  // edit is a real pending change and the row has to show it —
                  // reading `channel.lockout` meant unlocking a channel in the
                  // edit sheet left the row's lock icon lit until upload, with
                  // no indication the change had registered.
                  const displayLockout = isCleared ? false : (draft?.lockout ?? channel.lockout);
                  const displayPriority = isCleared ? false : channel.priority;
                  const isPending = pendingChannelIds.has(channel.index);
                  // REGRESSION GUARD (#272): the amber row treatment means
                  // "clear STAGED, not yet uploaded", so it must be gated on
                  // isPending — NOT on isCleared alone. isCleared is a pure
                  // value test (the draft's frequency parses to 0), and a
                  // successful upload REBUILDS the draft from the written
                  // channel (handleUploadDrafts) rather than deleting it. So a
                  // genuinely-cleared channel keeps a zero-frequency draft for
                  // the life of the session: gating on isCleared alone left the
                  // row amber and flashing forever after the write had landed.
                  // Only draftChanges (via pendingChannelIds) knows the change
                  // already shipped. Same stale-draft trap as the isPending
                  // (#195) and priority/lockout (#206) guards above.
                  // Guarded by ChannelsTab.test.tsx :: keeps a staged clear
                  // amber only while it is genuinely pending.
                  const isClearPending = isCleared && isPending;

                  return (
                    <ChannelRow
                      key={channel.index}
                      displayIndex={displayIndex}
                      isEditing={isEditing}
                      isPending={isPending}
                      isClearPending={isClearPending}
                      isSelected={selectedChannelIds.includes(channel.index)}
                      onSelect={() => handleToggleSelect(channel.index)}
                      onClick={() => handleOpenEditSheet(channel.index)}
                      onMove={moveRow}
                      isGrabbed={activeGrabIndex === channel.index}
                      onToggleGrab={() => {
                        if (activeGrabIndex === channel.index) {
                          setGrabbedChannelIndex(null);
                          setReorderAnnouncement(
                            `Dropped channel at position ${rowIndex + 1} of ${orderedFilteredChannels.length}.`,
                          );
                          return;
                        }
                        setGrabbedChannelIndex(channel.index);
                        setReorderAnnouncement(
                          `Grabbed channel at position ${rowIndex + 1} of ${orderedFilteredChannels.length}. Use the up and down arrow keys to move it, then Escape or Enter to drop.`,
                        );
                      }}
                      onKeyboardMove={(direction) =>
                        keyboardMoveRow(rowIndex, direction, orderedFilteredChannels)
                      }
                      onReleaseGrab={() => {
                        releaseGrab();
                        setReorderAnnouncement(
                          `Dropped channel at position ${rowIndex + 1} of ${orderedFilteredChannels.length}.`,
                        );
                      }}
                      rowIndex={rowIndex}
                      rowCount={orderedFilteredChannels.length}
                      disableDrag={searchTerm.trim().length > 0}
                      displayFrequency={displayFrequency}
                      columns={columns}
                      validDelays={capabilities.valid_delays}
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
            draft={editingDraft ?? buildDraft(editingChannel, capabilities.cleared_delay)}
            isOpen={editingChannelIndex !== null}
            onClose={handleCloseEditSheet}
            onSave={(draft) => handleSaveDraft(editingChannelIndex, draft)}
            priorityChecked={editingChannel.priority}
            onPriorityChange={(next) => handlePriorityChange(editingChannelIndex, next)}
            emptyDraft={buildEmptyDraft(capabilities.cleared_delay)}
          />
        )}
      </div>
    </motion.div>
  );
}
