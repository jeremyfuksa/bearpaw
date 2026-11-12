import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Behavioural guards for an UNLISTED scanner (#900), mounting the real App.
 *
 * App.regression.test.tsx pins source shapes because mounting App is costly;
 * these two flows cannot be pinned that way. "No control in the DOM" and "no
 * `sendScan` on leaving Device" are statements about what RUNS, and the second
 * is the one that matters: since #899 the backend answers every command to an
 * unlisted radio with 400 `unsupported_model`, so a resume that fires anyway is
 * a failed request on every trip off the Device page.
 */

const api = vi.hoisted(() => {
  // What the mount-time REST reads answer. Tests set it; the store alone is
  // not enough because App overwrites it from `getDeviceInfo()` on mount.
  const state = { deviceInfo: {} as Record<string, unknown> };
  return {
    state,
    sendHold: vi.fn(() => Promise.resolve({})),
    sendKey: vi.fn(() => Promise.resolve({})),
    toggleTemporaryLockout: vi.fn(() => Promise.resolve({})),
    sendScan: vi.fn(() => Promise.resolve({})),
    setPreference: vi.fn(() => Promise.resolve({})),
    getDeviceInfo: vi.fn(() => Promise.resolve(state.deviceInfo)),
    getStatus: vi.fn(() => Promise.resolve({ stale: false, mode: 'SCAN' })),
    getChannels: vi.fn(() => Promise.resolve([])),
    getBanks: vi.fn(() => Promise.resolve({})),
    syncMemory: vi.fn(() => Promise.resolve({})),
    getAllSettings: vi.fn(() => Promise.resolve({})),
    getScanners: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('../../api/useApi', () => {
  // ONE client for the whole run, like the real `getAPI()`: App puts `api` in
  // effect deps, so a fresh object per call re-runs those effects every render.
  const client = new Proxy(api, {
    get: (target, prop: string) =>
      prop in target ? (target as Record<string, unknown>)[prop] : stub(prop),
  });
  const stubs = new Map<string, ReturnType<typeof vi.fn>>();
  function stub(name: string) {
    if (!stubs.has(name))
      stubs.set(
        name,
        vi.fn(() => Promise.resolve({})),
      );
    return stubs.get(name);
  }
  return { API_BASE: '/api/v1', getAPI: () => client };
});

// Menu events only arrive under Tauri; capture the handlers App registers and
// call them directly, as the native menu would.
const menu = vi.hoisted(() => ({ handlers: null as null | Record<string, () => void> }));
vi.mock('../../hooks/useMenuEvents', () => ({
  useMenuEvents: (handlers: Record<string, () => void>) => {
    menu.handlers = handlers;
  },
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: Object.assign(vi.fn(), {
    error: toastError,
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

import App from '../App';
import { WebSocketContext } from '../../websocket/useWebSocket';
import type { ScannerWebSocket } from '../../websocket/ScannerWebSocket';
import { useStore } from '../../store/useStore';
import { createTestLiveState } from '../../test/fixtures';
import type { DeviceInfo } from '../../types';

const wsValue = {
  ws: { on: () => () => {} } as unknown as ScannerWebSocket,
  connected: true,
  connecting: false,
};

function renderApp() {
  return render(
    <WebSocketContext.Provider value={wsValue}>
      <App />
    </WebSocketContext.Provider>,
  );
}

const FIRST_SENTENCE = 'Bearpaw found your SDS100, which is currently unsupported.';

function connect(deviceInfo: DeviceInfo) {
  api.state.deviceInfo = deviceInfo as unknown as Record<string, unknown>;
  useStore.setState({ liveState: createTestLiveState({ stale: false }), deviceInfo });
}

function connectUnsupported() {
  connect({
    model: 'SDS100',
    connection_status: 'connected',
    diagnostic_code: 'unsupported_model',
    scanner_id: 'sds100-1',
  });
}

describe('an unsupported scanner in App (#900)', () => {
  beforeEach(() => {
    api.sendScan.mockClear();
    api.sendHold.mockClear();
    api.sendKey.mockClear();
    api.toggleTemporaryLockout.mockClear();
    api.getAllSettings.mockClear();
    api.getBanks.mockClear();
    api.syncMemory.mockClear();
    api.setPreference.mockClear();
    toastError.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })),
    );
    connectUnsupported();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('an unsupported scanner shows the panel instead of the scanner display', async () => {
    renderApp();
    expect(await screen.findByText(FIRST_SENTENCE)).toBeInTheDocument();
    expect(
      screen.getByText('A safe, read-only diagnostic on your scanner can help fix that.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    // Nothing that would send a command to the radio.
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('button', { name: /hold/i })).toBeNull();
    expect(screen.queryByLabelText(/squelch/i)).toBeNull();
    expect(screen.queryByLabelText(/volume/i)).toBeNull();
  });

  it('sends no connect-time command: no memory sync, no bank read', async () => {
    // Each would come back 400 `unsupported_model` since #899.
    renderApp();
    await screen.findByText(FIRST_SENTENCE);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(api.syncMemory).not.toHaveBeenCalled();
    expect(api.getBanks).not.toHaveBeenCalled();
  });

  it('shows and announces nothing live from the radio, including its live region', async () => {
    useStore.setState({
      liveState: createTestLiveState({
        stale: false,
        mode: 'SCAN',
        squelch_open: true,
        frequency: 155.34,
        alpha_tag: 'EMS Operations',
      }),
    });
    const { container } = renderApp();
    await screen.findByText(FIRST_SENTENCE);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const text = container.textContent ?? '';
    expect(text).not.toContain('155.34');
    expect(text).not.toContain('EMS Operations');
    expect(screen.queryByText(/hits/i)).toBeNull();
    // Every live region, wherever it is mounted.
    for (const region of container.querySelectorAll('[role="status"], [aria-live]')) {
      expect(region.textContent).not.toContain('155.34');
      expect(region.textContent).not.toContain('EMS Operations');
    }
  });

  it('shows the live hit on a supported scanner', async () => {
    // Positive half: without it, an App that never renders live data passes.
    connect({ model: 'BC125AT', connection_status: 'connected', scanner_id: 'bc125at-1' });
    useStore.setState({
      liveState: createTestLiveState({
        stale: false,
        mode: 'SCAN',
        squelch_open: true,
        frequency: 155.34,
        alpha_tag: 'EMS Operations',
      }),
    });
    const { container } = renderApp();
    await waitFor(() => expect(container.textContent).toContain('EMS Operations'));
  });

  it('sends nothing from the menu or the keyboard shortcuts', async () => {
    renderApp();
    await screen.findByText(FIRST_SENTENCE);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    api.sendScan.mockClear();
    api.syncMemory.mockClear();
    const user = userEvent.setup();
    await user.keyboard('{Control>}s{/Control}');
    await user.keyboard('{Control>}h{/Control}');
    await user.keyboard('{Control>}l{/Control}');
    await user.keyboard('{Control>}{ArrowUp}{/Control}');
    await user.keyboard('{Control>}{ArrowDown}{/Control}');
    act(() => {
      menu.handlers?.onHold();
      menu.handlers?.onScan();
      menu.handlers?.onSyncMemory();
    });
    expect(menu.handlers, 'App must have registered menu handlers').not.toBeNull();
    expect(api.sendScan).not.toHaveBeenCalled();
    expect(api.sendHold).not.toHaveBeenCalled();
    expect(api.sendKey).not.toHaveBeenCalled();
    expect(api.toggleTemporaryLockout).not.toHaveBeenCalled();
    expect(api.syncMemory).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('still sends from the menu and the shortcuts on a supported scanner', async () => {
    // Positive half: a harness whose keys and menu never reach the API passes
    // the guard above.
    connect({ model: 'BC125AT', connection_status: 'connected', scanner_id: 'bc125at-1' });
    renderApp();
    await screen.findByRole('tab', { name: 'Device' });
    const user = userEvent.setup();
    await user.keyboard('{Control>}s{/Control}');
    await user.keyboard('{Control>}h{/Control}');
    expect(api.sendScan).toHaveBeenCalled();
    expect(api.sendHold).toHaveBeenCalled();
    act(() => {
      menu.handlers?.onSyncMemory();
    });
    expect(api.syncMemory).toHaveBeenCalled();
  });

  it('the Channels tab is not offered for an unsupported scanner', async () => {
    renderApp();
    await screen.findByText(FIRST_SENTENCE);
    expect(screen.queryByRole('tab', { name: 'Channels' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Scan' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Device' })).toBeInTheDocument();
  });

  it('the Device page offers the info card and preferences, and reads no settings', async () => {
    renderApp();
    await screen.findByText(FIRST_SENTENCE);
    await userEvent.click(screen.getByRole('tab', { name: 'Device' }));
    expect(await screen.findByText('Device Information')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preferences' })).toBeInTheDocument();
    // Every card below sends a command; the backend would answer each with 400.
    expect(screen.queryByText('Audio & Power')).toBeNull();
    expect(screen.queryByText('Scanning Logic')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close Call' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Locked Channels' })).toBeNull();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(api.getAllSettings).not.toHaveBeenCalled();
  });

  it('does not resume scan when leaving Device on an unsupported scanner', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderApp();
      await screen.findByText(FIRST_SENTENCE);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(screen.getByRole('tab', { name: 'Device' }));
      await user.click(screen.getByRole('tab', { name: 'Scan' }));
      // The resume is delayed 1 s; wait past it so a late call would show.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(api.sendScan).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still resumes scan when leaving Device on a supported scanner', async () => {
    // The positive half: without it, a build that never resumes passes the
    // guard above.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      connect({ model: 'BC125AT', connection_status: 'connected', scanner_id: 'bc125at-1' });
      renderApp();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(await screen.findByRole('tab', { name: 'Device' }));
      await user.click(screen.getByRole('tab', { name: 'Scan' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await waitFor(() => expect(api.sendScan).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }
  });
});
