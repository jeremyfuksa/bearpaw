import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BearpawProgress } from '../BearpawProgress';

describe('BearpawProgress', () => {
  it('reports the rounded percent in its aria-label at the boundaries', () => {
    const { container, rerender } = render(<BearpawProgress percent={0} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory sync 0% complete',
    );

    rerender(<BearpawProgress percent={100} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory sync 100% complete',
    );
  });

  it('rounds the percent for display', () => {
    const { container } = render(<BearpawProgress percent={42.7} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory sync 43% complete',
    );
  });

  it('renders the pad plus 5 toes regardless of percent', () => {
    const { container } = render(<BearpawProgress percent={0} />);
    // 1 pad + 5 toes = 6 ellipses total.
    expect(container.querySelectorAll('ellipse')).toHaveLength(6);
  });

  it('clamps out-of-range input', () => {
    const { container, rerender } = render(<BearpawProgress percent={-50} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory sync 0% complete',
    );

    rerender(<BearpawProgress percent={250} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory sync 100% complete',
    );
  });

  it('handles non-finite input gracefully', () => {
    const { container } = render(<BearpawProgress percent={NaN} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory sync 0% complete',
    );
  });
});
