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

  // a11y S1: ARIA tabs pattern — roving tabindex, arrow-key nav, and each tab
  // wired to the shared view panel.
  it('gives only the selected tab a tabindex of 0 (roving tabindex)', () => {
    render(<TabBar currentTab="Scan" onTabChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Scan' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Channels' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tab', { name: 'Device' })).toHaveAttribute('tabindex', '-1');
  });

  it('associates each tab with the view panel', () => {
    render(<TabBar currentTab="Scan" onTabChange={() => {}} />);
    const scan = screen.getByRole('tab', { name: 'Scan' });
    expect(scan).toHaveAttribute('aria-controls', 'view-panel');
    expect(scan).toHaveAttribute('id', 'tab-scan');
  });

  it('ArrowRight moves selection to the next tab', async () => {
    const onTabChange = vi.fn();
    render(<TabBar currentTab="Scan" onTabChange={onTabChange} />);
    screen.getByRole('tab', { name: 'Scan' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    // TABS order is Scan, Channels, Device — so next is Channels.
    expect(onTabChange).toHaveBeenCalledWith('Channels');
  });

  it('Home and End jump to the first and last tab', async () => {
    const onTabChange = vi.fn();
    render(<TabBar currentTab="Channels" onTabChange={onTabChange} />);
    screen.getByRole('tab', { name: 'Channels' }).focus();
    await userEvent.keyboard('{End}');
    expect(onTabChange).toHaveBeenLastCalledWith('Device');
    await userEvent.keyboard('{Home}');
    expect(onTabChange).toHaveBeenLastCalledWith('Scan');
  });
});
