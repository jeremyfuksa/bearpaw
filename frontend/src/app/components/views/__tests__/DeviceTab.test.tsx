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
  BC75XLT_CAPS,
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

  /**
   * Turn Close Call on, toggle one band, and return the WIRE POSITION that
   * moved (1-based, as the mask is written).
   *
   * Reads the index that changed rather than an absolute value: the band's
   * starting state comes from hydration, so asserting `true` or `false`
   * pins the fixture instead of the mapping. What matters is which slot the
   * click reached.
   *
   * The switches are disabled while the mode is 'off' — the default until
   * hydration — so the mode has to move first. That write is itself a
   * setCloseCallSettings call, hence the before/after pair.
   */
  const bandPositionMovedBy = async (label: string): Promise<number[]> => {
    await userEvent.click(screen.getByLabelText('Mode'));
    await userEvent.click(await screen.findByRole('option', { name: 'CC Priority' }));
    await waitFor(() => expect(mockApiClient.setCloseCallSettings).toHaveBeenCalled());

    await userEvent.click(screen.getByLabelText(label));
    await waitFor(() =>
      expect(mockApiClient.setCloseCallSettings.mock.calls.length).toBeGreaterThan(1),
    );
    const payloads = mockApiClient.setCloseCallSettings.mock.calls.map(
      (call) => (call[0] as { band: boolean[] }).band,
    );
    const before = payloads[0];
    const after = payloads[payloads.length - 1];
    return after.map((_, i) => i).filter((i) => before[i] !== after[i]);
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

    // #346: priority modes silently do nothing unless SOME channel carries the
    // priority flag — the radio shows "Priority Scan: No Channel" and the mode
    // does not stick. The dropdown stays live (the radio accepts the write);
    // the hint is what tells the user why nothing happened.
    describe('no-priority-channel hint (#346)', () => {
      it('warns when memory is synced and no channel has priority', () => {
        useStore.setState({
          channels: [createTestChannel({ index: 1, priority: false })],
          sync: { ...useStore.getState().sync, hasSyncedInitially: true },
        });

        renderDeviceTab();

        expect(screen.getByText(/will not engage/i)).toBeInTheDocument();
      });

      it('stays silent once a channel carries priority', () => {
        useStore.setState({
          channels: [
            createTestChannel({ index: 1, priority: false }),
            createTestChannel({ index: 2, priority: true }),
          ],
          sync: { ...useStore.getState().sync, hasSyncedInitially: true },
        });

        renderDeviceTab();

        expect(screen.queryByText(/will not engage/i)).not.toBeInTheDocument();
      });

      // The empty channel list before memory sync is indistinguishable from
      // "synced, nothing flagged". Warning here would fire on every cold start,
      // before the app could possibly know.
      it('stays silent before memory sync, when channels are simply unknown', () => {
        useStore.setState({
          channels: [],
          sync: { ...useStore.getState().sync, hasSyncedInitially: false },
        });

        renderDeviceTab();

        expect(screen.queryByText(/will not engage/i)).not.toBeInTheDocument();
      });

      // The hint is only useful to a screen-reader user if it is associated
      // with the control it explains; visual adjacency does not carry over.
      it('associates the hint with the Priority Mode select', () => {
        useStore.setState({
          channels: [createTestChannel({ index: 1, priority: false })],
          sync: { ...useStore.getState().sync, hasSyncedInitially: true },
        });

        renderDeviceTab();

        const trigger = screen.getByRole('combobox', { name: /Priority Mode/i });
        const describedBy = trigger.getAttribute('aria-describedby');
        expect(describedBy).toBeTruthy();
        expect(document.getElementById(describedBy!)).toHaveTextContent(/will not engage/i);
      });

      it('leaves the Priority Mode select usable while the hint shows', async () => {
        mockApiClient.setPrioritySettings = vi.fn().mockResolvedValue(undefined);
        useStore.setState({
          channels: [createTestChannel({ index: 1, priority: false })],
          sync: { ...useStore.getState().sync, hasSyncedInitially: true },
        });

        renderDeviceTab();

        const trigger = screen.getByRole('combobox', { name: /Priority Mode/i });
        expect(trigger).not.toBeDisabled();
        await userEvent.click(trigger);
        await userEvent.click(screen.getByRole('option', { name: /^Plus$/i }));

        expect(mockApiClient.setPrioritySettings).toHaveBeenCalledWith(2);
      });
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

  describe('capability-gated controls (#404/#405)', () => {
    // Verified on hardware 2026-08-26: BLT, BSV, CNT and WXS all reply ERR on a
    // BC75XLT, in and out of program mode. A visible control that cannot work is
    // worse than an absent one — it invites a click that silently fails and logs
    // an error on every settings read.
    it('hides backlight, battery save, and contrast on a BC75XLT', async () => {
      useStore.setState({
        deviceInfo: { ...createTestDeviceInfo(), capabilities: BC75XLT_CAPS },
      });
      renderDeviceTab();
      await selectCategory(/Device Config/i);

      expect(screen.queryByLabelText('Backlight')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Contrast')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Battery Saver')).not.toBeInTheDocument();
    });

    // `KBP` on this model is `[RSV],[LOCK]` -- the beep slot is reserved, and
    // the radio answers `KBP,,0` (settings probe 2026-08-26). The read could
    // never parse, so the switch rendered a fabricated `on`; the write put a
    // number in the reserved slot, which per the vendor spec aborts the whole
    // set command and takes the key lock with it.
    it('hides key beep on a BC75XLT', async () => {
      useStore.setState({
        deviceInfo: { ...createTestDeviceInfo(), capabilities: BC75XLT_CAPS },
      });
      renderDeviceTab();
      await selectCategory(/Device Config/i);

      expect(screen.queryByLabelText('Key Beep')).not.toBeInTheDocument();
    });

    // With two supported families, a user with both scanners otherwise has no
    // in-app way to confirm which one Bearpaw is driving.
    it('names the detected scanner and its memory capacity', async () => {
      useStore.setState({
        deviceInfo: {
          ...createTestDeviceInfo(),
          model: 'BC75XLT',
          capabilities: BC75XLT_CAPS,
        },
      });
      renderDeviceTab();
      await selectCategory(/Device Config/i);

      expect(screen.getByText('BC75XLT')).toBeInTheDocument();
      expect(screen.getByText(/300 ch/)).toBeInTheDocument();
      expect(screen.getByText(/10×30/)).toBeInTheDocument();
    });

    // Bearpaw drives two families now, so naming one when nothing is connected
    // is a guess presented as fact.
    it('does not guess a model when nothing is connected', async () => {
      useStore.setState({ deviceInfo: null });
      renderDeviceTab();
      await selectCategory(/Device Config/i);

      expect(screen.queryByText('BC125AT')).not.toBeInTheDocument();
    });

    // The same controls must still be there for scanners that have them — a
    // gate that hides everything passes the test above and breaks the app.
    it('keeps them for a BC125AT-family scanner', async () => {
      renderDeviceTab();
      await selectCategory(/Device Config/i);

      expect(screen.getByLabelText('Backlight')).toBeInTheDocument();
      expect(screen.getByLabelText('Contrast')).toBeInTheDocument();
      expect(screen.getByLabelText('Battery Saver')).toBeInTheDocument();
      expect(screen.getByLabelText('Key Beep')).toBeInTheDocument();
    });

    // The BC75XLT has service search on its `Svc` key but no `SSG` command, so
    // none of the ten toggles on that page can write. The whole subtab goes,
    // not the switches: a page of dead controls asks the same question on
    // every visit. Its band names are wrong for this model as well — `WX`
    // leads its list and it has no Military Air.
    it('hides the Service Search page on a BC75XLT', () => {
      useStore.setState({
        deviceInfo: { ...createTestDeviceInfo(), capabilities: BC75XLT_CAPS },
      });
      renderDeviceTab();

      expect(screen.queryByRole('button', { name: /Service Search/i })).not.toBeInTheDocument();
    });

    // Paired half — a gate that hid it from everyone would pass the test above.
    it('keeps the Service Search page on a BC125AT-family scanner', () => {
      renderDeviceTab();

      expect(screen.getByRole('button', { name: /Service Search/i })).toBeInTheDocument();
    });

    // REGRESSION GUARD: the Close Call band switch writes the WIRE position
    // its label names. Positions 4 and 5 are swapped between families —
    // BC125AT is [.., UHF, 800 MHz], BC75XLT is [.., reserved, UHF], verified
    // on hardware 2026-08-28 (writing 11111 reads back 11101). Bearpaw used
    // the BC125AT order for both, so on a BC75XLT the "UHF" switch wrote the
    // reserved slot and "800 MHz" — a band that radio cannot receive — was
    // the real UHF control.
    //
    // Asserting the label list alone is NOT enough: hiding the 800 MHz row
    // while leaving UHF at index 3 passes a label check and still writes
    // nothing. The payload index is the assertion that matters.
    it('maps UHF to wire position 5 on a BC75XLT', async () => {
      useStore.setState({
        deviceInfo: { ...createTestDeviceInfo(), capabilities: BC75XLT_CAPS },
      });
      renderDeviceTab();
      await selectCategory(/Close Call/i);

      expect(screen.queryByLabelText('800 MHz')).not.toBeInTheDocument();

      // Index 4 is the fifth mask character. Index 3 is reserved here and must
      // never move.
      expect(await bandPositionMovedBy('UHF')).toEqual([4]);
    });

    // Paired half. Same click, different radio, different wire slot.
    it('maps UHF to wire position 4 on a BC125AT-family scanner', async () => {
      renderDeviceTab();
      await selectCategory(/Close Call/i);

      expect(screen.getByLabelText('800 MHz')).toBeInTheDocument();

      expect(await bandPositionMovedBy('UHF')).toEqual([3]);
    });

    // CLC field 5 is reserved on a BC75XLT: written 1, it reads back empty.
    // Accepted without an error and silently discarded, so nothing but a
    // read-back would ever reveal it.
    it('hides Lockout Hits While Scanning on a BC75XLT', async () => {
      useStore.setState({
        deviceInfo: { ...createTestDeviceInfo(), capabilities: BC75XLT_CAPS },
      });
      renderDeviceTab();
      await selectCategory(/Close Call/i);

      expect(screen.queryByLabelText(/Lockout Hits While Scanning/i)).not.toBeInTheDocument();
    });

    // CC Only (mode 3) is absent from the BC75XLT vendor spec AND its owner's
    // manual, but the radio accepts and retains it (hardware 2026-08-28).
    // Captures win — this option must NOT be hidden on that model.
    it('still offers CC Only on a BC75XLT', async () => {
      useStore.setState({
        deviceInfo: { ...createTestDeviceInfo(), capabilities: BC75XLT_CAPS },
      });
      renderDeviceTab();
      await selectCategory(/Close Call/i);
      await userEvent.click(screen.getByLabelText('Mode'));

      expect(await screen.findByRole('option', { name: 'CC Only' })).toBeInTheDocument();
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
