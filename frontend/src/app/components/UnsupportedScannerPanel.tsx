interface UnsupportedScannerPanelProps {
  model: string;
  /** The user already chose "Not now" for this scanner: show the resting state. */
  dismissed: boolean;
  /**
   * Optional on purpose: "Run diagnostic" renders only when a handler exists,
   * so a build with no diagnostic behind it offers no dead button.
   */
  onRunDiagnostic?: () => void;
  onDismiss: () => void;
  onSeeSupported: () => void;
}

const linkClass =
  'text-scanner-text-light underline underline-offset-2 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

/**
 * Stands in for the scanner display when Bearpaw recognises a Uniden radio it
 * has no command set for. The backend refuses every command to such a radio,
 * so showing controls would only invite a click that fails.
 *
 * Inline, never a modal: "Not now" must leave the app usable, and it never
 * asks again. The resting state keeps the way back to the diagnostic.
 */
export function UnsupportedScannerPanel({
  model,
  dismissed,
  onRunDiagnostic,
  onDismiss,
  onSeeSupported,
}: UnsupportedScannerPanelProps) {
  return (
    <section
      aria-label="Unsupported scanner"
      className="flex h-full flex-col items-center justify-center gap-4 rounded-lg border border-white/5 bg-black/20 p-8 text-center"
    >
      <p className="text-lg font-bold text-white">
        Bearpaw found your {model}, which is currently unsupported.
      </p>
      {dismissed ? (
        <div className="flex items-center gap-6 text-sm">
          {onRunDiagnostic && (
            <button type="button" onClick={onRunDiagnostic} className={linkClass}>
              Run diagnostic
            </button>
          )}
          <button type="button" onClick={onSeeSupported} className={linkClass}>
            See supported scanners
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm text-white/70">
            A safe, read-only diagnostic on your scanner can help fix that.
          </p>
          <div className="flex items-center gap-3">
            {onRunDiagnostic && (
              <button
                type="button"
                onClick={onRunDiagnostic}
                className="rounded-md bg-white/15 px-4 py-2 text-sm font-bold text-white hover:bg-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                Run diagnostic
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md border border-white/20 px-4 py-2 text-sm text-white/80 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Not now
            </button>
          </div>
        </>
      )}
    </section>
  );
}
