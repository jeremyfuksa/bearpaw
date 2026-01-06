import { useEffect, useMemo, useState } from "react";

import { ScannerWebSocket } from "./ScannerWebSocket";

const defaultWsURL =
  import.meta.env.VITE_WS_URL ||
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

export function useWebSocket(url?: string) {
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

  return { ws, connected, connecting };
}
