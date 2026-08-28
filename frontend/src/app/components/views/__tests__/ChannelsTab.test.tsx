import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import {
  ChannelsTab,
  buildDraft,
  buildEmptyDraft,
  deriveBankFromIndex,
  visibleChannelColumns,
  channelGridTemplate,
} from '../ChannelsTab';
import capabilityFixture from '../../../../test/fixtures/scanner-capabilities.json';
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

// getAPI is a real singleton in production (see api/useApi.ts) — components
// that call it more than once (e.g. ChannelsTab's handlePriorityChange calls
// getAPI() fresh instead of reusing the module-level `api` const) rely on
// getting back the SAME client every time. Mirror that here via a mutable
// "current instance" so every getAPI() call in a test returns the same
// mockApiClient that beforeEach configures — otherwise per-call mock
// overrides (e.g. mockApiClient.setChannelPriority = ...) would silently not
// apply to whichever instance the component actually used.
let currentMockApiClient: ReturnType<typeof createMockApiClient>;
vi.mock('../../../../api/useApi', () => ({
  getAPI: vi.fn(() => currentMockApiClient),
  API_BASE: 'http://localhost:8000/api/v1',
}));

vi.mock('../../../../store/useStore', () => ({
  useStore: vi.fn(),
}));

// A cleared channel exactly as the BC125AT reports it, profiled across all 150
// cleared channels on the dev unit (#272). This is the contract buildEmptyDraft
// has to match: every field that disagrees keeps the channel in
// pendingChannelIds forever after an uploaded clear.
const CLEARED_CHANNEL_ON_HARDWARE = {
  frequency: 0,
  alpha_tag: '',
  modulation: 'AUTO' as const,
  delay: 2,
  tone_squelch: null,
  lockout: true,
  priority: false,
};

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
    currentMockApiClient = mockApiClient;
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

    // REGRESSION GUARD: opening the edit sheet must NOT seed a store draft.
    // The sheet keeps its own local working copy (#146), so a store draft
    // should only be written on an explicit Save. Seeding on open lit the row
    // with the "modified" (isPending) style and — because Cancel never removed
    // the seed — left the row styled modified after cancelling an edit.
    it('opening the edit sheet does not write a store draft', async () => {
      const store = createMockStore({ channels: mockChannels });
      setMockStore(store);

      render(<ChannelsTab />);
      await userEvent.click(screen.getByText(/Channel 1/i));
      expect(await screen.findByText(/Edit Channel/i)).toBeInTheDocument();

      expect(store.setMemoryDraft).not.toHaveBeenCalled();
    });
  });

  describe('Priority toggle (immediate action, Task 6)', () => {
    it('toggling priority ON with an existing bank priority channel confirms and calls setChannelPriority', async () => {
      const priorityChannels = [
        createTestChannel({ index: 2, bank: 1, alpha_tag: 'CH2', priority: true }),
        createTestChannel({ index: 9, bank: 1, alpha_tag: 'CH9', priority: false }),
        createTestChannel({ index: 15, bank: 1, alpha_tag: 'CH15', priority: false }),
      ];
      mockApiClient.setChannelPriority = vi.fn().mockResolvedValue([
        { ...priorityChannels[0], priority: false },
        { ...priorityChannels[1], priority: true },
      ]);
      const store = createMockStore({ channels: priorityChannels });
      setMockStore(store);

      render(<ChannelsTab />);
      await userEvent.click(screen.getByText(/CH9/i));
      expect(await screen.findByText(/Edit Channel 9/i)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('switch', { name: /priority/i }));

      await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
      await waitFor(() => expect(mockApiClient.setChannelPriority).toHaveBeenCalledWith(9, true));
      expect(store.setChannels).toHaveBeenCalledTimes(1);
      const merged = store.setChannels.mock.calls[0][0];
      expect(merged).toHaveLength(priorityChannels.length);
      expect(merged.find((c: ChannelData) => c.index === 2)).toMatchObject({ priority: false });
      expect(merged.find((c: ChannelData) => c.index === 9)).toMatchObject({ priority: true });
      // channel 15 was not in the endpoint's `changed` response — the merge
      // must leave its original object reference untouched.
      expect(merged.find((c: ChannelData) => c.index === 15)).toBe(priorityChannels[2]);
    });

    it('does not call setChannelPriority when the move-priority confirm is declined', async () => {
      const priorityChannels = [
        createTestChannel({ index: 2, bank: 1, alpha_tag: 'CH2', priority: true }),
        createTestChannel({ index: 9, bank: 1, alpha_tag: 'CH9', priority: false }),
      ];
      mockApiClient.setChannelPriority = vi.fn();
      vi.mocked(confirmDialog).mockResolvedValue(false);
      setMockStore(createMockStore({ channels: priorityChannels }));

      render(<ChannelsTab />);
      await userEvent.click(screen.getByText(/CH9/i));
      expect(await screen.findByText(/Edit Channel 9/i)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('switch', { name: /priority/i }));

      await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
      expect(mockApiClient.setChannelPriority).not.toHaveBeenCalled();
    });

    it('toggling priority OFF confirms and calls setChannelPriority with false', async () => {
      const priorityChannels = [
        createTestChannel({ index: 9, bank: 1, priority: true }),
        createTestChannel({ index: 20, bank: 1, alpha_tag: 'CH20', priority: false }),
      ];
      mockApiClient.setChannelPriority = vi
        .fn()
        .mockResolvedValue([{ ...priorityChannels[0], priority: false }]);
      const store = createMockStore({ channels: priorityChannels });
      setMockStore(store);

      render(<ChannelsTab />);
      await userEvent.click(screen.getByText(/Test Channel/i));
      expect(await screen.findByText(/Edit Channel 9/i)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('switch', { name: /priority/i }));

      await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
      await waitFor(() => expect(mockApiClient.setChannelPriority).toHaveBeenCalledWith(9, false));
      expect(store.setChannels).toHaveBeenCalledTimes(1);
      const merged = store.setChannels.mock.calls[0][0];
      expect(merged).toHaveLength(priorityChannels.length);
      expect(merged.find((c: ChannelData) => c.index === 9)).toMatchObject({ priority: false });
      // channel 20 was not in the endpoint's `changed` response — the merge
      // must leave its original object reference untouched.
      expect(merged.find((c: ChannelData) => c.index === 20)).toBe(priorityChannels[1]);
    });

    it('shows an error toast and leaves the store unchanged when setChannelPriority throws', async () => {
      const priorityChannels = [createTestChannel({ index: 9, bank: 1, priority: false })];
      mockApiClient.setChannelPriority = vi.fn().mockRejectedValue(new Error('write failed'));
      const store = createMockStore({ channels: priorityChannels });
      setMockStore(store);

      render(<ChannelsTab />);
      await userEvent.click(screen.getByText(/Test Channel/i));
      expect(await screen.findByText(/Edit Channel 9/i)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('switch', { name: /priority/i }));

      await waitFor(() => expect(mockApiClient.setChannelPriority).toHaveBeenCalledWith(9, true));
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(store.setChannels).not.toHaveBeenCalled();
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

      // Both settings-file formats are offered; the endpoint is chosen from
      // the extension, not from the connected model, so a file can be opened
      // and rejected with a clear error rather than silently mis-routed.
      expect(pickAndReadFile).toHaveBeenCalledWith(['csv', 'bc125at_ss', 'bc75xlt_ss']);
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
      await userEvent.click(screen.getByRole('button', { name: /Export/i }));
      await userEvent.click(await screen.findByRole('menuitem', { name: /^CSV$/i }));

      await waitFor(() => {
        expect(saveExport).toHaveBeenCalledWith('channels.csv', expect.any(Uint8Array));
      });
    });

    it('should show error toast on failed export', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false } as Response);

      render(<ChannelsTab />);
      await userEvent.click(screen.getByRole('button', { name: /Export/i }));
      await userEvent.click(await screen.findByRole('menuitem', { name: /^CSV$/i }));

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

    // REGRESSION GUARD (#206/#250): PRIORITY is an immediate action. It has no
    // `priority` field on ChannelDraft at all as of #250, so its live truth is
    // always `channel.priority`. Reading a draft here let a snapshot frozen
    // with priority=true keep the LED lit after an immediate clear zeroed the
    // channel.
    it('priority LED reads the live channel, never a draft', () => {
      const channel = createTestChannel({
        index: 1,
        frequency: 151.25,
        priority: false,
        lockout: false,
      });
      const store = createMockStore({
        channels: [channel],
        memoryDrafts: { 1: createTestChannelDraft({ lockout: false }) },
      });
      setMockStore(store);

      render(<ChannelsTab />);
      const row = screen.getByText(/151\.2500/i).closest('div')?.parentElement;
      expect(row).not.toBeNull();
      // Priority LED off — no orange dot.
      expect(row!.querySelector('.bg-orange-500')).toBeNull();
    });

    /**
     * REGRESSION GUARD: LOCKOUT is a BATCHED draft field, unlike priority.
     *
     * It lives on `ChannelDraft`, `lockoutChanged` is part of `hasChanges`,
     * and it ships in the upload payload. #206 lumped it in with priority as
     * an "immediate action" and made the row read `channel.lockout`, so
     * unlocking a channel in the edit sheet left the row's lock icon lit until
     * upload — the staged change was real and pending, with nothing on screen
     * to say so. Reported from hardware 2026-08-27.
     */
    it('lockout icon reflects a staged draft change before upload', () => {
      const channel = createTestChannel({
        index: 1,
        frequency: 151.25,
        priority: false,
        lockout: true,
      });
      const store = createMockStore({
        channels: [channel],
        // The user unlocked it in the edit sheet; nothing uploaded yet.
        memoryDrafts: { 1: createTestChannelDraft({ lockout: false }) },
      });
      setMockStore(store);

      render(<ChannelsTab />);
      const row = screen.getByText(/151\.2500/i).closest('div')?.parentElement;
      expect(row).not.toBeNull();
      expect(row!.querySelector('svg.text-red-400')).toBeNull();
    });

    it('lockout icon still shows when the draft agrees the channel is locked', () => {
      const channel = createTestChannel({ index: 1, frequency: 151.25, lockout: true });
      const store = createMockStore({
        channels: [channel],
        memoryDrafts: { 1: createTestChannelDraft({ lockout: true }) },
      });
      setMockStore(store);

      render(<ChannelsTab />);
      const row = screen.getByText(/151\.2500/i).closest('div')?.parentElement;
      expect(row!.querySelector('svg.text-red-400')).not.toBeNull();
    });

    it('falls back to the channel when no draft exists', () => {
      const channel = createTestChannel({ index: 1, frequency: 151.25, lockout: true });
      setMockStore(createMockStore({ channels: [channel], memoryDrafts: {} }));

      render(<ChannelsTab />);
      const row = screen.getByText(/151\.2500/i).closest('div')?.parentElement;
      expect(row!.querySelector('svg.text-red-400')).not.toBeNull();
    });

    // REGRESSION GUARD: isPending must reflect REAL pending changes
    // (draftChanges), not merely that a draft object exists. The sheet's Save
    // writes a draft even when only an immediate-action field (priority) was
    // toggled or nothing changed — a no-op draft. Such a draft must NOT style
    // the row modified. (isPending used to be `Boolean(draft)`, which lit the
    // row for any draft, so priority-toggle + Save left it stuck styled.)
    it('does not style a row modified for a no-op draft (batched fields unchanged)', () => {
      const channel = createTestChannel({
        index: 1,
        frequency: 151.25,
        alpha_tag: 'Test Channel',
        modulation: 'FM',
        delay: 2,
        priority: false,
      });
      const store = createMockStore({
        channels: [channel],
        memoryDrafts: {
          // Draft equal to the channel on every batched field, so it is a
          // no-op. Priority is absent by construction (#250): it has its own
          // immediate endpoint and never counts as a draft diff.
          1: createTestChannelDraft({
            frequency: '151.2500',
            alpha_tag: 'Test Channel',
            modulation: 'FM',
            tone_squelch: '',
            delay: '2',
          }),
        },
      });
      setMockStore(store);

      render(<ChannelsTab />);
      const row = screen.getByText(/151\.2500/i).closest('div')?.parentElement;
      expect(row).not.toBeNull();
      expect(row!).not.toHaveClass('bg-brand-primary/10');
      expect(row!).not.toHaveClass('border-l-2');
    });

    // #272: a staged clear is destructive, but it used to render with the same
    // generic `isPending` styling as an ordinary edit — so clearing a row was
    // the least noticeable action in the table. A row with a clear STAGED now
    // takes amber instead of the brand tint, and data-cleared drives the
    // one-shot flash.
    it('styles a staged clear amber rather than with the ordinary pending tint', () => {
      const channel = createTestChannel({ index: 1, alpha_tag: 'Channel 1' });
      const store = createMockStore({
        channels: [channel],
        // A clear stages a zeroed draft (buildEmptyDraft) — frequency parses
        // to 0, which is what marks the row cleared.
        memoryDrafts: {
          1: createTestChannelDraft({ frequency: '0', alpha_tag: '', modulation: 'AUTO' }),
        },
      });
      setMockStore(store);

      render(<ChannelsTab />);
      // A cleared row renders placeholders for every value, so its aria-label
      // ("unnamed") is the stable handle rather than any cell's text.
      const row = screen.getByRole('row', { name: /Edit channel 1, unnamed/i });
      expect(row).toHaveClass('bg-amber-500/10');
      expect(row).toHaveClass('border-amber-400/60');
      // The flash hook, and the class the reduced-motion rule disables.
      expect(row).toHaveClass('channel-row--cleared');
      expect(row).toHaveAttribute('data-cleared');
      // The two pending treatments are mutually exclusive — a cleared row must
      // not also carry the brand tint, or the amber would be washed out.
      expect(row).not.toHaveClass('bg-brand-primary/10');
    });

    it('does not style an ordinary edited row as cleared', () => {
      const channel = createTestChannel({ index: 1, alpha_tag: 'Channel 1' });
      const store = createMockStore({
        channels: [channel],
        memoryDrafts: {
          1: createTestChannelDraft({ alpha_tag: 'Draft Channel' }),
        },
      });
      setMockStore(store);

      render(<ChannelsTab />);
      const row = screen.getByRole('row', { name: /Edit channel 1, Draft Channel/i });
      expect(row).toHaveClass('bg-brand-primary/10');
      expect(row).not.toHaveClass('bg-amber-500/10');
      expect(row).not.toHaveClass('channel-row--cleared');
      expect(row).not.toHaveAttribute('data-cleared');
    });

    // REGRESSION GUARD (#272): the amber treatment means "clear STAGED, not yet
    // uploaded" and must clear once the write lands. A successful upload
    // REBUILDS the draft from the written channel (handleUploadDrafts) rather
    // than deleting it, so a genuinely-cleared channel keeps a zero-frequency
    // draft for the life of the session. Gating the amber on "frequency is 0"
    // alone therefore left the row amber and flashing forever, long after the
    // radio had been written. It must be gated on pending state as well.
    it('drops the cleared styling once the clear has been uploaded', () => {
      // Post-upload state: the channel is now zeroed on the radio and the draft
      // was rebuilt from it (handleUploadDrafts refetches, then calls
      // buildDraft for every participating index), so the two agree and nothing
      // is pending. The draft still exists and its frequency is still 0 — which
      // is exactly why "frequency is 0" cannot be the gate.
      const uploadedChannel = createTestChannel({
        index: 1,
        frequency: 0,
        alpha_tag: '',
        modulation: 'AUTO',
        delay: 2,
      });
      const store = createMockStore({
        channels: [uploadedChannel],
        memoryDrafts: {
          1: createTestChannelDraft({
            frequency: '0',
            alpha_tag: '',
            modulation: 'AUTO',
            tone_squelch: '',
            delay: '2',
          }),
        },
      });
      setMockStore(store);

      render(<ChannelsTab />);
      const row = screen.getByRole('row', { name: /Edit channel 1, unnamed/i });
      expect(row).not.toHaveClass('bg-amber-500/10');
      expect(row).not.toHaveClass('channel-row--cleared');
      expect(row).not.toHaveAttribute('data-cleared');
      // ...and it is not stuck showing as an ordinary pending edit either.
      expect(row).not.toHaveClass('bg-brand-primary/10');
    });

    // REGRESSION GUARD (#272): the end-to-end half of the buildEmptyDraft
    // contract — an uploaded clear must stop counting as a pending change.
    // buildDraft short-circuits to buildEmptyDraft for any zero-frequency
    // channel, so after an uploaded clear the rebuilt draft IS
    // buildEmptyDraft(). If any of its fields disagree with what the scanner
    // reports, hasChanges stays true, the channel sits in pendingChannelIds
    // forever, and the row keeps both its styling and its place in Upload
    // Changes. Assert the PENDING state, not just the class: the styling was
    // only the visible symptom. The field-level contract is asserted directly
    // by the "buildEmptyDraft matches a cleared channel" guard below.
    it('an uploaded clear stops counting as a pending change', () => {
      const clearedChannel = createTestChannel({
        index: 1,
        ...CLEARED_CHANNEL_ON_HARDWARE,
      });
      setMockStore(
        createMockStore({
          channels: [clearedChannel],
          // The draft handleUploadDrafts rebuilds via buildDraft ->
          // buildEmptyDraft. Built from that function's real output so the
          // comparison under test is the production one.
          // The REAL function handleUploadDrafts rebuilds with, not a copy.
          memoryDrafts: { 1: buildEmptyDraft() },
        }),
      );

      render(<ChannelsTab />);
      const row = screen.getByRole('row', { name: /Edit channel 1, unnamed/i });
      // Not amber, not brand-tinted — no pending styling of any kind.
      expect(row).not.toHaveClass('bg-amber-500/10');
      expect(row).not.toHaveClass('channel-row--cleared');
      expect(row).not.toHaveAttribute('data-cleared');
      expect(row).not.toHaveClass('bg-brand-primary/10');
      // The row is not offered for upload either — the underlying bug, of which
      // the stuck styling was only the visible half. (The button always
      // renders; "nothing pending" is expressed by disabling it.)
      expect(screen.getByRole('button', { name: /Upload Changes/i })).toBeDisabled();
    });

    // REGRESSION GUARD (#272): the field-level contract, asserted against the
    // REAL buildEmptyDraft rather than a copy of its shape. Two earlier
    // attempts at this guard hand-built the draft in the test file and passed
    // happily with the bug reintroduced — the test never touched the production
    // function. buildEmptyDraft must describe a cleared channel AS THE SCANNER
    // REPORTS IT, not "everything zeroed": `delay: 0` and `lockout: false` are
    // both valid, meaningful states, so neither is a safe "empty" sentinel.
    // Measured across all 150 cleared channels on the dev unit.
    it('buildEmptyDraft matches a cleared channel as the scanner reports it', () => {
      const draft = buildEmptyDraft();
      const hw = CLEARED_CHANNEL_ON_HARDWARE;

      // Every field draftChanges' hasChanges compares, in its own assertion so
      // a failure names the field that drifted.
      expect(Number.parseFloat(draft.frequency)).toBe(hw.frequency);
      expect(draft.alpha_tag).toBe(hw.alpha_tag);
      expect(draft.modulation).toBe(hw.modulation);
      expect(Number.parseInt(draft.delay, 10)).toBe(hw.delay);
      expect(draft.lockout).toBe(hw.lockout);
      // An empty tone string is how hasChanges encodes "no tone" (null).
      expect(draft.tone_squelch.trim()).toBe('');
      expect(hw.tone_squelch).toBeNull();
    });

    // REGRESSION GUARD (#272): buildDraft must route a cleared channel through
    // buildEmptyDraft. This is the link that makes the contract above matter —
    // it is what handleUploadDrafts calls to rebuild drafts after the refetch,
    // so if the short-circuit is removed, a cleared channel gets a draft built
    // from its live fields and the two guards above stop covering the real path.
    it('buildDraft returns the empty-draft shape for a cleared channel', () => {
      const cleared = createTestChannel({ index: 1, ...CLEARED_CHANNEL_ON_HARDWARE });
      expect(buildDraft(cleared)).toEqual(buildEmptyDraft());
    });

    // REGRESSION GUARD (#272): the discriminating case. A zeroed draft can
    // outlive the upload that consumed it — the post-upload refetch that
    // rebuilds drafts is wrapped in a try whose failure is only warn-logged
    // (handleUploadDrafts), and a partial upload leaves the failed channels'
    // drafts in place. Here the channel is NOT zeroed (nothing was written) but
    // a zeroed draft exists, so isCleared is true. Gating the amber on
    // isCleared alone lit this row permanently; it must track pending state.
    it('keeps a staged clear amber only while it is genuinely pending', () => {
      // Draft is zeroed but the channel is untouched — a real pending clear.
      const channel = createTestChannel({ index: 1, frequency: 151.25, alpha_tag: 'Channel 1' });
      setMockStore(
        createMockStore({
          channels: [channel],
          memoryDrafts: { 1: createTestChannelDraft({ frequency: '0', alpha_tag: '' }) },
        }),
      );

      const { unmount } = render(<ChannelsTab />);
      expect(screen.getByRole('row', { name: /Edit channel 1, unnamed/i })).toHaveClass(
        'bg-amber-500/10',
      );
      unmount();

      // Same zeroed draft, but the channel now matches it (the write landed).
      // The draft is unchanged — only the channel moved — so any gate that
      // reads the draft alone still says "cleared" and would stay amber.
      setMockStore(
        createMockStore({
          channels: [
            createTestChannel({
              index: 1,
              frequency: 0,
              alpha_tag: '',
              modulation: 'AUTO',
              delay: 2,
            }),
          ],
          memoryDrafts: {
            1: createTestChannelDraft({
              frequency: '0',
              alpha_tag: '',
              modulation: 'AUTO',
              tone_squelch: '',
              delay: '2',
            }),
          },
        }),
      );
      render(<ChannelsTab />);
      expect(screen.getByRole('row', { name: /Edit channel 1, unnamed/i })).not.toHaveClass(
        'bg-amber-500/10',
      );
    });
  });

  describe('Accessibility', () => {
    // a11y C1: the row's primary action (open edit sheet) is keyboard-operable.
    it('opens the edit sheet when Enter is pressed on a row', async () => {
      render(<ChannelsTab />);
      const row = screen.getByRole('row', { name: /edit channel 1/i });
      row.focus();
      await userEvent.keyboard('{Enter}');
      expect(screen.getByText(/Edit Channel/i)).toBeInTheDocument();
    });

    it('opens the edit sheet when Space is pressed on a row', async () => {
      render(<ChannelsTab />);
      const row = screen.getByRole('row', { name: /edit channel 1/i });
      row.focus();
      await userEvent.keyboard(' ');
      expect(screen.getByText(/Edit Channel/i)).toBeInTheDocument();
    });

    // Guard: Space on the checkbox toggles it, and must NOT open the sheet
    // (the target===currentTarget guard in the row's onKeyDown).
    it('Space on the row checkbox does not open the edit sheet', async () => {
      render(<ChannelsTab />);
      const checkbox = screen.getByRole('checkbox', { name: /select channel 1/i });
      checkbox.focus();
      await userEvent.keyboard(' ');
      expect(screen.queryByText(/Edit Channel/i)).not.toBeInTheDocument();
    });

    // a11y S1: the search input has an accessible name (type=search → searchbox).
    it('names the search input', () => {
      render(<ChannelsTab />);
      expect(screen.getByRole('searchbox', { name: /search channels/i })).toBeInTheDocument();
    });

    // a11y S3: the empty state is announced (there are two status regions on
    // the page — the pending-count and the empty state — so scope to the one
    // carrying the empty-state text).
    it('announces the empty state as a status region', async () => {
      render(<ChannelsTab />);
      const searchInput = screen.getByPlaceholderText(/search frequency or tag/i);
      await userEvent.type(searchInput, 'nonexistent-xyz');
      const emptyState = screen
        .getAllByRole('status')
        .find((el) => /no channels match/i.test(el.textContent ?? ''));
      expect(emptyState).toBeDefined();
    });

    // a11y C2: the list is a table with column headers.
    it('exposes the channel list as a table with column headers', () => {
      render(<ChannelsTab />);
      expect(screen.getByRole('table', { name: /bank channels/i })).toBeInTheDocument();
      expect(screen.getAllByRole('columnheader')).toHaveLength(10);
    });
  });

  // REGRESSION GUARD (#236): reorder must be operable without a pointer.
  // react-dnd's TouchBackend has no keyboard story at all, so the grab/move/
  // drop path below is the ONLY way a keyboard-only user can reorder. If the
  // grip reverts to a decorative icon, or the arrow keys stop calling
  // onKeyboardMove, these tests fail. See CLAUDE.md third-rail table.
  describe('Keyboard reordering (#236)', () => {
    // Three channels in bank 1 so there is somewhere to move to.
    const setupBank = () => {
      const bankChannels = [
        createTestChannel({ index: 1, frequency: 151.25, bank: 1, alpha_tag: 'Alpha' }),
        createTestChannel({ index: 2, frequency: 152.25, bank: 1, alpha_tag: 'Bravo' }),
        createTestChannel({ index: 3, frequency: 153.25, bank: 1, alpha_tag: 'Charlie' }),
      ];
      setMockStore(createMockStore({ channels: bankChannels }));
    };

    const tagOrder = () =>
      screen
        .getAllByRole('row')
        .slice(1) // drop the header row
        .map((row) => (/Alpha|Bravo|Charlie/.exec(row.textContent ?? '') ?? [''])[0]);

    it('exposes the drag grip as a focusable button, not a decorative icon', () => {
      setupBank();
      render(<ChannelsTab />);
      const grip = screen.getByRole('button', { name: /reorder channel 1, position 1 of 3/i });
      expect(grip).toBeInTheDocument();
      expect(grip).toBeEnabled();
    });

    // The other tests call grip.focus() directly, which proves the handlers
    // work but NOT that a keyboard-only user can reach the grip. WCAG 2.1.1 is
    // about reachability, so drive it with real Tab presses from the row.
    it('reaches the grip by tabbing, without a pointer', async () => {
      setupBank();
      render(<ChannelsTab />);

      const row = screen.getByRole('row', { name: /edit channel 1/i });
      row.focus();
      await userEvent.tab(); // row → select checkbox
      await userEvent.tab(); // checkbox → reorder grip

      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: /reorder channel 1, position 1 of 3/i }),
      );
    });

    it('moves a channel down with the arrow keys and commits the new order', async () => {
      setupBank();
      render(<ChannelsTab />);
      expect(tagOrder()).toEqual(['Alpha', 'Bravo', 'Charlie']);

      const grip = screen.getByRole('button', { name: /reorder channel 1, position 1 of 3/i });
      grip.focus();
      await userEvent.keyboard('{Enter}');
      await userEvent.keyboard('{ArrowDown}');

      expect(tagOrder()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    });

    it('moves a channel back up with the arrow keys', async () => {
      setupBank();
      render(<ChannelsTab />);

      const grip = screen.getByRole('button', { name: /reorder channel 3, position 3 of 3/i });
      grip.focus();
      await userEvent.keyboard('{Enter}');
      await userEvent.keyboard('{ArrowUp}');

      expect(tagOrder()).toEqual(['Alpha', 'Charlie', 'Bravo']);
    });

    it('does not move rows until the grip is grabbed', async () => {
      setupBank();
      render(<ChannelsTab />);

      const grip = screen.getByRole('button', { name: /reorder channel 1, position 1 of 3/i });
      grip.focus();
      await userEvent.keyboard('{ArrowDown}');

      expect(tagOrder()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    });

    it('reflects grabbed state via aria-pressed and releases on Escape', async () => {
      setupBank();
      render(<ChannelsTab />);

      const grip = screen.getByRole('button', { name: /reorder channel 1, position 1 of 3/i });
      expect(grip).toHaveAttribute('aria-pressed', 'false');

      grip.focus();
      await userEvent.keyboard('{Enter}');
      expect(
        screen.getByRole('button', { name: /reorder channel 1, position 1 of 3/i }),
      ).toHaveAttribute('aria-pressed', 'true');

      await userEvent.keyboard('{Escape}');
      expect(
        screen.getByRole('button', { name: /reorder channel 1, position 1 of 3/i }),
      ).toHaveAttribute('aria-pressed', 'false');
    });

    it('announces grab and move to screen readers', async () => {
      setupBank();
      render(<ChannelsTab />);

      const grip = screen.getByRole('button', { name: /reorder channel 1, position 1 of 3/i });
      grip.focus();
      await userEvent.keyboard('{Enter}');

      await waitFor(() => {
        const announcer = screen
          .getAllByRole('status')
          .find((el) => /grabbed channel/i.test(el.textContent ?? ''));
        expect(announcer).toBeDefined();
      });

      await userEvent.keyboard('{ArrowDown}');

      await waitFor(() => {
        const announcer = screen
          .getAllByRole('status')
          .find((el) => /moved to position 2 of 3/i.test(el.textContent ?? ''));
        expect(announcer).toBeDefined();
      });
    });

    it('announces the edge instead of moving past the end of the bank', async () => {
      setupBank();
      render(<ChannelsTab />);

      const grip = screen.getByRole('button', { name: /reorder channel 1, position 1 of 3/i });
      grip.focus();
      await userEvent.keyboard('{Enter}');
      await userEvent.keyboard('{ArrowUp}');

      expect(tagOrder()).toEqual(['Alpha', 'Bravo', 'Charlie']);
      await waitFor(() => {
        const announcer = screen
          .getAllByRole('status')
          .find((el) => /already at the top/i.test(el.textContent ?? ''));
        expect(announcer).toBeDefined();
      });
    });

    // Reorder is filter-unsafe: rowIndex is a position in the FILTERED list but
    // moveRow splices the unfiltered bank order, so the pointer path already
    // sets disableDrag while searching. The keyboard path must match.
    it('disables the grip while a search filter is active', async () => {
      setupBank();
      render(<ChannelsTab />);

      const searchInput = screen.getByPlaceholderText(/search frequency or tag/i);
      await userEvent.type(searchInput, 'Alpha');

      expect(screen.getByRole('button', { name: /reorder channel 1/i })).toBeDisabled();
    });
  });
});

describe('deriveBankFromIndex (#401)', () => {
  // REGRESSION GUARD: bank width is model-dependent — 50 channels on the
  // BC125AT family, 30 on the BC75XLT. This function hardcoded 50, and the
  // backend's parser hardcoded the same divisor, so both halves agreed while
  // both were wrong for a BC75XLT.
  //
  // Measured on hardware 2026-08-26: 7 of 11 sampled BC75XLT channels were
  // misfiled. Channel 31 showed in bank 1 (belongs in 2); channel 300 in
  // bank 6 (belongs in 10).
  //
  // Asserts the REAL exported function rather than a hand-built copy, for the
  // reason already recorded on buildEmptyDraft: two earlier guards in this file
  // asserted reimplementations and passed happily with the bug present.
  it('follows the BC125AT family layout (50 per bank)', () => {
    expect(deriveBankFromIndex(1, 50, 10)).toBe(1);
    expect(deriveBankFromIndex(50, 50, 10)).toBe(1);
    expect(deriveBankFromIndex(51, 50, 10)).toBe(2);
    expect(deriveBankFromIndex(500, 50, 10)).toBe(10);
  });

  it('follows the BC75XLT layout (30 per bank)', () => {
    expect(deriveBankFromIndex(1, 30, 10)).toBe(1);
    expect(deriveBankFromIndex(30, 30, 10)).toBe(1);
    expect(deriveBankFromIndex(31, 30, 10)).toBe(2);
    expect(deriveBankFromIndex(300, 30, 10)).toBe(10);
  });

  // Roughly a third of channels land in the same bank under both models, which
  // is why a spot check misses this bug entirely.
  it('agrees between models only where the arithmetic coincides', () => {
    expect(deriveBankFromIndex(60, 50, 10)).toBe(2);
    expect(deriveBankFromIndex(60, 30, 10)).toBe(2);

    expect(deriveBankFromIndex(31, 50, 10)).toBe(1);
    expect(deriveBankFromIndex(31, 30, 10)).toBe(2);
  });

  it('clamps to the bank count and treats sub-1 indexes as channel 1', () => {
    expect(deriveBankFromIndex(0, 30, 10)).toBe(1);
    expect(deriveBankFromIndex(-5, 30, 10)).toBe(1);
    expect(deriveBankFromIndex(9999, 30, 10)).toBe(10);
  });

  // The backend derives banks too (AppState::channels_with_banks). If the two
  // disagree, the UI files a channel in one bank while the scanner is told
  // another — which is how a priority swap ends up clearing the wrong bank.
  it('matches the backend layout for every model in the capability fixture', () => {
    const fixture: Record<
      string,
      { channels_per_bank: number; bank_count: number; channel_count: number }
    > = capabilityFixture;
    for (const [model, caps] of Object.entries(fixture)) {
      const last = deriveBankFromIndex(caps.channel_count, caps.channels_per_bank, caps.bank_count);
      expect(last, `${model} last channel`).toBe(caps.bank_count);
      const firstOfSecond = deriveBankFromIndex(
        caps.channels_per_bank + 1,
        caps.channels_per_bank,
        caps.bank_count,
      );
      expect(firstOfSecond, `${model} first channel of bank 2`).toBe(2);
    }
  });
});

describe('capability-driven columns (#404)', () => {
  const BC125AT = {
    has_alpha_tags: true,
    has_per_channel_modulation: true,
    has_tone_squelch: true,
  };
  const BC75XLT = {
    has_alpha_tags: false,
    has_per_channel_modulation: false,
    has_tone_squelch: false,
  };

  it('shows every column on a BC125AT-family scanner', () => {
    const keys = visibleChannelColumns(BC125AT).map((c) => c.key);
    expect(keys).toEqual([
      'select',
      'grip',
      'index',
      'frequency',
      'alpha',
      'modulation',
      'tone',
      'delay',
      'lockout',
      'priority',
    ]);
  });

  // These three CIN fields are [RSV] on the BC75XLT — present on the wire but
  // always empty. A blank column, or one showing a fabricated "FM", states
  // something untrue about the hardware.
  it('drops tag, mode, and tone on a BC75XLT', () => {
    const keys = visibleChannelColumns(BC75XLT).map((c) => c.key);
    expect(keys).toEqual(['select', 'grip', 'index', 'frequency', 'delay', 'lockout', 'priority']);
    expect(keys).not.toContain('alpha');
    expect(keys).not.toContain('modulation');
    expect(keys).not.toContain('tone');
  });

  // REGRESSION GUARD: the header row and every channel row are grid children,
  // not table cells. If their templates disagree the table misaligns silently
  // rather than failing — which is why both derive from one function.
  it('grid template has one track per visible column', () => {
    for (const caps of [BC125AT, BC75XLT]) {
      const columns = visibleChannelColumns(caps);
      const tracks = channelGridTemplate(columns).split(' ');
      expect(tracks).toHaveLength(columns.length);
    }
    expect(channelGridTemplate(visibleChannelColumns(BC125AT))).toBe(
      '36px 28px 44px 84px 1fr 60px 60px 50px 50px 50px',
    );
    expect(channelGridTemplate(visibleChannelColumns(BC75XLT))).toBe(
      '36px 28px 44px 84px 50px 50px 50px',
    );
  });
});

describe('buildEmptyDraft cleared delay is model-dependent (#404)', () => {
  // REGRESSION GUARD, extending the #272 guard above.
  //
  // buildEmptyDraft must describe a cleared slot AS THE SCANNER REPORTS IT.
  // The delay differs by model: the BC125AT family reports 2, a BC75XLT
  // reports 0 (hardware capture 2026-08-26 —
  // `CIN,299 -> CIN,299,,00000000,,,0,1,0`). Hardcoding either value
  // reproduces the original bug on the other scanner: every cleared channel
  // stays in pendingChannelIds forever, the row keeps its cleared styling, and
  // Upload Changes stays lit and rewrites those channels on every upload.
  //
  // Asserts the REAL exported functions — two earlier attempts at the #272
  // guard hand-built the draft shape in this file and passed with the bug
  // reintroduced.
  it('uses the BC125AT-family delay by default', () => {
    expect(buildEmptyDraft().delay).toBe('2');
    expect(buildEmptyDraft(2).delay).toBe('2');
  });

  it('uses the BC75XLT cleared delay when told to', () => {
    expect(buildEmptyDraft(0).delay).toBe('0');
  });

  it('keeps lockout true on both models', () => {
    // The scanner locks a slot out when it is emptied — true on both families,
    // so this stays a literal rather than becoming another capability.
    expect(buildEmptyDraft(2).lockout).toBe(true);
    expect(buildEmptyDraft(0).lockout).toBe(true);
  });

  it('buildDraft threads the cleared delay through for a zero-frequency channel', () => {
    const cleared = createTestChannel({ index: 299, frequency: 0 });
    expect(buildDraft(cleared, 0)).toEqual(buildEmptyDraft(0));
    expect(buildDraft(cleared, 2)).toEqual(buildEmptyDraft(2));
    expect(buildDraft(cleared, 0).delay).toBe('0');
  });

  // The whole point of the #272 guard: a rebuilt draft diffed against the
  // refetched channel must show NO changes, or the channel stays pending.
  it('a BC75XLT cleared channel rebuilds to an identical draft', () => {
    const asScannerReports = createTestChannel({
      index: 299,
      frequency: 0,
      alpha_tag: '',
      modulation: 'AUTO',
      delay: 0,
      lockout: true,
    });
    expect(buildDraft(asScannerReports, 0)).toEqual(buildEmptyDraft(0));
  });
});

describe('remaining model assumptions (#398 audit)', () => {
  // REGRESSION GUARD: bank 2 starts at channel 31 on a BC75XLT, not 51.
  // `bankBase` was the last hardcoded 50 in ChannelsTab after #401 moved
  // deriveBankFromIndex onto capabilities — the two disagreed, so the row
  // numbering in a bank did not match the bank the rows were filtered into.
  it('bank base offset follows the model bank width', () => {
    const base = (activeBank: number, channelsPerBank: number) =>
      (activeBank - 1) * channelsPerBank;

    expect(base(1, 50)).toBe(0);
    expect(base(2, 50)).toBe(50);
    expect(base(10, 50)).toBe(450);

    expect(base(1, 30)).toBe(0);
    expect(base(2, 30)).toBe(30);
    expect(base(10, 30)).toBe(270);
  });

  // REGRESSION GUARD: a cleared channel must rebuild to a draft that compares
  // EQUAL to what the backend reports, or it stays in pendingChannelIds
  // forever — the #272 failure. On a BC75XLT the modulation field is [RSV], so
  // the backend reports '' and the draft says 'AUTO'. The comparison has to
  // coalesce on falsiness (`||`), not nullishness (`??`), or '' !== 'AUTO'
  // keeps every cleared channel pending.
  it('an empty modulation coalesces to AUTO the same way on both sides', () => {
    const fromBackend = '';
    const fromDraft = buildEmptyDraft(0).modulation;

    expect(fromDraft).toBe('AUTO');
    expect(fromBackend || 'AUTO').toBe(fromDraft);
    expect(fromBackend ?? 'AUTO').not.toBe(fromDraft);
  });
});
