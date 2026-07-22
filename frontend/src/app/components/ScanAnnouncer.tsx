import { useEffect, useRef, useState } from 'react';

type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

interface ScanAnnouncerProps {
  squelchOpen: boolean;
  /** Raw scanner mode ('SCAN' | 'HOLD' | 'DIRECT'). MUST be the raw
   * liveState.mode, not a normalized/mapped value — hit/scan edges are
   * gated on `mode === 'SCAN'`. */
  mode: string;
  frequency?: number | null;
  alphaTag?: string | null;
  connectionStatus: ConnectionStatus;
  isSyncing: boolean;
}

/**
 * A visually-hidden polite live region that announces ONLY discrete state
 * transitions to screen readers — never the ~5 Hz value churn of the scan
 * display.
 *
 * REGRESSION GUARD (a11y C1/C2/C3): this component intentionally reads the
 * PREVIOUS state from refs (not from the deps array) so it emits text exactly
 * once per transition — a scan→hit, a hit→scanning, or a connection change.
 * It must NEVER be replaced by putting `aria-live` on the frequency/RSSI text
 * nodes: those update multiple times per second and a live region on them would
 * flood the user into uselessness (that is finding C2, the over-verbose
 * extreme, which is as broken as the silent extreme C1). The settled policy is
 * to announce transitions, not values.
 * Guarded by ScanAnnouncer.test.tsx.
 */
export function ScanAnnouncer({
  squelchOpen,
  mode,
  frequency,
  alphaTag,
  connectionStatus,
  isSyncing,
}: ScanAnnouncerProps) {
  const [message, setMessage] = useState('');
  const prevSquelchRef = useRef(false);
  const prevConnRef = useRef<ConnectionStatus>(connectionStatus);

  useEffect(() => {
    // During memory sync the scanner is parked in a PRG bracket and mode/squelch
    // churn through it; suppress hit/scan announcements so the bracket doesn't
    // leak a spurious "Scanning"/"Hit". The sync overlay announces its own
    // progress separately.
    if (isSyncing) {
      prevSquelchRef.current = squelchOpen;
      return;
    }

    // Connection edge first — and while offline, nothing else is announced.
    if (connectionStatus !== prevConnRef.current) {
      if (connectionStatus === 'disconnected') {
        setMessage('Disconnected');
      } else if (prevConnRef.current === 'disconnected' && connectionStatus === 'connected') {
        setMessage('Reconnected');
      }
      prevConnRef.current = connectionStatus;
    }
    if (connectionStatus === 'disconnected') {
      prevSquelchRef.current = squelchOpen;
      return;
    }

    // Hit / scanning edges — only meaningful in SCAN mode. A user-driven HOLD or
    // DIRECT squelch transition is not a "hit".
    if (mode === 'SCAN') {
      if (squelchOpen && !prevSquelchRef.current) {
        const freq = typeof frequency === 'number' ? frequency.toFixed(3) : '';
        const tag = alphaTag ? `, ${alphaTag}` : '';
        setMessage(freq ? `Hit — ${freq}${tag}` : `Hit${tag}`);
      } else if (!squelchOpen && prevSquelchRef.current) {
        setMessage('Scanning');
      }
    }

    prevSquelchRef.current = squelchOpen;
  }, [squelchOpen, mode, frequency, alphaTag, connectionStatus, isSyncing]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
