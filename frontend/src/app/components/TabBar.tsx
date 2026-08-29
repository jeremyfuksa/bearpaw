import { useRef } from 'react';
import bearpawLogo from '@/assets/bearpaw-logo.svg';
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
 *
 * Implements the ARIA tabs pattern (a11y S1): roving tabindex (only the
 * selected tab is in the Tab order) and Arrow/Home/End keys move between tabs.
 * Arrow selection also runs onTabChange (App's handleTabChange), so the
 * leaving-Device scan-resume fires on keyboard nav just as it does on click.
 */
export function TabBar({ currentTab, onTabChange }: TabBarProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusTab = (index: number) => {
    const tab = TABS[index];
    onTabChange(tab);
    tabRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusTab((index + 1) % TABS.length);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusTab((index - 1 + TABS.length) % TABS.length);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(TABS.length - 1);
        break;
    }
  };

  return (
    // The logo is a SIBLING of the tablist, not a child. `role="tablist"` may
    // only contain tabs; an image inside it is an ARIA violation and would be
    // announced as part of the tab set. The border and background move to this
    // wrapper so the bar still reads as one strip.
    <div className="flex shrink-0 items-center border-b border-scanner-bg-dark bg-scanner-bg-dark/40 px-4 py-1.5">
      <div role="tablist" aria-label="Views" className="flex items-center gap-1">
        {TABS.map((tab, index) => {
          const active = tab === currentTab;
          return (
            <button
              key={tab}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${tab.toLowerCase()}`}
              aria-selected={active}
              aria-controls="view-panel"
              tabIndex={active ? 0 : -1}
              onClick={() => onTabChange(tab)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={`rounded-md px-3 py-1 font-sans text-xs transition-colors ${
                active
                  ? 'bg-white/10 text-scanner-text-light'
                  : 'text-white/60 hover:bg-white/5 hover:text-white/80'
              }`}
            >
              {tab}
            </button>
          );
        })}
      </div>

      {/* Decorative: the window already carries an h1 "Bearpaw", so the
          wordmark repeats a name the page has stated. alt="" keeps it out of
          the accessibility tree rather than announcing it twice. */}
      <img
        src={bearpawLogo}
        alt=""
        aria-hidden
        className="ml-auto h-4 w-auto select-none opacity-70"
      />
    </div>
  );
}
