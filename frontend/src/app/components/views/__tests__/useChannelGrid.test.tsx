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
  onPasteTruncated?: (dropped: number) => void;
  onMoveRows?: (from: number, to: number, count: number) => boolean;
}) {
  const g = useChannelGrid({
    fields: FIELDS,
    rowCount: DATA.length,
    cellText: (r, f) => DATA[r][FIELDS.indexOf(f)],
    onApply: props.onApply ?? vi.fn(),
    onTogglePriority: props.onTogglePriority ?? vi.fn(),
    pasteBlocked: props.pasteBlocked ?? false,
    onPasteBlocked: props.onPasteBlocked ?? vi.fn(),
    onPasteTruncated: props.onPasteTruncated ?? vi.fn(),
    rowName: (r) => `row ${r + 1}`,
    onMoveRows: props.onMoveRows ?? vi.fn(() => true),
  });
  return (
    <>
      <textarea {...g.sinkProps} />
      <button onMouseDown={(e) => e.preventDefault()} onClick={() => g.selectRow(2, false)}>
        select row 3
      </button>
      <div role="grid" aria-label="Channels">
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
    </>
  );
}

const sink = () => screen.getByRole('textbox', { name: /^Channels grid/ });
const clip = (text = '') => ({ clipboardData: { getData: () => text, setData: vi.fn() } });

describe('useChannelGrid', () => {
  // Review #1: the desktop shell's Scanner menu binds Cmd+S (Scan), Cmd+H
  // (Hold) and Cmd+Y (Sync Memory) natively. The sink is skipped by the
  // global shortcut hook, so nothing would preventDefault them and the menu
  // would act from inside the grid. Clipboard keys must still pass through.
  it('swallows the Scanner-menu accelerators but not the clipboard keys', () => {
    render(<Harness />);
    for (const key of ['s', 'h', 'y']) {
      expect(fireEvent.keyDown(sink(), { key, metaKey: true })).toBe(false);
    }
    for (const key of ['c', 'v', 'x', 'a', 'z']) {
      expect(fireEvent.keyDown(sink(), { key, metaKey: true })).toBe(true);
    }
  });

  // Review #5: focus sits on an offscreen textarea, so the browser never
  // scrolls the active cell into view on its own.
  it('scrolls the active cell into view as it moves', () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    render(<Harness />);
    fireEvent.keyDown(sink(), { key: 'ArrowDown', metaKey: true });
    expect(scroll.mock.contexts.at(-1)).toHaveProperty('id', 'channel-cell-2-0');
    scroll.mockRestore();
  });

  // Review #6: the editor renders inside the cell, whose mousedown commits.
  it('clicking inside the open editor keeps it open', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    fireEvent.keyDown(sink(), { key: 'Enter' });
    const editor = screen.getByRole('textbox', { name: 'Frequency, row 1' });
    fireEvent.mouseDown(editor);
    expect(screen.getByRole('textbox', { name: 'Frequency, row 1' })).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  // Review #7: aria-activedescendant on a textarea is not announced, so the
  // sink's own name has to say where the user is.
  it("the sink's name says which cell is active", () => {
    render(<Harness />);
    expect(sink()).toHaveAccessibleName('Channels grid, Frequency, row 1, 154.4300');
    fireEvent.keyDown(sink(), { key: 'ArrowRight' });
    expect(sink()).toHaveAccessibleName('Channels grid, Tag, row 1, Fire');
  });

  it('reports how many pasted rows ran past the last row', () => {
    const onPasteTruncated = vi.fn();
    render(<Harness onPasteTruncated={onPasteTruncated} />);
    fireEvent.keyDown(sink(), { key: 'ArrowDown', metaKey: true });
    fireEvent.paste(sink(), clip('1\n2\n3'));
    expect(onPasteTruncated).toHaveBeenCalledWith(2);
  });

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

  it('Alt+ArrowDown moves the selected rows and the selection follows', () => {
    const onMoveRows = vi.fn(() => true);
    render(<Harness onMoveRows={onMoveRows} />);
    fireEvent.keyDown(sink(), { key: 'ArrowDown', altKey: true });
    expect(onMoveRows).toHaveBeenCalledWith(0, 1, 1);
    expect(sink()).toHaveAttribute('aria-activedescendant', 'channel-cell-1-0');
  });

  // Review (PR C) #1: selecting a row during an edit left the editor open on
  // the new active cell (Priority) and silently dropped the typed text.
  it('selecting a row while editing commits the edit and closes the editor', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    fireEvent.keyDown(sink(), { key: 'Enter' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Frequency, row 1' }), {
      target: { value: '146.52' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'select row 3' }));
    expect(onApply).toHaveBeenCalledWith([{ r: 0, field: 'frequency', text: '146.52' }]);
    expect(screen.queryByRole('textbox', { name: /^(Frequency|Priority), row/ })).toBeNull();
  });

  it('Alt+ArrowUp at the top does nothing', () => {
    const onMoveRows = vi.fn(() => true);
    render(<Harness onMoveRows={onMoveRows} />);
    fireEvent.keyDown(sink(), { key: 'ArrowUp', altKey: true });
    expect(onMoveRows).not.toHaveBeenCalled();
  });

  it('a refused move leaves the selection where it was', () => {
    render(<Harness onMoveRows={() => false} />);
    fireEvent.keyDown(sink(), { key: 'ArrowDown', altKey: true });
    expect(sink()).toHaveAttribute('aria-activedescendant', 'channel-cell-0-0');
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
