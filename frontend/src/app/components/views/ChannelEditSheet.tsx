import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../../../lib/utils';
import { Switch } from '../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import type { ChannelData, ChannelDraft } from '../../../types';

interface ChannelEditSheetProps {
  channel: ChannelData;
  draft: ChannelDraft;
  isOpen: boolean;
  onClose: () => void;
  onSave: (draft: ChannelDraft) => Promise<void>;
  onFieldChange: (field: keyof ChannelDraft, value: string | boolean) => void;
  onClear: () => void;
}

export function ChannelEditSheet({
  channel,
  draft,
  isOpen,
  onClose,
  onSave,
  onFieldChange,
  onClear,
}: ChannelEditSheetProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setErrors({});
    }
  }, [isOpen]);

  const validateField = (field: keyof ChannelDraft, value: string | boolean): string | null => {
    if (field === 'frequency' && typeof value === 'string') {
      const freq = parseFloat(value);
      if (isNaN(freq)) return 'Invalid frequency';
      if (freq === 0) return null;
      if (freq < 25 || freq > 512) return 'Frequency must be 25-512 MHz';
    }
    if (field === 'delay' && typeof value === 'string') {
      const delay = parseInt(value, 10);
      if (isNaN(delay) || delay < 0 || delay > 30) return 'Delay must be 0-30 seconds';
    }
    if (field === 'tone_squelch' && typeof value === 'string' && value.trim() !== '') {
      const tone = parseFloat(value);
      if (isNaN(tone) || tone < 0 || tone > 999) return 'Tone must be 0-999';
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
            initial={{ y: '100%', opacity: 0 }}
            animate={{ y: '0%', opacity: 1 }}
            exit={{ y: '100%', opacity: 0 }}
            transition={{
              type: 'spring',
              damping: 25,
              stiffness: 300,
            }}
            className="scanner-modal w-[var(--layout-modal-channel-width)] rounded-t-xl"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <h3 className="text-lg font-bold text-white">Edit Channel {channel.index}</h3>
              <button
                onClick={onClose}
                aria-label="Close"
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
                  aria-label="Frequency"
                  value={draft.frequency}
                  onChange={(e) => handleFieldChange('frequency', e.target.value)}
                  className={cn(
                    'scanner-input w-full px-3 py-2 text-sm',
                    errors.frequency
                      ? 'border-red-500'
                      : 'border-white/10 focus:border-brand-primary',
                  )}
                />
                {errors.frequency && <p className="text-xs text-red-400">{errors.frequency}</p>}
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-white/70">Alpha Tag</label>
                <input
                  type="text"
                  aria-label="Alpha Tag"
                  value={draft.alpha_tag}
                  onChange={(e) => handleFieldChange('alpha_tag', e.target.value)}
                  maxLength={16}
                  className="scanner-input w-full px-3 py-2 text-sm"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-white/70">Modulation</label>
                <Select
                  value={draft.modulation}
                  onValueChange={(value) => handleFieldChange('modulation', value)}
                >
                  <SelectTrigger
                    aria-label="Modulation"
                    className="scanner-input h-10 w-full text-sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="scanner-select-content">
                    {['AUTO', 'FM', 'AM', 'NFM'].map((option) => (
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
                  aria-label="Tone Squelch"
                  value={draft.tone_squelch}
                  onChange={(e) => handleFieldChange('tone_squelch', e.target.value)}
                  placeholder="—"
                  className={cn(
                    'scanner-input w-full px-3 py-2 text-sm',
                    errors.tone_squelch
                      ? 'border-red-500'
                      : 'border-white/10 focus:border-brand-primary',
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
                  aria-label="Delay"
                  value={draft.delay}
                  onChange={(e) => handleFieldChange('delay', e.target.value)}
                  className={cn(
                    'scanner-input w-full px-3 py-2 text-sm',
                    errors.delay ? 'border-red-500' : 'border-white/10 focus:border-brand-primary',
                  )}
                />
                {errors.delay && <p className="text-xs text-red-400">{errors.delay}</p>}
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-white/5">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      aria-label="Lockout"
                      checked={draft.lockout}
                      onCheckedChange={(checked) => handleFieldChange('lockout', checked)}
                      className="data-[state=checked]:bg-brand-primary"
                    />
                    <label className="text-xs font-medium text-white/70">Lockout</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      aria-label="Priority"
                      checked={draft.priority}
                      onCheckedChange={(checked) => handleFieldChange('priority', checked)}
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
                className="scanner-button-muted flex-1 py-2.5 text-xs font-bold uppercase tracking-wider"
              >
                Cancel
              </button>
              <button
                onClick={onClear}
                className="flex-1 rounded border border-white/10 bg-white/10 py-2.5 text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-white/20"
              >
                Clear
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || Object.keys(errors).length > 0}
                className="scanner-button-primary flex-1 py-2.5 text-xs uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? 'Saving...' : 'Save Draft'}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
