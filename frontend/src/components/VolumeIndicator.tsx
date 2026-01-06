import { useCallback, useEffect, useRef, useState } from "react";

import { useAPI } from "../api/useApi";
import { useStore } from "../store/useStore";

export function VolumeIndicator() {
  const volume = useStore((state) => state.liveState?.volume ?? 0);
  const deviceInfo = useStore((state) => state.deviceInfo);
  const updateLiveState = useStore((state) => state.updateLiveState);
  const api = useAPI();
  const [isOpen, setIsOpen] = useState(false);
  const [draftVolume, setDraftVolume] = useState(volume);
  const [busy, setBusy] = useState(false);
  const isConnected = deviceInfo?.connection_status === "connected";
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setDraftVolume(volume);
    }
  }, [isOpen, volume]);

  const applyVolume = useCallback(async () => {
    if (draftVolume === volume) {
      setIsOpen(false);
      return;
    }
    setBusy(true);
    try {
      await api.setVolume(draftVolume);
      updateLiveState({ volume: draftVolume });
    } catch (error) {
      console.warn("Failed to set volume", error);
    } finally {
      setBusy(false);
      setIsOpen(false);
    }
  }, [api, draftVolume, updateLiveState, volume]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) {
        return;
      }
      applyVolume();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [applyVolume, isOpen]);

  return (
    <>
      <div className="volume-popover">
        <button
          className="volume-indicator"
          type="button"
          onClick={() => {
            if (isOpen) {
              applyVolume();
            } else {
              setIsOpen(true);
            }
          }}
          aria-label={`Volume ${volume} out of 15`}
          aria-expanded={isOpen}
          disabled={!isConnected}
          ref={buttonRef}
        >
          <span className="volume-label">VOL</span>
          <span className="volume-value">{volume}/15</span>
        </button>
        {isOpen && (
          <div className="volume-panel" ref={panelRef} role="dialog" aria-label="Volume">
            <input
              type="range"
              min={0}
              max={15}
              step={1}
              value={draftVolume}
              onChange={(event) => setDraftVolume(Number(event.target.value))}
              disabled={busy}
            />
            <div className="volume-readout">{draftVolume}</div>
          </div>
        )}
      </div>
      {isOpen && (
        <span className="sr-only" aria-live="polite">
          Volume {draftVolume}
        </span>
      )}
    </>
  );
}
