import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { ScannerWebSocket } from "./ScannerWebSocket";

// Detect if running in Tauri
const isTauri = '__TAURI__' in window;

console.log('WebSocket: isTauri =', isTauri, 'window.__TAURI__ =', window.__TAURI__);

// WebSocket URL configuration
// For development, always use the backend on port 8000
const defaultWsURL = 'ws://localhost:8000/ws';

console.log('WebSocket URL:', defaultWsURL);

interface WebSocketContextValue {
  ws: ScannerWebSocket;
  connected: boolean;
  connecting: boolean;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

export function WebSocketProvider({ children, url }: { children: React.ReactNode; url?: string }) {
  const wsURL = url ?? defaultWsURL;
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);

  const ws = useMemo(() => new ScannerWebSocket(wsURL), [wsURL]);

  useEffect(() => {
    const unsubscribe = ws.on("connection", (data) => {
      if ("status" in data) {
        setConnected(data.status === "connected");
        setConnecting(data.status === "connecting");
      }
    });

    ws.connect();

    return () => {
      unsubscribe();
      ws.disconnect();
    };
  }, [ws]);

  const value = useMemo(() => ({ ws, connected, connecting }), [ws, connected, connecting]);

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket(url?: string): WebSocketContextValue {
  const context = useContext(WebSocketContext);

  if (!context) {
    throw new Error("useWebSocket must be used within WebSocketProvider");
  }

  return context;
}
