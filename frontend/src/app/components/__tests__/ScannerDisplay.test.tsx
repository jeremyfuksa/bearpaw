import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

    it('flips HOLD → SCAN when isHolding is true', () => {
      const { rerender } = render(<ScannerDisplay {...defaultProps} isHolding={false} />);
      expect(screen.getByRole('button', { name: /^HOLD$/i })).toBeInTheDocument();

      rerender(<ScannerDisplay {...defaultProps} isHolding={true} />);
      expect(screen.getByRole('button', { name: /^SCAN$/i })).toBeInTheDocument();
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
    it('calls onLockout with temporary on single click', async () => {
      const onLockout = vi.fn();
      render(<ScannerDisplay {...defaultProps} onLockout={onLockout} />);
      await userEvent.click(screen.getByRole('button', { name: /lockout/i }));
      expect(onLockout).toHaveBeenCalledWith('temporary');
    });

    it('calls onLockout with permanent on double click', async () => {
      const onLockout = vi.fn();
      render(<ScannerDisplay {...defaultProps} onLockout={onLockout} />);
      await userEvent.dblClick(screen.getByRole('button', { name: /lockout/i }));
      expect(onLockout).toHaveBeenCalledWith('permanent');
    });

    it('calls onHoldToggle when HOLD button is clicked', async () => {
      const onHoldToggle = vi.fn();
      render(<ScannerDisplay {...defaultProps} onHoldToggle={onHoldToggle} />);
      await userEvent.click(screen.getByRole('button', { name: /^HOLD$/i }));
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
