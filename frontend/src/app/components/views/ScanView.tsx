import { motion } from 'motion/react';
import { Clock, FileText, Radio, Signal } from 'lucide-react';
import { useMemo } from 'react';
import { BarChart, Bar, LabelList, ResponsiveContainer, XAxis } from 'recharts';
import { cn } from '../../../lib/utils';
import { useStore } from '../../../store/useStore';
import type { ConnectionStatus } from '../../../hooks/useConnectionStatus';
import type { BusiestChannel, HeatmapStats } from '../../../hooks/useDashboardAnalytics';
import { ScannerDisplay } from '../ScannerUI';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { ScannerMode } from '../../App';

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

function normalizeSignal(value?: number) {
  if (value === undefined || value === null) return 0;
  if (value <= 5) return Math.round(value);
  return Math.min(5, Math.round(value / 20));
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

/** Fixed five-row layout — the most recent five hits always occupy the
 *  list region. Each slot flex-1 to share the height evenly; empty
 *  slots remain in place so the layout doesn't reflow when a hit
 *  arrives and the oldest entry rotates out. */
const HIT_SLOT_COUNT = 5;

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
  onHoldToggle: () => void;
  onLockout: (type: 'temporary' | 'permanent') => void;
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
  onHoldToggle,
  onLockout,
  onVolumeChange,
  onBankToggle,
  onOpenActivityExport,
}: ScanViewProps) {
  const liveState = useStore((state) => state.liveState);
  const activityLog = useStore((state) => state.activityLog);
  const fullActivityLog = useStore((state) => state.fullActivityLog);
  const banks = useStore((state) => state.banks);

  const recentHits = useMemo(
    () =>
      activityLog.map((entry) => ({
        id: entry.id,
        frequency: entry.frequency.toFixed(3),
        tag: entry.alpha_tag || '—',
        strength: normalizeSignal(entry.rssi),
        time: entry.timestamp,
      })),
    [activityLog],
  );

  const isScanningRightNow =
    !isInitialSyncing && liveState?.mode === 'SCAN' && !liveState?.squelch_open;
  const signalStrength = normalizeSignal(liveState?.rssi);
  const isError = connectionStatus === 'disconnected';
  const errorType = isError ? 'usb' : undefined;

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
        <div className="shrink-0 self-stretch w-1/2">
          <ScannerDisplay
            mainText={mainText}
            subText={subText}
            signalStrength={signalStrength}
            isScanning={isScanningRightNow}
            isError={isError}
            errorType={errorType}
            volume={liveState?.volume ?? 0}
            isHolding={isHolding}
            onVolumeChange={onVolumeChange}
            onHoldToggle={onHoldToggle}
            onLockout={onLockout}
            banks={banks}
            onBankToggle={onBankToggle}
          />
        </div>

        {/* Recent Hits */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col gap-[clamp(32px,3cqmin,60px)] self-stretch py-[10px]">
          <div className="flex shrink-0 items-center justify-between border-b border-white/10 pb-[clamp(6px,1.8cqmin,28px)]">
            <div className="flex items-center gap-[clamp(6px,1.8cqmin,24px)]">
              <Radio className="size-[clamp(14px,3cqmin,52px)] text-brand-primary" />
              <h3 className="font-display font-bold text-[clamp(13px,3.5cqmin,56px)] text-scanner-text-light">
                Recent Hits
              </h3>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenActivityExport}
                  disabled={fullActivityLog.length === 0}
                  className={cn(
                    'inline-flex items-center justify-center rounded-scanner-xs border border-white/10 bg-white/5 text-white/80 transition-colors hover:bg-white/10 hover:border-white/20 hover:text-white',
                    'h-[clamp(20px,4.5cqmin,72px)] w-[clamp(24px,5cqmin,84px)]',
                    fullActivityLog.length === 0 && 'opacity-50 cursor-not-allowed',
                  )}
                  aria-label="Export activity log"
                >
                  <FileText className="size-[clamp(12px,2.5cqmin,40px)]" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                align="center"
                className="scanner-select-content"
                arrowClassName="bg-background fill-background"
              >
                Export
              </TooltipContent>
            </Tooltip>
          </div>
          {recentHits.length === 0 ? (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 pr-2 text-white/20 text-[clamp(11px,3cqmin,52px)] italic">
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
            // Rows are sized `auto` (content height) and the grid uses
            // `align-content: space-between` so the first hit sits at the
            // top of the list, the last hit sits flush against the bottom
            // (which aligns with the Display panel's bank row beside it),
            // and the middle hits are spaced evenly between. The minimum
            // `gap-y` keeps a small floor when the panel is short.
            <div className="grid flex-1 min-h-0 grid-cols-[minmax(14ch,max-content)_auto_minmax(0,1fr)_auto] grid-rows-[repeat(5,auto)] content-between gap-x-[clamp(12px,3.5cqmin,60px)] gap-y-[clamp(2px,1.4cqmin,20px)] pr-2 text-[clamp(13px,5cqmin,72px)]">
              {Array.from({ length: HIT_SLOT_COUNT }, (_, idx) => {
                const hit = recentHits[idx];
                if (!hit) {
                  return <div key={`empty-${idx}`} className="col-span-4" aria-hidden="true" />;
                }
                return (
                  <div
                    key={hit.id}
                    className="col-span-4 grid grid-cols-subgrid items-center rounded-[4px] px-[clamp(2px,1cqmin,12px)] hover:bg-white/5"
                  >
                    <span className="whitespace-nowrap text-white/30">
                      {getRelativeTime(hit.time)}
                    </span>
                    <span className="whitespace-nowrap text-right font-mono text-brand-light">
                      {hit.frequency}
                    </span>
                    <span className="whitespace-nowrap text-white/60" title={hit.tag}>
                      {hit.tag}
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
          <h3 className="font-display font-bold text-[clamp(14px,3cqmin,56px)] mb-[clamp(8px,2cqmin,32px)] flex items-center gap-[clamp(6px,1.8cqmin,24px)]">
            <Signal className="size-[clamp(14px,3cqmin,52px)] text-blue-400" /> Busiest Channels
          </h3>
          {dashboardLoading ? (
            <div className="flex-1 flex items-center justify-center text-white/20 text-xs">
              Loading...
            </div>
          ) : busiestChannels.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-white/20 text-xs italic">
              No data yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={busiestChannels}>
                <XAxis
                  dataKey="alpha_tag"
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
          <h3 className="font-display font-bold text-[clamp(14px,3cqmin,56px)] mb-[clamp(8px,2cqmin,32px)] flex items-center gap-[clamp(6px,1.8cqmin,24px)]">
            <Clock className="size-[clamp(14px,3cqmin,52px)] text-green-400" /> Activity Heatmap
          </h3>
          <div className="flex flex-1 flex-col justify-center gap-[var(--layout-heatmap-cell-gap)]">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, row) => (
              <div key={day} className="flex items-center gap-[clamp(6px,1.8cqmin,24px)]">
                <span className="text-[clamp(10px,2.4cqmin,40px)] text-white/30 w-[clamp(20px,4cqmin,72px)] text-right font-mono uppercase">
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
                          'aspect-square w-full cursor-pointer rounded-scanner-xs ring-white/50 transition-all hover:ring-1',
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
          <div className="flex justify-between text-[clamp(10px,2.4cqmin,40px)] text-white/30 mt-1 pl-[clamp(20px,4.5cqmin,80px)]">
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
