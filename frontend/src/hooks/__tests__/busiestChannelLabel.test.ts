import { describe, it, expect } from 'vitest';
import { busiestChannelLabel } from '../useDashboardAnalytics';

/**
 * The Busiest Channels chart keyed its X axis on `alpha_tag` alone. A BC75XLT
 * reports `has_alpha_tags: false` and never sends one, so every bar rendered
 * blank — a chart of anonymous rectangles.
 *
 * The fallback is deliberately not a `has_alpha_tags` branch: an unnamed
 * channel on a BC125AT is equally blank, so the rule is "use whatever
 * identifies this row".
 */
describe('busiestChannelLabel', () => {
  it('prefers the alpha tag when the scanner supplies one', () => {
    expect(busiestChannelLabel({ alpha_tag: 'KC FIRE 1', frequency: 146.7 })).toBe('KC FIRE 1');
  });

  it('falls back to the frequency when there is no tag (every BC75XLT row)', () => {
    expect(busiestChannelLabel({ alpha_tag: null, frequency: 146.7 })).toBe('146.700');
  });

  it('falls back for an untagged BC125AT channel too, not just a BC75XLT', () => {
    expect(busiestChannelLabel({ alpha_tag: '', frequency: 154.115, channel: 12 })).toBe('154.115');
  });

  it('treats a whitespace-only tag as absent', () => {
    expect(busiestChannelLabel({ alpha_tag: '   ', frequency: 146.7 })).toBe('146.700');
  });

  it('uses the channel number when the frequency is missing or zero', () => {
    expect(busiestChannelLabel({ alpha_tag: null, frequency: 0, channel: 42 })).toBe('CH 42');
  });

  it('never fabricates a placeholder for a field the hardware cannot store', () => {
    const label = busiestChannelLabel({ alpha_tag: null });
    expect(label).toBe('—');
    expect(label).not.toMatch(/untitled/i);
  });
});
