// Pure edit logic for the channel grid (#659). No React, no store: the grid
// hook turns keys and clipboard into edits, ChannelsTab maps rows to channel
// indexes, and this module turns both into ChannelDrafts.
import type { ChannelDraft } from '../../../types';
import { buildEmptyDraft } from './ChannelsTab';
import { parseFrequency } from './channelValidation';

export type GridField =
  'frequency' | 'alpha_tag' | 'modulation' | 'tone_squelch' | 'delay' | 'lockout' | 'priority';
export type DraftField = Exclude<GridField, 'priority'>;

const HEADER_NAMES: Record<string, GridField> = {
  frequency: 'frequency',
  freq: 'frequency',
  tag: 'alpha_tag',
  name: 'alpha_tag',
  alpha: 'alpha_tag',
  'alpha tag': 'alpha_tag',
  mod: 'modulation',
  modulation: 'modulation',
  mode: 'modulation',
  tone: 'tone_squelch',
  ctcss: 'tone_squelch',
  'ctcss/dcs': 'tone_squelch',
  delay: 'delay',
  dly: 'delay',
  lockout: 'lockout',
  'l/o': 'lockout',
  lo: 'lockout',
  priority: 'priority',
  prio: 'priority',
};

/** Header names the grid has no field for. Recognised so a header row from
 * Bearpaw's own CSV export (Index ... Bank) is still detected as a header;
 * their columns are dropped. */
const IGNORED_HEADERS = new Set(['index', 'channel', 'ch', 'bank']);

const TRUTHY = /^(y|yes|on|true|1|l|lo|locked)$/i;

export function parseTsv(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => line.split('\t'));
}

/** Which field each pasted column lands in. A first row whose cells ALL name
 * a known column is a header: it is skipped, and columns map by name, so a
 * "freq / tag / mode" sheet on a BC75XLT drops Tag and Mode instead of
 * pouring them into Delay and L/O. Without a header, columns map by position
 * from the active column. Priority never takes pasted data: it is an
 * immediate action, not a draft field (#250). */
export function mapPasteColumns(
  block: string[][],
  visible: GridField[],
  startCol: number,
): { fields: (GridField | null)[]; rows: string[][] } {
  const first = block[0] ?? [];
  const keys = first.map((cell) => cell.trim().toLowerCase());
  const named = keys.map((k) => HEADER_NAMES[k] ?? null);
  const isHeader =
    block.length > 1 &&
    first.length > 0 &&
    keys.every((k, i) => named[i] !== null || IGNORED_HEADERS.has(k));
  if (isHeader) {
    const fields = named.map((f) => (f && f !== 'priority' && visible.includes(f) ? f : null));
    return { fields, rows: block.slice(1) };
  }
  const width = Math.max(...block.map((r) => r.length));
  const fields = Array.from({ length: width }, (_, i) => {
    const f = visible[startCol + i] ?? null;
    return f === 'priority' ? null : f;
  });
  return { fields, rows: block };
}

/** The text a cell shows and copies. */
export function cellText(
  field: GridField,
  draft: ChannelDraft,
  priority: boolean,
  booleanDelay = false,
): string {
  if (field === 'priority') return priority ? 'P' : '';
  // A BC75XLT's delay is 0/1 on the wire and ON/OFF on screen; copy what the
  // user sees. coerce() maps ON/OFF back on paste.
  if (field === 'delay' && booleanDelay) return draft.delay === '1' ? 'ON' : 'OFF';
  if (field === 'lockout') return draft.lockout ? 'Yes' : '';
  if (field === 'frequency') return parseFrequency(draft.frequency) === 0 ? '' : draft.frequency;
  return String(draft[field] ?? '');
}

/** What Delete writes into a field. null means Delete leaves it alone: delay
 * has no empty value on the wire. Frequency '' clears the whole channel. */
export function clearText(field: DraftField): string | null {
  if (field === 'delay') return null;
  if (field === 'modulation') return 'AUTO';
  if (field === 'lockout') return 'n';
  return '';
}

function coerce(field: DraftField, text: string, booleanDelay: boolean): string | boolean {
  const t = text.trim();
  switch (field) {
    case 'lockout':
      return TRUTHY.test(t);
    case 'frequency': {
      const n = parseFrequency(t);
      if (t === '' || n === 0) return '0';
      return Number.isFinite(n) ? n.toFixed(4) : t;
    }
    case 'modulation':
      return t === '' ? 'AUTO' : t.toUpperCase();
    case 'alpha_tag':
      return t.slice(0, 16);
    case 'delay':
      if (booleanDelay && /^(on|yes|true)$/i.test(t)) return '1';
      if (booleanDelay && /^(off|no|false)$/i.test(t)) return '0';
      return t;
    case 'tone_squelch':
      return t;
  }
}

/** Fold cell edits into one draft per channel. Invalid text is kept as typed
 * so validation can flag it; nothing here guesses beyond case and spaces,
 * because one bad CIN field aborts the whole write (CLAUDE.md pitfall 8). */
export function applyCellEdits(
  current: (index: number) => ChannelDraft,
  edits: Array<{ index: number; field: DraftField; text: string }>,
  caps: { cleared_delay: number; valid_delays: number[] },
): Map<number, ChannelDraft> {
  const booleanDelay =
    caps.valid_delays.length === 2 && caps.valid_delays[0] === 0 && caps.valid_delays[1] === 1;
  const byIndex = new Map<number, Array<{ field: DraftField; text: string }>>();
  for (const e of edits) {
    const list = byIndex.get(e.index) ?? [];
    list.push({ field: e.field, text: e.text });
    byIndex.set(e.index, list);
  }
  const out = new Map<number, ChannelDraft>();
  for (const [index, list] of byIndex) {
    const before = current(index);
    const wasEmpty = parseFrequency(before.frequency) === 0;
    let next: ChannelDraft = { ...before };
    for (const { field, text } of list) {
      next = { ...next, [field]: coerce(field, text, booleanDelay) };
    }
    if (parseFrequency(next.frequency) === 0) {
      // A zero frequency clears the CHANNEL, in the one shape that matches
      // what the scanner reports (third rail #272/#404). Never hand-build it.
      next = buildEmptyDraft(caps.cleared_delay);
    } else if (wasEmpty && !list.some((e) => e.field === 'lockout')) {
      // A cleared slot reports lockout=true; a channel the user just typed a
      // frequency into should scan.
      next.lockout = false;
    }
    out.set(index, next);
  }
  return out;
}
