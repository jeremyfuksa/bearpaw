import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChannelEditSheet } from '../ChannelEditSheet';
import { createTestChannel, createTestChannelDraft } from '../../../../test/fixtures';
import type { ChannelDraft, ChannelData } from '../../../../types';

/**
 * The sheet keeps a LOCAL working copy of the draft (#146): edits only reach
 * the parent through onSave. There is deliberately no onFieldChange prop any
 * more — the old per-keystroke store writes meant Cancel kept the edits and
 * they uploaded with the next Upload Changes.
 */
describe('ChannelEditSheet', () => {
  let mockChannel: ChannelData;
  let mockDraft: ChannelDraft;
  let mockOnSave: Mock<(draft: ChannelDraft) => Promise<void>>;
  let mockOnClose: Mock<() => void>;

  const renderSheet = (isOpen = true) =>
    render(
      <ChannelEditSheet
        channel={mockChannel}
        draft={mockDraft}
        isOpen={isOpen}
        onClose={mockOnClose}
        onSave={mockOnSave}
      />,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    mockChannel = createTestChannel({
      index: 1,
      frequency: 151.25,
      alpha_tag: 'Test Channel',
      modulation: 'FM',
      delay: 2,
      lockout: false,
      priority: false,
      tone_squelch: null,
    });
    mockDraft = createTestChannelDraft();
    mockOnSave = vi.fn().mockResolvedValue(undefined);
    mockOnClose = vi.fn();
  });

  describe('Rendering', () => {
    it('renders when open', () => {
      renderSheet();
      expect(screen.getByText(/Edit Channel 1/i)).toBeInTheDocument();
    });

    it('does not render when closed', () => {
      renderSheet(false);
      expect(screen.queryByText(/Edit Channel 1/i)).not.toBeInTheDocument();
    });

    it('renders the close button', () => {
      renderSheet();
      expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    });
  });

  describe('Local draft (Cancel discards edits)', () => {
    it('typing updates the local field, not the parent', async () => {
      renderSheet();
      const freq = screen.getByLabelText('Frequency');
      await userEvent.clear(freq);
      await userEvent.type(freq, '146.5200');
      expect(freq).toHaveValue('146.5200');
      expect(mockOnSave).not.toHaveBeenCalled();
    });

    it('Cancel closes without saving the edits', async () => {
      renderSheet();
      const alpha = screen.getByLabelText('Alpha Tag');
      await userEvent.clear(alpha);
      await userEvent.type(alpha, 'Edited Name');
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(mockOnClose).toHaveBeenCalled();
      expect(mockOnSave).not.toHaveBeenCalled();
    });

    it('Save commits the edited draft to the parent', async () => {
      renderSheet();
      const alpha = screen.getByLabelText('Alpha Tag');
      await userEvent.clear(alpha);
      await userEvent.type(alpha, 'Edited Name');
      await userEvent.click(screen.getByRole('button', { name: /save draft/i }));
      await waitFor(() => expect(mockOnSave).toHaveBeenCalledTimes(1));
      expect(mockOnSave.mock.calls[0][0]).toMatchObject({ alpha_tag: 'Edited Name' });
      expect(mockOnClose).toHaveBeenCalled();
    });

    it('reopening reseeds from the prop draft (discarded edits stay gone)', async () => {
      const { rerender } = renderSheet();
      const alpha = screen.getByLabelText('Alpha Tag');
      await userEvent.clear(alpha);
      await userEvent.type(alpha, 'Edited Name');

      rerender(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={false}
          onClose={mockOnClose}
          onSave={mockOnSave}
        />,
      );
      rerender(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
        />,
      );
      expect(screen.getByLabelText('Alpha Tag')).toHaveValue(mockDraft.alpha_tag);
    });
  });

  describe('Frequency validation (coverage bands, not a contiguous range)', () => {
    it.each(['30.0000', '146.5200', '300.0000', '462.5500', '0'])(
      'accepts in-band or zero frequency %s',
      async (value) => {
        renderSheet();
        const freq = screen.getByLabelText('Frequency');
        await userEvent.clear(freq);
        await userEvent.type(freq, value);
        expect(screen.queryByText(/Frequency must be/i)).not.toBeInTheDocument();
      },
    );

    it.each(['20.0000', '90.0000', '200.0000', '390.0000', '520.0000'])(
      'rejects gap/out-of-range frequency %s',
      async (value) => {
        renderSheet();
        const freq = screen.getByLabelText('Frequency');
        await userEvent.clear(freq);
        await userEvent.type(freq, value);
        expect(screen.getByText(/Frequency must be in a covered band/i)).toBeInTheDocument();
      },
    );
  });

  describe('Delay (canonical CIN set)', () => {
    it('offers exactly the scanner-legal delay values', async () => {
      renderSheet();
      const trigger = screen.getByRole('combobox', { name: /delay/i });
      await userEvent.click(trigger);
      for (const value of ['-10', '-5', '0', '1', '2', '3', '4', '5']) {
        expect(screen.getByRole('option', { name: value })).toBeInTheDocument();
      }
      expect(screen.queryByRole('option', { name: '10' })).not.toBeInTheDocument();
    });

    it('selecting a pre-delay saves it', async () => {
      renderSheet();
      const trigger = screen.getByRole('combobox', { name: /delay/i });
      await userEvent.click(trigger);
      await userEvent.click(screen.getByRole('option', { name: '-5' }));
      await userEvent.click(screen.getByRole('button', { name: /save draft/i }));
      await waitFor(() => expect(mockOnSave).toHaveBeenCalled());
      expect(mockOnSave.mock.calls[0][0]).toMatchObject({ delay: '-5' });
    });
  });

  describe('Tone validation (canonical CTCSS set)', () => {
    it('accepts a standard tone and empty', async () => {
      renderSheet();
      const tone = screen.getByLabelText('Tone Squelch');
      await userEvent.type(tone, '100.0');
      expect(screen.queryByText(/Not a standard CTCSS tone/i)).not.toBeInTheDocument();
      await userEvent.clear(tone);
      expect(screen.queryByText(/Not a standard CTCSS tone/i)).not.toBeInTheDocument();
    });

    it('rejects a non-canonical tone value', async () => {
      renderSheet();
      const tone = screen.getByLabelText('Tone Squelch');
      await userEvent.type(tone, '101.5');
      expect(screen.getByText(/Not a standard CTCSS tone/i)).toBeInTheDocument();
    });
  });

  describe('Modulation', () => {
    it('renders all modulation options and selecting one saves it', async () => {
      renderSheet();
      const trigger = screen.getByRole('combobox', { name: /modulation/i });
      await userEvent.click(trigger);
      expect(screen.getByRole('option', { name: 'AUTO' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'NFM' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('option', { name: 'AM' }));
      await userEvent.click(screen.getByRole('button', { name: /save draft/i }));
      await waitFor(() => expect(mockOnSave).toHaveBeenCalled());
      expect(mockOnSave.mock.calls[0][0]).toMatchObject({ modulation: 'AM' });
    });
  });

  describe('Switches', () => {
    it('toggling lockout/priority is committed on save', async () => {
      renderSheet();
      await userEvent.click(screen.getByRole('switch', { name: /lockout/i }));
      await userEvent.click(screen.getByRole('switch', { name: /priority/i }));
      await userEvent.click(screen.getByRole('button', { name: /save draft/i }));
      await waitFor(() => expect(mockOnSave).toHaveBeenCalled());
      expect(mockOnSave.mock.calls[0][0]).toMatchObject({ lockout: true, priority: true });
    });
  });

  describe('Clear', () => {
    it('Clear empties the local draft; Save commits the cleared slot', async () => {
      renderSheet();
      await userEvent.click(screen.getByRole('button', { name: /^clear$/i }));
      expect(screen.getByLabelText('Frequency')).toHaveValue('0');
      expect(screen.getByLabelText('Alpha Tag')).toHaveValue('');
      await userEvent.click(screen.getByRole('button', { name: /save draft/i }));
      await waitFor(() => expect(mockOnSave).toHaveBeenCalled());
      expect(mockOnSave.mock.calls[0][0]).toMatchObject({ frequency: '0', alpha_tag: '' });
    });
  });

  describe('Error gating', () => {
    it('Save is blocked while a field is invalid', async () => {
      renderSheet();
      const freq = screen.getByLabelText('Frequency');
      await userEvent.clear(freq);
      await userEvent.type(freq, '90.0');
      const save = screen.getByRole('button', { name: /save draft/i });
      expect(save).toBeDisabled();
      expect(mockOnSave).not.toHaveBeenCalled();
    });
  });
});
