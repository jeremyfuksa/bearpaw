import { useCallback } from 'react';
import { toast } from 'sonner';
import { getAPI } from '../api/useApi';
import { useStore } from '../store/useStore';

// The getting-started page lists the supported models under "What you'll need";
// it has no anchor for that list, so link the page.
export const SUPPORTED_SCANNERS_URL = 'https://bearpaw.app/docs/getting-started.html';

/**
 * Whether the connected radio is one Bearpaw recognises but has no command set
 * for (`diagnostic_code === 'unsupported_model'`, set by the poll loop), and
 * whether the user already said "Not now" to the panel for it.
 *
 * The dismissal is keyed on the scanner profile (`scanner_id`), falling back to
 * the model, and stored as a preference so it survives a restart: the panel
 * must never ask twice.
 */
export function useUnsupportedScanner(): {
  isUnsupported: boolean;
  model: string | null;
  dismissed: boolean;
  dismiss: () => void;
} {
  const deviceInfo = useStore((state) => state.deviceInfo);
  const dismissedKeys = useStore((state) => state.preferences.unsupportedPanelDismissed);
  const updatePreferences = useStore((state) => state.updatePreferences);

  const isUnsupported =
    deviceInfo?.connection_status === 'connected' &&
    deviceInfo.diagnostic_code === 'unsupported_model';
  const model = isUnsupported ? (deviceInfo?.model ?? null) : null;
  const key = deviceInfo?.scanner_id ?? deviceInfo?.model ?? null;
  const dismissed = key !== null && dismissedKeys.includes(key);

  const dismiss = useCallback(() => {
    if (key === null) return;
    const current = useStore.getState().preferences.unsupportedPanelDismissed;
    if (current.includes(key)) return;
    const next = [...current, key];
    getAPI()
      .setPreference('unsupported_panel_dismissed', next)
      .then(() => updatePreferences({ unsupportedPanelDismissed: next }))
      .catch((error) => {
        console.error('Failed to save preference', error);
        toast.error('Failed to save preference. Your previous setting is still active.');
      });
  }, [key, updatePreferences]);

  return { isUnsupported, model, dismissed, dismiss };
}
