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
  });

  it('checks delay against the model set', () => {
    expect(validateField('delay', '2', bc125)).toBeNull();
    expect(validateField('delay', '2', bc75)).toMatch(/Delay must be one of 0, 1/);
  });

  it('accepts standard CTCSS tones and blank', () => {
    expect(validateField('tone_squelch', '', bc125)).toBeNull();
    expect(validateField('tone_squelch', '100.0', bc125)).toBeNull();
    expect(validateField('tone_squelch', '101.0', bc125)).toMatch(/CTCSS/);
  });
});
