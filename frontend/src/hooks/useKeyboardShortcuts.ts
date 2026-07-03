import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { getAPI } from '../api/useApi';
import { useStore } from '../store/useStore';

interface ShortcutHandlers {
  openActivityLog: () => void;
  openMemoryBrowser: () => void;
  closeOverlays: () => void;
  openShortcuts: () => void;
}

/**
 * True when the keyboard event originates from a field the user is typing into
 * (text input, textarea, select, or any contentEditable element). Global
 * shortcuts must not fire in these — most importantly Ctrl/Cmd+C, which would
 * otherwise `preventDefault()` and hijack the native copy of selected text.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
  );
}

/**
 * Report a rejected fire-and-forget scanner command. Keeps unhandled promise
 * rejections out of the console and gives the user feedback via the same toast
 * mechanism the rest of the app uses.
 */
function reportCommandError(label: string, error: unknown): void {
  console.error(`[shortcuts] ${label} failed`, error);
  toast.error(`Failed to ${label}`);
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const api = getAPI();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Never intercept keys while the user is typing into a field.
      if (isEditableTarget(event.target)) return;

      const current = handlersRef.current;
      if (event.key === 'Escape') {
        current.closeOverlays();
        return;
      }

      // The help shortcut is a bare "?" (Shift+/ on most layouts) with no
      // Ctrl/Cmd — handle it before the modifier gate so it stays reachable.
      if (event.key === '?') {
        event.preventDefault();
        current.openShortcuts();
        return;
      }

      const modifierPressed = event.ctrlKey || event.metaKey;
      if (!modifierPressed) return;

      switch (event.key.toLowerCase()) {
        case 's':
          event.preventDefault();
          api.sendScan().catch((err) => reportCommandError('scan', err));
          break;
        case 'h':
          event.preventDefault();
          api.sendHold().catch((err) => reportCommandError('hold', err));
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
              api
                .toggleTemporaryLockout({
                  frequency: liveState.frequency,
                  channel: liveState.channel ?? undefined,
                })
                .catch((err) => reportCommandError('toggle lockout', err));
            }
          }
          break;
        }
        case 'm':
          event.preventDefault();
          current.openMemoryBrowser();
          break;
        case 'arrowup':
          // BC125AT up-arrow key code (docs/BC125AT_PROTOCOL.md §5.7). The
          // backend allowlist only accepts single-char codes; 'UP' is rejected.
          event.preventDefault();
          api.sendKey('^').catch((err) => reportCommandError('navigate up', err));
          break;
        case 'arrowdown':
          // BC125AT down-arrow key code.
          event.preventDefault();
          api.sendKey('V').catch((err) => reportCommandError('navigate down', err));
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [api]);
}
