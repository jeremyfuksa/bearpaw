import { useContext, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { WebSocketContext } from '../websocket/useWebSocket';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

/**
 * Single source of truth for the rendered connection status.
 *
 * Five separate signals contribute to "is the scanner connected" and they
 * can disagree:
 *   1. `WebSocket connected`     — is the WS open?
 *   2. `WebSocket connecting`    — is the WS in the middle of opening?
 *   3. `deviceInfo.connection_status` — backend's view of the USB/serial link
 *   4. `liveState.stale`         — backend stopped getting polls from the scanner
 *   5. (Tauri only) shell status — is the embedded backend process up?
 *
 * This hook collapses (1)–(4) into the one enum the UI actually renders.
 * Shell status is rendered separately so it isn't folded in here.
 *
 * Reads the WebSocket context directly (not via `useWebSocket()`) so
 * components rendered in isolation — Storybook-style or in unit tests —
 * don't crash. Without a provider, WS state is treated as "disconnected".
 *
 * Precedence (worst wins): connecting → disconnected → connected.
 */
export function useConnectionStatus(): ConnectionStatus {
  const wsContext = useContext(WebSocketContext);
  const deviceInfo = useStore((state) => state.deviceInfo);
  const stale = useStore((state) => state.liveState?.stale ?? false);

  return useMemo(() => {
    const connecting = wsContext?.connecting ?? false;
    const connected = wsContext?.connected ?? false;
    if (connecting) return 'connecting';
    if (!connected || deviceInfo?.connection_status === 'disconnected' || stale) {
      return 'disconnected';
    }
    return 'connected';
  }, [wsContext, deviceInfo?.connection_status, stale]);
}
