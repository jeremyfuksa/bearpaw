import { useEffect, useMemo, useState } from "react";

import { ScannerWebSocket } from "./ScannerWebSocket";

const defaultWsURL =
  import.meta.env.VITE_WS_URL ||
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

let sharedWs: ScannerWebSocket | null = null;
let sharedUrl: string | null = null;
let subscribers = 0;

export function useWebSocket(url?: string) {
  const wsURL = url ?? defaultWsURL;
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const ws = useMemo(() => {
    if (!sharedWs || sharedUrl !== wsURL) {
      sharedWs?.disconnect();
      sharedWs = new ScannerWebSocket(wsURL);
      sharedUrl = wsURL;
    }
    return sharedWs;
  }, [wsURL]);

  useEffect(() => {
    subscribers += 1;
    const unsubscribe = ws.on("connection", (data) => {
      if ("status" in data) {
        setConnected(data.status === "connected");
        setConnecting(data.status === "connecting");
      }
    });

    ws.connect();

    return () => {
      unsubscribe();
      subscribers = Math.max(0, subscribers - 1);
      if (subscribers === 0) {
        ws.disconnect();
      }
    };
  }, [ws]);

  return { ws, connected, connecting };
}
