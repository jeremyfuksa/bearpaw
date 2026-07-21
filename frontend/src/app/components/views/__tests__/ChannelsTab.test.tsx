import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { ChannelsTab } from '../ChannelsTab';
import { createTestChannel, createTestChannelDraft } from '../../../../test/fixtures';
import { createMockApiClient } from '../../../../test/mocks/mockApiClient';
import { createMockStore } from '../../../../test/mocks/mockStore';
import { useStore } from '../../../../store/useStore';
import { saveExport, pickAndReadFile, confirmDialog } from '../../../../tauri-shell';
import type { ChannelData } from '../../../../types';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
  },
}));

vi.mock('../../../../tauri-shell', () => ({
  saveExport: vi.fn().mockResolvedValue('browser'),
  confirmDialog: vi.fn().mockResolvedValue(true),
  pickAndReadFile: vi.fn(),
}));

vi.mock('../../../../api/useApi', () => ({
  getAPI: vi.fn(() => createMockApiClient()),
  API_BASE: 'http://localhost:8000/api/v1',
}));

vi.mock('../../../../store/useStore', () => ({
  useStore: vi.fn(),
}));

describe('ChannelsTab', () => {
  let mockApiClient: ReturnType<typeof createMockApiClient>;
  let mockChannels: ChannelData[];
  const mockedUseStore = vi.mocked(useStore);
  const setMockStore = (store: ReturnType<typeof createMockStore>) => {
    mockedUseStore.mockImplementation((selector) =>
      selector(store as unknown as Parameters<typeof selector>[0]),
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks wipes the `.mockResolvedValue(true)` set in the vi.mock
    // factory, leaving confirmDialog returning undefined. Re-establish the
    // "confirmed" default so tests that don't override it get a yes.
    vi.mocked(confirmDialog).mockResolvedValue(true);
    mockApiClient = createMockApiClient();
    mockChannels = [
      createTestChannel({ index: 1, frequency: 151.25, bank: 1, alpha_tag: 'Channel 1' }),
      createTestChannel({ index: 51, frequency: 155.5, bank: 2, alpha_tag: 'Channel 51' }),
      createTestChannel({ index: 101, frequency: 160.75, bank: 3, alpha_tag: 'Channel 101' }),
    ];
    mockApiClient.updateChannel = vi.fn().mockResolvedValue(mockChannels[0]);
    mockApiClient.getChannels = vi.fn().mockResolvedValue(mockChannels);

    setMockStore(createMockStore({ channels: mockChannels }));
  });

  describe('Bank Navigation', () => {
    it('should render 10 bank buttons', () => {
      render(<ChannelsTab />);
      const bankButtons = screen.getAllByRole('button', { name: /Bank \d+/i });
      expect(bankButtons).toHaveLength(10);
    });

    it('should highlight active bank', () => {
      render(<ChannelsTab />);
      const bank1 = screen.getByRole('button', { name: /^Bank 1$/i });
      expect(bank1).toHaveClass('bg-brand-primary/20');
    });

    it('should set active bank when button clicked', async () => {
      render(<ChannelsTab />);
      const bank2 = screen.getByRole('button', { name: /Bank 2/i });
      await userEvent.click(bank2);

      expect(bank2).toHaveClass('bg-brand-primary/20');
    });

    it('should filter channels by bank', async () => {
      render(<ChannelsTab />);
      const bank2 = screen.getByRole('button', { name: /Bank 2/i });
      await userEvent.click(bank2);

      expect(screen.getByText(/Channel 51/i)).toBeInTheDocument();
      expect(screen.queryByText(/Channel 1/i)).not.toBeInTheDocument();
    });
  });

  describe('Search Functionality', () => {
    it('should filter channels by frequency', async () => {
      render(<ChannelsTab />);
      const searchInput = screen.getByPlaceholderText(/search frequency or tag/i);
      await userEvent.type(searchInput, '151');

      expect(screen.getByText(/151\.2500/i)).toBeInTheDocument();
    });

    it('should filter channels by tag', async () => {
      render(<ChannelsTab />);
      const bank2 = screen.getByRole('button', { name: /^Bank 2$/i });
      await userEvent.click(bank2);
      const searchInput = screen.getByPlaceholderText(/search frequency or tag/i);
      await userEvent.type(searchInput, 'Channel 51');

      expect(screen.getByText(/Channel 51/i)).toBeInTheDocument();
    });

    it('should show all channels when search is cleared', async () => {
      render(<ChannelsTab />);
      const searchInput = screen.getByPlaceholderText(/search frequency or tag/i);
      await userEvent.type(searchInput, '151');
      await userEvent.clear(searchInput);

      expect(screen.getByText(/Channel 1/i)).toBeInTheDocument();
      expect(screen.queryByText(/Channel 51/i)).not.toBeInTheDocument();
    });

    it('should show no results message for non-matching search', async () => {
      render(<ChannelsTab />);
      const searchInput = screen.getByPlaceholderText(/search frequency or tag/i);
      await userEvent.type(searchInput, 'nonexistent');

      expect(screen.getByText(/No channels match your filters/i)).toBeInTheDocument();
    });
  });

  describe('Channel List Display', () => {
    it('should render channel list', () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/Channel 1/i)).toBeInTheDocument();
    });

    it('should render channel index', () => {
      render(<ChannelsTab />);
      const firstRow = screen.getByText(/Channel 1/i).closest('div')?.parentElement;
      expect(firstRow).not.toBeNull();
      expect(within(firstRow!).getByText('1')).toBeInTheDocument();
    });

    it('should render frequency', () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/151\.2500/i)).toBeInTheDocument();
    });

    it('should render alpha tag', () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/Channel 1/i)).toBeInTheDocument();
    });

    it('should show dash for empty alpha tag', () => {
      const mockChannels = [createTestChannel({ index: 1, alpha_tag: '' })];
      setMockStore(createMockStore({ channels: mockChannels }));

      render(<ChannelsTab />);
      const row = screen.getByText(/151\.2500/i).closest('div')?.parentElement;
      expect(row).not.toBeNull();
      expect(within(row!).getAllByText('—').length).toBeGreaterThan(0);
    });

    it('should render modulation', () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/FM/i)).toBeInTheDocument();
    });

    it('should render delay', () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/2s/i)).toBeInTheDocument();
    });

    it('should render lockout icon when channel is locked out', () => {
      const lockedChannel = createTestChannel({ index: 1, lockout: true });
      setMockStore(createMockStore({ channels: [lockedChannel] }));

      render(<ChannelsTab />);
      const row = screen.getByText(/151\.2500/i).closest('div')?.parentElement;
      expect(row).not.toBeNull();
      expect(row!.querySelector('svg.text-red-400')).not.toBeNull();
    });

    it('should render priority indicator when channel has priority', () => {
      const priorityChannel = createTestChannel({ index: 1, priority: true });
      setMockStore(createMockStore({ channels: [priorityChannel] }));

      render(<ChannelsTab />);
      const row = screen.getByText(/151\.2500/i).closest('div')?.parentElement;
      expect(row).not.toBeNull();
      expect(row!.querySelector('.bg-orange-500')).not.toBeNull();
    });
  });

  describe('Channel Editing', () => {
    it('should open edit sheet when channel row is clicked', async () => {
      render(<ChannelsTab />);
      const channelRow = screen.getByText(/Channel 1/i).closest('div');
      if (channelRow) {
        await userEvent.click(channelRow);
        expect(screen.getByText(/Edit Channel/i)).toBeInTheDocument();
      }
    });

    it('should set editing channel index', async () => {
      render(<ChannelsTab />);
      const channelRow = screen.getByText(/Channel 1/i).closest('div');
      if (channelRow) {
        await userEvent.click(channelRow);
        expect(await screen.findByText(/Edit Channel/i)).toBeInTheDocument();
      }
    });
  });

  describe('Import', () => {
    const pickedCsv = () => ({
      name: 'channels.csv',
      bytes: new TextEncoder().encode('a,b'),
    });
    const pickedSs = () => ({
      name: 'scanner.bc125at_ss',
      bytes: new TextEncoder().encode('Misc\tK+S'),
    });

    it('should prompt for a csv or ss file when import button clicked', async () => {
      vi.mocked(pickAndReadFile).mockResolvedValue(null); // user cancels
      render(<ChannelsTab />);
      await userEvent.click(screen.getByRole('button', { name: /Import/i }));

      expect(pickAndReadFile).toHaveBeenCalledWith(['csv', 'bc125at_ss']);
    });

    it('should dispatch a .csv file to the csv import endpoint', async () => {
      vi.mocked(pickAndReadFile).mockResolvedValue(pickedCsv());
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ imported: 1, errors: [] }),
      });
      global.fetch = fetchSpy as unknown as typeof fetch;
      mockApiClient.getChannels = vi.fn().mockResolvedValue(mockChannels);

      render(<ChannelsTab />);
      await userEvent.click(screen.getByRole('button', { name: /Import/i }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          expect.stringContaining('/memory/import/csv'),
          expect.objectContaining({ method: 'POST' }),
        );
      });
      expect(toast.success).toHaveBeenCalled();
    });

    it('should dispatch a .bc125at_ss file to the ss import endpoint after confirm', async () => {
      vi.mocked(pickAndReadFile).mockResolvedValue(pickedSs());
      vi.mocked(confirmDialog).mockResolvedValue(true);
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ imported: 0, settings_applied: 1, errors: [] }),
      });
      global.fetch = fetchSpy as unknown as typeof fetch;
      mockApiClient.getChannels = vi.fn().mockResolvedValue(mockChannels);

      render(<ChannelsTab />);
      await userEvent.click(screen.getByRole('button', { name: /Import/i }));

      await waitFor(() => {
        expect(confirmDialog).toHaveBeenCalled();
        expect(fetchSpy).toHaveBeenCalledWith(
          expect.stringContaining('/memory/import/bc125at_ss'),
          expect.objectContaining({ method: 'POST' }),
        );
      });
    });

    it('should not import a .ss file when the confirm is declined', async () => {
      vi.mocked(pickAndReadFile).mockResolvedValue(pickedSs());
      vi.mocked(confirmDialog).mockResolvedValue(false);
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;

      render(<ChannelsTab />);
      await userEvent.click(screen.getByRole('button', { name: /Import/i }));

      await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should show error toast on failed import', async () => {
      vi.mocked(pickAndReadFile).mockResolvedValue(pickedCsv());
      global.fetch = vi.fn().mockResolvedValue({ ok: false } as Response);
      mockApiClient.getChannels = vi.fn().mockRejectedValue(new Error('Import failed'));

      render(<ChannelsTab />);
      await userEvent.click(screen.getByRole('button', { name: /Import/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });
    });
  });

  describe('Export CSV', () => {
    it('should save the export when export button clicked', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode('test').buffer),
      } as unknown as Response);

      render(<ChannelsTab />);
      const exportButton = screen.getByRole('button', { name: /Export CSV/i });
      await userEvent.click(exportButton);

      await waitFor(() => {
        expect(saveExport).toHaveBeenCalledWith('channels.csv', expect.any(Uint8Array));
      });
    });

    it('should show error toast on failed export', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false } as Response);

      render(<ChannelsTab />);
      const exportButton = screen.getByRole('button', { name: /Export CSV/i });
      await userEvent.click(exportButton);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to export channels');
      });
    });
  });

  describe('Table Header', () => {
    it('should render table headers', () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/^CH$/i)).toBeInTheDocument();
      expect(screen.getByText(/^FREQ$/i)).toBeInTheDocument();
      expect(screen.getByText(/^TAG$/i)).toBeInTheDocument();
      expect(screen.getByText(/^MODE$/i)).toBeInTheDocument();
      expect(screen.getByText(/^TONE$/i)).toBeInTheDocument();
      expect(screen.getByText(/^DLY$/i)).toBeInTheDocument();
      expect(screen.getByText(/^L\/O$/i)).toBeInTheDocument();
      expect(screen.getByText(/^PRIO$/i)).toBeInTheDocument();
    });
  });

  describe('Selection', () => {
    it('should select all visible rows', async () => {
      const selectionChannels = [
        createTestChannel({ index: 1, alpha_tag: 'Channel 1', bank: 1 }),
        createTestChannel({ index: 2, alpha_tag: 'Channel 2', bank: 1 }),
      ];
      setMockStore(createMockStore({ channels: selectionChannels }));

      render(<ChannelsTab />);
      const [headerCheckbox, ...rowCheckboxes] = screen.getAllByRole('checkbox');
      await userEvent.click(headerCheckbox);

      rowCheckboxes.forEach((checkbox) => {
        expect(checkbox).toBeChecked();
      });
    });

    it('should clear selected channels', async () => {
      const selectionChannels = [
        createTestChannel({ index: 1, alpha_tag: 'Channel 1', bank: 1 }),
        createTestChannel({ index: 2, alpha_tag: 'Channel 2', bank: 1 }),
      ];
      const store = createMockStore({ channels: selectionChannels });
      store.setMemoryDraft = vi.fn();
      setMockStore(store);
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      render(<ChannelsTab />);
      const [headerCheckbox, ...rowCheckboxes] = screen.getAllByRole('checkbox');
      await userEvent.click(headerCheckbox);
      await userEvent.click(screen.getByRole('button', { name: /Clear Selected/i }));

      expect(store.setMemoryDraft).toHaveBeenCalledTimes(2);
      selectionChannels.forEach((channel) => {
        expect(store.setMemoryDraft).toHaveBeenCalledWith(channel.index, expect.any(Object));
      });
      rowCheckboxes.forEach((checkbox) => {
        expect(checkbox).not.toBeChecked();
      });
    });
  });

  describe('Pending Styling', () => {
    it('should highlight rows with draft changes', () => {
      const draftChannel = createTestChannel({ index: 1, alpha_tag: 'Channel 1' });
      const store = createMockStore({
        channels: [draftChannel],
        memoryDrafts: {
          1: createTestChannelDraft({ alpha_tag: 'Draft Channel' }),
        },
      });
      setMockStore(store);

      render(<ChannelsTab />);
      const row = screen.getByText(/Draft Channel/i).closest('div')?.parentElement;
      expect(row).not.toBeNull();
      expect(row!).toHaveClass('bg-brand-primary/10');
      expect(row!).toHaveClass('border-l-2');
    });
  });
});
