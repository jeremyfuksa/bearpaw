import { useState } from 'react';
import { Download, Calendar } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { cn } from '../../../lib/utils';
import { API_BASE } from '../../../api/useApi';
import { saveExport } from '../../../tauri-shell';
import { useStore } from '../../../store/useStore';

interface ActivityExportSheetProps {
  isOpen: boolean;
  onClose: () => void;
  hasActivity: boolean;
}

type Timeframe = 'today' | 'week' | 'month' | 'all' | 'custom';

export type ExportTimezone = 'local' | 'utc';

// The backend applies no hard cap on `limit` (analytics.rs defaults to 100 when
// omitted), so request a high ceiling to avoid silently truncating "All Time".
const EXPORT_ROW_LIMIT = 100000;

// The <input type="date"> onChange stores `new Date('YYYY-MM-DD')`, which JS
// parses as UTC midnight. Read the calendar day back via the UTC accessors and
// re-anchor it to the local day so the exported range matches what the user saw.
function getCustomStartTime(date: Date | null): number | null {
  if (!date) return null;
  const start = new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0);
  return Math.floor(start.getTime() / 1000);
}

function getCustomEndTime(date: Date | null): number | null {
  if (!date) return null;
  // End of the selected day (inclusive) so the end day's hits aren't dropped.
  const end = new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59);
  return Math.floor(end.getTime() / 1000);
}

function getStartOfToday(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(start.getTime() / 1000);
}

function getStartOfWeek(): number {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const start = new Date(now.getFullYear(), now.getMonth(), diff);
  return Math.floor(start.getTime() / 1000);
}

function getStartOfMonth(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return Math.floor(start.getTime() / 1000);
}

// Every timeframe boundary above is built from LOCAL calendar accessors, so
// "Today" already means the user's today. The rows it selected were then
// stamped with toISOString(), which is always UTC — so a Pacific user's
// "today" export carried tomorrow's dates (#498). Output now agrees with the
// selection that produced it.
//
// ISO 8601 with an explicit offset rather than a bare local wall-clock: it
// reads as local time AND still names the instant, so an export shared across
// zones, or read back later, is never ambiguous about which moment it means.
function pad(value: number, width = 2): string {
  return String(Math.trunc(Math.abs(value))).padStart(width, '0');
}

/** The viewer's UTC offset as `+HH:MM`, for both the stamp and its UI label. */
export function localOffsetLabel(date: Date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  return `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
}

// Exported for tests (#498). Asserting the format through the component would
// only ever prove the runner's own zone, and a hand-rolled copy in the test
// file would pass whether or not it matched what the export actually writes —
// the same trap `buildEmptyDraft` documents in ChannelsTab.
//
// UTC is offered because amateur radio logs in it by convention, so `Z` rather
// than `+00:00`: Zulu is the spelling that audience reads. Both modes drop
// milliseconds. Hits are second-resolution and the extra digits are noise in a
// log a person reads.
export function formatExportTimestamp(date: Date, timezone: ExportTimezone = 'local'): string {
  if (timezone === 'utc') {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${localOffsetLabel(date)}`
  );
}

// Same defect, second site: the filename dated the export in UTC, so exporting
// after 4pm Pacific produced a file named for tomorrow.
// It follows the same preference, so the filename never disagrees with the
// rows inside it.
export function formatExportDate(date: Date, timezone: ExportTimezone = 'local'): string {
  if (timezone === 'utc') {
    return date.toISOString().slice(0, 10);
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function ActivityExportSheet({ isOpen, onClose, hasActivity }: ActivityExportSheetProps) {
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>('today');
  const [customStartDate, setCustomStartDate] = useState<Date | null>(null);
  const [customEndDate, setCustomEndDate] = useState<Date | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const exportTimezone = useStore((state) => state.preferences.activityExportTimezone);
  const updatePreferences = useStore((state) => state.updatePreferences);

  // Written straight through rather than reusing DeviceTab's
  // handlePreferenceChange: that one is a closure over its own component. The
  // backend key must match PREFERENCE_KEY_MAP's entry, and App.tsx must read
  // the same key back on load, or the choice survives only this session.
  const setExportTimezone = async (timezone: ExportTimezone) => {
    updatePreferences({ activityExportTimezone: timezone });
    try {
      await fetch(`${API_BASE}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_export_timezone: timezone }),
      });
    } catch (error) {
      console.error('Failed to save preference', error);
      toast.error('Failed to save timestamp preference');
    }
  };

  const getTimeframeLabel = (timeframe: Timeframe): string => {
    switch (timeframe) {
      case 'today':
        return 'Today';
      case 'week':
        return 'This Week';
      case 'month':
        return 'This Month';
      case 'all':
        return 'All Time';
      case 'custom':
        return 'Custom Range';
      default:
        return timeframe;
    }
  };

  const buildQueryParams = (): URLSearchParams => {
    const params = new URLSearchParams();

    switch (selectedTimeframe) {
      case 'today':
        params.append('start_time', String(getStartOfToday()));
        break;
      case 'week':
        params.append('start_time', String(getStartOfWeek()));
        break;
      case 'month':
        params.append('start_time', String(getStartOfMonth()));
        break;
      case 'all':
        break;
      case 'custom': {
        // Only append bounds that are actually set. An unset date falls back to
        // the full range on that side (backend defaults start=0 / end=MAX)
        // instead of collapsing to start_time=0&end_time=0 (empty CSV).
        const start = getCustomStartTime(customStartDate);
        const end = getCustomEndTime(customEndDate);
        if (start !== null) params.append('start_time', String(start));
        if (end !== null) params.append('end_time', String(end));
        break;
      }
    }

    // Always request a high row ceiling so exports aren't capped at the
    // backend's default of 100 rows.
    params.append('limit', String(EXPORT_ROW_LIMIT));

    return params;
  };

  const generateFilename = (): string => {
    const date = formatExportDate(new Date(), exportTimezone);
    return `activity-log-${date}.csv`;
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const params = buildQueryParams();
      const response = await fetch(`${API_BASE}/analytics/activity-log?${params.toString()}`);

      if (!response.ok) {
        throw new Error('Failed to export activity log');
      }

      const data = await response.json();
      const header = ['timestamp', 'frequency', 'tag', 'channel', 'rssi', 'duration'].join(',');
      const rows = data.map((entry: any) => {
        const timestamp = formatExportTimestamp(new Date(entry.timestamp * 1000), exportTimezone);
        const frequency = entry.frequency.toFixed(4);
        const tag = entry.alpha_tag ?? '';
        const channel = entry.channel ?? '';
        const rssi = entry.rssi ?? '';
        const duration = entry.duration ?? '';
        return [timestamp, frequency, `"${tag.replace(/"/g, '""')}"`, channel, rssi, duration].join(
          ',',
        );
      });

      const csv = [header, ...rows].join('\n');
      const bytes = new TextEncoder().encode(csv);
      const where = await saveExport(generateFilename(), bytes);
      if (where !== 'cancelled') {
        toast.success(where === 'saved' ? 'Activity log saved' : 'Activity log exported');
      }
      onClose();
    } catch (error) {
      console.error('Failed to export activity log', error);
      toast.error('Failed to export activity log');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* Radix Dialog supplies role="dialog", aria-modal, focus trap + restore,
          and Escape-to-close (a11y C1–C4). Neutralizing utilities override
          DialogContent's own grid/padding/sm:max-w-lg so scanner-modal wins. */}
      <DialogContent className="scanner-modal w-[var(--layout-modal-activity-width)] max-w-none translate-x-[-50%] translate-y-[-50%] gap-0 rounded-t-xl border-white/10 p-0">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <DialogTitle className="text-lg font-bold text-white">Export Activity Log</DialogTitle>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="space-y-3">
            <label className="text-xs font-medium text-white/70 uppercase tracking-wider">
              Select timeframe
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(['today', 'week', 'month', 'all', 'custom'] as Timeframe[]).map((timeframe) => (
                <button
                  key={timeframe}
                  onClick={() => setSelectedTimeframe(timeframe)}
                  className={cn(
                    'flex items-center gap-2 px-4 py-3 rounded text-sm font-medium transition-colors',
                    selectedTimeframe === timeframe
                      ? 'border border-brand-primary/30 bg-brand-primary/20 text-brand-primary'
                      : 'scanner-button-muted border',
                  )}
                >
                  <Calendar size={20} aria-hidden />
                  {getTimeframeLabel(timeframe)}
                </button>
              ))}
            </div>
          </div>

          {selectedTimeframe === 'custom' && (
            <div className="space-y-4 border-t border-white/10 pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label
                    htmlFor="activity-export-start-date"
                    className="text-xs font-medium text-white/70"
                  >
                    Start Date
                  </label>
                  <input
                    id="activity-export-start-date"
                    type="date"
                    value={customStartDate ? customStartDate.toISOString().slice(0, 10) : ''}
                    onChange={(e) =>
                      setCustomStartDate(e.target.value ? new Date(e.target.value) : null)
                    }
                    className="scanner-input w-full px-3 py-2 text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="activity-export-end-date"
                    className="text-xs font-medium text-white/70"
                  >
                    End Date
                  </label>
                  <input
                    id="activity-export-end-date"
                    type="date"
                    value={customEndDate ? customEndDate.toISOString().slice(0, 10) : ''}
                    onChange={(e) =>
                      setCustomEndDate(e.target.value ? new Date(e.target.value) : null)
                    }
                    className="scanner-input w-full px-3 py-2 text-sm"
                  />
                </div>
              </div>
            </div>
          )}

          <div className="space-y-3 border-t border-white/10 pt-4">
            <span
              id="activity-export-tz-label"
              className="block text-xs font-medium uppercase tracking-wider text-white/70"
            >
              Timestamps
            </span>
            <div
              className="grid grid-cols-2 gap-2"
              role="group"
              aria-labelledby="activity-export-tz-label"
            >
              {(['local', 'utc'] as ExportTimezone[]).map((timezone) => (
                <button
                  key={timezone}
                  type="button"
                  aria-pressed={exportTimezone === timezone}
                  onClick={() => void setExportTimezone(timezone)}
                  className={cn(
                    'flex items-center justify-center gap-2 rounded px-4 py-3 text-sm font-medium transition-colors',
                    exportTimezone === timezone
                      ? 'border border-brand-primary/30 bg-brand-primary/20 text-brand-primary'
                      : 'scanner-button-muted border',
                  )}
                >
                  {timezone === 'local' ? `Local time ${localOffsetLabel()}` : 'UTC'}
                </button>
              ))}
            </div>
            <p className="text-xs text-white/50">
              Changes how rows are stamped, not which rows are included.
            </p>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-white/10 shrink-0 space-y-3">
          <button
            type="button"
            onClick={handleExport}
            disabled={!hasActivity || isExporting}
            aria-busy={isExporting}
            className="scanner-button-primary flex w-full items-center justify-center gap-2 py-3 text-sm uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={20} aria-hidden="true" />
            {isExporting ? 'Exporting...' : 'Download CSV'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
