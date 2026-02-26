import { useState } from "react";
import { X, Download, Calendar, Trash2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { cn } from "../../../lib/utils";
import { useAPI } from "../../../api/useApi";

interface ActivityExportSheetProps {
  isOpen: boolean;
  onClose: () => void;
  hasActivity: boolean;
}

type Timeframe = "today" | "week" | "month" | "all" | "custom";

function getUnixTime(date: Date | null): number {
  if (!date) return 0;
  return Math.floor(date.getTime() / 1000);
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

export function ActivityExportSheet({ isOpen, onClose, hasActivity }: ActivityExportSheetProps) {
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>("today");
  const [customStartDate, setCustomStartDate] = useState<Date | null>(null);
  const [customEndDate, setCustomEndDate] = useState<Date | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const api = useAPI();

  const getTimeframeLabel = (timeframe: Timeframe): string => {
    switch (timeframe) {
      case "today":
        return "Today";
      case "week":
        return "This Week";
      case "month":
        return "This Month";
      case "all":
        return "All Time";
      case "custom":
        return "Custom Range";
      default:
        return timeframe;
    }
  };

  const buildQueryParams = (): URLSearchParams => {
    const params = new URLSearchParams();

    switch (selectedTimeframe) {
      case "today":
        params.append("start_time", String(getStartOfToday()));
        break;
      case "week":
        params.append("start_time", String(getStartOfWeek()));
        break;
      case "month":
        params.append("start_time", String(getStartOfMonth()));
        break;
      case "all":
        break;
      case "custom":
        params.append("start_time", String(getUnixTime(customStartDate)));
        params.append("end_time", String(getUnixTime(customEndDate)));
        break;
    }

    return params;
  };

  const generateFilename = (): string => {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    return `activity-log-${date}.csv`;
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const params = buildQueryParams();
      const response = await fetch(`/api/v1/analytics/activity-log?${params.toString()}`);

      if (!response.ok) {
        throw new Error("Failed to export activity log");
      }

      const data = await response.json();
      const header = ["timestamp", "frequency", "tag", "channel", "rssi", "duration"].join(",");
      const rows = data.map((entry: any) => {
        const timestamp = new Date(entry.timestamp * 1000).toISOString();
        const frequency = entry.frequency.toFixed(4);
        const tag = entry.alpha_tag ?? "";
        const channel = entry.channel ?? "";
        const rssi = entry.rssi ?? "";
        const duration = entry.duration ?? "";
        return [timestamp, frequency, `"${tag.replace(/"/g, '""')}"`, channel, rssi, duration].join(",");
      });

      const csv = [header, ...rows].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = generateFilename();
      link.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch (error) {
      console.error("Failed to export activity log", error);
    } finally {
      setIsExporting(false);
    }
  };

  const handleCleanup = async () => {
    setIsExporting(true);
    try {
      await api.cleanupAnalytics();
      toast.success("Analytics data cleaned up");
    } catch (error) {
      console.error("Failed to cleanup analytics", error);
      toast.error("Failed to cleanup analytics");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 z-50"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%", opacity: 0 }}
            animate={{ y: "0%", opacity: 1 }}
            exit={{ y: "100%", opacity: 0 }}
            transition={{
              type: "spring",
              damping: 25,
              stiffness: 300,
            }}
            className="scanner-modal w-[var(--layout-modal-activity-width)] rounded-t-xl"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <h3 className="text-lg font-bold text-white">Export Activity Log</h3>
              <button
                onClick={onClose}
                aria-label="Close"
                className="text-white/50 hover:text-white transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              <div className="space-y-3">
                <label className="text-xs font-medium text-white/70 uppercase tracking-wider">Select timeframe</label>
                <div className="grid grid-cols-2 gap-2">
                  {(["today", "week", "month", "all", "custom"] as Timeframe[]).map((timeframe) => (
                    <button
                      key={timeframe}
                      onClick={() => setSelectedTimeframe(timeframe)}
                      className={cn(
                        "flex items-center gap-2 px-4 py-3 rounded text-sm font-medium transition-colors",
                        selectedTimeframe === timeframe
                          ? "border border-brand-primary/30 bg-brand-primary/20 text-brand-primary"
                          : "scanner-button-muted border"
                      )}
                    >
                      <Calendar size={16} />
                      {getTimeframeLabel(timeframe)}
                    </button>
                  ))}
                </div>
              </div>

              {selectedTimeframe === "custom" && (
                <div className="space-y-4 border-t border-white/10 pt-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label htmlFor="activity-export-start-date" className="text-xs font-medium text-white/70">
                        Start Date
                      </label>
                      <input
                        id="activity-export-start-date"
                        type="date"
                        value={customStartDate ? customStartDate.toISOString().slice(0, 10) : ""}
                        onChange={(e) => setCustomStartDate(e.target.value ? new Date(e.target.value) : null)}
                        className="scanner-input w-full px-3 py-2 text-sm"
                      />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="activity-export-end-date" className="text-xs font-medium text-white/70">
                        End Date
                      </label>
                      <input
                        id="activity-export-end-date"
                        type="date"
                        value={customEndDate ? customEndDate.toISOString().slice(0, 10) : ""}
                        onChange={(e) => setCustomEndDate(e.target.value ? new Date(e.target.value) : null)}
                        className="scanner-input w-full px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-white/10 shrink-0 space-y-3">
              <button
                onClick={handleExport}
                disabled={!hasActivity || isExporting}
                className="scanner-button-primary flex w-full items-center justify-center gap-2 py-3 text-sm uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download size={16} />
                {isExporting ? "Exporting..." : "Download CSV"}
              </button>
              <button
                onClick={handleCleanup}
                disabled={isExporting}
                className="flex w-full items-center justify-center gap-2 rounded border border-destructive bg-destructive py-3 text-sm font-bold uppercase tracking-wider text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 size={16} />
                {isExporting ? "Cleaning..." : "Cleanup Analytics"}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
