import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DeviceTab,
  PREFERENCE_KEY_MAP,
  CLOSE_CALL_MODE_TO_WIRE,
  CLOSE_CALL_WIRE_TO_MODE,
  closeCallWireToMode,
  PRIORITY_MODE_TO_WIRE,
  priorityWireToMode,
} from '../DeviceTab';
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

    // a11y S4 regression guard: sliders are named via aria-label, which the
    // Slider wrapper must forward to the role="slider" thumb (Radix puts a
    // root-level aria-label on the wrong element). Querying by name fails if
    // the wrapper regresses.
    it('names its sliders (aria-label reaches the thumb)', () => {
      renderDeviceTab();
      expect(screen.getByRole('slider', { name: /volume/i })).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: /squelch/i })).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: /battery saver/i })).toBeInTheDocument();
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

    // Regression guard (#264): the range MHz inputs are controlled, so
    // updateRange must always write the raw typed string to state — otherwise
    // clearing the field (or typing a leading '.') parses to NaN, the state
    // write is skipped, and React snaps the input back to its old value,
    // visibly swallowing the keystroke.
    it('lets you clear a range input without snapping back', async () => {
      mockApiClient.setCustomSearchRange = vi.fn().mockResolvedValue(undefined);

      renderDeviceTab();
      await selectCategory(/Custom Search/i);

      const startInput = screen.getByDisplayValue('140.0000');
      fireEvent.change(startInput, { target: { value: '' } });

      await waitFor(() => {
        expect(startInput).toHaveValue('');
      });
      // An empty bound must NOT reach the wire — the parse guard still holds.
      expect(mockApiClient.setCustomSearchRange).not.toHaveBeenCalled();
    });

    it('lets you type a leading decimal into a range input', async () => {
      mockApiClient.setCustomSearchRange = vi.fn().mockResolvedValue(undefined);

      renderDeviceTab();
      await selectCategory(/Custom Search/i);

      const startInput = screen.getByDisplayValue('140.0000');
      fireEvent.change(startInput, { target: { value: '.' } });

      await waitFor(() => {
        expect(startInput).toHaveValue('.');
      });
      expect(mockApiClient.setCustomSearchRange).not.toHaveBeenCalled();
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
      expect(screen.getByRole('button', { name: /Github/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Buy me a coffee/i })).toBeInTheDocument();
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

describe('CLOSE_CALL_MODE_TO_WIRE', () => {
  // Digits confirmed on hardware (fw 1.06.06, #241) — captured three times, see
  // docs/wire_captures/2026-08-03/. The app previously had 1/2 INVERTED, so
  // selecting "CC Priority" put the radio in DND. Pin them.
  //
  // Mode 3 (`CC Only`) is NOT in BC125AT_PROTOCOL.md §7.6 — found on hardware
  // in clc-mode-probe-cc-only.txt, where it moved 2 -> 3 off the keypad.
  it.each([
    ['off', 0],
    ['cc_priority', 1],
    ['cc_dnd', 2],
    ['cc_only', 3],
  ])('maps %s to wire %i', (mode, wire) => {
    expect(CLOSE_CALL_MODE_TO_WIRE[mode]).toBe(wire);
  });

  it('derives the read map as an exact inverse', () => {
    // The read direction is derived, not hand-written, so the two cannot drift.
    // This asserts the derivation itself, not a second copy of the digits.
    for (const [mode, wire] of Object.entries(CLOSE_CALL_MODE_TO_WIRE)) {
      expect(CLOSE_CALL_WIRE_TO_MODE[wire]).toBe(mode);
    }
  });

  it('models every digit the backend accepts', () => {
    // set_close_call validates (0..=3) in api/handlers/settings.rs. A digit the
    // backend accepts but the UI cannot display is the #241/#340 bug class.
    // Keep these in step — if the backend range widens, this fails until the
    // UI follows.
    expect(Object.values(CLOSE_CALL_MODE_TO_WIRE).sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('closeCallWireToMode', () => {
  it.each([
    [0, 'off'],
    [1, 'cc_priority'],
    [2, 'cc_dnd'],
    [3, 'cc_only'],
  ])('maps wire %i to %s', (wire, mode) => {
    expect(closeCallWireToMode(wire)).toBe(mode);
  });

  // Same guard as priorityWireToMode, for the same reason (#340): the dropdown
  // is also the write path, so an unmodelled digit rendered as "Off" becomes a
  // CLC,0 write on the next save. `CC Only` was exactly that case before it was
  // mapped — the radio reported 3 and the UI showed Off.
  it('returns null for an unmodelled wire mode instead of falling back to off', () => {
    expect(closeCallWireToMode(4)).toBeNull();
    expect(closeCallWireToMode(99)).toBeNull();
  });
});

describe('priorityWireToMode', () => {
  // All four digits confirmed on hardware (fw 1.06.06, #341) — every mode was
  // entered from a different one, so each is a directly observed transition:
  // 1->0 Off, 0->2 Plus, 2->3 DND, 3->1 On.
  // See docs/wire_captures/2026-08-03/pri-mode-probe.txt.
  it.each([
    [0, 'off'],
    [1, 'on'],
    [2, 'plus'],
    [3, 'dnd'],
  ])('maps wire %i to %s', (wire, mode) => {
    expect(priorityWireToMode(wire)).toBe(mode);
  });

  // Regression guard: an unmodelled wire mode must NOT collapse to 'off'.
  // The old `priorityMap[mode] || 'off'` displayed "Off" for any unknown digit,
  // and since that dropdown is also the write path, the next save sent PRI,0
  // and genuinely switched priority off — a display gap turning into an
  // unrequested state change. Returning null keeps the read from lying.
  //
  // All four documented digits are mapped now, so this uses an out-of-range
  // value. Do NOT delete this guard as redundant: the hazard is the silent
  // fallback, which would return whenever the wire grows a digit we don't know.
  it('returns null for an unmodelled wire mode instead of falling back to off', () => {
    expect(priorityWireToMode(4)).toBeNull();
  });

  it('returns null for out-of-range wire values', () => {
    expect(priorityWireToMode(99)).toBeNull();
    expect(priorityWireToMode(-1)).toBeNull();
  });

  it('models every digit the backend accepts', () => {
    // set_priority validates (0..=3) in api/handlers/settings.rs. A digit the
    // backend accepts but the UI cannot display is the #341 bug class: the
    // radio sits in a mode the app renders as something else. Keep these in
    // step — if the backend range widens, this fails until the UI follows.
    expect(Object.values(PRIORITY_MODE_TO_WIRE).sort()).toEqual([0, 1, 2, 3]);
  });
});
