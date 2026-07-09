import { describe, expect, it } from 'vitest';
import { formatLiveTone } from '../App';
import type { LiveState } from '../../types';

const base = (over: Partial<LiveState>): LiveState =>
  ({
    timestamp: 0,
    frequency: 146.85,
    modulation: 'FM',
    squelch_open: true,
    rssi: 0,
    mode: 'SCAN',
    volume: 0,
    ...over,
  }) as LiveState;

describe('formatLiveTone', () => {
  it('formats a CTCSS tone as "CTCSS <Hz>"', () => {
    expect(formatLiveTone(base({ tone_squelch_kind: 'ctcss', tone_squelch: 100 }))).toBe(
      'CTCSS 100.0',
    );
  });

  it('passes a DCS label through as-is', () => {
    expect(
      formatLiveTone(
        base({ tone_squelch_kind: 'dcs', tone_dcs_code: 128, tone_dcs_label: 'DCS 023' }),
      ),
    ).toBe('DCS 023');
  });

  it('labels tone search', () => {
    expect(formatLiveTone(base({ tone_squelch_kind: 'search' }))).toBe('Tone Search');
  });

  it('returns null for none', () => {
    expect(formatLiveTone(base({ tone_squelch_kind: 'none' }))).toBeNull();
  });

  it('returns null when tone fields are absent', () => {
    expect(formatLiveTone(base({}))).toBeNull();
  });

  it('returns null for ctcss with a missing Hz value', () => {
    expect(formatLiveTone(base({ tone_squelch_kind: 'ctcss', tone_squelch: null }))).toBeNull();
  });

  it('returns null for dcs with a missing label', () => {
    expect(formatLiveTone(base({ tone_squelch_kind: 'dcs', tone_dcs_code: 128 }))).toBeNull();
  });
});
