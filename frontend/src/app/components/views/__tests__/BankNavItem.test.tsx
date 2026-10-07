import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { BankNavItem } from '../ChannelsTab';

/** The Channels sidebar's bank entry and its in-place rename (#677). */
describe('BankNavItem', () => {
  const setup = (overrides: Partial<React.ComponentProps<typeof BankNavItem>> = {}) => {
    const props = {
      bank: 2,
      name: 'Sea',
      active: true,
      canRename: true,
      onSelect: vi.fn(),
      onRename: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    render(<BankNavItem {...props} />);
    return props;
  };

  it('shows the bank name', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Bank 2: Sea' })).toHaveTextContent('Sea');
  });

  it('falls back to "Bank n" for an unnamed bank', () => {
    setup({ name: '' });
    expect(screen.getByRole('button', { name: 'Bank 2' })).toHaveTextContent('Bank 2');
  });

  it('offers rename only on the selected bank', () => {
    setup({ active: false });
    expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument();
  });

  it('hides rename before a scanner profile is known', () => {
    setup({ canRename: false });
    expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument();
  });

  it('saves a trimmed name on Enter', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Rename bank 2' }));
    const input = screen.getByRole('textbox', { name: 'Name for bank 2' });
    await userEvent.clear(input);
    await userEvent.type(input, '  Marine  {Enter}');
    expect(props.onRename).toHaveBeenCalledTimes(1);
    expect(props.onRename).toHaveBeenCalledWith('Marine');
  });

  /**
   * The field stays up while the save is in flight, so leaving it then is a
   * second commit of the same edit: two writes for one rename.
   */
  it('does not save twice when focus leaves during the save', async () => {
    let finish = () => {};
    const onRename = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    setup({ onRename });
    await userEvent.click(screen.getByRole('button', { name: 'Rename bank 2' }));
    await userEvent.type(screen.getByRole('textbox'), 'X{Enter}');
    await userEvent.tab();
    finish();
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('saves when the field loses focus', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Rename bank 2' }));
    await userEvent.type(screen.getByRole('textbox'), 'X');
    await userEvent.tab();
    expect(props.onRename).toHaveBeenCalledWith('SeaX');
  });

  it('discards the edit on Escape', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Rename bank 2' }));
    await userEvent.type(screen.getByRole('textbox'), 'X{Escape}');
    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('does not write when the name is unchanged', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Rename bank 2' }));
    await userEvent.type(screen.getByRole('textbox'), '{Enter}');
    expect(props.onRename).not.toHaveBeenCalled();
  });
});
