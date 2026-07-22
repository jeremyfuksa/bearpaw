import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { ScannerDisplay } from '../ScannerUI';

describe('ScannerDisplay', () => {
  const defaultProps = {
    mainText: '151.250',
    subText: '151.250 • CH 1 • FM',
    signalStrength: 3,
    isError: false,
    isScanning: false,
    volume: 8,
    isHolding: false,
    onVolumeChange: vi.fn(),
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
      // DropdownMenu rather than a Popover. Focus the trigger, open with
      // Enter, arrow to the second item (Permanent), and select with Enter.
      const onLockout = vi.fn();
      render(<ScannerDisplay {...defaultProps} onLockout={onLockout} />);
      const trigger = screen.getByRole('button', { name: /lockout/i });
      trigger.focus();
      await userEvent.keyboard('{Enter}');
      expect(await screen.findByRole('menuitem', { name: 'Permanent' })).toBeInTheDocument();
      await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
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
