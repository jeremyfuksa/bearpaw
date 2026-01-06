import { useCallback, useEffect, useRef, useState } from "react";

import { useAPI } from "./api/useApi";
import "./App.css";
import { ActivityLog } from "./components/ActivityLog";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { NotificationCenter } from "./components/NotificationCenter";
import { PrimaryControls } from "./components/PrimaryControls";
import { ShortcutsHelp } from "./components/ShortcutsHelp";
import { VirtualDisplay } from "./components/VirtualDisplay";
import { VolumeIndicator } from "./components/VolumeIndicator";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useNotifications } from "./hooks/useNotifications";
import { useStore } from "./store/useStore";
import { stepToChannel } from "./utils/channelNavigation";
import { useWebSocket } from "./websocket/useWebSocket";
import type { EventMessage, ProgressMessage, StateUpdateMessage } from "./types";

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
  const addActivityLogEntry = useStore((state) => state.addActivityLogEntry);
  const liveChannel = useStore((state) => state.liveState?.channel);

  const { notifications, addNotification, removeNotification } = useNotifications();

  const [showActivityLog, setShowActivityLog] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [banks, setBanks] = useState<boolean[]>(() => Array.from({ length: 10 }, () => true));
  const [banksBusy, setBanksBusy] = useState(false);
  const [temporaryLockoutChannels, setTemporaryLockoutChannels] = useState<number[]>([]);
  const syncInProgressRef = useRef(false);
  const syncStartedRef = useRef(false);
  const lastHitOpenRef = useRef(false);
  const lockoutTimerRef = useRef<number | null>(null);

  const notifyError = useCallback(
    (fallback: string, error: unknown) => {
      const message = error instanceof Error && error.message ? error.message : fallback;
      addNotification({
        type: "error",
        message: message === fallback ? fallback : `${fallback}: ${message}`,
        duration: 5000,
      });
    },
    [addNotification]
  );

  const openShortcuts = useCallback(() => setShowShortcutsHelp(true), []);
  const openActivity = useCallback(() => setShowActivityLog(true), []);
  const closeOverlays = useCallback(() => {
    setShowShortcutsHelp(false);
    setShowActivityLog(false);
  }, []);

  useEffect(() => {
    return () => {
      if (lockoutFlashTimerRef.current !== null) {
        window.clearTimeout(lockoutFlashTimerRef.current);
      }
    };
  }, []);

  useKeyboardShortcuts({
    openShortcuts,
    openActivityLog: openActivity,
    closeOverlays,
  });

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
        try {
          const lockouts = await api.getLockouts({ includeFrequencies: false });
          if (!active) return;
          setTemporaryLockoutChannels(lockouts.temporary_channels.map((entry) => entry.channel));
        } catch (error) {
          if (active) {
            console.warn("Failed to load initial lockouts", error);
          }
        }
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

  const deviceConnection = deviceInfo?.connection_status;
  const deviceConnected = deviceConnection === "connected";
  const deviceDisconnected = deviceConnection === "disconnected";

  useEffect(() => {
    if (!deviceConnected) return;
    let active = true;

    const refreshLockouts = async () => {
      try {
        const lockouts = await api.getLockouts({ includeFrequencies: false });
        if (!active) return;
        setTemporaryLockoutChannels(lockouts.temporary_channels.map((entry) => entry.channel));
      } catch (error) {
        if (active) {
          console.warn("Failed to refresh lockouts", error);
        }
      }
    };

    refreshLockouts();
    const interval = window.setInterval(refreshLockouts, 5000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [api, deviceConnected]);

  useEffect(() => {
    if (!deviceConnected) return;
    let active = true;

    const loadBanks = async () => {
      try {
        const result = await api.getBanks();
        if (!active) return;
        if (Array.isArray(result.banks) && result.banks.length === 10) {
          setBanks(result.banks);
        }
      } catch (error) {
        if (active) {
          console.warn("Failed to load banks", error);
        }
      }
    };

    loadBanks();

    return () => {
      active = false;
    };
  }, [api, deviceConnected]);

  const [scanOverrideUntil, setScanOverrideUntil] = useState<number | null>(null);
  const normalizedMode = (liveState?.mode ?? "").toString().trim().toUpperCase();
  const isHold = normalizedMode === "HOLD";
  const isScanOverrideActive =
    scanOverrideUntil !== null && Date.now() < scanOverrideUntil;
  const isDeviceDisconnected = deviceDisconnected || Boolean(liveState?.stale);
  const lockoutFlashTimerRef = useRef<number | null>(null);
  const [lockoutFlash, setLockoutFlash] = useState<"temp" | "perm" | null>(null);

  const triggerLockoutFlash = useCallback((kind: "temp" | "perm") => {
    setLockoutFlash(kind);
    if (lockoutFlashTimerRef.current !== null) {
      window.clearTimeout(lockoutFlashTimerRef.current);
    }
    lockoutFlashTimerRef.current = window.setTimeout(() => {
      setLockoutFlash(null);
      lockoutFlashTimerRef.current = null;
    }, 900);
  }, []);

  const handleToggle = useCallback(async () => {
    if (!deviceConnected || toggleBusy) return;
    setToggleBusy(true);
    try {
      if (isHold) {
        setScanOverrideUntil(Date.now() + 1200);
        await api.sendScan();
      } else {
        await api.sendHold();
      }
    } catch (error) {
      console.warn("Failed to toggle scan/hold", error);
      notifyError("Failed to toggle scan/hold", error);
    } finally {
      setToggleBusy(false);
    }
  }, [api, deviceConnected, isHold, notifyError, toggleBusy]);

  const triggerTemporaryLockout = useCallback(async () => {
    if (!deviceConnected) return;
    try {
      const frequency = liveState?.frequency;
      if (!frequency) {
        notifyError("No active frequency for lockout", new Error("missing_frequency"));
        return;
      }
      const result = await api.toggleTemporaryLockout({
        frequency,
        channel: liveState?.channel ?? undefined,
      });
      if (result.channel) {
        setTemporaryLockoutChannels((prev) =>
          result.locked
            ? prev.includes(result.channel!)
              ? prev
              : [...prev, result.channel!]
            : prev.filter((channelId) => channelId !== result.channel)
        );
      }
      triggerLockoutFlash("temp");
      const lockoutChannel = result.channel ?? liveState?.channel;
      addNotification({
        type: "info",
        message: result.locked
          ? lockoutChannel
            ? `Temporary lockout enabled for CH ${lockoutChannel}`
            : "Temporary lockout enabled"
          : lockoutChannel
            ? `Temporary lockout cleared for CH ${lockoutChannel}`
            : "Temporary lockout cleared",
        duration: 2500,
      });
      if ((liveState?.mode ?? "").toString().trim().toUpperCase() === "HOLD") {
        window.setTimeout(() => {
          api.sendScan().catch((error) => {
            console.warn("Failed to resume scan after temporary lockout", error);
          });
        }, 1000);
      }
    } catch (error) {
      console.warn("Failed to toggle lockout", error);
      notifyError("Failed to toggle lockout", error);
    }
  }, [
    addNotification,
    api,
    deviceConnected,
    liveState?.frequency,
    liveState?.channel,
    notifyError,
  ]);

  const triggerPermanentLockout = useCallback(async () => {
    if (!deviceConnected) return;
    try {
      const channelId = liveState?.channel ?? null;
      if (!channelId) {
        notifyError("No channel selected for lockout", new Error("missing_channel"));
        return;
      }
      const updated = await api.togglePermanentLockout(channelId);
      setChannels(channels.map((channel) => (channel.index === updated.index ? updated : channel)));
      setTemporaryLockoutChannels((prev) => prev.filter((channel) => channel !== updated.index));
      triggerLockoutFlash("perm");
      addNotification({
        type: "info",
        message: `Permanent lockout ${updated.lockout ? "enabled" : "cleared"} for CH ${updated.index}`,
        duration: 2500,
      });
      if ((liveState?.mode ?? "").toString().trim().toUpperCase() === "HOLD") {
        window.setTimeout(() => {
          api.sendScan().catch((error) => {
            console.warn("Failed to resume scan after permanent lockout", error);
          });
        }, 1000);
      }
    } catch (error) {
      console.warn("Failed to toggle lockout", error);
      notifyError("Failed to toggle lockout", error);
    }
  }, [addNotification, api, channels, deviceConnected, liveState?.channel, notifyError, setChannels]);

  const handleLockout = useCallback(
    (clickCount: number) => {
      if (lockoutTimerRef.current !== null) {
        window.clearTimeout(lockoutTimerRef.current);
        lockoutTimerRef.current = null;
      }
      if (clickCount >= 2) {
        void triggerPermanentLockout();
        return;
      }
      lockoutTimerRef.current = window.setTimeout(() => {
        lockoutTimerRef.current = null;
        void triggerTemporaryLockout();
      }, 500);
    },
    [triggerPermanentLockout, triggerTemporaryLockout]
  );

  const handleClearTemporaryLockouts = useCallback(async () => {
    if (!deviceConnected) return;
    try {
      const result = await api.clearTemporaryLockouts();
      addNotification({
        type: result.failed.length > 0 ? "warning" : "info",
        message:
          result.failed.length > 0
            ? `Cleared ${result.cleared.length} temp lockouts, ${result.failed.length} failed`
            : `Cleared ${result.cleared.length} temp lockouts`,
        duration: 2500,
      });
    } catch (error) {
      console.warn("Failed to clear temporary lockouts", error);
      notifyError("Failed to clear temporary lockouts", error);
    }
  }, [addNotification, api, deviceConnected, notifyError]);

  const handleClearGlobalLockouts = useCallback(async () => {
    if (!deviceConnected) return;
    try {
      const result = await api.clearGlobalLockouts();
      if (result.cleared.length > 0) {
        setTemporaryLockoutChannels((prev) =>
          prev.filter((channelId) => !result.cleared.includes(channelId))
        );
      }
      addNotification({
        type: result.failed.length > 0 ? "warning" : "info",
        message:
          result.failed.length > 0
            ? `Cleared ${result.cleared.length} global lockouts, ${result.failed.length} failed`
            : `Cleared ${result.cleared.length} global lockouts`,
        duration: 2500,
      });
    } catch (error) {
      console.warn("Failed to clear global lockouts", error);
      notifyError("Failed to clear global lockouts", error);
    }
  }, [addNotification, api, deviceConnected, notifyError]);

  const handleClearChannelLockouts = useCallback(async () => {
    if (!deviceConnected) return;
    try {
      const result = await api.clearChannelLockouts();
      if (result.cleared.length > 0) {
        setChannels(
          channels.map((channel) =>
            result.cleared.includes(channel.index) ? { ...channel, lockout: false } : channel
          )
        );
      }
      addNotification({
        type: result.failed.length > 0 ? "warning" : "info",
        message:
          result.failed.length > 0
            ? `Cleared ${result.cleared.length} channel lockouts, ${result.failed.length} failed`
            : `Cleared ${result.cleared.length} channel lockouts`,
        duration: 2500,
      });
    } catch (error) {
      console.warn("Failed to clear channel lockouts", error);
      notifyError("Failed to clear channel lockouts", error);
    }
  }, [addNotification, api, channels, deviceConnected, notifyError, setChannels]);

  const handleBankToggle = useCallback(
    async (index: number) => {
      if (banksBusy) return;
      const nextBanks = banks.map((active, idx) => (idx === index ? !active : active));
      setBanks(nextBanks);
      setBanksBusy(true);
      try {
        const result = await api.setBanks(nextBanks);
        if (Array.isArray(result.banks) && result.banks.length === 10) {
          setBanks(result.banks);
        }
      } catch (error) {
        console.warn("Failed to update banks", error);
        notifyError("Failed to update banks", error);
        setBanks((prev) => prev.map((active, idx) => (idx === index ? !active : active)));
      } finally {
        setBanksBusy(false);
      }
    },
    [api, banks, banksBusy, notifyError]
  );

  return (
    <div className="mvp">
      <div
        className={`mvp-ui${isDeviceDisconnected ? " mvp-ui--disabled" : ""}`}
        aria-label="Uniden Scanner Control"
      >
        <div className="mvp-layout">
          <div className="mvp-main">
            <header className="mvp-header">
              <div className="mvp-headerLeft">
                <ConnectionStatus />
                <VolumeIndicator />
              </div>
              <div className="mvp-headerActions">
                <button
                  className="mvp-actionButton"
                  onClick={() => setShowShortcutsHelp(true)}
                  aria-label="Open keyboard shortcuts"
                >
                  ?
                </button>
                <button
                  className={`mvp-actionButton${
                    lockoutFlash === "perm"
                      ? " mvp-actionButton--lockoutPerm"
                      : lockoutFlash === "temp"
                        ? " mvp-actionButton--lockoutTemp"
                        : ""
                  }`}
                  onClick={(event) => handleLockout(event.detail)}
                  disabled={(!deviceConnected && !connected) || toggleBusy}
                  title="Click: temporary lockout. Double-click: permanent lockout."
                  aria-label="Lockout (click temporary, double-click permanent)"
                  aria-pressed={Boolean(lockoutFlash)}
                >
                  L/O
                </button>
                <button
                  className="mvp-actionButton"
                  onClick={handleClearTemporaryLockouts}
                  disabled={!deviceConnected}
                  title="Clear temporary lockouts"
                  aria-label="Clear temporary lockouts"
                >
                  CLR TL/O
                </button>
                <button
                  className="mvp-actionButton"
                  onClick={handleClearGlobalLockouts}
                  disabled={!deviceConnected}
                  title="Clear global lockouts"
                  aria-label="Clear global lockouts"
                >
                  CLR L/O
                </button>
                <button
                  className="mvp-actionButton"
                  onClick={handleClearChannelLockouts}
                  disabled={!deviceConnected}
                  title="Clear channel lockouts"
                  aria-label="Clear channel lockouts"
                >
                  CLR CH
                </button>
                <PrimaryControls
                  isHolding={isHold}
                  onToggle={handleToggle}
                  disabled={(!deviceConnected && !connected) || toggleBusy}
                />
              </div>
            </header>

            <VirtualDisplay
              temporaryLockoutChannels={temporaryLockoutChannels}
              scanOverrideActive={isScanOverrideActive}
            />

            <div className="mvp-bankControls" aria-label="Bank controls">
              {banks.map((active, index) => (
                <button
                  key={`bank-${index + 1}`}
                  className={`mvp-bankToggle${active ? " mvp-bankToggle--active" : ""}`}
                  type="button"
                  onClick={() => handleBankToggle(index)}
                  disabled={banksBusy || (!deviceConnected && !connected)}
                >
                  {index + 1}
                </button>
              ))}
            </div>
          </div>

          <aside className="mvp-side" aria-label="Recent hits">
            <section className="mvp-hitLog">
              <div className="mvp-hitLogHeader">
                <div>
                  <p className="mvp-hitLogTitle">Recent hits</p>
                  <p className="mvp-hitLogSubtitle">Last 5</p>
                </div>
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
                    <button
                      key={entry.id}
                      className="mvp-hitLogRow"
                      type="button"
                      onClick={() => {
                        if (entry.channel) {
                          void stepToChannel(api, liveChannel, entry.channel);
                        }
                      }}
                      disabled={!connected || !entry.channel}
                    >
                      <span>{entry.alpha_tag || "—"}</span>
                      <span>{entry.frequency.toFixed(4)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>

      <ActivityLog isOpen={showActivityLog} onClose={() => setShowActivityLog(false)} />
      <ShortcutsHelp isOpen={showShortcutsHelp} onClose={() => setShowShortcutsHelp(false)} />
      <NotificationCenter notifications={notifications} onDismiss={removeNotification} />
    </div>
  );
}

export default App;
