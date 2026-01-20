import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import App from '../App';

function normalizeSignal(value?: number): number {
  if (value === undefined || value === null) return 0;
  if (value <= 5) return Math.round(value);
  return Math.min(5, Math.round(value / 20));
}

function formatDuration(totalSeconds?: number): string {
  if (!totalSeconds || totalSeconds <= 0) return "0:00";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

describe('App Utilities', () => {
  describe('normalizeSignal', () => {
    it('should return 0 for undefined', () => {
      expect(normalizeSignal(undefined)).toBe(0);
    });

    it('should return 0 for null', () => {
      expect(normalizeSignal(null)).toBe(0);
    });

    it('should return 0 for value of 0', () => {
      expect(normalizeSignal(0)).toBe(0);
    });

    it('should return value directly for values <= 5', () => {
      expect(normalizeSignal(3)).toBe(3);
      expect(normalizeSignal(5)).toBe(5);
    });

    it('should scale values > 5 to 1-5 range', () => {
      expect(normalizeSignal(20)).toBe(1);
      expect(normalizeSignal(40)).toBe(2);
      expect(normalizeSignal(60)).toBe(3);
      expect(normalizeSignal(80)).toBe(4);
      expect(normalizeSignal(100)).toBe(5);
    });

    it('should cap at 5', () => {
      expect(normalizeSignal(200)).toBe(5);
      expect(normalizeSignal(1000)).toBe(5);
    });
  });

  describe('formatDuration', () => {
    it('should return 0:00 for undefined', () => {
      expect(formatDuration(undefined)).toBe("0:00");
    });

    it('should return 0:00 for 0', () => {
      expect(formatDuration(0)).toBe("0:00");
    });

    it('should return 0:00 for negative values', () => {
      expect(formatDuration(-10)).toBe("0:00");
    });

    it('should format seconds correctly', () => {
      expect(formatDuration(30)).toBe("0:30");
      expect(formatDuration(45)).toBe("0:45");
    });

    it('should format minutes and seconds', () => {
      expect(formatDuration(90)).toBe("1:30");
      expect(formatDuration(125)).toBe("2:05");
      expect(formatDuration(3661)).toBe("61:01");
    });
  });
});
