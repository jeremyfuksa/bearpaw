import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { ScannerDisplay } from '../ScannerUI';

describe('ScannerDisplay', () => {
  const defaultProps = {
    mainText: '151.2500',
    subText: '151.2500 • FM • CH1',
    mode: 'SCAN',
    signalStrength: 3,
    isError: false,
    isScanning: false,
    variant: 'default' as const,
  };

  describe('rendering', () => {
    it('should render main text', () => {
      render(<ScannerDisplay {...defaultProps} />);
      expect(screen.getByText('151.2500')).toBeInTheDocument();
    });

    it('should render sub text', () => {
      render(<ScannerDisplay {...defaultProps} />);
      expect(screen.getByText('151.2500 • FM • CH1')).toBeInTheDocument();
    });

    it('should show scanning state when isScanning is true', () => {
      render(<ScannerDisplay {...defaultProps} isScanning={true} />);
      expect(screen.getByText('Scanning...')).toBeInTheDocument();
      expect(screen.getByText(/searching for signal/i)).toBeInTheDocument();
    });

    it('should show frequency when not scanning', () => {
      render(<ScannerDisplay {...defaultProps} mainText="Test Channel" />);
      expect(screen.getByText('Test Channel')).toBeInTheDocument();
      expect(screen.queryByText('Scanning...')).not.toBeInTheDocument();
    });

    it('should render main text without crashing', () => {
      render(<ScannerDisplay {...defaultProps} />);
      expect(screen.getByText('151.2500')).toBeInTheDocument();
    });

    it('should render when isError is true with usb error', () => {
      render(<ScannerDisplay {...defaultProps} isError={true} errorType="usb" />);
      expect(screen.getByText('151.2500')).toBeInTheDocument();
    });

    it('should render when isError is true with socket error', () => {
      render(<ScannerDisplay {...defaultProps} isError={true} errorType="socket" />);
      expect(screen.getByText('151.2500')).toBeInTheDocument();
    });

    it('should render when isError is false', () => {
      render(<ScannerDisplay {...defaultProps} isError={false} />);
      expect(screen.getByText('151.2500')).toBeInTheDocument();
    });
  });

  describe('variants', () => {
    it("should use hero variant styles when variant is 'hero'", () => {
      const { container } = render(<ScannerDisplay {...defaultProps} variant="hero" />);
      const display = container.querySelector('.scanner-display-surface');
      expect(display).toHaveClass('h-full');
    });

    it("should use default variant styles when variant is 'default'", () => {
      const { container } = render(<ScannerDisplay {...defaultProps} variant="default" />);
      const display = container.querySelector('div');
      expect(display).toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('should handle empty main text', () => {
      render(<ScannerDisplay {...defaultProps} mainText="" />);
      const mainTextEl = screen.queryByText('151.2500');
      expect(mainTextEl).not.toBeInTheDocument();
    });

    it('should handle null sub text', () => {
      render(<ScannerDisplay {...defaultProps} subText={undefined as any} />);
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('should handle zero signal strength', () => {
      render(<ScannerDisplay {...defaultProps} signalStrength={0} />);
      expect(screen.getByText('151.2500')).toBeInTheDocument();
    });

    it('should handle max signal strength', () => {
      render(<ScannerDisplay {...defaultProps} signalStrength={5} />);
      expect(screen.getByText('151.2500')).toBeInTheDocument();
    });
  });
});
