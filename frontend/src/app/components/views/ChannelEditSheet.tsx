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
}

/** Valid CIN delay values (docs/BC125AT_PROTOCOL.md §5.3). Negatives are
 * pre-delays. The sheet used to accept 0-30, which either rejected legal
 * pre-delays or passed values the scanner 400s on (#146). */
const DELAY_OPTIONS = ['-10', '-5', '0', '1', '2', '3', '4', '5'];

/** BC125AT coverage bands in MHz (docs/SCANNER_PROTOCOL_REFERENCE.md §6).
 * 25-512 is NOT contiguous — gap frequencies (90.0, 200.0) fail only at the
 * wire with a cryptic error unless caught here (#146). */
const FREQUENCY_BANDS: Array<[number, number]> = [
  [25, 54],
  [108, 174],
  [225, 380],
  [400, 512],
];

/** The 50 canonical EIA CTCSS tones (docs/BC125AT_PROTOCOL.md §7.2). The
 * backend rejects anything else with `tone_invalid`; validating here gives
 * the user a readable error before upload. */
const CTCSS_TONES = [
  67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2,
  110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5,
  167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7,
  218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1,
];

function validateField(field: keyof ChannelDraft, value: string | boolean): string | null {
  if (field === 'frequency' && typeof value === 'string') {
    const freq = parseFloat(value);
    if (isNaN(freq)) return 'Invalid frequency';
    if (freq === 0) return null;
    if (!FREQUENCY_BANDS.some(([lo, hi]) => freq >= lo && freq <= hi)) {
      return 'Frequency must be in a covered band: 25–54, 108–174, 225–380, or 400–512 MHz';
    }
  }
  if (field === 'delay' && typeof value === 'string') {
    if (!DELAY_OPTIONS.includes(value.trim())) {
      return 'Delay must be one of -10, -5, 0, 1, 2, 3, 4, 5';
    }
  }
  if (field === 'tone_squelch' && typeof value === 'string' && value.trim() !== '') {
    const tone = parseFloat(value);
    if (isNaN(tone) || !CTCSS_TONES.some((t) => Math.abs(t - tone) < 0.05)) {
      return 'Not a standard CTCSS tone (e.g. 67.0 … 254.1)';
    }
  }
  return null;
}

export function ChannelEditSheet({
  channel,
  draft,
  isOpen,
  onClose,
  onSave,
}: ChannelEditSheetProps) {
  // Local working copy (#146): edits live here until Save commits them via
  // onSave. Cancel/Close simply discards — previously every keystroke wrote
  // straight into the store draft, so a "cancelled" edit still uploaded with
  // the next Upload Changes.
  const [localDraft, setLocalDraft] = useState<ChannelDraft>(draft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setLocalDraft(draft);
      setErrors({});
    }
    // Reseed only when the sheet opens (or switches channel while open);
    // `draft` is deliberately read at open time, not tracked live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, channel.index]);

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
    setLocalDraft((prev) => ({ ...prev, [field]: value }));
  };

  const handleClear = () => {
    setLocalDraft({
      frequency: '0',
      alpha_tag: '',
      modulation: 'AUTO',
      tone_squelch: '',
      delay: '2',
      lockout: false,
      priority: false,
      comments: '',
    });
    setErrors({});
  };

  const handleSave = async () => {
    const validationErrors: Record<string, string> = {};
    let hasErrors = false;

    for (const [field, value] of Object.entries(localDraft)) {
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
      await onSave(localDraft);
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
                  value={localDraft.frequency}
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
                  value={localDraft.alpha_tag}
                  onChange={(e) => handleFieldChange('alpha_tag', e.target.value)}
                  maxLength={16}
                  className="scanner-input w-full px-3 py-2 text-sm"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-white/70">Modulation</label>
                <Select
                  value={localDraft.modulation}
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
                <label className="text-xs font-medium text-white/70">Tone Squelch (CTCSS Hz)</label>
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label="Tone Squelch"
                  value={localDraft.tone_squelch}
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
                <Select
                  value={localDraft.delay}
                  onValueChange={(value) => handleFieldChange('delay', value)}
                >
                  <SelectTrigger aria-label="Delay" className="scanner-input h-10 w-full text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="scanner-select-content">
                    {DELAY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.delay && <p className="text-xs text-red-400">{errors.delay}</p>}
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-white/5">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      aria-label="Lockout"
                      checked={localDraft.lockout}
                      onCheckedChange={(checked) => handleFieldChange('lockout', checked)}
                      className="data-[state=checked]:bg-brand-primary"
                    />
                    <label className="text-xs font-medium text-white/70">Lockout</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      aria-label="Priority"
                      checked={localDraft.priority}
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
                onClick={handleClear}
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
