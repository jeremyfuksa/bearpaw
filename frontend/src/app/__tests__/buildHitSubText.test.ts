import { describe, it, expect } from 'vitest';
import { buildHitSubText } from '../App';
import type { LiveState } from '../../types';

/**
 * The frequency belongs in the sub-line only when an alpha tag is carrying
 * the headline. Without a tag the headline IS the frequency, so repeating it
 * below renders "146.700 / 146.700 • NFM".
 *
 * This is not a BC75XLT-only concern even though that scanner has no alpha
 * tags at all (`has_alpha_tags: false`) and so hits it on every single hit —
 * an untagged channel on a BC125AT stutters identically. Hence the rule is
 * "never repeat the headline" rather than a capability branch.
 */
const base: LiveState = {
  timestamp: 0,
  frequency: 146.7,
  modulation: 'NFM',
  squelch_open: true,
  rssi: 36,
  mode: 'SCAN',
  channel: null,
  alpha_tag: null,
  volume: 1,
  battery: null,
  stale: false,
  tone_squelch_kind: 'none',
};

describe('buildHitSubText', () => {
  it('omits the frequency when no alpha tag is carrying the headline', () => {
    expect(buildHitSubText(base)).toBe('NFM');
  });

  it('includes the frequency when an alpha tag is carrying the headline', () => {
    expect(buildHitSubText({ ...base, alpha_tag: 'KC FIRE 1' })).toBe('146.700 • NFM');
  });

  it('omits the frequency for an untagged BC125AT channel, not just a BC75XLT', () => {
    // Same shape as a BC125AT hit on a channel the user never named: the
    // capability flag is irrelevant, the missing tag is what matters.
    expect(buildHitSubText({ ...base, channel: 12 })).toBe('NFM • CH 12');
  });

  it('still shows the channel and tone alongside a tag', () => {
    expect(
      buildHitSubText({
        ...base,
        alpha_tag: 'KC FIRE 1',
        channel: 12,
        tone_squelch_kind: 'ctcss',
        tone_squelch: 131.8,
      }),
    ).toBe('146.700 • NFM • CH 12 • CTCSS 131.8');
  });

  it('drops the tone once the squelch closes', () => {
    expect(
      buildHitSubText({
        ...base,
        squelch_open: false,
        tone_squelch_kind: 'ctcss',
        tone_squelch: 131.8,
      }),
    ).toBe('NFM');
  });

  it('renders nothing rather than "0.000" for a cleared channel', () => {
    expect(buildHitSubText({ ...base, frequency: 0, modulation: '' })).toBe('');
  });
});
