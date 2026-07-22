import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { useWebSocket } from '../websocket/useWebSocket';
import type { ActivityLogEntry, EventMessage, StateUpdateMessage } from '../types';

/**
 * Owns the "did a hit just finish?" state machine.
 *
 * The scanner reports squelch transitions via `state_update` and the start
 * of a hit (with frequency/channel/alpha_tag/rssi metadata) via a separate
 * `scan_hit` event. We need to join these two streams: capture the metadata
 * at squelch-open and only emit an `ActivityLogEntry` once squelch closes
 * AND the hit lasted longer than the user's minimum-duration threshold.
 *
 * Reads `preferences.hitMinDuration` live each transition rather than via
 * dependency array — the threshold can change mid-session and we want the
 * next hit to honor the new value without resubscribing the WS handlers.
 */
export function useActivityLogTracker(): void {
  const { ws } = useWebSocket();
  const addToFullActivityLog = useStore((state) => state.addToFullActivityLog);

  const lastHitOpenRef = useRef(false);
  const squelchOpenStartTimeRef = useRef<number | null>(null);
  const currentHitDataRef = useRef<ActivityLogEntry | null>(null);

  useEffect(() => {
    // Local sequence gate (#144): this hook consumes state_update directly
    // (not via the store), so reordered messages the store correctly drops
    // would still drive the hit state machine here — producing spurious or
    // truncated hit entries. Mirror the store's monotonic check.
    let lastSequence = 0;
    const unsubscribeState = ws.on('state_update', (message) => {
      const payload = message as StateUpdateMessage;
      if (typeof payload.sequence === 'number') {
        if (payload.sequence <= lastSequence) return;
        lastSequence = payload.sequence;
      }
      const squelchOpen = payload.data.squelch_open;
      if (typeof squelchOpen !== 'boolean') return;

      if (squelchOpen && !lastHitOpenRef.current) {
        squelchOpenStartTimeRef.current = payload.timestamp;
        lastHitOpenRef.current = true;
        return;
      }

      if (!squelchOpen && lastHitOpenRef.current) {
        const startTime = squelchOpenStartTimeRef.current ?? payload.timestamp;
        const duration = payload.timestamp - startTime;
        const minDuration = useStore.getState().preferences.hitMinDuration;
        if (
          duration >= minDuration &&
          squelchOpenStartTimeRef.current !== null &&
          currentHitDataRef.current
        ) {
          const entry: ActivityLogEntry = {
            ...currentHitDataRef.current,
            id: `${squelchOpenStartTimeRef.current}-${payload.sequence}`,
            timestamp: squelchOpenStartTimeRef.current,
            duration,
            ended_at: payload.timestamp,
          };
          addToFullActivityLog(entry);
        }
        squelchOpenStartTimeRef.current = null;
        currentHitDataRef.current = null;
        lastHitOpenRef.current = false;
      }
    });

    const unsubscribeEvent = ws.on('event', (message) => {
      const payload = message as EventMessage;
      if (payload.event !== 'scan_hit') return;
      squelchOpenStartTimeRef.current = payload.timestamp;
      currentHitDataRef.current = {
        id: `${payload.timestamp}-pending`,
        timestamp: payload.timestamp,
        frequency: payload.data.frequency ?? 0,
        channel: payload.data.channel ?? null,
        alpha_tag: payload.data.alpha_tag ?? null,
        type: 'hit',
        rssi: payload.data.rssi,
        hasAudio: false,
        duration: 0,
        ended_at: 0,
      };
    });

    return () => {
      unsubscribeState();
      unsubscribeEvent();
    };
  }, [addToFullActivityLog, ws]);
}
