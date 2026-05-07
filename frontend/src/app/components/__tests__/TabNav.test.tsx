import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { TabNav } from '../ScannerUI';

describe('TabNav Component', () => {
  const defaultProps = {
    currentTab: 'Scan',
    onTabChange: vi.fn(),
    connectionStatus: 'connected',
    modelName: 'BC125AT',
  };

  describe('rendering', () => {
    it('should render 3 tabs', () => {
      render(<TabNav {...defaultProps} />);
      const tabs = screen.getAllByRole('button', { name: /scan|device|channels/i });
      expect(tabs).toHaveLength(3);
    });

    it('should render Scan, Device, Channels tabs', () => {
      render(<TabNav {...defaultProps} />);
      expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Device' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Channels' })).toBeInTheDocument();
    });

    it('should show model name when connected', () => {
      render(<TabNav {...defaultProps} connectionStatus="connected" modelName="BC125AT" />);
      expect(screen.getByText('BC125AT')).toBeInTheDocument();
    });

    it("should show 'Connecting...' when connecting", () => {
      render(<TabNav {...defaultProps} connectionStatus="connecting" />);
      expect(screen.getByText('Connecting...')).toBeInTheDocument();
    });

    it("should show 'Disconnected' when disconnected", () => {
      render(<TabNav {...defaultProps} connectionStatus="disconnected" />);
      expect(screen.getByText('Disconnected')).toBeInTheDocument();
    });

    it('should show green status indicator when connected', () => {
      render(<TabNav {...defaultProps} connectionStatus="connected" />);
      expect(screen.getByText('BC125AT')).toBeInTheDocument();
    });
  });

  describe('active tab styling', () => {
    it('should apply active styles to Scan tab when currentTab is Scan', () => {
      render(<TabNav {...defaultProps} currentTab="Scan" />);
      const scanTab = screen.getByRole('button', { name: 'Scan' });
      expect(scanTab).toHaveClass('text-white');
      const textElement = scanTab.querySelector('p');
      expect(textElement).toHaveClass('font-bold');
    });

    it('should apply active styles to Device tab when currentTab is Device', () => {
      render(<TabNav {...defaultProps} currentTab="Device" />);
      const deviceTab = screen.getByRole('button', { name: 'Device' });
      expect(deviceTab).toHaveClass('text-white');
      const textElement = deviceTab.querySelector('p');
      expect(textElement).toHaveClass('font-bold');
    });

    it('should apply inactive styles to non-active tabs', () => {
      render(<TabNav {...defaultProps} currentTab="Scan" />);
      const deviceTab = screen.getByRole('button', { name: 'Device' });
      const channelsTab = screen.getByRole('button', { name: 'Channels' });
      expect(deviceTab).toHaveClass('scanner-text-light');
      expect(channelsTab).toHaveClass('scanner-text-light');
    });
  });

  describe('user interactions', () => {
    it('should call onTabChange with Scan when Scan tab is clicked', async () => {
      const onTabChange = vi.fn();
      render(<TabNav {...defaultProps} onTabChange={onTabChange} currentTab="Device" />);

      const scanTab = screen.getByRole('button', { name: 'Scan' });
      await userEvent.click(scanTab);

      expect(onTabChange).toHaveBeenCalledWith('Scan');
    });

    it('should call onTabChange with Device when Device tab is clicked', async () => {
      const onTabChange = vi.fn();
      render(<TabNav {...defaultProps} onTabChange={onTabChange} currentTab="Scan" />);

      const deviceTab = screen.getByRole('button', { name: 'Device' });
      await userEvent.click(deviceTab);

      expect(onTabChange).toHaveBeenCalledWith('Device');
    });

    it('should call onTabChange with Channels when Channels tab is clicked', async () => {
      const onTabChange = vi.fn();
      render(<TabNav {...defaultProps} onTabChange={onTabChange} currentTab="Scan" />);

      const channelsTab = screen.getByRole('button', { name: 'Channels' });
      await userEvent.click(channelsTab);

      expect(onTabChange).toHaveBeenCalledWith('Channels');
    });

    it('should allow switching between tabs', async () => {
      const onTabChange = vi.fn();
      render(<TabNav {...defaultProps} onTabChange={onTabChange} currentTab="Scan" />);

      const deviceTab = screen.getByRole('button', { name: 'Device' });
      const channelsTab = screen.getByRole('button', { name: 'Channels' });

      await userEvent.click(deviceTab);
      expect(onTabChange).toHaveBeenLastCalledWith('Device');

      await userEvent.click(channelsTab);
      expect(onTabChange).toHaveBeenLastCalledWith('Channels');
    });
  });

  describe('edge cases', () => {
    it('should handle empty model name', () => {
      render(<TabNav {...defaultProps} modelName="" connectionStatus="disconnected" />);
      expect(screen.getByText('Disconnected')).toBeInTheDocument();
    });

    it('should display model name when connected', () => {
      render(<TabNav {...defaultProps} />);
      expect(screen.getByText('BC125AT')).toBeInTheDocument();
    });

    it('should handle custom model name', () => {
      render(<TabNav {...defaultProps} modelName="SR30C" connectionStatus="connected" />);
      expect(screen.getByText('SR30C')).toBeInTheDocument();
    });
  });
});
