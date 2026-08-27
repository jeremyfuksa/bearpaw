import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { BankControls } from '../ScannerUI';

describe('BankControls', () => {
  const defaultProps = {
    activeBanks: [true, true, true, true, true, true, true, true, true, true],
    onToggleBank: vi.fn(),
  };

  describe('rendering', () => {
    it('renders 10 bank buttons', () => {
      render(<BankControls {...defaultProps} />);
      expect(screen.getAllByRole('button')).toHaveLength(10);
    });

    it('renders bank labels 1–9 then 0 (mapping bank 10 → "0")', () => {
      render(<BankControls {...defaultProps} />);
      expect(screen.getByRole('button', { name: /^bank 1\b/i })).toHaveTextContent('1');
      expect(screen.getByRole('button', { name: /^bank 5\b/i })).toHaveTextContent('5');
      expect(screen.getByRole('button', { name: /^bank 0\b/i })).toHaveTextContent('0');
    });

    it('reflects enabled state via aria-pressed and the accessible name', () => {
      render(
        <BankControls
          {...defaultProps}
          activeBanks={[true, false, false, false, false, false, false, false, false, false]}
        />,
      );
      const bank1 = screen.getByRole('button', { name: /bank 1 \(enabled\)/i });
      const bank2 = screen.getByRole('button', { name: /bank 2 \(disabled\)/i });
      expect(bank1).toHaveAttribute('aria-pressed', 'true');
      expect(bank2).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('user interactions', () => {
    it('calls onToggleBank with the bank index when a button is clicked', async () => {
      const onToggleBank = vi.fn();
      render(<BankControls {...defaultProps} onToggleBank={onToggleBank} />);
      await userEvent.click(screen.getByRole('button', { name: /bank 3/i }));
      expect(onToggleBank).toHaveBeenCalledWith(2);
    });

    it('maps bank labelled "0" back to index 9', async () => {
      const onToggleBank = vi.fn();
      render(<BankControls {...defaultProps} onToggleBank={onToggleBank} />);
      await userEvent.click(screen.getByRole('button', { name: /bank 0/i }));
      expect(onToggleBank).toHaveBeenCalledWith(9);
    });

    it('toggles each bank independently', async () => {
      const onToggleBank = vi.fn();
      render(<BankControls {...defaultProps} onToggleBank={onToggleBank} />);
      const labels = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
      for (let i = 0; i < labels.length; i++) {
        await userEvent.click(
          screen.getByRole('button', { name: new RegExp(`^bank ${labels[i]}\\b`, 'i') }),
        );
        expect(onToggleBank).toHaveBeenNthCalledWith(i + 1, i);
      }
    });
  });

  describe('edge cases', () => {
    it('marks every bank enabled when all activeBanks are true', () => {
      render(
        <BankControls {...defaultProps} activeBanks={Array.from({ length: 10 }, () => true)} />,
      );
      screen.getAllByRole('button').forEach((button) => {
        expect(button).toHaveAttribute('aria-pressed', 'true');
      });
    });

    it('marks every bank disabled when all activeBanks are false', () => {
      render(
        <BankControls {...defaultProps} activeBanks={Array.from({ length: 10 }, () => false)} />,
      );
      screen.getAllByRole('button').forEach((button) => {
        expect(button).toHaveAttribute('aria-pressed', 'false');
      });
    });

    it('handles mixed bank states', () => {
      const mixed = [true, false, true, false, true, false, true, false, true, false];
      render(<BankControls {...defaultProps} activeBanks={mixed} />);
      screen.getAllByRole('button').forEach((button, index) => {
        expect(button).toHaveAttribute('aria-pressed', String(mixed[index]));
      });
    });
  });

  // Bank 8-10 off, the rest on — the mask actually read from the dev BC75XLT
  // on 2026-08-27, which is what exposed the placeholder problem.
  const REAL_MASK = [true, true, true, true, true, true, true, false, false, false];

  describe('before the scanner has answered (#393)', () => {
    /**
     * REGRESSION GUARD: the store's placeholder is ten ENABLED banks, and the
     * startup SCG read failed on every launch — so a radio with banks 8-10 off
     * displayed all ten lit.
     *
     * The buttons must not present the placeholder as the radio's state, and
     * must not claim `aria-pressed` either way: asserting a value we do not
     * have is the bug, not the styling.
     */
    it('does not claim a state before the mask is known', () => {
      render(<BankControls {...defaultProps} activeBanks={REAL_MASK} banksKnown={false} />);
      const bank1 = screen.getByRole('button', { name: /bank 1 \(reading from scanner\)/i });
      expect(bank1).toBeDisabled();
      expect(bank1).not.toHaveAttribute('aria-pressed');
      expect(screen.queryByRole('button', { name: /\(enabled\)/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /\(disabled\)/i })).not.toBeInTheDocument();
    });

    /**
     * The sharp end of #393. A toggle computes the next mask from the current
     * one, so acting on the all-enabled placeholder would WRITE that guess
     * back to the scanner — turning a display bug into a memory write that
     * silently re-enables banks the user had switched off.
     */
    it('cannot toggle while the mask is still a placeholder', async () => {
      const onToggleBank = vi.fn();
      render(
        <BankControls
          {...defaultProps}
          activeBanks={REAL_MASK}
          banksKnown={false}
          onToggleBank={onToggleBank}
        />,
      );

      await userEvent.click(
        screen.getByRole('button', { name: /bank 1 \(reading from scanner\)/i }),
      );

      expect(onToggleBank).not.toHaveBeenCalled();
    });

    it('behaves normally once the mask is known', async () => {
      const onToggleBank = vi.fn();
      render(
        <BankControls
          {...defaultProps}
          activeBanks={REAL_MASK}
          banksKnown
          onToggleBank={onToggleBank}
        />,
      );

      const bank8 = screen.getByRole('button', { name: /bank 8 \(disabled\)/i });
      expect(bank8).toBeEnabled();
      await userEvent.click(bank8);
      expect(onToggleBank).toHaveBeenCalledWith(7);
    });

    it('defaults to known so existing callers are unaffected', () => {
      render(<BankControls {...defaultProps} activeBanks={REAL_MASK} />);
      expect(screen.getByRole('button', { name: /bank 1 \(enabled\)/i })).toBeEnabled();
    });
  });
});
