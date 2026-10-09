import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMockApiClient } from '../../../../test/mocks/mockApiClient';
import { getAPI } from '../../../../api/useApi';
import { useStore } from '../../../../store/useStore';
import type { ScannerProfile } from '../../../../types';
import { APIError } from '../../../../api/client';
import { confirmDialog } from '../../../../tauri-shell';
import { toast } from 'sonner';
import { KnownScanners, forgetMessage } from '../KnownScanners';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../../tauri-shell', () => ({ confirmDialog: vi.fn() }));
vi.mock('../../../../api/useApi', () => ({
  getAPI: vi.fn(() => createMockApiClient()),
}));

const NOW = Date.now() / 1000;

const profile = (overrides: Partial<ScannerProfile> = {}): ScannerProfile => ({
  scanner_id: 'a',
  model: 'BC125AT',
  display_name: null,
  last_seen: NOW,
  synced_at: NOW - 3 * 86400,
  channels: 350,
  bank_names: 0,
  history_shared: false,
  loaded: true,
  connected: true,
  ...overrides,
});

/** #417: the Device tab's known-scanner line and list. */
describe('KnownScanners', () => {
  let api: ReturnType<typeof createMockApiClient>;

  const setup = (profiles: ScannerProfile[]) => {
    api = createMockApiClient();
    api.getScanners.mockResolvedValue(profiles);
    vi.mocked(getAPI).mockReturnValue(api as unknown as ReturnType<typeof getAPI>);
    render(<KnownScanners />);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(confirmDialog).mockResolvedValue(true);
    useStore.setState({
      deviceInfo: { connection_status: 'connected', model: 'BC125AT', scanner_id: 'a' },
    });
  });

  it('renders nothing when no profile is stored', async () => {
    setup([]);
    await waitFor(() => expect(api.getScanners).toHaveBeenCalled());
    expect(screen.queryByText(/BC125AT/)).not.toBeInTheDocument();
  });

  /** Status and sync age repeat the Status row and status bar, so the line drops them. */
  it('shows one profile as a single line, not a list', async () => {
    setup([profile()]);
    expect(await screen.findByText('BC125AT')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
    expect(screen.queryByText('Synced 3d ago')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText('Known scanners')).not.toBeInTheDocument();
  });

  it('lists two profiles and marks the connected one', async () => {
    setup([
      profile({ display_name: 'Base' }),
      profile({
        scanner_id: 'b',
        model: 'BC75XLT',
        display_name: 'Truck',
        loaded: false,
        connected: false,
        last_seen: NOW - 2 * 3600,
      }),
    ]);
    const items = await screen.findAllByRole('listitem');
    expect(screen.getByRole('heading', { name: 'Known scanners' })).toBeInTheDocument();
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('aria-current', 'true');
    expect(items[0]).toHaveTextContent('Base');
    expect(items[1]).not.toHaveAttribute('aria-current');
    expect(items[0]).toHaveTextContent('Connected');
    expect(items[0]).toHaveTextContent('Synced 3d ago');
    expect(items[1]).toHaveTextContent('Last seen 2h ago');
    expect(items[1]).not.toHaveTextContent('Not connected');
  });

  it('renames with the keyboard and returns focus to Rename', async () => {
    const user = userEvent.setup();
    setup([profile()]);
    const button = await screen.findByRole('button', { name: 'Rename BC125AT' });
    await user.click(button);
    await user.type(screen.getByRole('textbox', { name: 'Name for this BC125AT' }), 'Base{Enter}');

    expect(api.renameScanner).toHaveBeenCalledWith('a', 'Base');
    expect(await screen.findByText('Base')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename Base' })).toHaveFocus();
  });

  it('cancels a rename with Escape and saves nothing', async () => {
    const user = userEvent.setup();
    setup([profile({ display_name: 'Base' })]);
    await user.click(await screen.findByRole('button', { name: 'Rename Base' }));
    await user.type(screen.getByRole('textbox'), 'xyz{Escape}');

    expect(api.renameScanner).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Rename Base' })).toHaveFocus();
  });

  it('clears a name when saved blank', async () => {
    const user = userEvent.setup();
    setup([profile({ display_name: 'Base' })]);
    await user.click(await screen.findByRole('button', { name: 'Rename Base' }));
    await user.clear(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');

    expect(api.renameScanner).toHaveBeenCalledWith('a', null);
    expect(await screen.findByRole('button', { name: 'Rename BC125AT' })).toBeInTheDocument();
  });

  // ---- Forget (#417) ----

  const truck = (overrides: Partial<ScannerProfile> = {}) =>
    profile({
      scanner_id: 'b',
      model: 'BC75XLT',
      display_name: 'Truck',
      loaded: false,
      connected: false,
      channels: 120,
      bank_names: 3,
      ...overrides,
    });

  /**
   * The gate is `loaded`, not `connected`: an unplugged scanner's memory stays
   * in use and the cache flush would write it straight back, so the API
   * refuses it. A build gating on `connected` offers Forget on the second row.
   */
  it('hides Forget on the loaded profile, connected or unplugged', async () => {
    setup([profile({ display_name: 'Base', connected: false }), truck()]);
    await screen.findAllByRole('listitem');

    expect(screen.queryByRole('button', { name: 'Forget Base' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Forget Truck' })).toBeInTheDocument();
  });

  it('states exactly what is deleted, and never says settings', () => {
    const message = forgetMessage(truck());
    expect(message).toBe(
      'Forget Truck? This deletes its 120 cached channels, 3 bank names and activity ' +
        "history from Bearpaw. The scanner itself isn't changed.",
    );
    expect(message).not.toMatch(/setting/i);
  });

  it('counts in the singular and leaves out what is not stored', () => {
    expect(forgetMessage(truck({ channels: 1, bank_names: 1 }))).toContain(
      'its 1 cached channel, 1 bank name and activity history',
    );
    expect(forgetMessage(truck({ channels: 251, bank_names: 0 }))).toContain(
      'its 251 cached channels and activity history',
    );
    expect(forgetMessage(truck({ channels: 0, bank_names: 0, history_shared: true }))).toBe(
      'Forget Truck? Activity history stays, because your other BC75XLT shares it. ' +
        "The scanner itself isn't changed.",
    );
  });

  it('says history is kept when another profile shares the model', () => {
    const message = forgetMessage(truck({ history_shared: true }));
    expect(message).toContain('its 120 cached channels and 3 bank names from Bearpaw.');
    expect(message).toContain('Activity history stays, because your other BC75XLT shares it.');
  });

  it('forgets after confirming, removes the row and keeps focus in the block', async () => {
    const user = userEvent.setup();
    setup([profile(), truck(), truck({ scanner_id: 'c', display_name: 'Shack' })]);
    await user.click(await screen.findByRole('button', { name: 'Forget Truck' }));

    expect(confirmDialog).toHaveBeenCalledWith(forgetMessage(truck()), 'Forget Truck');
    expect(api.forgetScanner).toHaveBeenCalledWith('b');
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(screen.queryByText('Truck')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Known scanners' })).toHaveFocus();
    expect(toast.success).toHaveBeenCalledWith('Forgot Truck');
  });

  it('deletes nothing when the confirmation is declined', async () => {
    const user = userEvent.setup();
    vi.mocked(confirmDialog).mockResolvedValue(false);
    setup([profile(), truck()]);
    await user.click(await screen.findByRole('button', { name: 'Forget Truck' }));

    expect(confirmDialog).toHaveBeenCalled();
    expect(api.forgetScanner).not.toHaveBeenCalled();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps the row and explains a 409 from a scanner plugged in meanwhile', async () => {
    const user = userEvent.setup();
    setup([profile(), truck()]);
    api.forgetScanner.mockRejectedValue(new APIError('conflict', 409, 'scanner_loaded'));
    await user.click(await screen.findByRole('button', { name: 'Forget Truck' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't forget Truck: it's the scanner in use"),
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
