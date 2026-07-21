import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TabBar } from '../TabBar';

describe('TabBar', () => {
  it('renders all three tabs', () => {
    render(<TabBar currentTab="Scan" onTabChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Scan' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Device' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Channels' })).toBeInTheDocument();
  });

  it('marks only the current tab as selected', () => {
    render(<TabBar currentTab="Device" onTabChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Device' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Scan' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Channels' })).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onTabChange with the clicked tab', async () => {
    const onTabChange = vi.fn();
    render(<TabBar currentTab="Scan" onTabChange={onTabChange} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Channels' }));
    expect(onTabChange).toHaveBeenCalledTimes(1);
    expect(onTabChange).toHaveBeenCalledWith('Channels');
  });
});
