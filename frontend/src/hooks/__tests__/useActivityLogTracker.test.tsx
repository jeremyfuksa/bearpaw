import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useActivityLogTracker } from '../useActivityLogTracker';
import { useStore } from '../../store/useStore';
import type { WSMessage } from '../../types';

// A minimal stand-in for ScannerWebSocket: records listeners by event and lets
// the test push messages through them. `on` returns a real unsubscribe so the
// hook's cleanup is exercised too.
type Listener = (data: WSMessage | { status: string; error?: unknown }) => void;

function createFakeWs() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on(event: string, cb: Listener): () => void {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => listeners.get(event)?.delete(cb);
    },
    emit(event: string, data: WSMessage | { status: string; error?: unknown }) {
      listeners.get(event)?.forEach((cb) => cb(data));
    },
  };
}

let fakeWs: ReturnType<typeof createFakeWs>;

vi.mock('../../websocket/useWebSocket', () => ({
  useWebSocket: () => ({ ws: fakeWs, connected: true, connecting: false }),
}));

const stateUpdate = (sequence: number, timestamp: number, squelch_open: boolean): WSMessage => ({
  type: 'state_update',
  timestamp,
  sequence,
  data: { squelch_open },
});

const scanHit = (timestamp: number): WSMessage => ({
  type: 'event',
  timestamp,
  event: 'scan_hit',
  data: { frequency: 146.85, channel: 1, alpha_tag: 'TEST', rssi: 50 },
});

describe('useActivityLogTracker', () => {
  let addSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeWs = createFakeWs();
    addSpy = vi.fn();
    useStore.setState({
      addToFullActivityLog: addSpy as never,
      preferences: { ...useStore.getState().preferences, hitMinDuration: 0 },
    });
  });

  // Drives one full hit (scan_hit -> squelch open -> squelch close) at the
  // given base sequence/time and returns nothing; the hook emits an entry on
  // the closing update if the gate lets it through.
  const runHit = (baseSeq: number, baseTime: number) => {
    fakeWs.emit('event', scanHit(baseTime));
    fakeWs.emit('state_update', stateUpdate(baseSeq, baseTime, true));
    fakeWs.emit('state_update', stateUpdate(baseSeq + 1, baseTime + 100, false));
  };

  it('logs a hit when squelch opens then closes', () => {
    renderHook(() => useActivityLogTracker());
    runHit(5000, 10_000);
    expect(addSpy).toHaveBeenCalledTimes(1);
  });

  // Regression guard (#261): after a backend restart the WS sequence reseeds
  // near 0. The tracker's closure-local gate must reset on the 'connected'
  // transition, or every post-reconnect state_update is dropped as stale and
  // hit tracking silently freezes for the rest of the session.
  it('keeps tracking hits after a reconnect reseeds low sequences', () => {
    renderHook(() => useActivityLogTracker());

    // A long-running session: the gate climbs high.
    runHit(5000, 10_000);
    expect(addSpy).toHaveBeenCalledTimes(1);

    // Backend restarts; WS reconnects with fresh low sequences.
    fakeWs.emit('connection', { status: 'connected' });

    // A new hit at low sequences must still register.
    runHit(1, 20_000);
    expect(addSpy).toHaveBeenCalledTimes(2);
  });

  it('drops a half-open hit captured before a reconnect', () => {
    renderHook(() => useActivityLogTracker());

    // Squelch opens (hit captured) but never closes before the drop.
    fakeWs.emit('event', scanHit(10_000));
    fakeWs.emit('state_update', stateUpdate(5000, 10_000, true));

    // Reconnect: the stale open-hit state must be cleared.
    fakeWs.emit('connection', { status: 'connected' });

    // A lone squelch-close at a low sequence must NOT emit a bogus entry.
    fakeWs.emit('state_update', stateUpdate(1, 20_000, false));
    expect(addSpy).not.toHaveBeenCalled();
  });
});
