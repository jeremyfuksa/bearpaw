import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { motion } from "motion/react";
import {
  Radio,
  Settings,
  Plus,
  Minus,
  Save,
  RotateCcw,
} from "lucide-react";

import { cn } from "../../../lib/utils";
import { useAPI } from "../../../api/useApi";
import { useStore } from "../../../store/useStore";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type SearchCategory = "Service Search" | "Custom Search";

interface SearchRange {
  id: number;
  enabled: boolean;
  label: string;
  start: string;
  end: string;
}

export function SearchTab() {
  const api = useAPI();
  const liveState = useStore((state) => state.liveState);

  const [selectedCategory, setSelectedCategory] = useState<SearchCategory>("Service Search");

  // Service Search settings
  const [serviceSearchGroups, setServiceSearchGroups] = useState<boolean[]>([]);

  // Custom Search settings and ranges
  const [searchRanges, setSearchRanges] = useState<SearchRange[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRanges, setSelectedRanges] = useState<number[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const settingsLoadedRef = useRef(false);

  // Load search settings on mount
  useEffect(() => {
    if (settingsLoadedRef.current) {
      return;
    }

    let active = true;
    const loadSearchSettings = async () => {
      try {
        const [serviceSearchData, customSearchData, customSearchRanges] = await Promise.all([
          api.getServiceSearchSettings(),
          api.getCustomSearchSettings(),
          Promise.all(Array.from({ length: 10 }, (_, i) => api.getCustomSearchRange(i))),
        ]);

        if (!active) return;

        // Load service search settings
        setServiceSearchGroups(serviceSearchData.groups);

        // Load custom search settings
        const defaultLabels = [
          "VHF Low", "Civil Air", "VHF High", "UHF Air", "UHF",
          "800 MHz", "Range 7", "Range 8", "Range 9", "Range 10"
        ];

        setSearchRanges(customSearchRanges.map((r, idx) => ({
          id: r.index,
          enabled: customSearchData.groups[idx] || false,
          label: defaultLabels[idx] || `Range ${r.index}`,
          start: r.lower.toFixed(4),
          end: r.upper.toFixed(4),
        })));

        settingsLoadedRef.current = true;
      } catch (error) {
        console.error("Failed to load search settings", error);
        toast.error("Failed to load search settings");
      }
    };

    loadSearchSettings();

    return () => {
      active = false;
    };
  }, [api]);

  const toggleAllSelected = useCallback(
    (checked: boolean) => {
      setSelectedRanges(checked ? searchRanges.map(r => r.id) : []);
    },
    [searchRanges],
  );

  const toggleSelection = useCallback((rangeId: number) => {
    setSelectedRanges((prev) =>
      prev.includes(rangeId)
        ? prev.filter((value) => value !== rangeId)
        : [...prev, rangeId],
    );
  }, []);

  const handleServiceSearchToggle = useCallback(async (index: number) => {
    const newGroups = [...serviceSearchGroups];
    newGroups[index] = !newGroups[index];
    setServiceSearchGroups(newGroups);

    try {
      await api.setServiceSearchSettings(newGroups);
      toast.success("Service search updated");
    } catch (error) {
      console.error("Failed to update service search", error);
      toast.error("Failed to update service search");
      setServiceSearchGroups(serviceSearchGroups);
    }
  }, [api, serviceSearchGroups]);

  const handleCustomSearchToggle = useCallback(async (index: number) => {
    const newRanges = [...searchRanges];
    newRanges[index] = { ...newRanges[index], enabled: !newRanges[index].enabled };
    setSearchRanges(newRanges);

    const groups = newRanges.map(r => r.enabled);
    try {
      await api.setCustomSearchSettings(groups);
      toast.success("Custom search updated");
    } catch (error) {
      console.error("Failed to update custom search", error);
      toast.error("Failed to update custom search");
      setSearchRanges(searchRanges);
    }
  }, [api, searchRanges]);

  const updateRange = useCallback(async (id: number, field: "start" | "end", value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) || num < 0) {
      return;
    }

    const newRanges = searchRanges.map((r) =>
      r.id === id ? { ...r, [field]: value } : r
    );
    setSearchRanges(newRanges);

    const range = newRanges.find(r => r.id === id);
    if (range) {
      try {
        const startVal = parseFloat(range.start);
        const endVal = parseFloat(range.end);
        if (isNaN(startVal) || isNaN(endVal)) {
          console.error("Invalid frequency range");
          return;
        }
        await api.setCustomSearchRange(id, startVal, endVal);
      } catch (error) {
        console.error("Failed to update search range", error);
        toast.error("Failed to update search range");
      }
    }
  }, [api, searchRanges]);

  const filteredRanges = useMemo(() => {
    if (!searchTerm) return searchRanges;
    return searchRanges.filter(r =>
      r.label.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.start.includes(searchTerm) ||
      r.end.includes(searchTerm)
    );
  }, [searchRanges, searchRanges]);

  const activeRangeCount = searchRanges.filter((r) => r.enabled).length;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex h-full gap-6"
    >
      {/* Side Nav */}
      <div className="w-[200px] flex flex-col gap-1 bg-black/20 rounded-lg p-2 border border-white/5 h-full">
        {["Service Search", "Custom Search"].map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat as SearchCategory)}
            className={cn(
              "text-left px-3 py-2 rounded text-xs font-medium transition-colors",
              selectedCategory === cat
                ? "bg-brand-hover/20 text-brand-hover"
                : "text-white/60 hover:bg-white/5 hover:text-white",
            )}
          >
            {cat}
          </button>
        ))}
        <div className="mt-2 border-t border-white/10" />
      </div>

      {/* Content */}
      <div className="flex-1 bg-black/20 rounded-lg border border-white/10 p-6 h-full overflow-y-auto">
        <h2 className="text-lg font-bold mb-6 border-b border-white/10 pb-2">
          {selectedCategory}
          {selectedCategory === "Custom Search" && (
            <span className="text-xs font-normal text-white/50 ml-2">
              {activeRangeCount} of 10 active
            </span>
          )}
        </h2>

        {/* Service Search */}
        {selectedCategory === "Service Search" && (
          <div className="space-y-4 max-w-3xl">
            <div className="bg-white/5 rounded-lg border border-white/10 p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded bg-brand-primary/10 text-brand-primary border border-brand-primary/20">
                  <Radio size={20} />
                </div>
                <div>
                  <h3 className="font-bold text-white text-sm">Service Search</h3>
                  <p className="text-xs text-white/60 mt-1">
                    Scan predefined service bands (Police, Fire, EMS, etc.)
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                <p className="text-sm text-white/70">Select service groups to scan:</p>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    "Police", "Fire", "EMS", "Air", "Ham", "Marine",
                    "Railroad", "CB", "Racing", "TV Broadcast", "Weather"
                  ].map((service, idx) => (
                    <button
                      key={service}
                      onClick={() => handleServiceSearchToggle(idx)}
                      className={cn(
                        "flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-all",
                        serviceSearchGroups[idx]
                          ? "bg-brand-primary/20 text-brand-primary border border-brand-primary/40"
                          : "bg-white/5 text-white/70 border border-white/10 hover:bg-white/10 hover:text-white"
                      )}
                    >
                      <div className={cn(
                        "w-4 h-4 rounded border-2",
                        serviceSearchGroups[idx] ? "bg-brand-primary border-brand-primary" : "border-white/20"
                      )} />
                      <span className="text-sm font-medium">{service}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Custom Search */}
        {selectedCategory === "Custom Search" && (
          <div className="flex flex-col h-full gap-4">
            {/* Controls */}
            <div className="flex items-center justify-between gap-3 pb-4 border-b border-white/10">
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  placeholder="Search ranges..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-64 bg-black/30 border border-white/10 rounded px-3 py-2 text-xs text-white placeholder:text-white/40 focus:outline-none focus:border-brand-primary"
                />
                <button
                  onClick={() => {
                    setSearchTerm("");
                    setSelectedRanges([]);
                  }}
                  className="px-3 py-2 text-xs font-medium text-white/70 bg-white/10 hover:bg-white/20 rounded border border-white/10 transition-colors"
                >
                  Clear
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleAllSelected(filteredRanges.length > 0 && selectedRanges.length === filteredRanges.length)}
                  disabled={filteredRanges.length === 0}
                  className="px-3 py-2 text-xs font-medium text-white/70 bg-white/10 hover:bg-white/20 rounded border border-white/10 transition-colors disabled:opacity-50"
                >
                  {selectedRanges.length === filteredRanges.length ? "Deselect" : "Select Page"}
                </button>
                <button
                  onClick={() => {
                    const newRanges = filteredRanges.map(r => ({ ...r, enabled: !r.enabled }));
                    setSearchRanges(newRanges);
                  }}
                  className="px-3 py-2 text-xs font-medium text-white/70 bg-white/10 hover:bg-white/20 rounded border border-white/10 transition-colors"
                >
                  {selectedRanges.some(id => !filteredRanges.find(r => r.id === id)?.enabled)
                    ? "Enable All" : "Disable All"}
                </button>
              </div>
            </div>

            {/* Range List */}
            <div className="flex-1 rounded-lg border border-white/5 bg-black/10 overflow-hidden">
              <div className="grid grid-cols-[60px_1fr_150px_100px_80px] text-xs font-bold uppercase tracking-wider text-white/40 bg-white/5 border-b border-white/10 px-3 py-2">
                <div className="flex justify-center">
                  <input
                    type="checkbox"
                    checked={filteredRanges.length > 0 && selectedRanges.length === filteredRanges.length}
                    onChange={(e) => toggleAllSelected(e.target.checked)}
                    className="form-checkbox h-3.5 w-3.5 text-brand-primary bg-black/40 border-white/20 rounded"
                  />
                </div>
                <div>Range</div>
                <div>Frequency (MHz)</div>
                <div>Actions</div>
              </div>

              <div className="divide-y divide-white/5 max-h-[450px] overflow-y-auto">
                {filteredRanges.map((range) => {
                  const isSelected = selectedRanges.includes(range.id);
                  return (
                    <div
                      key={range.id}
                      className={cn(
                        "grid grid-cols-[60px_1fr_150px_100px_80px] items-center px-3 py-2 text-sm",
                        isSelected ? "bg-brand-primary/10" : "hover:bg-white/5",
                      )}
                    >
                      <div className="flex justify-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelection(range.id)}
                          className="form-checkbox h-3.5 w-3.5 text-brand-primary bg-black/40 border-white/20 rounded"
                        />
                      </div>
                      <div className="font-medium text-white">{range.label}</div>
                      <div className="flex gap-2 items-center">
                        <input
                          type="text"
                          value={range.start}
                          onChange={(e) => updateRange(range.id, "start", e.target.value)}
                          className="w-20 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-white text-right focus:outline-none focus:border-brand-primary"
                          placeholder="Start"
                        />
                        <span className="text-white/40">-</span>
                        <input
                          type="text"
                          value={range.end}
                          onChange={(e) => updateRange(range.id, "end", e.target.value)}
                          className="w-20 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-white text-right focus:outline-none focus:border-brand-primary"
                          placeholder="End"
                        />
                      </div>
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => handleCustomSearchToggle(range.id)}
                          className={cn(
                            "px-2 py-1 rounded text-xs font-medium transition-colors",
                            range.enabled
                              ? "bg-brand-primary text-black"
                              : "bg-white/10 text-white/70 hover:text-white"
                          )}
                        >
                          {range.enabled ? "On" : "Off"}
                        </button>
                        <button
                          onClick={() => {
                            setSelectedRanges([range.id]);
                            setSearchTerm(range.label);
                          }}
                          className="p-1.5 rounded bg-white/10 text-white/70 hover:text-white border border-white/10 transition-colors"
                        >
                          <RotateCcw size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}

                {filteredRanges.length === 0 && (
                  <div className="py-16 text-center text-white/40 text-sm">
                    No search ranges found
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
