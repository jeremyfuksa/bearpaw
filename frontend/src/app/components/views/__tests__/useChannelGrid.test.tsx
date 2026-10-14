import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useChannelGrid, type GridEdit } from '../useChannelGrid';
import type { GridField } from '../channelGridEdits';

const FIELDS: GridField[] = ['frequency', 'alpha_tag', 'modulation', 'lockout', 'priority'];
const DATA = [
  ['154.4300', 'Fire', 'FM', '', 'P'],
  ['155.1150', 'EMS', 'NFM', 'Yes', ''],
  ['', '', 'AUTO', '', ''],
];

function Harness(props: {
  onApply?: (e: GridEdit[]) => void;
  onTogglePriority?: (r: number) => void;
  pasteBlocked?: boolean;
  onPasteBlocked?: () => void;
}) {
  const g = useChannelGrid({
    fields: FIELDS,
    rowCount: DATA.length,
    cellText: (r, f) => DATA[r][FIELDS.indexOf(f)],
    onApply: props.onApply ?? vi.fn(),
    onTogglePriority: props.onTogglePriority ?? vi.fn(),
    pasteBlocked: props.pasteBlocked ?? false,
    onPasteBlocked: props.onPasteBlocked ?? vi.fn(),
  });
  return (
    <div role="grid" aria-label="Channels">
      <textarea {...g.sinkProps} />
      {DATA.map((row, r) => (
        <div role="row" key={r}>
          {row.map((text, c) => (
            <div key={c} {...g.cellProps(r, c)}>
              {g.editing !== null && g.active.r === r && g.active.c === c ? (
                <input {...g.editorProps(r, c)} />
              ) : (
                text
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const sink = () => screen.getByRole('textbox', { name: 'Channels grid' });
const clip = (text = '') => ({ clipboardData: { getData: () => text, setData: vi.fn() } });

describe('useChannelGrid', () => {
  it('arrow keys move the active cell; aria-activedescendant follows', () => {
    render(<Harness />);
    fireEvent.keyDown(sink(), { key: 'ArrowDown' });
    fireEvent.keyDown(sink(), { key: 'ArrowRight' });
    expect(sink()).toHaveAttribute('aria-activedescendant', 'channel-cell-1-1');
    fireEvent.keyDown(sink(), { key: 'ArrowDown', metaKey: true });
    expect(sink()).toHaveAttribute('aria-activedescendant', 'channel-cell-2-1');
  });

  it('Tab moves across cells and leaves the grid at either edge', () => {
    render(<Harness />);
    expect(fireEvent.keyDown(sink(), { key: 'Tab', shiftKey: true })).toBe(true); // not prevented
    expect(fireEvent.keyDown(sink(), { key: 'Tab' })).toBe(false); // handled in the grid
    expect(sink()).toHaveAttribute('aria-activedescendant', 'channel-cell-0-1');
    fireEvent.keyDown(sink(), { key: 'ArrowRight', metaKey: true });
    expect(fireEvent.keyDown(sink(), { key: 'Tab' })).toBe(true); // not prevented: focus leaves
  });

  it('Shift+arrow extends the selection', () => {
    render(<Harness />);
    fireEvent.keyDown(sink(), { key: 'ArrowDown', shiftKey: true });
    const cells = screen.getAllByRole('gridcell');
    expect(cells[0]).toHaveAttribute('aria-selected', 'true');
    expect(cells[5]).toHaveAttribute('aria-selected', 'true');
    expect(cells[10]).toHaveAttribute('aria-selected', 'false');
  });

  it('typing starts an edit; Enter commits once and moves down; Escape cancels', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    fireEvent.keyDown(sink(), { key: '1' });
    const editor = screen.getByRole('textbox', { name: 'Frequency, row 1' });
    fireEvent.change(editor, { target: { value: '162.55' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith([{ r: 0, field: 'frequency', text: '162.55' }]);
    expect(sink()).toHaveAttribute('aria-activedescendant', 'channel-cell-1-0');

    fireEvent.keyDown(sink(), { key: 'x' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Frequency, row 2' }), {
      key: 'Escape',
    });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('Delete clears the range per column and never touches priority', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    fireEvent.keyDown(sink(), { key: 'ArrowRight', shiftKey: true, metaKey: true });
    fireEvent.keyDown(sink(), { key: 'Delete' });
    expect(onApply).toHaveBeenCalledWith([
      { r: 0, field: 'frequency', text: '' },
      { r: 0, field: 'alpha_tag', text: '' },
      { r: 0, field: 'modulation', text: 'AUTO' },
      { r: 0, field: 'lockout', text: 'n' },
    ]);
  });

  it('copy writes the range as TSV; cut copies then clears', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    fireEvent.keyDown(sink(), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(sink(), { key: 'ArrowRight', shiftKey: true });
    const copy = clip();
    fireEvent.copy(sink(), copy);
    expect(copy.clipboardData.setData).toHaveBeenCalledWith(
      'text/plain',
      '154.4300\tFire\n155.1150\tEMS',
    );
    fireEvent.cut(sink(), clip());
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('pastes a block from the active cell; a single value fills the selection', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    fireEvent.paste(sink(), clip('146.52\tCall\n'));
    expect(onApply).toHaveBeenLastCalledWith([
      { r: 0, field: 'frequency', text: '146.52' },
      { r: 0, field: 'alpha_tag', text: 'Call' },
    ]);
    fireEvent.keyDown(sink(), { key: 'ArrowRight' });
    fireEvent.keyDown(sink(), { key: 'ArrowDown', shiftKey: true, metaKey: true });
    fireEvent.paste(sink(), clip('County'));
    expect(onApply).toHaveBeenLastCalledWith(
      [0, 1, 2].map((r) => ({ r, field: 'alpha_tag', text: 'County' })),
    );
  });

  it('drops pasted rows past the last row', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    fireEvent.keyDown(sink(), { key: 'ArrowDown', metaKey: true });
    fireEvent.paste(sink(), clip('1\n2\n3'));
    expect(onApply).toHaveBeenLastCalledWith([{ r: 2, field: 'frequency', text: '1' }]);
  });

  it('refuses to paste while blocked and writes nothing', () => {
    const onApply = vi.fn();
    const onPasteBlocked = vi.fn();
    render(<Harness onApply={onApply} pasteBlocked onPasteBlocked={onPasteBlocked} />);
    fireEvent.paste(sink(), clip('146.52'));
    expect(onApply).not.toHaveBeenCalled();
    expect(onPasteBlocked).toHaveBeenCalled();
  });

  it('Space fires priority immediately on PRIO and toggles lockout on L/O', () => {
    const onApply = vi.fn();
    const onTogglePriority = vi.fn();
    render(<Harness onApply={onApply} onTogglePriority={onTogglePriority} />);
    fireEvent.keyDown(sink(), { key: 'ArrowRight', metaKey: true });
    fireEvent.keyDown(sink(), { key: ' ' });
    expect(onTogglePriority).toHaveBeenCalledWith(0);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.keyDown(sink(), { key: 'ArrowLeft' });
    fireEvent.keyDown(sink(), { key: ' ' });
    expect(onApply).toHaveBeenCalledWith([{ r: 0, field: 'lockout', text: 'y' }]);
  });
});
