import { motion } from 'motion/react';
import { FileText, RotateCcw } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { BarChart, Bar, LabelList, ResponsiveContainer, XAxis } from 'recharts';
import { toast } from 'sonner';
import { getAPI } from '../../../api/useApi';
import { cn } from '../../../lib/utils';
import { useStore } from '../../../store/useStore';
import type { ConnectionStatus } from '../../../hooks/useConnectionStatus';
import type { BusiestChannel, HeatmapStats } from '../../../hooks/useDashboardAnalytics';
import { useScannerCapabilities } from '../../../hooks/useScannerCapabilities';
import type { ActivityLogEntry } from '../../../types';
import { ScannerDisplay, type LockoutKind } from '../ScannerUI';
import type { ScannerMode } from '../../App';

/** Row order for the heatmap: Monday first, matching `computeLocalHeatmap`. */
export const HEATMAP_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/**
 * One sentence describing the heatmap, for its `<caption>`.
 *
 * The grid itself is 168 coloured squares with no text, so without this a
 * screen-reader user gets a table of numbers and no idea what the shape of it
 * is. Names the busiest hour, which is the question the chart exists to answer.
 */
export function summarizeHeatmap(grid: number[][]): string {
  let total = 0;
  let peak = { day: -1, hour: -1, count: 0 };
  for (let day = 0; day < grid.length; day++) {
    for (let hour = 0; hour < (grid[day]?.length ?? 0); hour++) {
      const count = grid[day][hour] ?? 0;
      total += count;
      if (count > peak.count) peak = { day, hour, count };
    }
  }
  if (total === 0) return 'Activity heatmap: no hits recorded in the last 7 days.';
  const label = HEATMAP_DAY_LABELS[peak.day] ?? '';
  const hour = String(peak.hour).padStart(2, '0');
  return `Activity heatmap: ${total} hits over the last 7 days by day and hour. Busiest is ${label} at ${hour}:00 with ${peak.count}.`;
}

const HEATMAP_INTENSITY_CLASSES = [
  'bg-heatmap-0',
  'bg-heatmap-1',
  'bg-heatmap-2',
  'bg-heatmap-3',
  'bg-heatmap-4',
  'bg-heatmap-5',
] as const;

function getRelativeTime(date: Date | number) {
  const timestamp = typeof date === 'number' ? date * 1000 : date.getTime();
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/** `rssi` is 0–100 (the scanner's own 0–5 bars × 20 where it reports them,
 *  #815), so this recovers the LCD's bar count exactly. A value of 0–5 is a
 *  weak 0–100 reading, never a bar count: treating it as one drew 3% as 3 bars. */
function normalizeSignal(value?: number) {
  if (value === undefined || value === null) return 0;
  return Math.min(5, Math.round(value / 20));
}

/** One row in the Recent Hits list. A `count > 1` means consecutive
 *  same-channel hits were rolled up; `tag` already carries the `(N)` suffix. */
export interface RolledHit {
  id: string;
  frequency: string;
  tag: string;
  strength: number;
  time: number;
  count: number;
}

/** Channel number is the grouping identity; frequency is the fallback for
 *  channel-less freq-only hits. The `freq:` prefix keeps a channel number from
 *  ever colliding with a frequency value. */
function hitGroupKey(entry: ActivityLogEntry): string {
  return entry.channel != null ? `ch:${entry.channel}` : `freq:${entry.frequency}`;
}

/**
 * Collapse each maximal run of *consecutive* same-channel hits into a single
 * row. Input is newest-first (as `fullActivityLog` is kept), so the first entry
 * of each run is the most recent — its time/frequency/tag represent the group.
 * A different channel breaks the run: `A, A, B, A` yields three rows, not two.
 *
 * Signal strength is the rounded average of the group's normalized strengths;
 * the `(N)` count suffix is only appended when the group has more than one hit.
 */
export function rollUpHits(entries: ActivityLogEntry[]): RolledHit[] {
  const groups: RolledHit[] = [];
  let currentKey: string | null = null;
  let strengthSum = 0;

  for (const entry of entries) {
    const key = hitGroupKey(entry);
    if (key !== currentKey) {
      // Start a new group. `entry` is the most recent hit in it.
      currentKey = key;
      strengthSum = normalizeSignal(entry.rssi);
      groups.push({
        id: entry.id,
        frequency: entry.frequency.toFixed(3),
        // Empty, not an em dash: a scanner with no alpha tags would otherwise
        // render a full column of placeholders. The dash is applied at render
        // time, and only when the tag column is shown at all.
        tag: entry.alpha_tag || '',
        strength: strengthSum,
        time: entry.timestamp,
        count: 1,
      });
      continue;
    }
    // Extend the current (last-pushed) group.
    const group = groups[groups.length - 1];
    group.count += 1;
    strengthSum += normalizeSignal(entry.rssi);
    group.strength = Math.round(strengthSum / group.count);
  }

  // The `(N)` suffix is NOT baked into `tag` any more. With no alpha tags
  // there is no tag column to carry it, and a bare "(3)" floating in an
  // otherwise empty column reads as a glitch. The renderer places it.
  return groups;
}

/**
 * The hits Recent Hits shows after a reset (#818): those that ENDED after it.
 * Compared on `ended_at`, not the start time, so a transmission still on the
 * air when Reset was pressed shows up when it ends instead of vanishing.
 */
export function hitsSinceReset(
  entries: ActivityLogEntry[],
  resetAt: number | null,
): ActivityLogEntry[] {
  if (resetAt === null) return entries;
  return entries.filter((entry) => (entry.ended_at ?? entry.timestamp) > resetAt);
}

function HitSignalBars({ strength }: { strength: number }) {
  return (
    <div className="flex shrink-0 items-end gap-[clamp(1px,0.8cqmin,8px)]">
      {[1, 2, 3, 4, 5].map((bar) => (
        <span
          key={bar}
          className={cn(
            'h-[clamp(8px,3.5cqmin,56px)] w-[clamp(2px,1.2cqmin,18px)] rounded-scanner-xs',
            bar <= strength ? 'bg-green-500' : 'bg-white/10',
          )}
        />
      ))}
    </div>
  );
}

/** Five rows fill the list region; older hits continue below and are reached
 *  by scrolling it (#817). Empty slots pad a short list to five so the layout
 *  doesn't reflow as the first hits arrive. */
const HIT_SLOT_COUNT = 5;
/** How far back the list goes. The log can hold thousands of entries, and the
 *  whole list re-renders with every live update; Export covers the rest. */
const RECENT_HITS_LIMIT = 100;

export interface ScanViewProps {
  mainText: string;
  subText: string;
  scannerMode: ScannerMode;
  connectionStatus: ConnectionStatus;
  isHolding: boolean;
  isInitialSyncing: boolean;
  chartAnimate: boolean;
  dashboardLoading: boolean;
  busiestChannels: BusiestChannel[];
  hourlyHeatmap: number[][];
  heatmapStats: HeatmapStats;
  squelch: number;
  onSquelchChange: (squelch: number) => void;
  onHoldToggle: () => void;
  onLockout: (type: LockoutKind) => void;
  onVolumeChange: (value: number) => void;
  onBankToggle: (index: number) => void;
  onOpenActivityExport: () => void;
}

export function ScanView({
  mainText,
  subText,
  connectionStatus,
  isHolding,
  isInitialSyncing,
  chartAnimate,
  dashboardLoading,
  busiestChannels,
  hourlyHeatmap,
  heatmapStats,
  squelch,
  onSquelchChange,
  onHoldToggle,
  onLockout,
  onVolumeChange,
  onBankToggle,
  onOpenActivityExport,
}: ScanViewProps) {
  const liveState = useStore((state) => state.liveState);
  const fullActivityLog = useStore((state) => state.fullActivityLog);
  const banks = useStore((state) => state.banks);
  const banksKnown = useStore((state) => state.banksKnown);
  const bankNames = useStore((state) => state.bankNames);

  // Roll up consecutive same-channel hits into one row (e.g. "WOF Rides (6)"),
  // then show the five most recent groups. Sourced from `fullActivityLog`
  // rather than the store's 5-entry `activityLog` so a group's count can
  // exceed five.
  // A scanner with no alpha tags would render a full column of placeholders,
  // so the column is removed rather than blanked (CLAUDE.md: hide unsupported
  // surfaces, do not show an empty one). The roll-up count moves next to the
  // frequency, which becomes the row's identity.
  const capabilities = useScannerCapabilities();
  const showTagColumn = capabilities.has_alpha_tags;
  const recentHitsResetAt = useStore((state) => state.preferences.recentHitsResetAt);
  const updatePreferences = useStore((state) => state.updatePreferences);
  const recentHits = useMemo(
    () =>
      rollUpHits(hitsSinceReset(fullActivityLog, recentHitsResetAt)).slice(0, RECENT_HITS_LIMIT),
    [fullActivityLog, recentHitsResetAt],
  );

  // Clears Recent Hits only; the stored log is untouched (#818). Saved before
  // the store changes, so a failed save leaves the list as it was.
  const handleResetRecentHits = useCallback(() => {
    const resetAt = Date.now() / 1000;
    getAPI()
      .setPreference('recent_hits_reset_at', resetAt)
      .then(() => updatePreferences({ recentHitsResetAt: resetAt }))
      .catch((error) => {
        console.error('Failed to reset Recent Hits', error);
        toast.error('Could not reset Recent Hits. Try again.');
      });
  }, [updatePreferences]);

  // A new hit is added at the top. Scrolled back, that would push the rows
  // being read down by one, so move the scroll by however far the previous
  // top row moved. At the top (scrollTop 0) the new hit simply shows. Done by
  // hand because WKWebView has no CSS scroll anchoring; `overflow-anchor:
  // none` on the list keeps Chromium from adjusting a second time.
  const listRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const rows = list ? [...list.children].filter((el) => el instanceof HTMLElement) : [];
    const prev = anchorRef.current;
    if (list && prev && list.scrollTop > 0) {
      const moved = rows.find((row) => row.dataset.hitId === prev.id);
      if (moved) list.scrollTop += moved.offsetTop - prev.top;
    }
    const first = rows.find((row) => row.dataset.hitId);
    anchorRef.current = first ? { id: first.dataset.hitId ?? '', top: first.offsetTop } : null;
  }, [recentHits]);

  const isError = connectionStatus === 'disconnected';
  // The last mode survives a disconnect, so `mode === 'SCAN'` alone kept the
  // display on "Scanning..." with no scanner attached.
  const isScanningRightNow =
    !isError && !isInitialSyncing && liveState?.mode === 'SCAN' && !liveState?.squelch_open;
  const signalStrength = normalizeSignal(liveState?.rssi);

  return (
    <motion.div
      key="scan"
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="flex flex-col gap-6 h-full relative"
      layout
    >
      {/* Top row — bordered container holding the orange display panel and the Recent Hits
          list. Sized with flex-1 so it claims roughly half the available height alongside the
          bottom row of dashboard widgets; min-height guards against squeezing when the window
          is short. `container-type: size` here scopes Recent Hits' cqmin units to the top row,
          so its type and controls scale alongside the Display when the window grows. */}
      <div className="flex flex-1 min-h-[var(--layout-dashboard-main-height)] items-stretch gap-6 rounded-lg border border-white/5 bg-black/20 p-[9px] transition-all duration-500 ease-in-out [container-type:size]">
        <div className="relative flex-1 min-w-0 self-stretch">
          <ScannerDisplay
            mainText={mainText}
            subText={subText}
            signalStrength={signalStrength}
            isScanning={isScanningRightNow}
            isError={isError}
            volume={liveState?.volume ?? 0}
            squelch={squelch}
            onSquelchChange={onSquelchChange}
            isHolding={isHolding}
            onVolumeChange={onVolumeChange}
            onHoldToggle={onHoldToggle}
            onLockout={onLockout}
            banks={banks}
            banksKnown={banksKnown}
            bankNames={bankNames}
            onBankToggle={onBankToggle}
          />
        </div>

        {/* Recent Hits */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col gap-[clamp(32px,3cqmin,60px)] self-stretch py-[10px]">
          <div className="flex shrink-0 items-center justify-between border-b border-white/10 pb-[clamp(6px,1.8cqmin,28px)]">
            <h3 className="font-display font-bold text-[clamp(13px,3.5cqmin,56px)] text-scanner-text-light">
              Recent Hits
            </h3>
            {/* A visible text label, not an icon plus a hover tooltip. The
              tooltip read "Export" and was reachable only by pointer, so the
              control's purpose was hidden from touch users and from anyone
              scanning the page. `aria-label` stays because it is more specific
              than the visible text and contains it, which is what WCAG 2.5.3
              (Label in Name) requires. */}
            <div className="flex shrink-0 items-center gap-[clamp(4px,1.2cqmin,16px)]">
              <button
                type="button"
                onClick={handleResetRecentHits}
                disabled={recentHits.length === 0}
                className={cn(
                  'inline-flex shrink-0 items-center gap-[clamp(4px,1.2cqmin,16px)] rounded-scanner-xs border border-white/10 bg-white/5 px-[clamp(8px,1.8cqmin,28px)] py-[clamp(4px,1cqmin,16px)] text-[clamp(11px,2.6cqmin,44px)] text-white/80 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white',
                  recentHits.length === 0 && 'cursor-not-allowed opacity-50',
                )}
                aria-label="Reset Recent Hits"
              >
                <RotateCcw aria-hidden className="size-[clamp(14px,2.2cqmin,36px)]" />
                Reset
              </button>
              <button
                type="button"
                onClick={onOpenActivityExport}
                disabled={fullActivityLog.length === 0}
                className={cn(
                  'inline-flex shrink-0 items-center gap-[clamp(4px,1.2cqmin,16px)] rounded-scanner-xs border border-white/10 bg-white/5 px-[clamp(8px,1.8cqmin,28px)] py-[clamp(4px,1cqmin,16px)] text-[clamp(11px,2.6cqmin,44px)] text-white/80 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white',
                  fullActivityLog.length === 0 && 'cursor-not-allowed opacity-50',
                )}
                aria-label="Export activity log"
              >
                <FileText aria-hidden className="size-[clamp(14px,2.2cqmin,36px)]" />
                Export
              </button>
            </div>
          </div>
          {recentHits.length === 0 ? (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 pr-2 text-white/60 text-[clamp(11px,3cqmin,52px)] italic">
              Waiting for signals...
            </div>
          ) : (
            // One grid for all five rows so every column lines up vertically
            // (proper "tabbing"). Each row uses `grid-cols-subgrid` to inherit
            // the parent's column tracks, which lets us still hover-highlight
            // the whole row as a single element.
            //
            // The timestamp column is `minmax(14ch, max-content)` rather than
            // `auto` so it reserves room for the longest expected label
            // ("59 seconds ago") and doesn't wobble as the relative-time
            // string ticks ("17 seconds ago" → "18 seconds ago" → "1 minute
            // ago" …). `ch` scales with the font, so the floor tracks the
            // fluid type sizing automatically.
            //
            // Each row is a fifth of the list's height (`auto-rows-[20%]`, no
            // row gap), so five fill it exactly and the sixth starts just out
            // of view: the list scrolls rather than growing (#817).
            // The template is the SAME whether or not the scanner has alpha
            // tags. The third track holds the tag when there is one and the
            // roll-up count when there is not, so it is never an empty
            // placeholder column -- and, critically, the frequency column
            // stays pure numerics. `text-right` is there so decimal points
            // line up; putting the "(N)" suffix inside that span made the
            // column's contents vary in width, and right-aligning
            // "146.8500 (2)" against "27.4050" indents the short rows into a
            // ragged left edge.
            <div
              ref={listRef}
              role="list"
              aria-label="Recent hits"
              tabIndex={0}
              className="grid flex-1 min-h-0 overflow-y-auto [overflow-anchor:none] grid-cols-[minmax(14ch,max-content)_auto_minmax(0,1fr)_auto] auto-rows-[20%] gap-x-[clamp(12px,3.5cqmin,60px)] pr-2 text-[clamp(13px,5cqmin,72px)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {Array.from({ length: Math.max(HIT_SLOT_COUNT, recentHits.length) }, (_, idx) => {
                const hit = recentHits[idx];
                if (!hit) {
                  return <div key={`empty-${idx}`} className="col-span-4" aria-hidden="true" />;
                }
                const countSuffix = hit.count > 1 ? ` (${hit.count})` : '';
                return (
                  <div
                    key={hit.id}
                    role="listitem"
                    data-hit-id={hit.id}
                    className="col-span-4 grid grid-cols-subgrid items-center rounded-[4px] px-[clamp(2px,1cqmin,12px)] hover:bg-white/5"
                  >
                    <span className="whitespace-nowrap text-white/60">
                      {getRelativeTime(hit.time)}
                    </span>
                    <span className="whitespace-nowrap text-right font-mono text-brand-light">
                      {hit.frequency}
                    </span>
                    <span className="whitespace-nowrap text-white/60" title={hit.tag || undefined}>
                      {showTagColumn ? `${hit.tag || '—'}${countSuffix}` : countSuffix.trimStart()}
                    </span>
                    <HitSignalBars strength={hit.strength} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Dashboard Widgets — appear below, share the remaining vertical space 50/50 with the
          top row. `container-type: size` here scopes each child widget's cqmin units to this
          row so their headings and chart labels scale alongside the Display. */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-1 min-h-0 gap-6 overflow-hidden [container-type:size]"
      >
        {/* Busiest Channels */}
        <div className="flex-1 min-h-0 bg-black/20 rounded-lg border border-white/5 p-4 flex flex-col">
          <h3 className="font-display font-bold text-[clamp(14px,3cqmin,56px)] mb-[clamp(8px,2cqmin,32px)]">
            Busiest Channels
          </h3>
          {dashboardLoading ? (
            <div className="flex-1 flex items-center justify-center text-white/60 text-xs">
              Loading...
            </div>
          ) : busiestChannels.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-white/60 text-xs italic">
              No data yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={busiestChannels}>
                <XAxis
                  dataKey="label"
                  tick={{ fill: 'var(--color-chart-axis)', fontSize: 10 }}
                  interval={0}
                />
                <Bar
                  dataKey="hit_count"
                  fill="var(--color-chart-bar)"
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={chartAnimate}
                  animationDuration={600}
                >
                  <LabelList
                    dataKey="hit_count"
                    position="insideTop"
                    style={{
                      fill: 'var(--color-chart-label)',
                      fontSize: 10,
                      fontWeight: 600,
                    }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Activity Heatmap */}
        <div className="flex-1 min-h-0 bg-black/20 rounded-lg border border-white/5 p-4 flex flex-col">
          <h3 className="font-display font-bold text-[clamp(14px,3cqmin,56px)] mb-[clamp(8px,2cqmin,32px)]">
            Activity Heatmap
          </h3>
          {/* The grid is 168 unlabelled <div>s. `title` is not announced on a
            non-focusable element, so to assistive tech this widget was
            entirely empty -- a WCAG 1.1.1 failure. It is marked decorative
            here and the equivalent data is exposed as a real table below,
            which AT can navigate cell by cell with day/hour context. */}
          <div
            aria-hidden="true"
            className="flex flex-1 flex-col justify-center gap-[var(--layout-heatmap-cell-gap)]"
          >
            {HEATMAP_DAY_LABELS.map((day, row) => (
              <div key={day} className="flex items-center gap-[clamp(6px,1.8cqmin,24px)]">
                <span className="text-[clamp(10px,2.4cqmin,40px)] text-white/60 w-[clamp(20px,4cqmin,72px)] text-right font-mono uppercase">
                  {day}
                </span>
                <div className="grid flex-1 grid-cols-[repeat(24,minmax(0,1fr))] gap-[var(--layout-heatmap-cell-gap)]">
                  {Array.from({ length: 24 }).map((_, col) => {
                    const heatmapData = hourlyHeatmap?.[row]?.[col] ?? 0;
                    let intensity = 0;
                    if (heatmapData > 0 && heatmapStats.max > 0) {
                      const normalized = heatmapData / heatmapStats.max;
                      intensity = Math.min(5, Math.max(1, Math.ceil(normalized * 5)));
                    }

                    return (
                      <div
                        key={col}
                        className={cn(
                          // No `cursor-pointer`: nothing here is clickable, and a
                          // pointer cursor promises an interaction that does not exist.
                          'aspect-square w-full rounded-scanner-xs ring-white/50 transition-all hover:ring-1',
                          HEATMAP_INTENSITY_CLASSES[intensity],
                        )}
                        title={`${day} ${col}:00 - ${heatmapData} hits`}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div
            aria-hidden="true"
            className="flex justify-between text-[clamp(10px,2.4cqmin,40px)] text-white/60 mt-1 pl-[clamp(20px,4.5cqmin,80px)]"
          >
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
          {/* Visually hidden, not display:none -- `sr-only` keeps it in the
            accessibility tree. A table rather than a paragraph so a screen
            reader announces "Tue, 18:00, 4 hits" as it moves, instead of
            reading 168 bare numbers in a row. */}
          <table className="sr-only">
            <caption>{summarizeHeatmap(hourlyHeatmap ?? [])}</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                {Array.from({ length: 24 }, (_, hour) => (
                  <th key={hour} scope="col">{`${String(hour).padStart(2, '0')}:00`}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {HEATMAP_DAY_LABELS.map((day, row) => (
                <tr key={day}>
                  <th scope="row">{day}</th>
                  {Array.from({ length: 24 }, (_, col) => (
                    <td key={col}>{hourlyHeatmap?.[row]?.[col] ?? 0}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>
    </motion.div>
  );
}
