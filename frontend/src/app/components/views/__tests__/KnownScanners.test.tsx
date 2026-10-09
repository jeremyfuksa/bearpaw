import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMockApiClient } from '../../../../test/mocks/mockApiClient';
import { getAPI } from '../../../../api/useApi';
import { useStore } from '../../../../store/useStore';
import type { ScannerProfile } from '../../../../types';
import { KnownScanners } from '../KnownScanners';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
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
    useStore.setState({
      deviceInfo: { connection_status: 'connected', model: 'BC125AT', scanner_id: 'a' },
    });
  });

  it('renders nothing when no profile is stored', async () => {
    setup([]);
    await waitFor(() => expect(api.getScanners).toHaveBeenCalled());
    expect(screen.queryByText(/BC125AT/)).not.toBeInTheDocument();
  });

  it('shows one profile as a single line, not a list', async () => {
    setup([profile()]);
    expect(await screen.findByText('BC125AT')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Synced 3d ago')).toBeInTheDocument();
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
    expect(items[1]).toHaveTextContent('Not connected · last seen 2h ago');
  });

  it('explains an unplugged profile instead of offering to switch to it', async () => {
    setup([
      profile(),
      profile({ scanner_id: 'b', model: 'BC75XLT', loaded: false, connected: false }),
    ]);
    const items = await screen.findAllByRole('listitem');
    expect(items[1]).toHaveTextContent('Plug it in to use it.');
    expect(items[0]).not.toHaveTextContent('Plug it in');
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
});
