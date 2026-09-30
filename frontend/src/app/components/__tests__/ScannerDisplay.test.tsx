import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { ScannerDisplay, StatusBar, formatSyncedAt } from '../ScannerUI';

describe('ScannerDisplay', () => {
  const defaultProps = {
    mainText: '151.250',
    subText: '151.250 • CH 1 • FM',
    signalStrength: 3,
    isError: false,
    isScanning: false,
    volume: 8,
    squelch: 2,
    isHolding: false,
    onVolumeChange: vi.fn(),
    onSquelchChange: vi.fn(),
    onHoldToggle: vi.fn(),
    onLockout: vi.fn(),
    banks: [true, true, true, false, false, false, false, false, false, false],
    onBankToggle: vi.fn(),
  };

  describe('rendering', () => {
    it('renders main text and sub text', () => {
      render(<ScannerDisplay {...defaultProps} />);
      expect(screen.getByText('151.250')).toBeInTheDocument();
      expect(screen.getByText('151.250 • CH 1 • FM')).toBeInTheDocument();
    });

    it('shows scanning state when isScanning is true', () => {
      render(<ScannerDisplay {...defaultProps} isScanning={true} />);
      expect(screen.getByText('Scanning...')).toBeInTheDocument();
      expect(screen.getByText(/searching for signal/i)).toBeInTheDocument();
    });

    it('shows the channel name (not Scanning...) when isScanning is false', () => {
      render(<ScannerDisplay {...defaultProps} mainText="Test Channel" />);
      expect(screen.getByText('Test Channel')).toBeInTheDocument();
      expect(screen.queryByText('Scanning...')).not.toBeInTheDocument();
    });

    it('renders the current volume on the VOL button', () => {
      render(<ScannerDisplay {...defaultProps} volume={12} />);
      expect(screen.getByRole('button', { name: 'Volume 12' })).toHaveTextContent('VOL 12');
    });

    it('renders the current squelch on the SQL button', () => {
      render(<ScannerDisplay {...defaultProps} squelch={5} />);
      expect(screen.getByRole('button', { name: 'Squelch 5' })).toHaveTextContent('SQL 5');
    });

    it('toggles HOLD button aria-pressed and aria-label when isHolding flips', () => {
      // REGRESSION GUARD: The visible label stays "HOLD" in both states; the
      // held/not-held signal is conveyed by aria-pressed (for assistive tech),
      // aria-label (assistive tech action description), and the highlight
      // colour (sighted users). Do NOT reintroduce a text-label flip — the
      // jarring HOLD↔SCAN swap was removed because it implied "press here to
      // resume" while also being the same button you pressed to enter HOLD.
      const { rerender } = render(<ScannerDisplay {...defaultProps} isHolding={false} />);
      const buttonNotHeld = screen.getByRole('button', { name: /Hold scanner/i });
      expect(buttonNotHeld).toHaveTextContent('HOLD');
      expect(buttonNotHeld).toHaveAttribute('aria-pressed', 'false');

      rerender(<ScannerDisplay {...defaultProps} isHolding={true} />);
      const buttonHeld = screen.getByRole('button', { name: /Resume scan/i });
      expect(buttonHeld).toHaveTextContent('HOLD');
      expect(buttonHeld).toHaveAttribute('aria-pressed', 'true');
    });

    it('renders 10 bank buttons reflecting enabled/disabled state', () => {
      render(<ScannerDisplay {...defaultProps} />);
      const enabled = screen.getAllByRole('button', { name: /\(enabled\)/i });
      const disabled = screen.getAllByRole('button', { name: /\(disabled\)/i });
      expect(enabled).toHaveLength(3);
      expect(disabled).toHaveLength(7);
    });

    it('renders with error state', () => {
      render(<ScannerDisplay {...defaultProps} isError={true} errorType="usb" />);
      expect(screen.getByText('151.250')).toBeInTheDocument();
    });
  });

  describe('user interactions', () => {
    it('opens the lockout dropdown and calls onLockout with temporary', async () => {
      const onLockout = vi.fn();
      render(<ScannerDisplay {...defaultProps} onLockout={onLockout} />);
      await userEvent.click(screen.getByRole('button', { name: /lockout/i }));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Temporary' }));
      expect(onLockout).toHaveBeenCalledWith('temporary');
    });

    it('opens the lockout dropdown and calls onLockout with permanent', async () => {
      const onLockout = vi.fn();
      render(<ScannerDisplay {...defaultProps} onLockout={onLockout} />);
      await userEvent.click(screen.getByRole('button', { name: /lockout/i }));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Permanent' }));
      expect(onLockout).toHaveBeenCalledWith('permanent');
    });

    it('closes the lockout dropdown after a selection', async () => {
      render(<ScannerDisplay {...defaultProps} />);
      await userEvent.click(screen.getByRole('button', { name: /lockout/i }));
      expect(screen.getByRole('menuitem', { name: 'Temporary' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('menuitem', { name: 'Temporary' }));
      await waitFor(() =>
        expect(screen.queryByRole('menuitem', { name: 'Temporary' })).not.toBeInTheDocument(),
      );
    });

    it('opens and selects a lockout item by keyboard alone', async () => {
      // Keyboard-only path: the click tests never exercise arrow-key
      // navigation, which is the whole reason the L/O control uses a real
      // DropdownMenu rather than a Popover.
      //
      // This used to send {ArrowDown}{ArrowDown} and assert 'permanent'. Radix
      // CLAMPS at the last item rather than wrapping, so two presses landed on
      // whatever was last -- which was Permanent only because there were two
      // items. Adding a third (#522) silently moved this test onto the new
      // item while it kept passing its old name. Stepping ONE item and
      // asserting the middle one is count-independent: a fourth item cannot
      // quietly change what this exercises.
      const onLockout = vi.fn();
      render(<ScannerDisplay {...defaultProps} onLockout={onLockout} />);
      const trigger = screen.getByRole('button', { name: /lockout/i });
      trigger.focus();
      await userEvent.keyboard('{Enter}');
      expect(await screen.findByRole('menuitem', { name: 'Permanent' })).toBeInTheDocument();
      await userEvent.keyboard('{ArrowDown}{Enter}');
      expect(onLockout).toHaveBeenCalledWith('permanent');
    });

    it('calls onHoldToggle when HOLD button is clicked', async () => {
      const onHoldToggle = vi.fn();
      render(<ScannerDisplay {...defaultProps} onHoldToggle={onHoldToggle} />);
      await userEvent.click(screen.getByRole('button', { name: /Hold scanner/i }));
      expect(onHoldToggle).toHaveBeenCalledTimes(1);
    });

    it('calls onBankToggle with the bank index when a bank button is clicked', async () => {
      const onBankToggle = vi.fn();
      render(<ScannerDisplay {...defaultProps} onBankToggle={onBankToggle} />);
      await userEvent.click(screen.getByRole('button', { name: /^bank 4/i }));
      expect(onBankToggle).toHaveBeenCalledWith(3); // index, not label
    });
  });

  describe('edge cases', () => {
    it('falls back to em dash when subText is missing', () => {
      render(<ScannerDisplay {...defaultProps} subText={undefined} />);
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('handles zero signal strength', () => {
      render(<ScannerDisplay {...defaultProps} signalStrength={0} />);
      expect(screen.getByText('151.250')).toBeInTheDocument();
    });

    it('handles max signal strength', () => {
      render(<ScannerDisplay {...defaultProps} signalStrength={5} />);
      expect(screen.getByText('151.250')).toBeInTheDocument();
    });
  });
});

describe('last-synced label (#413)', () => {
  // Channel memory persists across restarts now, so "how old is what I'm
  // looking at" became a real question the UI has to answer. It sits beside
  // the connection status because that is where "what is this app currently
  // showing me" already lives.

  const NOW = 1_800_000_000; // fixed clock; the helper takes `now` for this

  it('renders nothing when memory has never been read', () => {
    // null is a fresh install, or a cache the capacity guard rejected. A sync
    // is almost always running at that moment, so a "Never" would flash and
    // vanish.
    expect(formatSyncedAt(null, NOW)).toBeNull();
    expect(formatSyncedAt(undefined, NOW)).toBeNull();
  });

  it('treats the 0.0 sentinel as never, not as 1970', () => {
    // ShadowState::default leaves last_sync at 0.0. The backend serialises that
    // as null, but a 0 arriving by any other route must not render as
    // "Synced 20000d ago".
    expect(formatSyncedAt(0, NOW)).toBeNull();
  });

  it('reads as just now inside the first minute', () => {
    expect(formatSyncedAt(NOW - 5, NOW)).toBe('Synced just now');
    expect(formatSyncedAt(NOW - 59, NOW)).toBe('Synced just now');
  });

  it('steps through minutes, hours and days', () => {
    expect(formatSyncedAt(NOW - 60, NOW)).toBe('Synced 1m ago');
    expect(formatSyncedAt(NOW - 45 * 60, NOW)).toBe('Synced 45m ago');
    expect(formatSyncedAt(NOW - 3600, NOW)).toBe('Synced 1h ago');
    expect(formatSyncedAt(NOW - 5 * 3600, NOW)).toBe('Synced 5h ago');
    expect(formatSyncedAt(NOW - 86400, NOW)).toBe('Synced 1d ago');
    expect(formatSyncedAt(NOW - 3 * 86400, NOW)).toBe('Synced 3d ago');
  });

  it('does not render a negative age when the clock disagrees', () => {
    // The timestamp comes from the backend and the comparison clock from the
    // browser. A machine whose clock is behind must not show "Synced -2m ago".
    expect(formatSyncedAt(NOW + 120, NOW)).toBe('Synced just now');
  });

  it('shows the label in the status bar when memory has an age', () => {
    render(
      <StatusBar
        connectionStatus="connected"
        modelName="BC125AT"
        currentTab="Scan"
        syncedAt={Date.now() / 1000 - 3 * 86400}
      />,
    );
    expect(screen.getByText('Synced 3d ago')).toBeInTheDocument();
  });

  it('omits the label entirely when memory has never been read', () => {
    render(
      <StatusBar
        connectionStatus="connected"
        modelName="BC125AT"
        currentTab="Scan"
        syncedAt={null}
      />,
    );
    expect(screen.queryByText(/Synced/)).not.toBeInTheDocument();
  });
});
