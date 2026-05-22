import { useEffect } from 'react';
import { isTauriRuntime } from '../tauri-shell';
import type { Tab } from '../app/App';

export interface MenuEventHandlers {
  onNavigate: (tab: Tab) => void;
  onHold: () => void;
  onScan: () => void;
  onSyncMemory: () => void;
  onOpenDocs: () => void;
  onOpenIssues: () => void;
  onShowAbout: () => void;
}

const NAV_TABS: Record<string, Tab> = {
  'bearpaw:nav:scan': 'Scan',
  'bearpaw:nav:device': 'Device',
  'bearpaw:nav:channels': 'Channels',
};

const EVENT_NAMES = [
  'bearpaw:nav:scan',
  'bearpaw:nav:device',
  'bearpaw:nav:channels',
  'bearpaw:cmd:hold',
  'bearpaw:cmd:scan',
  'bearpaw:cmd:sync-memory',
  'bearpaw:help:docs',
  'bearpaw:help:issues',
  'bearpaw:help:about',
] as const;

export function useMenuEvents(handlers: MenuEventHandlers): void {
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      for (const name of EVENT_NAMES) {
        const unlisten = await listen(name, () => {
          const navTab = NAV_TABS[name];
          if (navTab) {
            handlers.onNavigate(navTab);
            return;
          }
          switch (name) {
            case 'bearpaw:cmd:hold':
              handlers.onHold();
              break;
            case 'bearpaw:cmd:scan':
              handlers.onScan();
              break;
            case 'bearpaw:cmd:sync-memory':
              handlers.onSyncMemory();
              break;
            case 'bearpaw:help:docs':
              handlers.onOpenDocs();
              break;
            case 'bearpaw:help:issues':
              handlers.onOpenIssues();
              break;
            case 'bearpaw:help:about':
              handlers.onShowAbout();
              break;
          }
        });
        if (cancelled) {
          void unlisten();
          return;
        }
        unlisteners.push(() => void unlisten());
      }
    })().catch((error) => {
      console.warn('[Menu] Failed to subscribe to menu events', error);
    });

    return () => {
      cancelled = true;
      for (const off of unlisteners) off();
    };
  }, [handlers]);
}
