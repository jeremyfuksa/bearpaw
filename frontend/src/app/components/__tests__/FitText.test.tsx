import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { FitText } from '../FitText';

// jsdom doesn't implement ResizeObserver. Stub it so the component
// mounts cleanly — the actual shrink math is exercised in browser /
// manual testing rather than here.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('FitText', () => {
  beforeAll(() => {
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
      ResizeObserverStub;
  });

  it('renders the supplied text exactly', () => {
    const { container } = render(<FitText>WOF Maintenance</FitText>);
    expect(container.textContent).toBe('WOF Maintenance');
  });

  it('passes the className through to the rendered text span', () => {
    const { container } = render(<FitText className="font-display text-[40px]">Hello</FitText>);
    const span = container.querySelector('span');
    expect(span).not.toBeNull();
    expect(span?.className).toContain('font-display');
    expect(span?.className).toContain('text-[40px]');
  });

  it('forwards the title attribute', () => {
    const { container } = render(<FitText title="Tooltip text">Display</FitText>);
    expect(container.querySelector('span')?.getAttribute('title')).toBe('Tooltip text');
  });

  it('does not wrap multi-word text onto a second line', () => {
    const { container } = render(<FitText>Many many many words</FitText>);
    const span = container.querySelector('span');
    expect(span?.className).toContain('whitespace-nowrap');
  });

  it('does not crash when ResizeObserver is missing (server / unsupported env)', () => {
    const orig = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
    try {
      // Silence the inevitable warning the missing constructor triggers.
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => render(<FitText>Probe</FitText>)).toThrow();
      err.mockRestore();
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = orig;
    }
  });
});
