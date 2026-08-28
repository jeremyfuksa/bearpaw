import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { cn } from '../../../lib/utils';
import type { ScannerCapabilities } from '../../../types';
import { useScannerCapabilities } from '../../../hooks/useScannerCapabilities';

export interface SearchRangeDraft {
  start: string;
  end: string;
}

interface SearchRangeEditSheetProps {
  /** 1-based range index, matching the `CSP,<index>` slot. */
  index: number;
  draft: SearchRangeDraft;
  isOpen: boolean;
  onClose: () => void;
  onSave: (draft: SearchRangeDraft) => Promise<void>;
}

/**
 * Validate one limit of a custom-search range.
 *
 * Coverage comes from `ScannerCapabilities`, not a constant: the families do
 * not tune the same spectrum, and the BC125AT bands would accept frequencies a
 * BC75XLT cannot reach. Same rule `ChannelEditSheet` applies to a channel
 * frequency, for the same reason (#402).
 */
export function validateLimit(value: string, caps: ScannerCapabilities): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return 'Required';
  const freq = parseFloat(trimmed);
  if (isNaN(freq)) return 'Invalid frequency';
  if (!caps.coverage_bands.some(([lo, hi]) => freq >= lo && freq <= hi)) {
    const rendered = caps.coverage_bands.map(([lo, hi]) => `${lo}–${hi}`).join(', ');
    return `Must be in a covered band: ${rendered} MHz`;
  }
  return null;
}

/**
 * Edit one custom-search range's limits, then write them on Save.
 *
 * Replaces a pair of inline table inputs that wrote to the scanner on EVERY
 * keystroke. `updateRange` fired `setCustomSearchRange` whenever both fields
 * happened to parse, so typing `146.5` into an empty lower limit sent four
 * `CSP` writes — `1`, `14`, `146`, `146.5` — three of them values nobody
 * chose. Each one opens a program-mode bracket, which parks the scanner in
 * HOLD at channel 1.
 *
 * Batching behind a Save button also makes range editing match channel
 * editing, which has worked this way since #264: click the row, edit in a
 * dialog, save.
 */
export function SearchRangeEditSheet({
  index,
  draft,
  isOpen,
  onClose,
  onSave,
}: SearchRangeEditSheetProps) {
  const capabilities = useScannerCapabilities();
  const [localDraft, setLocalDraft] = useState<SearchRangeDraft>(draft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  // Re-seed whenever the sheet opens on a different range, so it never shows
  // the previous row's values for a frame. The local draft must survive
  // re-renders while the sheet is open -- that is the point of batching, a
  // cancelled edit must not reach the radio -- so it cannot be derived. The
  // write is edge-gated on `isOpen`/`index`, so it runs once per open rather
  // than per render. Same shape and same suppressions as ChannelEditSheet.
  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocalDraft(draft);
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, index]);

  const handleFieldChange = (field: keyof SearchRangeDraft, value: string) => {
    // The raw typed string always reaches state so the controlled input shows
    // what was typed -- gating that on a successful parse swallows a cleared
    // field or a leading '.' (#264). Validation gates the SAVE, not the
    // keystroke.
    setLocalDraft((prev) => ({ ...prev, [field]: value }));
    const error = validateLimit(value, capabilities);
    setErrors((prev) => {
      const next = { ...prev };
      if (error) {
        next[field] = error;
      } else {
        delete next[field];
      }
      return next;
    });
  };

  const handleSave = async () => {
    const found: Record<string, string> = {};
    for (const field of ['start', 'end'] as const) {
      const error = validateLimit(localDraft[field], capabilities);
      if (error) found[field] = error;
    }
    // An inverted range is refused here rather than sent: the scanner would
    // take it and search nothing.
    if (!Object.keys(found).length) {
      const lower = parseFloat(localDraft.start);
      const upper = parseFloat(localDraft.end);
      if (lower >= upper) {
        found.end = 'Upper limit must be above the lower limit';
      }
    }
    if (Object.keys(found).length) {
      setErrors(found);
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

  const field = (name: keyof SearchRangeDraft, label: string) => (
    <div className="space-y-1">
      <label htmlFor={`range-${name}`} className="text-sm font-medium text-white/70">
        {label}
      </label>
      <input
        id={`range-${name}`}
        type="text"
        inputMode="decimal"
        value={localDraft[name]}
        onChange={(e) => handleFieldChange(name, e.target.value)}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `range-${name}-error` : undefined}
        className={cn(
          'scanner-input w-full font-mono text-sm',
          errors[name] && 'border-red-500/60',
        )}
      />
      {errors[name] && (
        <p id={`range-${name}-error`} className="text-xs text-red-400">
          {errors[name]}
        </p>
      )}
    </div>
  );

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* Same neutralizing utilities as ChannelEditSheet so the scanner-modal
          sizing wins over DialogContent's own grid/padding. Radix supplies
          role="dialog", the focus trap, and Escape-to-close. */}
      <DialogContent className="scanner-modal w-[var(--layout-modal-channel-width)] max-w-none translate-x-[-50%] translate-y-[-50%] gap-0 rounded-t-xl border-white/10 p-0">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <DialogTitle className="text-lg font-bold text-white">
            Edit Search Range {index}
          </DialogTitle>
        </div>

        <div className="grid grid-cols-2 gap-4 px-6 py-5">
          {field('start', 'Lower (MHz)')}
          {field('end', 'Upper (MHz)')}
        </div>

        <div className="flex justify-end gap-2 border-t border-white/10 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-4 py-2 text-sm font-medium text-white/70 transition-colors hover:bg-white/5 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="rounded bg-brand-primary px-4 py-2 text-sm font-bold text-black transition-colors hover:bg-brand-hover disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
