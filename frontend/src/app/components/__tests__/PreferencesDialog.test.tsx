import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { PreferencesDialog, PREFERENCE_KEY_MAP } from '../PreferencesDialog';
import { useStore } from '../../../store/useStore';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../../api/useApi', () => ({
  API_BASE: 'http://127.0.0.1:3030/api/v1',
}));

describe('PreferencesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      preferences: { ...useStore.getState().preferences, analyticsScope: 'scanner' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderDialog = () => render(<PreferencesDialog isOpen onClose={() => {}} />);

  it('renders the preference controls under a Preferences title', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Preferences' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: /Hit Minimum Duration/i })).toBeInTheDocument();
  });

  it('renders the external links under About', async () => {
    renderDialog();
    expect(screen.queryByRole('button', { name: /Github/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'About' }));
    expect(screen.getByRole('button', { name: /Github/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Support Bearpaw/i })).toBeInTheDocument();
  });

  it('applies a preference only after the backend confirms persistence', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    renderDialog();

    await userEvent.click(screen.getByRole('switch', { name: /Combine Scanner Analytics/i }));

    await waitFor(() => expect(useStore.getState().preferences.analyticsScope).toBe('all'));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/preferences'),
      expect.objectContaining({ body: JSON.stringify({ analytics_scope: 'all' }) }),
    );
  });

  it('saves the Recent Hits clock-time switch under the key the store reads back (#816)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    useStore.setState({
      preferences: { ...useStore.getState().preferences, recentHitsTimeFormat: 'relative' },
    });
    renderDialog();

    await userEvent.click(screen.getByRole('switch', { name: /Show Clock Time in Recent Hits/i }));

    await waitFor(() => expect(useStore.getState().preferences.recentHitsTimeFormat).toBe('clock'));
    // The key mapStoredPreferences reads, so the choice survives a relaunch.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/preferences'),
      expect.objectContaining({ body: JSON.stringify({ recent_hits_time_format: 'clock' }) }),
    );
  });

  it('offers the Recent Hits time zone only while clock time is on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));
    useStore.setState({
      preferences: { ...useStore.getState().preferences, recentHitsTimeFormat: 'relative' },
    });
    renderDialog();
    expect(screen.queryByRole('combobox', { name: 'Recent Hits Time Zone' })).toBeNull();

    await userEvent.click(screen.getByRole('switch', { name: /Show Clock Time in Recent Hits/i }));

    expect(
      await screen.findByRole('combobox', { name: 'Recent Hits Time Zone' }),
    ).toBeInTheDocument();
  });

  it('keeps the saved preference and reports a persistence failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));
    renderDialog();

    await userEvent.click(screen.getByRole('switch', { name: /Combine Scanner Analytics/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/previous setting/i)),
    );
    expect(useStore.getState().preferences.analyticsScope).toBe('scanner');
    expect(screen.getByRole('switch', { name: /Combine Scanner Analytics/i })).not.toBeChecked();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<PreferencesDialog isOpen onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('PREFERENCE_KEY_MAP', () => {
  // Regression guard: preferences set via handlePreferenceChange must map to the
  // snake_case key the backend persists and App.tsx reads back. A missing entry
  // silently saves under the camelCase key (via `?? key`) and the setting looks
  // non-persistent — the auto-connect bug. These keys differ camel↔snake and
  // are set from the Preferences UI, so each MUST be in the map.
  it.each([
    ['dataRetentionDays', 'data_retention_days'],
    ['hitMinDuration', 'hit_min_duration'],
    ['recentHitsTimeFormat', 'recent_hits_time_format'],
    ['recentHitsTimezone', 'recent_hits_timezone'],
  ])('maps %s to %s', (camel, snake) => {
    expect(PREFERENCE_KEY_MAP[camel as keyof typeof PREFERENCE_KEY_MAP]).toBe(snake);
  });
});
