import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

import { useAPI } from "./api/useApi";
import "./App.css";
import { byPrefixAndName } from "./icons/fontAwesome";
import { useStore } from "./store/useStore";
import { useWebSocket } from "./websocket/useWebSocket";
import type { EventMessage, ProgressMessage, StateUpdateMessage } from "./types";

function formatFrequency(value: number | undefined) {
  if (!value || value <= 0) return null;
  return value.toFixed(4);
}

function rssiToPercent(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value >= 0 && value <= 100) return value;
  if (value > 100) return 100;

  const clamped = Math.max(-120, Math.min(0, value));
  return Math.round(((clamped + 120) / 120) * 100);
}

function percentToBars(percent: number) {
  if (percent >= 80) return 4;
  if (percent >= 60) return 3;
  if (percent >= 40) return 2;
  if (percent >= 20) return 1;
  return 0;
}

function isMeaningfulAlphaTag(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed !== "0" && trimmed !== "127";
}

function SignalIcon({ bars }: { bars: number }) {
  const normalizedBars = Math.max(0, Math.min(4, Math.floor(bars)));
  const inactiveOpacity = 0.2;

  return (
    <svg
      className="mvp-signalSvg"
      aria-label={`Signal strength: ${normalizedBars} of 4`}
      viewBox="0 0 640 640"
      role="img"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M216 384C202.7 384 192 394.7 192 408L192 520C192 533.3 202.7 544 216 544C229.3 544 240 533.3 240 520L240 408C240 394.7 229.3 384 216 384z"
        fill="currentColor"
        opacity={normalizedBars >= 1 ? 1 : inactiveOpacity}
      />
      <path
        d="M344 312C344 298.7 333.3 288 320 288C306.7 288 296 298.7 296 312L296 520C296 533.3 306.7 544 320 544C333.3 544 344 533.3 344 520L344 312z"
        fill="currentColor"
        opacity={normalizedBars >= 2 ? 1 : inactiveOpacity}
      />
      <path
        d="M424 192C410.7 192 400 202.7 400 216L400 520C400 533.3 410.7 544 424 544C437.3 544 448 533.3 448 520L448 216C448 202.7 437.3 192 424 192z"
        fill="currentColor"
        opacity={normalizedBars >= 3 ? 1 : inactiveOpacity}
      />
      <path
        d="M552 120C552 106.7 541.3 96 528 96C514.7 96 504 106.7 504 120L504 520C504 533.3 514.7 544 528 544C541.3 544 552 533.3 552 520L552 120z"
        fill="currentColor"
        opacity={normalizedBars >= 4 ? 1 : inactiveOpacity}
      />
    </svg>
  );
}

function App() {
  const api = useAPI();
  const { ws, connected, connecting } = useWebSocket();

  const updateLiveState = useStore((state) => state.updateLiveState);
  const setDeviceInfo = useStore((state) => state.setDeviceInfo);
  const setChannels = useStore((state) => state.setChannels);
  const setConnected = useStore((state) => state.setConnected);
  const setConnecting = useStore((state) => state.setConnecting);
  const liveState = useStore((state) => state.liveState);
  const deviceInfo = useStore((state) => state.deviceInfo);
  const channels = useStore((state) => state.channels);
  const activityLog = useStore((state) => state.activityLog);

  const [toggleBusy, setToggleBusy] = useState(false);
  const syncInProgressRef = useRef(false);
  const syncStartedRef = useRef(false);
  const lastHitOpenRef = useRef(false);
  const addActivityLogEntry = useStore((state) => state.addActivityLogEntry);

  useEffect(() => {
    setConnected(connected);
    setConnecting(connecting);
  }, [connected, connecting, setConnected, setConnecting]);

  useEffect(() => {
    const unsubscribeState = ws.on("state_update", (message) => {
      const payload = message as StateUpdateMessage;
      updateLiveState(payload.data, payload.sequence);
      const squelchOpen = payload.data.squelch_open;
      const isNewHit = squelchOpen === true && !lastHitOpenRef.current;
      if (typeof squelchOpen === "boolean") {
        lastHitOpenRef.current = squelchOpen;
      }
      if (
        isNewHit &&
        payload.data.frequency &&
        (payload.data.alpha_tag || payload.data.channel)
      ) {
        addActivityLogEntry({
          id: `${payload.timestamp}-${payload.sequence}`,
          timestamp: payload.timestamp,
          frequency: payload.data.frequency,
          channel: payload.data.channel ?? null,
          alpha_tag: payload.data.alpha_tag ?? null,
          type: "hit",
        });
      }
    });

    const unsubscribeEvent = ws.on("event", (message) => {
      const payload = message as EventMessage;
      if (payload.event === "state_stale") {
        updateLiveState({ stale: true });
      }
    });

    const unsubscribeProgress = ws.on("progress", (message) => {
      const payload = message as ProgressMessage;
      const isComplete =
        payload.percent >= 100 ||
        /sync complete/i.test(payload.message) ||
        /sync cancelled/i.test(payload.message);
      if (isComplete && syncInProgressRef.current) {
        syncInProgressRef.current = false;
        api
          .getChannels()
          .then((channelData) => setChannels(channelData))
          .catch((error) => console.warn("Failed to refresh channels after sync", error));
      }
    });

    return () => {
      unsubscribeState();
      unsubscribeEvent();
      unsubscribeProgress();
    };
  }, [addActivityLogEntry, api, setChannels, updateLiveState, ws]);

  useEffect(() => {
    let active = true;

    const loadInitialData = async () => {
      try {
        const [status, info, channelData] = await Promise.all([
          api.getStatus(),
          api.getDeviceInfo(),
          api.getChannels(),
        ]);
        if (!active) return;
        updateLiveState(status);
        setDeviceInfo(info);
        setChannels(channelData);
      } catch (error) {
        if (!active) return;
        console.warn("Failed to load initial scanner data", error);
      }
    };

    loadInitialData();

    return () => {
      active = false;
    };
  }, [api, setDeviceInfo, setChannels, updateLiveState]);

  useEffect(() => {
    if (syncStartedRef.current) return;
    if (!deviceInfo || deviceInfo.connection_status !== "connected") return;
    if (channels.length > 0) return;

    let active = true;
    const startMemorySync = async () => {
      try {
        const result = await api.syncMemory();
        if (!active) return;
        if (result.status === "started" || result.status === "already_running") {
          syncInProgressRef.current = true;
          syncStartedRef.current = true;
        }
      } catch (error) {
        if (!active) return;
        console.warn("Failed to start memory sync", error);
      }
    };

    startMemorySync();

    return () => {
      active = false;
    };
  }, [api, channels.length, deviceInfo]);

  useEffect(() => {
    let active = true;

    const refreshDeviceInfo = async () => {
      try {
        const info = await api.getDeviceInfo();
        if (active) {
          setDeviceInfo(info);
        }
      } catch (error) {
        if (active) {
          console.warn("Failed to refresh device info", error);
        }
      }
    };

    refreshDeviceInfo();
    const interval = window.setInterval(refreshDeviceInfo, 5000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [api, setDeviceInfo]);

  const getAlphaTag = useCallback(
    (channelIndex: number | null | undefined): string | null => {
      if (!channelIndex) return null;
      const channel = channels.find((ch) => ch.index === channelIndex);
      if (!channel || !isMeaningfulAlphaTag(channel.alpha_tag)) return null;
      return channel.alpha_tag;
    },
    [channels]
  );

  const deviceConnection = deviceInfo?.connection_status;
  const deviceConnected = deviceConnection === "connected";
  const deviceConnecting = deviceConnection === "connecting";
  const deviceDisconnected = deviceConnection === "disconnected";

  const normalizedMode = (liveState?.mode ?? "").toString().trim().toUpperCase();
  const isHold = normalizedMode === "HOLD";
  const isDirect = normalizedMode === "DIRECT";
  const isScanMode = normalizedMode === "SCAN";
  const isSquelchOpen = Boolean(liveState?.squelch_open);
  const isListening = isSquelchOpen || isHold || isDirect;
  const isStarting = !liveState;
  const showScanning = isScanMode && !isSquelchOpen;
  const frequencyText = formatFrequency(liveState?.frequency);
  const liveAlphaTag = isMeaningfulAlphaTag(liveState?.alpha_tag) ? liveState?.alpha_tag : null;
  const alphaTag = liveAlphaTag || getAlphaTag(liveState?.channel);
  const isDeviceDisconnected = deviceDisconnected || Boolean(liveState?.stale);
  const displayText = isDeviceDisconnected
    ? "--"
    : isStarting
    ? "Starting..."
    : showScanning
    ? "Scanning..."
    : isListening
    ? alphaTag || frequencyText || "No Signal"
    : "Scanning...";
  const signalBars = percentToBars(rssiToPercent(isSquelchOpen ? liveState?.rssi : 0));

  const statusText = useMemo(() => {
    const model = deviceInfo?.model || "Device";
    if (deviceDisconnected || liveState?.stale) return `${model} Disconnected`;
    if (deviceConnecting) return `${model} Connecting`;
    if (deviceConnected) return `${model} Connected`;
    if (connecting) return `${model} Connecting`;
    if (connected) return `${model} Connected`;
    return `${model} Disconnected`;
  }, [
    connected,
    connecting,
    deviceConnected,
    deviceConnecting,
    deviceDisconnected,
    deviceInfo?.model,
    liveState?.stale,
  ]);

  const statusDotState = deviceDisconnected || liveState?.stale
    ? "disconnected"
    : deviceConnecting
    ? "connecting"
    : deviceConnected
    ? "connected"
    : connected
    ? "connected"
    : connecting
    ? "connecting"
    : "disconnected";

  const handleToggle = useCallback(async () => {
    if (!deviceConnected || toggleBusy) return;
    setToggleBusy(true);
    try {
      if (isHold) {
        await api.sendScan();
      } else {
        await api.sendHold();
      }
    } catch (error) {
      console.warn("Failed to toggle scan/hold", error);
    } finally {
      setToggleBusy(false);
    }
  }, [api, deviceConnected, isHold, toggleBusy]);

  return (
    <div className="mvp">
      <div
        className={`mvp-ui${isDeviceDisconnected ? " mvp-ui--disabled" : ""}`}
        aria-label="Uniden Scanner Control"
      >
        <header className="mvp-header">
          <div className="mvp-headerLeft">
            <span className={`mvp-statusDot mvp-statusDot--${statusDotState}`} aria-hidden="true" />
            <p className="mvp-statusText">
              {statusText}
            </p>
          </div>
          {isHold && <p className="mvp-holdLabel">HOLD</p>}
        </header>

        <div className="mvp-display" role="status" aria-label="Scanner display">
          <div className="mvp-displayRow">
            <p className="mvp-displayText">{displayText}</p>
            <div className="mvp-displayIcon" aria-hidden="true">
              {isDeviceDisconnected ? (
                <FontAwesomeIcon icon={byPrefixAndName.fab["usb"]} className="mvp-icon" />
              ) : isStarting || showScanning ? (
                <FontAwesomeIcon icon={byPrefixAndName.fas["rotate"]} spin className="mvp-icon" />
              ) : (
                <SignalIcon bars={signalBars} />
              )}
            </div>
          </div>
        </div>

        <div className="mvp-controls">
          <button
            className="mvp-scanToggle"
            onClick={handleToggle}
            disabled={(!deviceConnected && !connected) || toggleBusy}
          >
            {isHold ? "Scan" : "Hold"}
          </button>
        </div>

        <section className="mvp-hitLog" aria-label="Recent hits">
          <div className="mvp-hitLogHeader">
            <p className="mvp-hitLogTitle">Recent hits</p>
            <p className="mvp-hitLogSubtitle">Last 5</p>
          </div>
          {activityLog.length === 0 ? (
            <div className="mvp-hitLogEmpty">No hits yet.</div>
          ) : (
            <div className="mvp-hitLogTable">
              <div className="mvp-hitLogRow mvp-hitLogRow--head">
                <span>Alpha tag</span>
                <span>Frequency</span>
              </div>
              {activityLog.map((entry) => (
                <div key={entry.id} className="mvp-hitLogRow">
                  <span>{entry.alpha_tag || "—"}</span>
                  <span>{entry.frequency.toFixed(4)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

      </div>
    </div>
  );
}

export default App;
