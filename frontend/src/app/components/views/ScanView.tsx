import { motion } from 'motion/react';
import { Activity, Clock, FileText, Play, Radio, Signal } from 'lucide-react';
import { useMemo } from 'react';
import { BarChart, Bar, LabelList, ResponsiveContainer, XAxis } from 'recharts';
import { cn } from '../../../lib/utils';
import { useStore } from '../../../store/useStore';
import type { ConnectionStatus } from '../../../hooks/useConnectionStatus';
import type { BusiestChannel, HeatmapStats } from '../../../hooks/useDashboardAnalytics';
import { BankControls, ScannerDisplay, StatusHeader } from '../ScannerUI';
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
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function normalizeSignal(value?: number) {
  if (value === undefined || value === null) return 0;
  if (value <= 5) return Math.round(value);
  return Math.min(5, Math.round(value / 20));
}

function SignalBars({ strength }: { strength: number }) {
  return (
    <>
      {[1, 2, 3, 4, 5].map((bar) => (
        <span
          key={bar}
          className={cn(
            'h-2 w-1 rounded-scanner-xs',
            bar <= strength ? 'bg-green-500' : 'bg-white/10',
          )}
        />
      ))}
    </>
  );
}

export interface ScanViewProps {
  mainText: string;
  subText: string;
  scannerMode: ScannerMode;
  connectionStatus: ConnectionStatus;
  isHolding: boolean;
  isInitialSyncing: boolean;
  syncProgressMessage: string;
  chartAnimate: boolean;
  dashboardLoading: boolean;
  busiestChannels: BusiestChannel[];
  hourlyHeatmap: number[][];
  heatmapStats: HeatmapStats;
  onHoldToggle: () => void;
  onLockout: (type: 'temporary' | 'permanent') => void;
  onVolumeChange: (value: number) => void;
  onBankToggle: (index: number) => void;
  onCancelSync: () => void;
  onOpenActivityExport: () => void;
}

export function ScanView({
  mainText,
  subText,
  scannerMode,
  connectionStatus,
  isHolding,
  isInitialSyncing,
  syncProgressMessage,
  chartAnimate,
  dashboardLoading,
  busiestChannels,
  hourlyHeatmap,
  heatmapStats,
  onHoldToggle,
  onLockout,
  onVolumeChange,
  onBankToggle,
  onCancelSync,
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
        frequency: entry.frequency.toFixed(4),
        tag: entry.alpha_tag || '—',
        strength: normalizeSignal(entry.rssi),
        time: entry.timestamp,
        hasAudio: entry.hasAudio ?? false,
        channel: entry.channel ?? null,
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
      <div className="flex h-[var(--layout-dashboard-main-height)] gap-6 transition-all duration-500 ease-in-out">
        <div
          className={cn(
            'flex flex-col gap-3 h-full transition-all duration-500 ease-in-out',
            'w-[var(--layout-dashboard-panel-width)]',
          )}
        >
          <StatusHeader
            volume={liveState?.volume ?? 0}
            onVolumeChange={onVolumeChange}
            isHolding={isHolding}
            onHoldToggle={onHoldToggle}
            onLockout={onLockout}
          />
          <ScannerDisplay
            mainText={mainText}
            subText={subText}
            mode={scannerMode}
            signalStrength={signalStrength}
            isScanning={isScanningRightNow}
            isError={isError}
            errorType={errorType}
            variant="default"
            className="flex-1 min-h-0 mb-3"
          />
          {isInitialSyncing && (
            <div className="mb-3 flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-scanner-text-secondary">
              <span>{syncProgressMessage || 'Loading channels from device...'}</span>
              <button
                type="button"
                onClick={onCancelSync}
                className="rounded-md border border-white/15 bg-white/10 px-2 py-1 text-scanner-text-light transition-colors hover:bg-white/20"
              >
                Cancel Sync
              </button>
            </div>
          )}
          <BankControls activeBanks={banks} onToggleBank={onBankToggle} />
        </div>

        {/* Recent Hits */}
        <div className="flex-1 bg-black/20 rounded-lg border border-white/5 p-4 overflow-hidden flex flex-col">
          <h3 className="font-bold text-sm mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-brand-primary" />
              <span>Recent Hits</span>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenActivityExport}
                  disabled={fullActivityLog.length === 0}
                  className={cn(
                    'ml-auto inline-flex items-center justify-center rounded-scanner-sm border border-white/10 bg-white/5 px-2 py-1 text-white/80 hover:text-white hover:bg-white/10 hover:border-white/20 transition-colors',
                    fullActivityLog.length === 0 && 'opacity-50 cursor-not-allowed',
                  )}
                  aria-label="Export activity log"
                >
                  <FileText size={14} />
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
          </h3>
          <div className="flex-1 overflow-y-auto pr-1 space-y-2">
            {recentHits.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-white/20 text-xs italic gap-2">
                <Activity className="w-8 h-8 opacity-20" />
                Waiting for signals...
              </div>
            ) : (
              recentHits.map((hit) => (
                <div
                  key={hit.id}
                  className="flex items-center text-xs py-1 px-2 hover:bg-white/5 rounded cursor-pointer group gap-2"
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {hit.hasAudio && (
                      <Play className="h-3 w-3 shrink-0 fill-brand-primary/20 text-brand-primary" />
                    )}
                    <span className="text-white/60 truncate" title={hit.tag}>
                      {hit.tag}
                    </span>
                  </div>
                  <div className="flex gap-0.5 h-2 items-end">
                    <SignalBars strength={hit.strength} />
                  </div>
                  <span className="w-[var(--size-hit-frequency-width)] text-right font-mono text-brand-light group-hover:text-brand-primary">
                    {hit.frequency}
                  </span>
                  <span className="w-[var(--size-hit-time-width)] whitespace-nowrap text-right text-xs text-white/30">
                    {getRelativeTime(hit.time)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Dashboard Widgets - Appear Below */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex-1 min-h-0 flex gap-6 overflow-hidden"
      >
        {/* Busiest Channels */}
        <div className="flex-1 min-h-0 bg-black/20 rounded-lg border border-white/5 p-4 flex flex-col">
          <h3 className="font-bold text-sm mb-3 flex items-center gap-2">
            <Signal className="w-4 h-4 text-blue-400" /> Busiest Channels
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
          <h3 className="font-bold text-sm mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4 text-green-400" /> Activity Heatmap
          </h3>
          <div className="flex flex-1 flex-col justify-center gap-[var(--layout-heatmap-cell-gap)]">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, row) => (
              <div key={day} className="flex items-center gap-2">
                <span className="text-xs text-white/30 w-5 text-right font-mono uppercase">
                  {day}
                </span>
                <div className="grid flex-1 grid-cols-[repeat(24,minmax(0,1fr))] gap-[var(--layout-heatmap-cell-gap)]">
                  {Array.from({ length: 24 }).map((_, col) => {
                    const heatmapData = hourlyHeatmap?.[row]?.[col] ?? 0;
                    let intensity = 0;
                    if (heatmapStats.max > heatmapStats.min) {
                      const normalized =
                        (heatmapData - heatmapStats.min) / (heatmapStats.max - heatmapStats.min);
                      intensity = Math.min(5, Math.floor(normalized * 5));
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
          <div className="flex justify-between text-xs text-white/30 mt-1 pl-7">
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
