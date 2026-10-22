import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SyncPaw } from '../SyncPaw';
import source from '../../../assets/bearpaw-paw.svg?raw';

describe('SyncPaw', () => {
  it('reveals only completed milestones and resets for another sync', () => {
    const { container, rerender } = render(<SyncPaw percent={0} />);
    const lit = () =>
      [...container.querySelectorAll('.is-lit')].map((g) => g.getAttribute('data-segment'));
    expect(lit()).toEqual([]);
    for (const [percent, digits] of [
      [1, 0],
      [19.99, 0],
      [20, 1],
      [39.99, 1],
      [40, 2],
      [60, 3],
      [80, 4],
      [99.99, 4],
      [100, 5],
    ]) {
      rerender(<SyncPaw percent={percent} />);
      expect(lit()).toHaveLength(digits + 1);
    }
    rerender(<SyncPaw percent={65} />);
    expect(lit()).toEqual(['palm', 'outer-left', 'inner-left', 'center']);
    rerender(<SyncPaw percent={0} />);
    expect(lit()).toEqual([]);
  });

  it('requires explicit success, and gives cancellation and errors distinct outcomes', () => {
    const { container, rerender, getByRole } = render(<SyncPaw percent={100} />);
    expect(getByRole('img')).not.toHaveAttribute('data-outcome');
    rerender(<SyncPaw percent={0} outcome="success" />);
    expect(getByRole('img')).toHaveAccessibleName('Memory sync complete');
    expect(container.querySelectorAll('.is-lit')).toHaveLength(6);
    rerender(<SyncPaw percent={60} outcome="cancelled" />);
    expect(getByRole('img')).toHaveAttribute('data-outcome', 'cancelled');
    expect(container.querySelector('.sync-paw__error')).toBeNull();
    rerender(<SyncPaw percent={60} outcome="error" />);
    expect(getByRole('img')).toHaveAccessibleName('Memory sync failed');
    expect(container.querySelector('.sync-paw__error circle')).not.toBeNull();
  });

  it('preserves the source paths and honors the reduced-motion preference', () => {
    const { container, getByRole } = render(<SyncPaw percent={NaN} reducedMotion />);
    const original = new DOMParser().parseFromString(source, 'image/svg+xml');
    expect(
      [...container.querySelectorAll('.sync-paw__off path')].map((p) => p.getAttribute('d')),
    ).toEqual([...original.querySelectorAll('path')].map((p) => p.getAttribute('d')));
    expect(getByRole('img')).toHaveAttribute('data-reduced-motion', 'true');
    expect(container.querySelectorAll('.is-lit')).toHaveLength(0);
  });
});
