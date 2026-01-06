import { useEffect, useMemo, useRef, useState } from "react";

import { useAPI } from "../api/useApi";
import { useStore } from "../store/useStore";
import type { Modulation } from "../types";

interface DirectTuneModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (freq: number) => void;
}

const modulationOptions: Modulation[] = ["FM", "AM", "NFM", "AUTO"];

export function DirectTuneModal({ isOpen, onClose, onSuccess }: DirectTuneModalProps) {
  const api = useAPI();
  const channels = useStore((state) => state.channels);
  const [frequency, setFrequency] = useState("");
  const [modulation, setModulation] = useState<Modulation>("AUTO");
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement;
    const input = modalRef.current?.querySelector("input");
    input?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])"
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [isOpen]);

  const channelRange = useMemo(() => {
    const freqs = channels
      .map((channel) => channel.frequency)
      .filter((value) => Number.isFinite(value));
    if (freqs.length === 0) return null;
    return {
      min: Math.min(...freqs),
      max: Math.max(...freqs),
    };
  }, [channels]);

  const handleClose = () => {
    setFrequency("");
    setModulation("AUTO");
    setError(null);
    onClose();
  };

  if (!isOpen) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const freq = Number.parseFloat(frequency);

    if (Number.isNaN(freq)) {
      setError("Enter a valid frequency.");
      return;
    }
    if (channelRange && (freq < channelRange.min || freq > channelRange.max)) {
      setError(
        `Frequency must be between ${channelRange.min.toFixed(4)} and ${channelRange.max.toFixed(
          4
        )} MHz.`
      );
      return;
    }

    try {
      await api.setFrequency(freq, modulation);
      onSuccess(freq);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to tune frequency.");
    }
  };

  return (
    <div
      className="modal-overlay"
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="direct-tune-title"
    >
      <div className="modal-content" ref={modalRef} onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h3 id="direct-tune-title">Tune Direct</h3>
          <button
            className="icon-button"
            type="button"
            onClick={handleClose}
            aria-label="Close tune dialog"
          >
            ×
          </button>
        </header>
        <form onSubmit={handleSubmit} className="modal-form">
          <label className="field-label" htmlFor="direct-frequency">
            Frequency
          </label>
          <div className="frequency-input">
            <input
              id="direct-frequency"
              type="text"
              placeholder="151.2500"
              value={frequency}
              onChange={(event) => setFrequency(event.target.value)}
              pattern="[0-9]+\.?[0-9]*"
              autoComplete="off"
            />
            <span className="unit">MHz</span>
          </div>
          <div className="field-hint">
            {channelRange
              ? `Device range: ${channelRange.min.toFixed(4)}–${channelRange.max.toFixed(4)} MHz`
              : "Device limits unavailable. Scanner will validate the frequency."}
          </div>

          <div className="modulation-selector">
            <div className="field-label">Modulation</div>
            <div className="button-group" role="group" aria-label="Modulation">
              {modulationOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={modulation === option ? "pill active" : "pill"}
                  onClick={() => setModulation(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="submit" className="btn btn-primary">
              Tune →
            </button>
            <button type="button" className="btn btn-secondary" onClick={handleClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
