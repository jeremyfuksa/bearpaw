import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SyncSpinner } from '../SyncSpinner';

describe('SyncSpinner', () => {
  it('reports the rounded percent in its aria-label at the boundaries', () => {
    const { container, rerender } = render(<SyncSpinner percent={0} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory sync 0% complete',
    );

    rerender(<SyncSpinner percent={100} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory sync 100% complete',
    );
  });

  it('rounds the percent for display', () => {
    const { container } = render(<SyncSpinner percent={42.7} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory sync 43% complete',
    );
  });

  it('sweeps the arc: full offset at 0%, no offset at 100%', () => {
    const { container, rerender } = render(<SyncSpinner percent={0} />);
    const arc = () => container.querySelectorAll('circle')[1];

    const circumference = Number(arc().getAttribute('stroke-dasharray'));
    expect(Number(arc().getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference);

    rerender(<SyncSpinner percent={100} />);
    expect(Number(arc().getAttribute('stroke-dashoffset'))).toBeCloseTo(0);
  });

  it('clamps out-of-range input', () => {
    const { container, rerender } = render(<SyncSpinner percent={-50} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory sync 0% complete',
    );

    rerender(<SyncSpinner percent={250} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory sync 100% complete',
    );
  });

  it('handles non-finite input gracefully', () => {
    const { container } = render(<SyncSpinner percent={NaN} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory sync 0% complete',
    );
  });
});
