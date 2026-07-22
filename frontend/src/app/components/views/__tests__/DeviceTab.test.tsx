import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeviceTab, PREFERENCE_KEY_MAP } from '../DeviceTab';
import { createMockApiClient } from '../../../../test/mocks/mockApiClient';
import {
  createTestChannel,
  createTestDeviceInfo,
  createTestLiveState,
} from '../../../../test/fixtures';
import { getAPI } from '../../../../api/useApi';
import { useStore } from '../../../../store/useStore';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../../../api/useApi', () => ({
  getAPI: vi.fn(() => createMockApiClient()),
}));

describe('DeviceTab', () => {
  let mockApiClient: ReturnType<typeof createMockApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient = createMockApiClient();
    vi.mocked(getAPI).mockReturnValue(mockApiClient as unknown as ReturnType<typeof getAPI>);
    useStore.setState({
      channels: [],
      liveState: createTestLiveState(),
      deviceInfo: createTestDeviceInfo(),
    });
  });

  const renderDeviceTab = () => render(<DeviceTab />);

  const selectCategory = async (label: RegExp | string) => {
    await userEvent.click(screen.getByRole('button', { name: label }));
  };

  describe('Device Config category', () => {
    it('should render device config by default', () => {
      renderDeviceTab();
      expect(screen.getByRole('heading', { name: /Audio & Power/i })).toBeInTheDocument();
    });

    it('should update volume when slider changes', async () => {
      mockApiClient.setVolume = vi.fn().mockResolvedValue(undefined);

      renderDeviceTab();

      const slider = screen.getAllByRole('slider')[0];
      slider.focus();
      await userEvent.keyboard('{ArrowRight}');

      expect(mockApiClient.setVolume).toHaveBeenCalled();
    });

    it('should call setBacklight when option selected', async () => {
      mockApiClient.setBacklight = vi.fn().mockResolvedValue(undefined);

      renderDeviceTab();

      const selectTrigger = screen.getByRole('combobox', { name: /Backlight/i });
      await userEvent.click(selectTrigger);

      const option = screen.getByRole('option', { name: /Always Off/i });
      await userEvent.click(option);

      expect(mockApiClient.setBacklight).toHaveBeenCalledWith('AF');
    });

    it('should call setPrioritySettings when option selected', async () => {
      mockApiClient.setPrioritySettings = vi.fn().mockResolvedValue(undefined);

      renderDeviceTab();

      const selectTrigger = screen.getByRole('combobox', { name: /Priority Mode/i });
      await userEvent.click(selectTrigger);

      const option = screen.getByRole('option', { name: /^Plus$/i });
      await userEvent.click(option);

      expect(mockApiClient.setPrioritySettings).toHaveBeenCalledWith(2);
    });
  });

  describe('Locked Channels category', () => {
    it('should render channel list when category selected', async () => {
      const mockChannels = [
        createTestChannel({ index: 1, frequency: 151.25, bank: 1 }),
        createTestChannel({ index: 5, frequency: 155.5, bank: 2 }),
      ];
      useStore.setState({ channels: mockChannels });
      mockApiClient.getLockouts = vi.fn().mockResolvedValue({
        channels: [1, 5],
        frequencies: [],
        temporary_channels: [],
      });

      renderDeviceTab();
      await selectCategory(/Locked Channels/i);

      await waitFor(() => {
        expect(screen.getByText(/2 locked/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/CH 1/i)).toBeInTheDocument();
      expect(screen.getByText(/151.2500/i)).toBeInTheDocument();
    });

    it('should call unlock when Unlock Selected button clicked', async () => {
      const mockChannels = [createTestChannel({ index: 1 })];
      useStore.setState({ channels: mockChannels });
      mockApiClient.getLockouts = vi.fn().mockResolvedValue({
        channels: [1],
        frequencies: [],
        temporary_channels: [],
      });
      mockApiClient.clearChannelLockouts = vi.fn().mockResolvedValue({
        cleared: [1],
        failed: [],
      });

      renderDeviceTab();
      await selectCategory(/Locked Channels/i);

      await screen.findByText(/CH 1/i);

      const checkbox = screen.getByRole('checkbox');
      await userEvent.click(checkbox);

      const unlockButton = screen.getByRole('button', { name: /Unlock Selected/i });
      await waitFor(() => {
        expect(unlockButton).toBeEnabled();
      });
      await userEvent.click(unlockButton);

      await waitFor(() => {
        expect(mockApiClient.clearChannelLockouts).toHaveBeenCalledWith([1]);
      });
    });
  });

  describe('Close Call category', () => {
    const enableCloseCall = async () => {
      await selectCategory(/Close Call/i);
      const selectTrigger = screen.getByRole('combobox', { name: /Mode/i });
      await userEvent.click(selectTrigger);
      const option = screen.getByRole('option', { name: /CC DND/i });
      await userEvent.click(option);
    };

    it('should call setCloseCallSettings when mode changed', async () => {
      mockApiClient.setCloseCallSettings = vi.fn().mockResolvedValue(undefined);

      renderDeviceTab();

      await selectCategory(/Close Call/i);
      const selectTrigger = screen.getByRole('combobox', { name: /Mode/i });
      await userEvent.click(selectTrigger);

      const option = screen.getByRole('option', { name: /CC DND/i });
      await userEvent.click(option);

      expect(mockApiClient.setCloseCallSettings).toHaveBeenCalled();
    });

    it('should toggle lockout switch', async () => {
      mockApiClient.setCloseCallSettings = vi.fn().mockResolvedValue(undefined);

      renderDeviceTab();
      await enableCloseCall();

      const lockoutSwitch = screen.getByRole('switch', { name: /Lockout Hits While Scanning/i });
      await userEvent.click(lockoutSwitch);

      expect(mockApiClient.setCloseCallSettings).toHaveBeenCalled();
    });

    it('should toggle beep switch', async () => {
      mockApiClient.setCloseCallSettings = vi.fn().mockResolvedValue(undefined);

      renderDeviceTab();
      await enableCloseCall();

      const beepSwitch = screen.getByRole('switch', { name: /Alert Beep/i });
      await userEvent.click(beepSwitch);

      expect(mockApiClient.setCloseCallSettings).toHaveBeenCalled();
    });

    it('should toggle light switch', async () => {
      mockApiClient.setCloseCallSettings = vi.fn().mockResolvedValue(undefined);

      renderDeviceTab();
      await enableCloseCall();

      const lightSwitch = screen.getByRole('switch', { name: /Alert Light/i });
      await userEvent.click(lightSwitch);

      expect(mockApiClient.setCloseCallSettings).toHaveBeenCalled();
    });
  });

  describe('Service Search category', () => {
    it('should toggle service search group', async () => {
      mockApiClient.setServiceSearchSettings = vi.fn().mockResolvedValue(undefined);

      renderDeviceTab();
      await selectCategory(/Service Search/i);

      const serviceSwitch = screen.getByRole('switch', { name: /Police/i });
      await userEvent.click(serviceSwitch);

      expect(mockApiClient.setServiceSearchSettings).toHaveBeenCalled();
    });
  });

  describe('Custom Search category', () => {
    it('should toggle search range enable', async () => {
      mockApiClient.setCustomSearchSettings = vi.fn().mockResolvedValue(undefined);

      renderDeviceTab();
      await selectCategory(/Custom Search/i);

      const switches = screen.getAllByRole('switch');
      await userEvent.click(switches[0]);

      expect(mockApiClient.setCustomSearchSettings).toHaveBeenCalled();
    });

    it('should update range values', async () => {
      mockApiClient.setCustomSearchRange = vi.fn().mockResolvedValue(undefined);

      renderDeviceTab();
      await selectCategory(/Custom Search/i);

      const startInput = screen.getByDisplayValue('140.0000');
      fireEvent.change(startInput, { target: { value: '141.0000' } });

      await waitFor(() => {
        expect(mockApiClient.setCustomSearchRange).toHaveBeenLastCalledWith(1, 141, 149);
      });
    });
  });

  describe('Preferences category', () => {
    it('should render preference controls', async () => {
      renderDeviceTab();
      await selectCategory(/Preferences/i);
      expect(screen.getByText(/Application Settings/i)).toBeInTheDocument();
    });

    it('should render external links', async () => {
      renderDeviceTab();
      await selectCategory(/Preferences/i);
      expect(screen.getByRole('button', { name: /Website/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Github/i })).toBeInTheDocument();
    });
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
  ])('maps %s to %s', (camel, snake) => {
    expect(PREFERENCE_KEY_MAP[camel as keyof typeof PREFERENCE_KEY_MAP]).toBe(snake);
  });
});
