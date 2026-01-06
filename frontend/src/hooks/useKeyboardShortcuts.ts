import { useEffect } from "react";

import { useAPI } from "../api/useApi";
import { useStore } from "../store/useStore";

interface ShortcutHandlers {
  openDirectTune: () => void;
  openMemoryBrowser: () => void;
  openShortcuts: () => void;
  closeOverlays: () => void;
  jumpToBankView: () => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const api = useAPI();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        handlers.closeOverlays();
        return;
      }

      const modifierPressed = event.ctrlKey || event.metaKey;
      if (!modifierPressed) return;

      switch (event.key.toLowerCase()) {
        case "s":
          event.preventDefault();
          api.sendScan();
          break;
        case "h":
          event.preventDefault();
          api.sendHold();
          break;
        case "f":
          event.preventDefault();
          handlers.openDirectTune();
          break;
        case "m":
          event.preventDefault();
          handlers.openMemoryBrowser();
          break;
        case "b":
          event.preventDefault();
          handlers.jumpToBankView();
          break;
        case "c": {
          event.preventDefault();
          const liveState = useStore.getState().liveState;
          if (liveState && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(liveState.frequency.toFixed(4));
          }
          break;
        }
        case "?":
          event.preventDefault();
          handlers.openShortcuts();
          break;
        case "arrowup":
          event.preventDefault();
          api.sendKey("UP");
          break;
        case "arrowdown":
          event.preventDefault();
          api.sendKey("DOWN");
          break;
        default:
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [api, handlers]);
}
