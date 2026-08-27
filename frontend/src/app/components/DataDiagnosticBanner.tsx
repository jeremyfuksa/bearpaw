import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface DataDiagnosticBannerProps {
  /** `deviceInfo.data_diagnostic_message` — the full, user-facing explanation. */
  message?: string | null;
}

/**
 * Surfaces a data-integrity problem (today: a failed database migration).
 *
 * A banner rather than a dialog or a toast, deliberately:
 *
 * - Not a dialog. Bearpaw is offline-first and startup must never block, and a
 *   modal on launch is hostile besides.
 * - Not a toast. `sonner` auto-dismisses, and a warning that disappears after
 *   five seconds is the same as no warning. Toasts here carry transient action
 *   feedback ("Sync cancelled"); a condition that persists until someone fixes
 *   it does not belong in that channel.
 *
 * Deliberately NOT gated on `connection_status`. The bug this exists for was a
 * migration failure that was invisible precisely BECAUSE the scanner connected
 * fine — see the `DeviceInfo` field docs and
 * `migration_diagnostic_survives_a_connect`.
 *
 * Dismissal is per-session state, not persisted: if the cause is still there on
 * the next launch, the warning should come back.
 */
export function DataDiagnosticBanner({ message }: DataDiagnosticBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  if (!message || dismissed) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Bearpaw could not open its saved data</p>
        <p className="mt-1 leading-relaxed break-words text-amber-100/90">{message}</p>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss data warning"
        className="shrink-0 rounded p-1 text-amber-200/70 hover:bg-amber-500/20 hover:text-amber-100"
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}
