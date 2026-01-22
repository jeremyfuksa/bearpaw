import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "../../../lib/utils";
import { Switch } from "../ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import type { ChannelData, ChannelDraft } from "../../../types";

interface ChannelEditSheetProps {
  channel: ChannelData;
  draft: ChannelDraft;
  isOpen: boolean;
  onClose: () => void;
  onSave: (draft: ChannelDraft) => Promise<void>;
  onFieldChange: (field: keyof ChannelDraft, value: string | boolean) => void;
}

export function ChannelEditSheet({
  channel,
  draft,
  isOpen,
  onClose,
  onSave,
  onFieldChange,
}: ChannelEditSheetProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setErrors({});
    }
  }, [isOpen]);

  const validateField = (field: keyof ChannelDraft, value: string | boolean): string | null => {
    if (field === "frequency" && typeof value === "string") {
      const freq = parseFloat(value);
      if (isNaN(freq)) return "Invalid frequency";
      if (freq < 25 || freq > 512) return "Frequency must be 25-512 MHz";
    }
    if (field === "delay" && typeof value === "string") {
      const delay = parseInt(value, 10);
      if (isNaN(delay) || delay < 0 || delay > 30) return "Delay must be 0-30 seconds";
    }
    if (field === "tone_squelch" && typeof value === "string" && value.trim() !== "") {
      const tone = parseFloat(value);
      if (isNaN(tone) || tone < 0 || tone > 999) return "Tone must be 0-999";
    }
    return null;
  };

  const handleFieldChange = (field: keyof ChannelDraft, value: string | boolean) => {
    const error = validateField(field, value);
    setErrors((prev) => {
      const newErrors = { ...prev };
      if (error) {
        newErrors[field] = error;
      } else {
        delete newErrors[field];
      }
      return newErrors;
    });
    onFieldChange(field, value);
  };

  const handleSave = async () => {
    const validationErrors: Record<string, string> = {};
    let hasErrors = false;

    for (const [field, value] of Object.entries(draft)) {
      const error = validateField(field as keyof ChannelDraft, value);
      if (error) {
        validationErrors[field] = error;
        hasErrors = true;
      }
    }

    if (hasErrors) {
      setErrors(validationErrors);
      return;
    }

    setIsSaving(true);
    try {
      await onSave(draft);
      onClose();
    } finally {
      setIsSaving(false);
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
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] max-h-[80vh] bg-[#11131b] rounded-t-xl border border-white/10 shadow-2xl z-50 flex flex-col"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <h3 className="text-lg font-bold text-white">Edit Channel {channel.index}</h3>
              <button
                onClick={onClose}
                className="text-white/50 hover:text-white transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-medium text-white/70">Frequency (MHz)</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={draft.frequency}
                  onChange={(e) => handleFieldChange("frequency", e.target.value)}
                  className={cn(
                    "w-full bg-black/40 border rounded px-3 py-2 text-white text-sm outline-none transition-colors",
                    errors.frequency ? "border-red-500" : "border-white/10 focus:border-brand-primary"
                  )}
                />
                {errors.frequency && (
                  <p className="text-xs text-red-400">{errors.frequency}</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-white/70">Alpha Tag</label>
                <input
                  type="text"
                  value={draft.alpha_tag}
                  onChange={(e) => handleFieldChange("alpha_tag", e.target.value)}
                  maxLength={16}
                  className="w-full bg-black/40 border border-white/10 focus:border-brand-primary rounded px-3 py-2 text-white text-sm outline-none transition-colors"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-white/70">Modulation</label>
                <Select value={draft.modulation} onValueChange={(value) => handleFieldChange("modulation", value)}>
                  <SelectTrigger className="w-full h-10 bg-black/40 border-white/10 focus:border-brand-primary text-white text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-[#11131b] border-white/10 text-white">
                    {["AUTO", "FM", "AM", "NFM"].map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-white/70">Tone Squelch</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={draft.tone_squelch}
                  onChange={(e) => handleFieldChange("tone_squelch", e.target.value)}
                  placeholder="—"
                  className={cn(
                    "w-full bg-black/40 border rounded px-3 py-2 text-white text-sm outline-none transition-colors",
                    errors.tone_squelch ? "border-red-500" : "border-white/10 focus:border-brand-primary"
                  )}
                />
                {errors.tone_squelch && (
                  <p className="text-xs text-red-400">{errors.tone_squelch}</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-white/70">Delay (seconds)</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={draft.delay}
                  onChange={(e) => handleFieldChange("delay", e.target.value)}
                  className={cn(
                    "w-full bg-black/40 border rounded px-3 py-2 text-white text-sm outline-none transition-colors",
                    errors.delay ? "border-red-500" : "border-white/10 focus:border-brand-primary"
                  )}
                />
                {errors.delay && (
                  <p className="text-xs text-red-400">{errors.delay}</p>
                )}
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-white/5">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={draft.lockout}
                      onCheckedChange={(checked) => handleFieldChange("lockout", checked)}
                      className="data-[state=checked]:bg-brand-primary"
                    />
                    <label className="text-xs font-medium text-white/70">Lockout</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={draft.priority}
                      onCheckedChange={(checked) => handleFieldChange("priority", checked)}
                      className="data-[state=checked]:bg-brand-primary"
                    />
                    <label className="text-xs font-medium text-white/70">Priority</label>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-3 px-6 py-4 border-t border-white/10 shrink-0">
              <button
                onClick={onClose}
                className="flex-1 py-2.5 rounded bg-white/5 hover:bg-white/10 text-white text-xs font-bold uppercase tracking-wider border border-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || Object.keys(errors).length > 0}
                className="flex-1 py-2.5 rounded bg-brand-primary hover:bg-brand-hover text-black text-xs font-bold uppercase tracking-wider border border-brand-primary/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
