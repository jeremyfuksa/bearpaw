import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChannelEditSheet } from '../ChannelEditSheet';
import { createTestChannel, createTestChannelDraft } from '../../../../test/fixtures';
import type { ChannelDraft, ChannelData } from '../../../../types';

describe('ChannelEditSheet', () => {
  let mockChannel: ChannelData;
  let mockDraft: ChannelDraft;
  let mockOnSave: ReturnType<typeof vi.fn>;
  let mockOnFieldChange: ReturnType<typeof vi.fn>;
  let mockOnClear: ReturnType<typeof vi.fn>;
  let mockOnClose: ReturnType<typeof vi.fn>;

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
    mockOnFieldChange = vi.fn();
    mockOnClear = vi.fn();
    mockOnClose = vi.fn();
  });

  describe('Rendering', () => {
    it('should render edit sheet when isOpen is true', () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
          onClear={mockOnClear}
        />,
      );
      expect(screen.getByText(/Edit Channel 1/i)).toBeInTheDocument();
    });

    it('should not render edit sheet when isOpen is false', () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={false}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      expect(screen.queryByText(/Edit Channel 1/i)).not.toBeInTheDocument();
    });

    it('should render close button', () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    });
  });

  describe('Frequency Field', () => {
    it('should render frequency input with initial value', () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/frequency/i);
      expect(input).toHaveValue('151.2500');
    });

    it('should call onFieldChange when frequency changes', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/frequency/i);
      fireEvent.change(input, { target: { value: '155.7500' } });
      expect(mockOnFieldChange).toHaveBeenLastCalledWith('frequency', '155.7500');
    });

    it('should show error for invalid frequency', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/frequency/i);
      fireEvent.change(input, { target: { value: 'invalid' } });
      await waitFor(() => {
        expect(screen.getByText(/Invalid frequency/i)).toBeInTheDocument();
      });
    });

    it('should show error for frequency out of range (below min)', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/frequency/i);
      fireEvent.change(input, { target: { value: '20.0000' } });
      await waitFor(() => {
        expect(screen.getByText(/Frequency must be 25-512 MHz/i)).toBeInTheDocument();
      });
    });

    it('should show error for frequency out of range (above max)', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/frequency/i);
      fireEvent.change(input, { target: { value: '600.0000' } });
      await waitFor(() => {
        expect(screen.getByText(/Frequency must be 25-512 MHz/i)).toBeInTheDocument();
      });
    });
  });

  describe('Alpha Tag Field', () => {
    it('should render alpha tag input with initial value', () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/alpha tag/i);
      expect(input).toHaveValue('Test Channel');
    });

    it('should call onFieldChange when alpha tag changes', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/alpha tag/i);
      fireEvent.change(input, { target: { value: 'Updated Tag' } });
      expect(mockOnFieldChange).toHaveBeenLastCalledWith('alpha_tag', 'Updated Tag');
    });

    it('should enforce maxLength of 16', () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/alpha tag/i) as HTMLInputElement;
      expect(input.maxLength).toBe(16);
    });
  });

  describe('Modulation Field', () => {
    it('should render modulation select with initial value', () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      expect(screen.getByText(/FM/i)).toBeInTheDocument();
    });

    it('should render all modulation options', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const selectTrigger = screen.getByRole('combobox');
      await userEvent.click(selectTrigger);
      expect(screen.getByText(/AUTO/i)).toBeInTheDocument();
      expect(screen.getByText(/AM/i)).toBeInTheDocument();
      expect(screen.getByText(/NFM/i)).toBeInTheDocument();
    });

    it('should call onFieldChange when modulation changes', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const selectTrigger = screen.getByRole('combobox');
      await userEvent.click(selectTrigger);

      const option = screen.getByRole('option', { name: /AM/i });
      await userEvent.click(option);

      expect(mockOnFieldChange).toHaveBeenCalledWith('modulation', 'AM');
    });
  });

  describe('Tone Squelch Field', () => {
    it('should render tone squelch input with initial value', () => {
      const draftWithTone = createTestChannelDraft({ tone_squelch: '162.2' });
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={draftWithTone}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/tone/i);
      expect(input).toHaveValue('162.2');
    });

    it('should call onFieldChange when tone squelch changes', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/tone/i);
      fireEvent.change(input, { target: { value: '192.8' } });
      expect(mockOnFieldChange).toHaveBeenLastCalledWith('tone_squelch', '192.8');
    });

    it('should show error for tone below 0', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/tone/i);
      fireEvent.change(input, { target: { value: '-10' } });
      await waitFor(() => {
        expect(screen.getByText(/Tone must be 0-999/i)).toBeInTheDocument();
      });
    });

    it('should show error for tone above 999', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/tone/i);
      fireEvent.change(input, { target: { value: '1500' } });
      await waitFor(() => {
        expect(screen.getByText(/Tone must be 0-999/i)).toBeInTheDocument();
      });
    });
  });

  describe('Delay Field', () => {
    it('should render delay input with initial value', () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/delay/i);
      expect(input).toHaveValue('2');
    });

    it('should call onFieldChange when delay changes', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/delay/i);
      fireEvent.change(input, { target: { value: '5' } });
      expect(mockOnFieldChange).toHaveBeenLastCalledWith('delay', '5');
    });

    it('should show error for delay below 0', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/delay/i);
      fireEvent.change(input, { target: { value: '-5' } });
      await waitFor(() => {
        expect(screen.getByText(/Delay must be 0-30 seconds/i)).toBeInTheDocument();
      });
    });

    it('should show error for delay above 30', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/delay/i);
      fireEvent.change(input, { target: { value: '50' } });
      await waitFor(() => {
        expect(screen.getByText(/Delay must be 0-30 seconds/i)).toBeInTheDocument();
      });
    });
  });

  describe('Lockout Switch', () => {
    it('should render lockout switch', () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      expect(screen.getByRole('switch', { name: /lockout/i })).toBeInTheDocument();
    });

    it('should call onFieldChange when lockout is toggled', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const lockoutSwitch = screen.getByRole('switch', { name: /lockout/i });
      await userEvent.click(lockoutSwitch);
      expect(mockOnFieldChange).toHaveBeenCalledWith('lockout', true);
    });
  });

  describe('Priority Switch', () => {
    it('should render priority switch', () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      expect(screen.getByRole('switch', { name: /priority/i })).toBeInTheDocument();
    });

    it('should call onFieldChange when priority is toggled', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const prioritySwitch = screen.getByRole('switch', { name: /priority/i });
      await userEvent.click(prioritySwitch);
      expect(mockOnFieldChange).toHaveBeenCalledWith('priority', true);
    });
  });

  describe('Save and Cancel Buttons', () => {
    it('should render save button', () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      expect(screen.getByRole('button', { name: /Save Draft/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Clear/i })).toBeInTheDocument();
    });

    it('should render cancel button', () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
          onClear={mockOnClear}
        />,
      );
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    });

    it('should call onSave when save button is clicked', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
          onClear={mockOnClear}
        />,
      );
      const saveButton = screen.getByRole('button', { name: /Save Draft/i });
      await userEvent.click(saveButton);
      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(mockDraft);
      });
    });

    it('should call onClose when cancel button is clicked', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
          onClear={mockOnClear}
        />,
      );
      const cancelButton = screen.getByRole('button', { name: /Cancel/i });
      await userEvent.click(cancelButton);
      expect(mockOnClose).toHaveBeenCalled();
    });

    it('should disable save button when there are errors', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/frequency/i);
      fireEvent.change(input, { target: { value: 'invalid' } });
      const saveButton = screen.getByRole('button', { name: /Save Draft/i });
      await waitFor(() => {
        expect(saveButton).toBeDisabled();
      });
    });

    it('should show saving state while saving', async () => {
      const savingPromise = new Promise((resolve) => setTimeout(resolve, 100));
      mockOnSave.mockReturnValue(savingPromise);

      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const saveButton = screen.getByRole('button', { name: /Save Draft/i });
      await userEvent.click(saveButton);

      expect(screen.getByText(/Saving\.\.\./i)).toBeInTheDocument();
    });
  });

  describe('Error Display', () => {
    it('should display error message below invalid frequency field', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/frequency/i);
      fireEvent.change(input, { target: { value: 'abc' } });
      await waitFor(() => {
        expect(screen.getByText(/Invalid frequency/i)).toBeInTheDocument();
      });
    });

    it('should display error message below invalid delay field', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/delay/i);
      fireEvent.change(input, { target: { value: 'abc' } });
      await waitFor(() => {
        expect(screen.getByText(/Delay must be 0-30 seconds/i)).toBeInTheDocument();
      });
    });

    it('should clear error when valid value is entered', async () => {
      render(
        <ChannelEditSheet
          channel={mockChannel}
          draft={mockDraft}
          isOpen={true}
          onClose={mockOnClose}
          onSave={mockOnSave}
          onFieldChange={mockOnFieldChange}
        />,
      );
      const input = screen.getByLabelText(/frequency/i);
      fireEvent.change(input, { target: { value: 'abc' } });
      await waitFor(() => {
        expect(screen.getByText(/Invalid frequency/i)).toBeInTheDocument();
      });

      fireEvent.change(input, { target: { value: '151.25' } });

      await waitFor(() => {
        expect(screen.queryByText(/Invalid frequency/i)).not.toBeInTheDocument();
      });
    });
  });
});
