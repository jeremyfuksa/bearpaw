import { useState } from 'react';
import { AlertTriangle, Info, X } from 'lucide-react';

interface DataDiagnosticBannerProps {
  /** `deviceInfo.data_diagnostic_message` — the full, user-facing explanation. */
  message?: string | null;
  /**
   * `'error'` (default) for a data problem; `'notice'` for something the user
   * should know that is NOT a problem, such as the database having been
   * upgraded on this launch.
   *
   * A notice is not styled or announced as a fault. Dressing a successful
   * upgrade as a warning would train people to dismiss the channel that also
   * carries real failures.
   */
  variant?: 'error' | 'notice';
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
export function DataDiagnosticBanner({ message, variant = 'error' }: DataDiagnosticBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  if (!message || dismissed) return null;

  const isNotice = variant === 'notice';
  const Icon = isNotice ? Info : AlertTriangle;

  return (
    <div
      // `status`, not `alert`, for a notice: a screen reader should not
      // interrupt for news that nothing is wrong.
      role={isNotice ? 'status' : 'alert'}
      className={
        isNotice
          ? 'flex items-start gap-3 border-b border-sky-500/40 bg-sky-500/10 px-4 py-3 text-sm text-sky-100'
          : 'flex items-start gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100'
      }
    >
      <Icon
        aria-hidden
        className={
          isNotice ? 'mt-0.5 size-4 shrink-0 text-sky-400' : 'mt-0.5 size-4 shrink-0 text-amber-400'
        }
      />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {isNotice ? 'Bearpaw upgraded its saved data' : 'Bearpaw could not open its saved data'}
        </p>
        <p
          className={
            isNotice
              ? 'mt-1 leading-relaxed break-words text-sky-100/90'
              : 'mt-1 leading-relaxed break-words text-amber-100/90'
          }
        >
          {message}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={isNotice ? 'Dismiss data notice' : 'Dismiss data warning'}
        className={
          isNotice
            ? 'shrink-0 rounded p-1 text-sky-200/70 hover:bg-sky-500/20 hover:text-sky-100'
            : 'shrink-0 rounded p-1 text-amber-200/70 hover:bg-amber-500/20 hover:text-amber-100'
        }
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}
