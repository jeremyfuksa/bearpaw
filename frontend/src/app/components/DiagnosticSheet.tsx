import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { getAPI } from '../../api/useApi';
import { APIError } from '../../api/client';
import { openExternalUrl, saveExport } from '../../tauri-shell';
import { buildIssueUrl, buildMailto, diagnosticFilename } from './diagnosticLinks';

interface DiagnosticSheetProps {
  isOpen: boolean;
  /** The model the scanner reported, for the copy and the filename. */
  model: string;
  onClose: () => void;
}

type Step =
  | { kind: 'intro' }
  | { kind: 'running' }
  | { kind: 'report'; text: string }
  | { kind: 'error'; message: string };

// `APIError.message` carries the backend's code (api/mod.rs `ApiError`).
function describeFailure(error: unknown): string {
  if (error instanceof APIError) {
    if (error.message === 'sync_in_progress') {
      return "Bearpaw is reading the scanner's memory right now. Try again when that finishes.";
    }
    if (error.message === 'program_mode_active') {
      return 'The scanner is busy with another task. Try again in a moment.';
    }
    if (error.message === 'device_disconnected') {
      return "The scanner isn't connected. Connect it and try again.";
    }
  }
  return "The diagnostic didn't finish. Nothing on your scanner was changed. Try again.";
}

const secondary =
  'rounded-md border border-white/20 px-4 py-2 text-sm text-white/80 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
const primary = 'scanner-button-primary px-4 py-2 text-sm uppercase tracking-wider';

/**
 * Runs the read-only diagnostic (`POST /diagnostic`) and lets the user send the
 * result. Nothing goes out until the user has seen the whole report: the send
 * buttons exist only in the `report` step, which is only reached with the text
 * on screen. Sending is the user's own mail app or browser, never Bearpaw.
 */
export function DiagnosticSheet({ isOpen, model, onClose }: DiagnosticSheetProps) {
  const [step, setStep] = useState<Step>({ kind: 'intro' });
  // A result that lands after the sheet closed must not resurrect it.
  const runId = useRef(0);

  // Every way out goes through here, so reopening always starts at the intro
  // and a run still in flight is dropped.
  const close = () => {
    runId.current += 1;
    setStep({ kind: 'intro' });
    onClose();
  };

  const run = async () => {
    const id = ++runId.current;
    setStep({ kind: 'running' });
    try {
      const { text } = await getAPI().runDiagnostic();
      if (id === runId.current) setStep({ kind: 'report', text });
    } catch (error) {
      console.error('Diagnostic failed', error);
      if (id === runId.current) setStep({ kind: 'error', message: describeFailure(error) });
    }
  };

  const save = async (text: string) => {
    try {
      const where = await saveExport(
        diagnosticFilename(model, new Date()),
        new TextEncoder().encode(text),
      );
      if (where !== 'cancelled') toast.success('Report saved');
    } catch (error) {
      console.error('Failed to save diagnostic report', error);
      toast.error('Failed to save the report');
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="scanner-modal w-[var(--layout-modal-activity-width)] max-w-none translate-x-[-50%] translate-y-[-50%] gap-0 rounded-t-xl border-white/10 p-0">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <DialogTitle className="text-lg font-bold text-white">Scanner diagnostic</DialogTitle>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {step.kind === 'intro' && (
            <p className="text-sm text-white/80">
              This asks your {model} a few questions about how it works: its model, firmware, and
              current settings. It writes nothing to your scanner. You'll see the whole report
              before anything is sent, and you choose how to send it.
            </p>
          )}
          {step.kind === 'running' && (
            <p role="status" className="text-sm text-white/80">
              Asking your {model}...
            </p>
          )}
          {step.kind === 'report' && (
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-black/30 p-3 text-xs text-white/90">
              {step.text}
            </pre>
          )}
          {step.kind === 'error' && (
            <p role="alert" className="text-sm text-white/80">
              {step.message}
            </p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-white/10 shrink-0 flex flex-wrap justify-end gap-3">
          {step.kind === 'intro' && (
            <>
              <button type="button" onClick={close} className={secondary}>
                Cancel
              </button>
              <button type="button" onClick={() => void run()} className={primary}>
                Run diagnostic
              </button>
            </>
          )}
          {step.kind === 'running' && (
            <button type="button" onClick={close} className={secondary}>
              Cancel
            </button>
          )}
          {step.kind === 'report' && (
            <>
              <button type="button" onClick={() => void save(step.text)} className={secondary}>
                Save report
              </button>
              <button
                type="button"
                onClick={() => openExternalUrl(buildMailto(step.text, model))}
                className={secondary}
              >
                Email it
              </button>
              <button
                type="button"
                onClick={() => openExternalUrl(buildIssueUrl(step.text, model))}
                className={primary}
              >
                Open an issue
              </button>
            </>
          )}
          {step.kind === 'error' && (
            <button type="button" onClick={() => void run()} className={primary}>
              Try again
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
