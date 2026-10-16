import { describe, it, expect } from 'vitest';
import { validateField, MODULATIONS } from '../channelValidation';
import capabilityFixture from '../../../../test/fixtures/scanner-capabilities.json';
import type { ScannerCapabilities } from '../../../../types';

const bc125 = capabilityFixture.BC125AT as unknown as ScannerCapabilities;
const bc75 = capabilityFixture.BC75XLT as unknown as ScannerCapabilities;

describe('validateField', () => {
  it('accepts every listed modulation and rejects anything else', () => {
    for (const m of MODULATIONS) expect(validateField('modulation', m, bc125)).toBeNull();
    expect(validateField('modulation', 'SPIKE FILL', bc125)).toMatch(/Modulation must be one of/);
    expect(validateField('modulation', 'fm', bc125)).toMatch(/Modulation must be one of/);
  });

  it('checks frequency against the connected model coverage', () => {
    expect(validateField('frequency', '154.4300', bc125)).toBeNull();
    expect(validateField('frequency', '300.0000', bc125)).toBeNull();
    expect(validateField('frequency', '300.0000', bc75)).toMatch(/covered band/);
    expect(validateField('frequency', '0', bc75)).toBeNull();
    expect(validateField('frequency', 'abc', bc75)).toBe('Invalid frequency');
    // #793: a numeric prefix is not a frequency.
    expect(validateField('frequency', '146,520', bc125)).toBe('Invalid frequency');
    expect(validateField('frequency', '0,145', bc125)).toBe('Invalid frequency');
  });

  it('checks delay against the model set', () => {
    expect(validateField('delay', '2', bc125)).toBeNull();
    expect(validateField('delay', '2', bc75)).toMatch(/Delay must be one of 0, 1/);
  });

  // Review #3: the upload handler rejects these characters (alpha_tag_invalid,
  // handlers/memory.rs) — flag them before the wire, not after a 400.
  it('accepts the scanner tag charset and rejects anything else', () => {
    expect(validateField('alpha_tag', '', bc125)).toBeNull();
    expect(validateField('alpha_tag', 'K0ECS - JoCo', bc125)).toBeNull();
    expect(validateField('alpha_tag', 'A!@#$%&*()-/<>.?', bc125)).toBeNull();
    for (const bad of ["Sheriff's Disp", 'Fire, Ch 1', 'KC_Metro', 'Café']) {
      expect(validateField('alpha_tag', bad, bc125)).toMatch(/Tag can only use/);
    }
    expect(validateField('alpha_tag', '12345678901234567', bc125)).toMatch(/16/);
  });

  // Restored from the deleted ChannelEditSheet suite (#146): 25–512 is NOT
  // contiguous, and the pre-connect fallback must still reject the gaps.
  it('rejects gap frequencies with no capabilities yet (#146)', () => {
    for (const gap of ['90.0', '200.0', '390.0', '520.0']) {
      expect(validateField('frequency', gap)).toMatch(/covered band/);
    }
    expect(validateField('frequency', '154.43')).toBeNull();
  });

  it('accepts pre-delays and rejects off-list delays (#146)', () => {
    expect(validateField('delay', '-5', bc125)).toBeNull();
    expect(validateField('delay', '-10', bc125)).toBeNull();
    expect(validateField('delay', '7')).toMatch(/Delay must be one of/);
  });

  it('accepts standard CTCSS tones and blank', () => {
    expect(validateField('tone_squelch', '', bc125)).toBeNull();
    expect(validateField('tone_squelch', '100.0', bc125)).toBeNull();
    expect(validateField('tone_squelch', '101.0', bc125)).toMatch(/CTCSS/);
  });
});
