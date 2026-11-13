import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useActivityLogTracker } from '../useActivityLogTracker';
import { useStore } from '../../store/useStore';
import type { WSMessage } from '../../types';
import { createTestActivityLogEntry } from '../../test/fixtures';

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

  // Regression guard (#873): the logged hit carries its PEAK strength. The
  // order is the backend's: the opening state_update, then scan_hit, both at
  // the opening tick's rssi, which on a BC125AT can be 0 because STS is read
  // before GLG. A build that keeps the opening value logs 0; one that keeps the
  // LAST value logs 60. Only the peak is 100.
  it('logs the strongest reading of the hit, not the first', () => {
    renderHook(() => useActivityLogTracker());
    const open = (sequence: number, timestamp: number, rssi: number): WSMessage => ({
      type: 'state_update',
      timestamp,
      sequence,
      data: { squelch_open: true, rssi },
    });

    fakeWs.emit('state_update', open(1, 10_000, 0));
    fakeWs.emit('event', {
      type: 'event',
      timestamp: 10_000,
      event: 'scan_hit',
      data: { frequency: 146.85, channel: 1, alpha_tag: 'TEST', rssi: 0 },
    });
    fakeWs.emit('state_update', open(2, 10_200, 100));
    fakeWs.emit('state_update', open(3, 10_400, 60));
    fakeWs.emit('state_update', stateUpdate(4, 10_600, false));

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls[0][0].rssi).toBe(100);
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

  // #927: a hit's recording is joined to its row by `hit_uid`, which the
  // backend allocates at squelch-open and sends on `scan_hit`.
  it('carries the hit_uid from scan_hit onto the logged entry', () => {
    renderHook(() => useActivityLogTracker());
    fakeWs.emit('event', {
      type: 'event',
      timestamp: 10_000,
      event: 'scan_hit',
      data: { frequency: 146.85, channel: 1, rssi: 50, hit_uid: '1794540552100-2a' },
    });
    fakeWs.emit('state_update', stateUpdate(5000, 10_000, true));
    fakeWs.emit('state_update', stateUpdate(5001, 10_100, false));
    expect(addSpy.mock.calls[0][0].hitUid).toBe('1794540552100-2a');
  });

  describe('recording_finished (#927)', () => {
    const finished = (hit_uid: string, recording_status: string): WSMessage => ({
      type: 'event',
      timestamp: 10_200,
      event: 'recording_finished',
      data: { hit_uid, recording_status, recording_duration: 4.2 },
    });

    beforeEach(() => {
      useStore.setState({
        fullActivityLog: [
          createTestActivityLogEntry({ id: 'a', hitUid: 'uid-a', hasAudio: false }),
          createTestActivityLogEntry({ id: 'b', hitUid: 'uid-b', hasAudio: false }),
        ],
      });
    });

    const hasAudio = () =>
      Object.fromEntries(useStore.getState().fullActivityLog.map((e) => [e.id, e.hasAudio]));

    it.each(['ready', 'partial'])('marks only that hit as playable when %s', (status) => {
      renderHook(() => useActivityLogTracker());
      fakeWs.emit('event', finished('uid-a', status));
      expect(hasAudio()).toEqual({ a: true, b: false });
    });

    it.each(['failed', 'too_short'])('leaves the hit unplayable when %s', (status) => {
      renderHook(() => useActivityLogTracker());
      fakeWs.emit('event', finished('uid-a', status));
      expect(hasAudio()).toEqual({ a: false, b: false });
    });

    it('records the clip length on the hit', () => {
      renderHook(() => useActivityLogTracker());
      fakeWs.emit('event', finished('uid-a', 'ready'));
      const [a, b] = useStore.getState().fullActivityLog;
      expect(a.recordingDuration).toBe(4.2);
      expect(b.recordingDuration).toBeUndefined();
    });
  });
});
