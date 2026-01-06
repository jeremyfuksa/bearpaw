import { useEffect, useMemo, useRef, useState } from "react";

import { useStore } from "../store/useStore";
import { SignalStrength } from "./SignalStrength";
import spinnerIconRaw from "../assets/spinner.svg?raw";
import usbIconRaw from "../assets/usb.svg?raw";
import plugIconRaw from "../assets/plug.svg?raw";

function formatFrequency(frequency: number) {
  return `${frequency.toFixed(4)} MHz`;
}

function isMeaningfulAlphaTag(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed !== "0" && trimmed !== "127";
}

function withCurrentColor(svg: string) {
  if (svg.includes("fill=\"currentColor\"")) return svg;
  return svg.replace("<svg", "<svg fill=\"currentColor\"");
}

interface VirtualDisplayProps {
  temporaryLockoutChannels?: number[];
  scanOverrideActive?: boolean;
}

export function VirtualDisplay({
  temporaryLockoutChannels = [],
  scanOverrideActive = false,
}: VirtualDisplayProps) {
  const liveState = useStore((state) => state.liveState);
  const channels = useStore((state) => state.channels);
  const deviceInfo = useStore((state) => state.deviceInfo);
  const socketConnected = useStore((state) => state.connected);
  const socketConnecting = useStore((state) => state.connecting);
  const [debouncedSignal, setDebouncedSignal] = useState(false);
  const dropoffTimerRef = useRef<number | null>(null);
  const lastHitRef = useRef<{
    frequency: number;
    modulation: string;
    channel: number | null;
    alphaTag: string | null;
    rssi: number;
  } | null>(null);
  const spinnerIcon = withCurrentColor(spinnerIconRaw);
  const usbIcon = withCurrentColor(usbIconRaw);
  const plugIcon = withCurrentColor(plugIconRaw);
  const channelNumber =
    liveState?.channel && liveState.channel > 0 ? liveState.channel : null;
  const effectiveState =
    debouncedSignal && lastHitRef.current
      ? {
          frequency: lastHitRef.current.frequency,
          modulation: lastHitRef.current.modulation,
          channel: lastHitRef.current.channel ?? null,
          alpha_tag: lastHitRef.current.alphaTag,
          rssi: lastHitRef.current.rssi,
        }
      : liveState;
  const effectiveChannel =
    effectiveState?.channel && effectiveState.channel > 0 ? effectiveState.channel : null;
  const channel = useMemo(() => {
    if (!effectiveChannel) return null;
    return channels.find((item) => item.index === effectiveChannel) ?? null;
  }, [channels, effectiveChannel]);
  const frequencyMatch = useMemo(() => {
    if (!Number.isFinite(effectiveState?.frequency)) return null;
    const freq = effectiveState!.frequency;
    return (
      channels.find((item) => Math.abs(item.frequency - freq) < 0.00005) ?? null
    );
  }, [channels, effectiveState]);
  const matchedChannel = channel ?? frequencyMatch;

  const hasFrequency = Number.isFinite(effectiveState?.frequency);
  const hasSignal = Boolean(liveState?.squelch_open);
  const normalizedMode = (liveState?.mode ?? "").toString().trim().toUpperCase();
  const isHold = normalizedMode === "HOLD";
  const isDirect = normalizedMode === "DIRECT";
  const isScanning =
    Boolean(liveState) &&
    (scanOverrideActive || normalizedMode === "SCAN") &&
    !debouncedSignal;
  const isStale = Boolean(liveState?.stale);
  const isSocketDisconnected = !socketConnected && !socketConnecting;
  const isUsbDisconnected = deviceInfo?.connection_status === "disconnected" || isStale;
  const disconnectReason = isSocketDisconnected
    ? "socket"
    : isUsbDisconnected
      ? "usb"
      : null;
  const isDisconnected = disconnectReason !== null;
  const isCloseCall = debouncedSignal && !matchedChannel && normalizedMode === "SCAN";
  const showDetails = !isDisconnected && (debouncedSignal || isHold || isDirect);
  const rssi = effectiveState?.rssi ?? 0;

  const liveAlphaTag = isMeaningfulAlphaTag(effectiveState?.alpha_tag)
    ? effectiveState?.alpha_tag
    : null;
  const channelAlphaTag = isMeaningfulAlphaTag(matchedChannel?.alpha_tag)
    ? matchedChannel?.alpha_tag
    : null;
  const tempLockoutActive =
    effectiveChannel !== null && temporaryLockoutChannels.includes(effectiveChannel);
  const fallbackLabel = effectiveChannel
    ? `CH ${effectiveChannel}`
    : matchedChannel
      ? `CH ${matchedChannel.index}`
      : isCloseCall
        ? "Close Call"
        : "DIRECT";
  const primaryLabel = liveAlphaTag || channelAlphaTag || fallbackLabel;
  const frequencyText = hasFrequency ? formatFrequency(effectiveState!.frequency) : "NO SIGNAL";
  const displayText = disconnectReason
    ? disconnectReason === "usb"
      ? "USB Error"
      : "Socket Error"
    : !liveState
      ? "NO SIGNAL"
      : isScanning
        ? "Scanning..."
        : primaryLabel;
  const detailChannel = effectiveChannel
    ? `CH ${effectiveChannel}`
    : matchedChannel
      ? `CH ${matchedChannel.index}`
      : isCloseCall
        ? "CC"
        : "DIRECT";
  const modulationText = effectiveState?.modulation ?? "--";
  const lockoutText = matchedChannel?.lockout ? "· L/O" : tempLockoutActive ? "· TL/O" : "";
  const statusIcon =
    isDisconnected
      ? disconnectReason === "socket"
        ? plugIcon
        : usbIcon
      : isScanning
        ? spinnerIcon
        : null;
  const showSignalStrength = !isDisconnected && !isScanning;

  const hasLiveState = Boolean(liveState);

  useEffect(() => {
    if (!hasLiveState) {
      setDebouncedSignal(false);
      lastHitRef.current = null;
      if (dropoffTimerRef.current !== null) {
        window.clearTimeout(dropoffTimerRef.current);
        dropoffTimerRef.current = null;
      }
      return;
    }

    if (hasSignal) {
      if (liveState) {
        lastHitRef.current = {
          frequency: liveState.frequency,
          modulation: liveState.modulation,
          channel: liveState.channel ?? null,
          alphaTag: liveState.alpha_tag ?? null,
          rssi: liveState.rssi ?? 0,
        };
      }
      setDebouncedSignal(true);
      if (dropoffTimerRef.current !== null) {
        window.clearTimeout(dropoffTimerRef.current);
        dropoffTimerRef.current = null;
      }
      return;
    }

    if (dropoffTimerRef.current !== null) {
      window.clearTimeout(dropoffTimerRef.current);
    }
    dropoffTimerRef.current = window.setTimeout(() => {
      setDebouncedSignal(false);
      dropoffTimerRef.current = null;
    }, 900);

    return () => {
      if (dropoffTimerRef.current !== null) {
        window.clearTimeout(dropoffTimerRef.current);
        dropoffTimerRef.current = null;
      }
    };
  }, [hasLiveState, hasSignal]);


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
        <div className="display-row">
          <div className="display-primary">{displayText}</div>
          {liveState && (
            <div className="display-icon">
              {showSignalStrength ? (
                <SignalStrength rssi={rssi} />
              ) : statusIcon ? (
                <span
                  className={`display-iconSvg${isScanning ? " display-iconSvg--spin" : ""}`}
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: statusIcon }}
                />
              ) : null}
            </div>
          )}
        </div>
        {liveState && hasFrequency && (
          <div className={`display-secondary${showDetails ? "" : " display-secondary--empty"}`}>
            <span className="detail-text">
              {showDetails
                ? `${frequencyText} · ${modulationText} · ${detailChannel}${lockoutText}`
                : "\u00A0"}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
