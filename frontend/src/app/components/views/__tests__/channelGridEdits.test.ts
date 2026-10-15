import { describe, it, expect } from 'vitest';
import {
  parseTsv,
  mapPasteColumns,
  applyCellEdits,
  cellText,
  clearText,
  type GridField,
} from '../channelGridEdits';
import { buildDraft, buildEmptyDraft } from '../ChannelsTab';
import { createTestChannel } from '../../../../test/fixtures';
import type { ChannelDraft } from '../../../../types';

const BC125 = { cleared_delay: 2, valid_delays: [-10, -5, 0, 1, 2, 3, 4, 5] };
const BC75 = { cleared_delay: 0, valid_delays: [0, 1] };
const ALL: GridField[] = [
  'frequency',
  'alpha_tag',
  'modulation',
  'tone_squelch',
  'delay',
  'lockout',
  'priority',
];
const BC75_COLS: GridField[] = ['frequency', 'delay', 'lockout', 'priority'];

const programmed = (f = 154.43): ChannelDraft =>
  buildDraft(createTestChannel({ index: 1, frequency: f, lockout: false, delay: 2 }), 2);

describe('parseTsv', () => {
  it('splits rows and cells, normalises CRLF, drops one trailing newline', () => {
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseTsv('only')).toEqual([['only']]);
    expect(parseTsv('a\n\nb')).toEqual([['a'], [''], ['b']]);
  });
});

describe('mapPasteColumns', () => {
  it('maps positionally from the start column when there is no header', () => {
    const { fields, rows } = mapPasteColumns([['154.43', 'Fire']], ALL, 0);
    expect(fields).toEqual(['frequency', 'alpha_tag']);
    expect(rows).toEqual([['154.43', 'Fire']]);
  });

  it('detects a header, skips it, and maps by name', () => {
    const { fields, rows } = mapPasteColumns(
      [
        ['Mode', 'Freq'],
        ['FM', '154.43'],
      ],
      ALL,
      3,
    );
    expect(fields).toEqual(['modulation', 'frequency']);
    expect(rows).toEqual([['FM', '154.43']]);
  });

  it('drops a named column the scanner does not have instead of shifting it (BC75XLT)', () => {
    const { fields } = mapPasteColumns(
      [
        ['Frequency', 'Tag', 'Mode'],
        ['154.43', 'Fire', 'FM'],
      ],
      BC75_COLS,
      0,
    );
    expect(fields).toEqual(['frequency', null, null]);
  });

  // Review #4: Bearpaw's own CSV export header must be recognised, not
  // poured into the grid as data. Columns the grid has no field for are
  // ignored by name.
  it("recognises Bearpaw's own export header and ignores Index and Bank", () => {
    const header = [
      'Index',
      'Frequency',
      'Modulation',
      'Alpha Tag',
      'Delay',
      'Lockout',
      'Priority',
      'CTCSS/DCS',
      'Bank',
    ];
    const { fields, rows } = mapPasteColumns(
      [header, ['401', '154.43', 'FM', 'Fire', '2', 'Off', 'Off', '', '9']],
      ALL,
      0,
    );
    expect(fields).toEqual([
      null,
      'frequency',
      'modulation',
      'alpha_tag',
      'delay',
      'lockout',
      null,
      'tone_squelch',
      null,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('never maps a pasted column onto priority', () => {
    expect(mapPasteColumns([['x'], ['y']], ALL, 6).fields).toEqual([null]);
    expect(mapPasteColumns([['Priority'], ['1']], ALL, 0).fields).toEqual([null]);
  });

  it('treats a first row with any non-header cell as data', () => {
    const { rows } = mapPasteColumns(
      [
        ['Frequency', '154.43'],
        ['155.1', 'x'],
      ],
      ALL,
      0,
    );
    expect(rows).toHaveLength(2);
  });
});

describe('applyCellEdits', () => {
  it('coerces frequency, modulation, tag and lockout', () => {
    const out = applyCellEdits(
      () => programmed(),
      [
        { index: 1, field: 'frequency', text: ' 155.115 MHz ' },
        { index: 1, field: 'modulation', text: 'nfm' },
        { index: 1, field: 'alpha_tag', text: 'A tag that is far too long' },
        { index: 1, field: 'lockout', text: 'Yes' },
      ],
      BC125,
    );
    expect(out.get(1)).toMatchObject({
      frequency: '155.1150',
      modulation: 'NFM',
      alpha_tag: 'A tag that is fa',
      lockout: true,
    });
  });

  // REGRESSION GUARD (#272/#404 via the grid): a cleared channel must be the
  // model's buildEmptyDraft shape, or it stays pending forever after upload.
  it('clearing the frequency clears the channel with the model shape', () => {
    expect(
      applyCellEdits(() => programmed(), [{ index: 1, field: 'frequency', text: '' }], BC125).get(
        1,
      ),
    ).toEqual(buildEmptyDraft(2));
    expect(
      applyCellEdits(() => programmed(), [{ index: 1, field: 'frequency', text: '0' }], BC75).get(
        1,
      ),
    ).toEqual(buildEmptyDraft(0));
  });

  it('a frequency typed into an empty slot produces an unlocked channel', () => {
    const out = applyCellEdits(
      () => buildEmptyDraft(2),
      [{ index: 1, field: 'frequency', text: '154.43' }],
      BC125,
    );
    expect(out.get(1)).toMatchObject({ frequency: '154.4300', lockout: false });
  });

  it('an explicit lockout in the same edit wins over unlock-on-fill', () => {
    const out = applyCellEdits(
      () => buildEmptyDraft(2),
      [
        { index: 1, field: 'frequency', text: '154.43' },
        { index: 1, field: 'lockout', text: 'y' },
      ],
      BC125,
    );
    expect(out.get(1)?.lockout).toBe(true);
  });

  it('maps on/off to 1/0 only on a boolean-delay model', () => {
    const on = [{ index: 1, field: 'delay' as const, text: 'On' }];
    expect(applyCellEdits(() => programmed(), on, BC75).get(1)?.delay).toBe('1');
    expect(applyCellEdits(() => programmed(), on, BC125).get(1)?.delay).toBe('On');
  });

  it('a blank tone stays blank, which draftChanges reads as "keep DCS"', () => {
    const out = applyCellEdits(
      () => programmed(),
      [{ index: 1, field: 'tone_squelch', text: '' }],
      BC125,
    );
    expect(out.get(1)?.tone_squelch).toBe('');
  });

  it('keeps an invalid value as typed so validation can flag it', () => {
    const out = applyCellEdits(
      () => programmed(),
      [{ index: 1, field: 'frequency', text: 'abc' }],
      BC125,
    );
    expect(out.get(1)?.frequency).toBe('abc');
  });

  it('returns one draft per channel touched', () => {
    const out = applyCellEdits(
      () => programmed(),
      [
        { index: 1, field: 'alpha_tag', text: 'A' },
        { index: 2, field: 'alpha_tag', text: 'B' },
        { index: 1, field: 'modulation', text: 'FM' },
      ],
      BC125,
    );
    expect([...out.keys()]).toEqual([1, 2]);
    expect(out.get(1)).toMatchObject({ alpha_tag: 'A', modulation: 'FM' });
  });
});

describe('cellText / clearText', () => {
  it('shows blank for a cleared frequency, Yes for lockout, P for priority', () => {
    expect(cellText('frequency', buildEmptyDraft(2), false)).toBe('');
    expect(cellText('lockout', { ...programmed(), lockout: true }, false)).toBe('Yes');
    expect(cellText('priority', programmed(), true)).toBe('P');
  });

  it('shows a boolean delay as ON/OFF, the way the cell displays it', () => {
    expect(cellText('delay', { ...programmed(), delay: '1' }, false, true)).toBe('ON');
    expect(cellText('delay', { ...programmed(), delay: '0' }, false, true)).toBe('OFF');
    expect(cellText('delay', { ...programmed(), delay: '2' }, false)).toBe('2');
  });

  it('Delete leaves delay alone and resets the rest', () => {
    expect(clearText('delay')).toBeNull();
    expect(clearText('modulation')).toBe('AUTO');
    expect(clearText('lockout')).toBe('n');
    expect(clearText('frequency')).toBe('');
    expect(clearText('alpha_tag')).toBe('');
  });
});
