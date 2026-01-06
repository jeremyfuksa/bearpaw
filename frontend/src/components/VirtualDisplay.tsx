import { useMemo } from "react";

import { SignalStrength } from "./SignalStrength";
import { useStore } from "../store/useStore";

function formatFrequency(frequency: number) {
  return `${frequency.toFixed(4)} MHz`;
}

export function VirtualDisplay() {
  const liveState = useStore((state) => state.liveState);
  const channels = useStore((state) => state.channels);
  const channelNumber =
    liveState?.channel && liveState.channel > 0 ? liveState.channel : null;
  const channel = useMemo(() => {
    if (!channelNumber) return null;
    return channels.find((item) => item.index === channelNumber) ?? null;
  }, [channels, channelNumber]);
  const frequencyMatch = useMemo(() => {
    if (!Number.isFinite(liveState?.frequency)) return null;
    const freq = liveState!.frequency;
    return (
      channels.find((item) => Math.abs(item.frequency - freq) < 0.00005) ?? null
    );
  }, [channels, liveState]);
  const matchedChannel = channel ?? frequencyMatch;

  const hasFrequency = Number.isFinite(liveState?.frequency);
  const hasSignal = !!liveState?.squelch_open;
  const isScanning = !!liveState && liveState.mode === "SCAN" && !hasSignal;
  const isCloseCall = hasSignal && !matchedChannel && liveState?.mode === "SCAN";
  const rssi = liveState?.rssi ?? 0;

  const alphaText =
    matchedChannel?.alpha_tag ||
    (channelNumber ? `CH${channelNumber}` : isCloseCall ? "Close Call" : "DIRECT");
  const frequencyText = hasFrequency ? formatFrequency(liveState!.frequency) : "NO SIGNAL";
  const displayText = !liveState ? "NO SIGNAL" : isScanning ? "Scanning" : alphaText;

  return (
    <section
      className={`virtual-display${isScanning ? " scanning" : ""}`}
      aria-label="Scanner display"
    >
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveState
          ? isScanning
            ? "Scanning"
            : hasFrequency
              ? `Tuned to ${liveState.frequency.toFixed(4)} megahertz, ${liveState.modulation}`
              : "Scanner not receiving signal"
          : "Scanner not receiving signal"}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {liveState?.squelch_open ? "Squelch open, receiving signal" : ""}
      </div>

      <div className="display-surface" aria-hidden="true">
        <div className="display-primary">{displayText}</div>
        {liveState && hasFrequency && (
          <div className="display-meta">
            <SignalStrength rssi={rssi} />
            {!isScanning && (
              <>
                <span className="meta-channel">
                  {channelNumber
                    ? `CH${channelNumber}`
                    : matchedChannel
                      ? `CH${matchedChannel.index}`
                      : isCloseCall
                        ? "CC"
                        : "DIRECT"}
                </span>
                <span className="meta-mode">{liveState?.modulation ?? "--"}</span>
                <span className="meta-frequency">{frequencyText}</span>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
