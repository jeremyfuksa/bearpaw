import { useCallback, useEffect, useState } from 'react';
import type { SyncOutcome } from '../app/components/SyncPaw';

// These messages are emitted after the backend closes its sync task. A 100%
// transfer update (e.g. "Exiting program mode") is not a successful outcome.
export function syncOutcomeFromMessage(message: string): SyncOutcome | null {
  if (/^sync failed\b/i.test(message)) return 'error';
  if (/^sync cancelled\b/i.test(message)) return 'cancelled';
  if (/^sync complete\b/i.test(message)) return 'success';
  return null;
}

/** Presentation only: never delays backend cleanup or post-sync refreshes. */
export function useSyncFeedback(active: boolean, reducedMotion: boolean) {
  const [feedback, setFeedback] = useState<{
    outcome: SyncOutcome;
    percent: number;
    message: string;
  } | null>(null);
  const finish = useCallback((outcome: SyncOutcome, percent: number, message: string) => {
    setFeedback({ outcome, percent, message });
  }, []);
  const dismiss = useCallback(() => setFeedback(null), []);
  const [wasActive, setWasActive] = useState(active);
  // Reset presentation on a new run before painting, rather than showing the
  // previous terminal state for one frame or delaying it through an effect.
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setFeedback(null);
  }
  useEffect(() => {
    if (active) return;
    if (!feedback || feedback.outcome === 'error') return;
    const timer = setTimeout(
      dismiss,
      reducedMotion ? 300 : feedback.outcome === 'success' ? 1100 : 900,
    );
    return () => clearTimeout(timer);
  }, [active, feedback, reducedMotion, dismiss]);
  return { feedback, finish, dismiss };
}
