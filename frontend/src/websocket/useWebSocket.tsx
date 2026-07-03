import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ScannerWebSocket } from './ScannerWebSocket';
import { useStore } from '../store/useStore';

function resolveDefaultWsURL(): string {
  const tauriMarker = (window as Window & { __TAURI__?: unknown }).__TAURI__;
  const isTauri = typeof tauriMarker === 'object' && tauriMarker !== null;
  if (isTauri) {
    return 'ws://localhost:8000/ws';
  }

  const envWsURL = (import.meta.env?.VITE_WS_URL as string | undefined)?.trim();
  if (envWsURL) {
    return envWsURL;
  }

  const envApiBase = (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.trim();
  if (envApiBase) {
    if (envApiBase.startsWith('http://') || envApiBase.startsWith('https://')) {
      const parsed = new URL(envApiBase);
      const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProtocol}//${parsed.host}/ws`;
    }
    if (envApiBase.startsWith('/') && typeof window !== 'undefined') {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProtocol}//${window.location.host}/ws`;
    }
  }

  if (typeof window !== 'undefined') {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${window.location.host}/ws`;
  }

  return 'ws://localhost:8000/ws';
}

interface WebSocketContextValue {
  ws: ScannerWebSocket;
  connected: boolean;
  connecting: boolean;
}

export const WebSocketContext = createContext<WebSocketContextValue | null>(null);

export function WebSocketProvider({ children, url }: { children: React.ReactNode; url?: string }) {
  const wsURL = url ?? resolveDefaultWsURL();
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);

  // Lazy-init via useRef so the socket survives any potential useMemo eviction.
  const wsRef = useRef<ScannerWebSocket | null>(null);
  if (wsRef.current === null) {
    wsRef.current = new ScannerWebSocket(wsURL);
  }
  const ws = wsRef.current;

  useEffect(() => {
    const unsubscribe = ws.on('connection', (data) => {
      if ('status' in data) {
        setConnected(data.status === 'connected');
        setConnecting(data.status === 'connecting');
        if (data.status === 'connected') {
          // The backend reseeds its WS sequence counter to 0 on (re)start.
          // Reset our gate on every (re)connect so a restarted backend's fresh
          // low sequences aren't dropped as stale (issue #136).
          useStore.getState().resetSequence();
        }
      }
    });

    ws.connect();

    return () => {
      unsubscribe();
      ws.disconnect();
    };
  }, [ws]);

  const value = useMemo(() => ({ ws, connected, connecting }), [ws, connected, connecting]);

  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>;
}

export function useWebSocket(): WebSocketContextValue {
  const context = useContext(WebSocketContext);

  if (!context) {
    throw new Error('useWebSocket must be used within WebSocketProvider');
  }

  return context;
}
