import { useEffect, useRef } from 'react';

import { getAPI } from '../api/useApi';
import { useStore } from '../store/useStore';

interface ShortcutHandlers {
  openActivityLog: () => void;
  openMemoryBrowser: () => void;
  closeOverlays: () => void;
  openShortcuts: () => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const api = getAPI();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const current = handlersRef.current;
      if (event.key === 'Escape') {
        current.closeOverlays();
        return;
      }

      const modifierPressed = event.ctrlKey || event.metaKey;
      if (!modifierPressed) return;

      switch (event.key.toLowerCase()) {
        case 's':
          event.preventDefault();
          api.sendScan();
          break;
        case 'h':
          event.preventDefault();
          api.sendHold();
          break;
        case 'c': {
          event.preventDefault();
          const liveState = useStore.getState().liveState;
          if (liveState && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(liveState.frequency.toFixed(4)).catch(() => {});
          }
          break;
        }
        case 'l': {
          event.preventDefault();
          if (event.shiftKey) {
            current.openActivityLog();
          } else {
            const liveState = useStore.getState().liveState;
            if (liveState?.frequency || liveState?.channel) {
              api.toggleTemporaryLockout({
                frequency: liveState.frequency,
                channel: liveState.channel,
              });
            }
          }
          break;
        }
        case '?':
          event.preventDefault();
          current.openShortcuts();
          break;
        case 'm':
          event.preventDefault();
          current.openMemoryBrowser();
          break;
        case 'arrowup':
          event.preventDefault();
          api.sendKey('UP');
          break;
        case 'arrowdown':
          event.preventDefault();
          api.sendKey('DOWN');
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [api]);
}
