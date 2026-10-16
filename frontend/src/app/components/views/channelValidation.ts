import type { ChannelDraft, ScannerCapabilities } from '../../../types';

/** Per-channel modulations the BC125AT family accepts. The edit dialog's
 * dropdown could never produce anything else, so this check only became
 * necessary once text can be typed or pasted into the field (#659). */
export const MODULATIONS = ['AUTO', 'FM', 'AM', 'NFM'] as const;

/** Fallback CIN delay values (docs/BC125AT_PROTOCOL.md §5.3). Negatives are
 * pre-delays. The sheet used to accept 0-30, which either rejected legal
 * pre-delays or passed values the scanner 400s on (#146).
 *
 * #402: the real set comes from ScannerCapabilities.valid_delays — a BC75XLT
 * takes a boolean (0/1), and sending it 2 is a format error that aborts the
 * ENTIRE CIN write, silently discarding frequency, lockout, and priority in
 * the same command. This constant is only the pre-connect default. */
const DELAY_OPTIONS = ['-10', '-5', '0', '1', '2', '3', '4', '5'];

/** BC125AT coverage bands in MHz (docs/SCANNER_PROTOCOL_REFERENCE.md §6).
 * 25-512 is NOT contiguous — gap frequencies (90.0, 200.0) fail only at the
 * wire with a cryptic error unless caught here (#146). */
const FREQUENCY_BANDS: Array<[number, number]> = [
  [25, 54],
  [108, 174],
  [225, 380],
  [400, 512],
];

/** The 50 canonical EIA CTCSS tones (docs/BC125AT_PROTOCOL.md §7.2). The
 * backend rejects anything else with `tone_invalid`; validating here gives
 * the user a readable error before upload. */
const CTCSS_TONES = [
  67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2,
  110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5,
  167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7,
  218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1,
];

/** The MHz a frequency cell's text holds, or NaN. The WHOLE text must be a
 * decimal number, an optional MHz suffix aside. `parseFloat` reads a prefix,
 * which turned a pasted '146,520' into 146 and '0,145' into a channel clear
 * (#793). Every reader of draft frequency text goes through this, so the
 * grid, validation and upload agree on what the text means. */
export function parseFrequency(text: string): number {
  const t = text.trim().replace(/\s*mhz$/i, '');
  return /^(\d+(\.\d*)?|\.\d+)$/.test(t) ? Number(t) : NaN;
}

export function validateField(
  field: keyof ChannelDraft,
  value: string | boolean,
  caps?: ScannerCapabilities,
): string | null {
  if (field === 'alpha_tag' && typeof value === 'string' && value !== '') {
    // Mirrors protocol::validate_channel_name, which the upload handler
    // enforces (alpha_tag_invalid). Empty is allowed: it clears the tag.
    if ([...value].length > 16) return 'Tag must be 16 characters or fewer';
    if (!/^[A-Za-z0-9 !@#$%&*()\-/<>.?]*$/.test(value)) {
      return 'Tag can only use letters, numbers, spaces and ! @ # $ % & * ( ) - / < > . ?';
    }
  }
  if (field === 'modulation' && typeof value === 'string') {
    if (!(MODULATIONS as readonly string[]).includes(value)) {
      return `Modulation must be one of ${MODULATIONS.join(', ')}`;
    }
  }
  if (field === 'frequency' && typeof value === 'string') {
    const freq = parseFrequency(value);
    if (isNaN(freq)) return 'Invalid frequency';
    if (freq === 0) return null;
    // #402: the families do not cover the same spectrum. A BC75XLT has no
    // 225–380 band at all and its UHF range starts at 406, not 400, so the
    // BC125AT bands would accept frequencies it cannot tune.
    const bands = caps?.coverage_bands ?? FREQUENCY_BANDS;
    if (!bands.some(([lo, hi]) => freq >= lo && freq <= hi)) {
      const rendered = bands.map(([lo, hi]) => `${lo}–${hi}`).join(', ');
      return `Frequency must be in a covered band: ${rendered} MHz`;
    }
  }
  if (field === 'delay' && typeof value === 'string') {
    const allowed = caps ? caps.valid_delays.map(String) : DELAY_OPTIONS;
    if (!allowed.includes(value.trim())) {
      return `Delay must be one of ${allowed.join(', ')}`;
    }
  }
  if (field === 'tone_squelch' && typeof value === 'string' && value.trim() !== '') {
    const tone = parseFloat(value);
    if (isNaN(tone) || !CTCSS_TONES.some((t) => Math.abs(t - tone) < 0.05)) {
      return 'Not a standard CTCSS tone (e.g. 67.0 … 254.1)';
    }
  }
  return null;
}
