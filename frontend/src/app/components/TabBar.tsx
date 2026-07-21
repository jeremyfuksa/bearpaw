import type { Tab } from '../App';

const TABS: Tab[] = ['Scan', 'Channels', 'Device'];

interface TabBarProps {
  currentTab: Tab;
  onTabChange: (tab: Tab) => void;
}

/**
 * In-window navigation across the three views. Shares `currentTab` state
 * with the native menu (File/View), so clicking a tab and picking the
 * matching menu item flip the same state — the two paths never drift.
 */
export function TabBar({ currentTab, onTabChange }: TabBarProps) {
  return (
    <div
      role="tablist"
      aria-label="Views"
      className="flex shrink-0 items-center gap-1 border-b border-scanner-bg-dark bg-scanner-bg-dark/40 px-4 py-1.5"
    >
      {TABS.map((tab) => {
        const active = tab === currentTab;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onTabChange(tab)}
            className={`rounded-md px-3 py-1 font-sans text-xs transition-colors ${
              active
                ? 'bg-white/10 text-scanner-text-light'
                : 'text-white/40 hover:bg-white/5 hover:text-white/70'
            }`}
          >
            {tab}
          </button>
        );
      })}
    </div>
  );
}
