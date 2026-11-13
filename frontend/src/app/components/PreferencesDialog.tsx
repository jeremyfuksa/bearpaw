import { useCallback, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Heart, Code, RefreshCw } from 'lucide-react';

import appIcon from '@/assets/app-icon.png';
import { cn } from '../../lib/utils';
import { API_BASE } from '../../api/useApi';
import { useStore, type Preferences } from '../../store/useStore';
import { openExternalUrl, revealLogs, isTauriRuntime } from '../../tauri-shell';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Slider } from './ui/slider';
import { Switch } from './ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

// Frontend uses camelCase preference keys; the backend persists snake_case
// (see default_preferences() in api/mod.rs). Map every key that differs so
// saved values round-trip through App.tsx's snake_case load path. A missing
// entry silently falls back to the camelCase key via `?? key`, saving under a
// key nobody reads back — the setting then looks non-persistent.
export const PREFERENCE_KEY_MAP: Partial<Record<keyof Preferences, string>> = {
  hitMinDuration: 'hit_min_duration',
  dataRetentionDays: 'data_retention_days',
  checkUpdatesOnLaunch: 'check_updates_on_launch',
  rereadMemoryOnConnect: 'reread_memory_on_connect',
  analyticsScope: 'analytics_scope',
  activityExportTimezone: 'activity_export_timezone',
  recentHitsTimeFormat: 'recent_hits_time_format',
};

const SECTIONS = ['General', 'Data & Storage', 'About'] as const;
type Section = (typeof SECTIONS)[number];

interface PreferencesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Run a manual update check (#273). Owned by App.tsx rather than by a local
   * `useUpdateCheck` call: the hook also runs the startup check, so a second
   * instance here would fire an extra request every time the dialog mounts.
   *
   * Optional so the dialog still renders bare in tests and outside Tauri.
   */
  onCheckForUpdates?: () => void;
  /** True while a manual check is in flight; disables the button. */
  checkingForUpdates?: boolean;
}

/** One setting: label and description on the left, its control on the right. */
function Row({
  label,
  htmlFor,
  description,
  children,
}: {
  label: string;
  htmlFor?: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-8 border-b border-white/5 py-4 last:border-b-0">
      <div className="min-w-0 space-y-0.5">
        <label htmlFor={htmlFor} className="text-sm font-medium text-white">
          {label}
        </label>
        <p className="text-sm text-white/60">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}

const secondaryButton =
  'rounded border border-white/5 bg-black/20 px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-black/40 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Bearpaw's own settings (#926). Everything here changes only the app, never
 * the radio, which is why it lives outside the Scan/Channels/Device tabs:
 * those tabs hold only controls that read from or write to the scanner.
 * Opened from Bearpaw > Settings… on macOS, Edit > Preferences… elsewhere
 * (both CmdOrCtrl+,), and from the gear at the end of the tab bar.
 */
export function PreferencesDialog({
  isOpen,
  onClose,
  onCheckForUpdates,
  checkingForUpdates,
}: PreferencesDialogProps) {
  const preferences = useStore((state) => state.preferences);
  const updatePreferences = useStore((state) => state.updatePreferences);
  const [section, setSection] = useState<Section>('General');

  const handlePreferenceChange = useCallback(
    async <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
      const backendKey = PREFERENCE_KEY_MAP[key] ?? key;
      try {
        const response = await fetch(`${API_BASE}/preferences`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [backendKey]: value }),
        });
        if (!response.ok) throw new Error(`Preference save failed (${response.status})`);
        updatePreferences({ [key]: value } as Partial<Preferences>);
      } catch (error) {
        console.error('Failed to save preference', error);
        toast.error('Failed to save preference. Your previous setting is still active.');
      }
    },
    [updatePreferences],
  );

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      {/* `sm:max-w-none`: DialogContent's default `sm:max-w-lg` otherwise caps
          the width at 32rem, and a plain max-w class does not override a
          responsive one. */}
      <DialogContent
        aria-describedby={undefined}
        className="scanner-modal h-[min(36rem,var(--layout-modal-max-height))] w-[var(--layout-modal-preferences-width)] max-w-[calc(100vw-2rem)] translate-x-[-50%] translate-y-[-50%] gap-0 overflow-hidden rounded-xl border-white/10 p-0 sm:max-w-[calc(100vw-2rem)]"
      >
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Preferences sections"
            className="flex w-[var(--layout-sidebar-device-width)] shrink-0 flex-col gap-1 border-r border-white/10 bg-black/20 p-3"
          >
            <DialogTitle className="px-3 pb-3 pt-1 text-base font-bold text-white">
              Preferences
            </DialogTitle>
            {SECTIONS.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setSection(name)}
                aria-current={section === name ? 'page' : undefined}
                className={cn(
                  'rounded px-3 py-2 text-left text-sm font-medium transition-colors',
                  section === name
                    ? 'bg-brand-hover/20 text-brand-hover'
                    : 'text-white/60 hover:bg-white/5 hover:text-white',
                )}
              >
                {name}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto px-8 pb-6 pt-12">
            <h3 className="mb-2 text-lg font-bold text-white">{section}</h3>

            {section === 'General' && (
              <>
                <Row
                  label="Hit Minimum Duration"
                  description="Minimum seconds a transmission must last to be logged as a hit"
                >
                  <Slider
                    aria-label="Hit Minimum Duration"
                    value={[preferences.hitMinDuration]}
                    onValueChange={(values) => handlePreferenceChange('hitMinDuration', values[0])}
                    min={0.5}
                    max={10}
                    step={0.5}
                    className="w-[var(--size-select-wide)]"
                  />
                  <span className="w-10 text-right font-mono text-sm text-white/70">
                    {preferences.hitMinDuration}s
                  </span>
                </Row>

                {/* Not gated on capabilities: both scanner families cache
                    channel memory and both can be programmed on their own
                    keypad, so the choice applies to every model. */}
                <Row
                  label="Re-read Channels on Connect"
                  htmlFor="reread-memory-on-connect"
                  description="Read channel memory from the scanner at every launch. Turn off for an instant start from the saved copy."
                >
                  <Switch
                    id="reread-memory-on-connect"
                    checked={preferences.rereadMemoryOnConnect}
                    onCheckedChange={(checked) =>
                      handlePreferenceChange('rereadMemoryOnConnect', checked)
                    }
                  />
                </Row>

                {/* Not gated on capabilities: the choice is about the stored
                    history, which can contain hits from a scanner that is not
                    the one attached right now. Hiding it when only one scanner
                    has ever been used would hide it exactly when a user is
                    trying to work out why their old hits disappeared. */}
                <Row
                  label="Combine Scanner Analytics"
                  htmlFor="analytics-scope"
                  description="Count hits from every scanner you have used, not just the connected one"
                >
                  <Switch
                    id="analytics-scope"
                    checked={preferences.analyticsScope === 'all'}
                    onCheckedChange={(checked) =>
                      handlePreferenceChange('analyticsScope', checked ? 'all' : 'scanner')
                    }
                  />
                </Row>

                <Row
                  label="Show Clock Time in Recent Hits"
                  htmlFor="recent-hits-time-format"
                  description="Show when each hit started and how long it lasted, instead of how long ago"
                >
                  <Switch
                    id="recent-hits-time-format"
                    checked={preferences.recentHitsTimeFormat === 'clock'}
                    onCheckedChange={(checked) =>
                      handlePreferenceChange('recentHitsTimeFormat', checked ? 'clock' : 'relative')
                    }
                  />
                </Row>
              </>
            )}

            {section === 'Data & Storage' && (
              <>
                <Row label="Data Retention" description="Auto-delete older logs">
                  <Select
                    value={String(preferences.dataRetentionDays)}
                    onValueChange={(value) =>
                      handlePreferenceChange('dataRetentionDays', parseInt(value))
                    }
                  >
                    <SelectTrigger
                      aria-label="Data Retention"
                      className="h-8 w-[var(--size-select-medium)] border-white/10 bg-white/5 text-sm text-white"
                    >
                      <SelectValue placeholder="Select retention" />
                    </SelectTrigger>
                    <SelectContent className="border-white/10 bg-gray-900 text-white">
                      <SelectItem value="30">30 Days</SelectItem>
                      <SelectItem value="90">90 Days</SelectItem>
                      <SelectItem value="365">1 Year</SelectItem>
                    </SelectContent>
                  </Select>
                </Row>
                {isTauriRuntime() && (
                  <Row
                    label="Log Files"
                    description="Open the folder containing this session's backend log"
                  >
                    <button
                      type="button"
                      onClick={() => void revealLogs()}
                      className={secondaryButton}
                    >
                      Show Log Files
                    </button>
                  </Row>
                )}
              </>
            )}

            {section === 'About' && (
              <>
                <div className="flex items-center gap-3 border-b border-white/5 py-4">
                  <img
                    src={appIcon}
                    alt=""
                    className="h-10 w-10 rounded object-cover shadow-lg shadow-brand-primary/20"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-white">Bearpaw v{__APP_VERSION__}</div>
                    <div className="text-sm text-white/50">Created by Jeremy Fuksa · KF0NUI</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => openExternalUrl('https://github.com/jeremyfuksa/bearpaw')}
                    className={cn(secondaryButton, 'flex items-center gap-1.5')}
                  >
                    <Code size={16} aria-hidden /> Github
                  </button>
                </div>

                {isTauriRuntime() && (
                  <>
                    {/* #273: the app is otherwise fully offline, so the one
                        network call it makes needs an opt-out. */}
                    <Row
                      label="Check for Updates on Launch"
                      htmlFor="check-updates-on-launch"
                      description="Ask GitHub for a newer release when Bearpaw starts"
                    >
                      <Switch
                        id="check-updates-on-launch"
                        checked={preferences.checkUpdatesOnLaunch}
                        onCheckedChange={(checked) =>
                          handlePreferenceChange('checkUpdatesOnLaunch', checked)
                        }
                      />
                    </Row>
                    {onCheckForUpdates && (
                      <Row label="Check Now" description="Same as Help → Check for Updates">
                        <button
                          type="button"
                          onClick={onCheckForUpdates}
                          disabled={checkingForUpdates}
                          className={cn(secondaryButton, 'flex items-center gap-1.5')}
                        >
                          <RefreshCw
                            size={14}
                            aria-hidden
                            className={cn(checkingForUpdates && 'animate-spin')}
                          />
                          {checkingForUpdates ? 'Checking…' : 'Check for Updates'}
                        </button>
                      </Row>
                    )}
                  </>
                )}

                <div className="mt-6 flex items-center gap-4 rounded-lg border border-orange-500/20 bg-gradient-to-br from-orange-500/15 to-orange-900/10 p-4">
                  <div className="flex-1 space-y-1">
                    <h4 className="text-sm font-bold text-white">Control your scanner anywhere.</h4>
                    <p className="text-sm leading-relaxed text-white/70">
                      Your support keeps me building Bearpaw and buys the scanners it learns to work
                      with next.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openExternalUrl('https://buymeacoffee.com/jeremyfuksa')}
                    className="flex shrink-0 items-center gap-2 rounded bg-brand-primary px-3 py-2 text-sm font-bold text-white shadow-lg shadow-brand-hover/20 transition-colors hover:bg-brand-hover"
                  >
                    <Heart aria-hidden className="h-4 w-4 fill-white/20" />
                    Support Bearpaw
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
