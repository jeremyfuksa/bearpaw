// Selection, keyboard, editing and clipboard for the channel grid (#659).
//
// REGRESSION GUARD (focus sink): ChannelsTab.test.tsx :: the grid's focus sink
// is a textarea. Focus lives on a visually hidden <textarea>, not the grid
// element. Tauri's macOS webview (WKWebView) only delivers copy/paste to an
// EDITABLE focused element; a focused div gets neither event (verified in
// tauri:dev, 2026-10-14). Being editable also makes useKeyboardShortcuts'
// isEditableTarget skip it, so the global Cmd+C (copy live frequency),
// Cmd+S (Scan) and Cmd+H (Hold) cannot fire from inside the grid. The sink
// always holds the selection as selected TSV, so WebKit's Copy is enabled.
import { useEffect, useId, useState } from 'react';
import type React from 'react';
import {
  clearText,
  mapPasteColumns,
  parseTsv,
  type DraftField,
  type GridField,
} from './channelGridEdits';

export interface GridEdit {
  r: number;
  field: DraftField;
  text: string;
}

export interface UseChannelGridArgs {
  fields: GridField[];
  rowCount: number;
  cellText: (r: number, field: GridField) => string;
  onApply: (edits: GridEdit[]) => void;
  onTogglePriority: (r: number) => void;
  pasteBlocked: boolean;
  onPasteBlocked: () => void;
  /** Called with how many pasted rows ran past the last row and were dropped. */
  onPasteTruncated: (dropped: number) => void;
  /** How a row is named to assistive tech, e.g. "channel 401". */
  rowName: (r: number) => string;
  /** Move `count` rows starting at `from` so they start at `to` (one step).
   * Returns false when the move is refused, e.g. while filtered. */
  onMoveRows: (from: number, to: number, count: number) => boolean;
  /** True on a model whose delay is a boolean (BC75XLT): the delay cell is
   * then a toggle, like lockout, not a text field. */
  booleanDelay: boolean;
  /** The values a closed-set column offers (Mode; Delay on a BC125AT), or
   * null for a column that is typed or toggled. */
  listOptions: (field: GridField) => readonly string[] | null;
}

/** The desktop shell's Scanner menu accelerators (main.rs: Hold, Scan, Sync
 * Memory). The sink is an editable target, so useKeyboardShortcuts leaves it
 * alone and nothing else would stop the native menu acting from the grid. */
const MENU_ACCELERATORS = new Set(['s', 'h', 'y']);

const LABELS: Record<GridField, string> = {
  frequency: 'Frequency',
  alpha_tag: 'Tag',
  modulation: 'Mode',
  tone_squelch: 'Tone',
  delay: 'Delay',
  lockout: 'Lockout',
  priority: 'Priority',
};

export function useChannelGrid({
  fields,
  rowCount,
  cellText,
  onApply,
  onTogglePriority,
  pasteBlocked,
  onPasteBlocked,
  onPasteTruncated,
  rowName,
  onMoveRows,
  booleanDelay,
  listOptions,
}: UseChannelGridArgs) {
  const [anchor, setAnchor] = useState({ r: 0, c: 0 });
  const [active, setActive] = useState({ r: 0, c: 0 });
  const [editing, setEditing] = useState<string | null>(null);
  // The open list of a list cell, with the highlighted option.
  const [menuState, setMenuState] = useState<{ r: number; c: number; highlight: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  // No refs: every handler below is handed to render, and react-hooks/refs
  // reports any render-time path to a ref. The sink is found by id instead.
  const sinkId = useId();
  const sinkEl = () => document.getElementById(sinkId) as HTMLTextAreaElement | null;

  const lastRow = Math.max(0, rowCount - 1);
  const lastCol = Math.max(0, fields.length - 1);
  // The row count shrinks when the filter or bank changes; never point past it.
  const a = { r: Math.min(anchor.r, lastRow), c: Math.min(anchor.c, lastCol) };
  const f = { r: Math.min(active.r, lastRow), c: Math.min(active.c, lastCol) };
  const r0 = Math.min(a.r, f.r);
  const r1 = Math.max(a.r, f.r);
  const c0 = Math.min(a.c, f.c);
  const c1 = Math.max(a.c, f.c);

  const isSelected = (r: number, c: number) => r >= r0 && r <= r1 && c >= c0 && c <= c1;
  const cellId = (r: number, c: number) => `channel-cell-${r}-${c}`;
  const focusSink = () => sinkEl()?.focus();

  const moveTo = (r: number, c: number, extend = false) => {
    const next = { r: Math.max(0, Math.min(lastRow, r)), c: Math.max(0, Math.min(lastCol, c)) };
    setActive(next);
    if (!extend) setAnchor(next);
  };

  const rangeTsv = () => {
    const lines: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const row: string[] = [];
      for (let c = c0; c <= c1; c++) row.push(cellText(r, fields[c]));
      lines.push(row.join('\t'));
    }
    return lines.join('\n');
  };

  const clearRange = () => {
    const edits: GridEdit[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const field = fields[c];
        if (field === 'priority') continue;
        const text = clearText(field);
        if (text !== null) edits.push({ r, field, text });
      }
    }
    if (edits.length) onApply(edits);
  };

  const applyEditing = () => {
    const field = fields[f.c];
    if (editing !== null && field !== 'priority') onApply([{ r: f.r, field, text: editing }]);
  };

  const commit = (move: { r: number; c: number } | null) => {
    applyEditing();
    setEditing(null);
    if (move) moveTo(move.r, move.c);
    focusSink();
  };

  const cancel = () => {
    setEditing(null);
    focusSink();
  };

  const isToggle = (field: GridField) => field === 'lockout' || (field === 'delay' && booleanDelay);

  /** Flip a toggle column for every selected row, all to the same value:
   * the opposite of the selection's TOP row, so the result is predictable
   * whichever end the selection was extended from. */
  const toggleRange = (field: DraftField) => {
    const on =
      field === 'lockout' ? cellText(r0, 'lockout') === '' : cellText(r0, 'delay') !== 'ON';
    const text = field === 'lockout' ? (on ? 'y' : 'n') : on ? 'on' : 'off';
    const edits: GridEdit[] = [];
    for (let r = r0; r <= r1; r++) edits.push({ r, field, text });
    onApply(edits);
  };

  const startEdit = (initial: string) => {
    if (fields[f.c] === 'priority' || isToggle(fields[f.c])) return;
    setAnchor(f);
    setEditing(initial);
  };

  const openMenu = (r: number, c: number) => {
    const options = listOptions(fields[c]);
    if (!options) return;
    if (editing !== null) commit(null);
    moveTo(r, c);
    setMenuState({ r, c, highlight: Math.max(0, options.indexOf(cellText(r, fields[c]))) });
    focusSink();
  };

  const pickOption = (i: number) => {
    if (!menuState) return;
    const field = fields[menuState.c];
    const options = listOptions(field);
    if (options && field !== 'priority') onApply([{ r: menuState.r, field, text: options[i] }]);
    setMenuState(null);
    focusSink();
  };

  /** A single click on a toggle cell's checkbox: flip that cell only. */
  const toggleAt = (r: number, c: number) => {
    const field = fields[c];
    if (field === 'priority') return onTogglePriority(r);
    if (!isToggle(field)) return;
    const text =
      field === 'lockout'
        ? cellText(r, 'lockout') === ''
          ? 'y'
          : 'n'
        : cellText(r, 'delay') === 'ON'
          ? 'off'
          : 'on';
    onApply([{ r, field: field as DraftField, text }]);
  };

  /** Enter, F2 or double-click: edit a text cell, open a list cell's list,
   * flip a toggle cell. */
  const activate = () => {
    const field = fields[f.c];
    if (field === 'priority') return;
    if (isToggle(field)) return toggleRange(field);
    if (listOptions(field)) return openMenu(f.r, f.c);
    startEdit(cellText(f.r, field));
  };

  // Keep the sink's text = the selection, selected, so native Copy has
  // something to copy even before our handler replaces it.
  const selectionTsv = editing === null && rowCount > 0 ? rangeTsv() : '';
  useEffect(() => {
    const sink = document.getElementById(sinkId) as HTMLTextAreaElement | null;
    if (!sink || editing !== null) return;
    sink.value = selectionTsv;
    if (document.activeElement === sink) sink.select();
  }, [selectionTsv, editing, sinkId]);

  // Focus sits on an offscreen textarea, so the browser never scrolls the
  // active cell into view on its own.
  const activeCellId = rowCount > 0 ? cellId(f.r, f.c) : null;
  useEffect(() => {
    if (activeCellId) document.getElementById(activeCellId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeCellId]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (editing !== null || rowCount === 0) return;
    if (menuState) {
      const count = listOptions(fields[menuState.c])?.length ?? 0;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const highlight = Math.max(0, Math.min(count - 1, menuState.highlight + step));
        return setMenuState({ ...menuState, highlight });
      }
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab') {
        e.preventDefault();
        return pickOption(menuState.highlight);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        return setMenuState(null);
      }
      setMenuState(null); // any other key closes the list and acts normally
    }
    const jump = e.metaKey || e.ctrlKey;
    if (jump && MENU_ACCELERATORS.has(e.key.toLowerCase())) {
      e.preventDefault();
      return;
    }
    // Cmd/Ctrl+A selects every channel in the bank. (Inside an open cell the
    // editor gets the key first, so there it still selects the cell's text.)
    if (jump && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setAnchor({ r: 0, c: 0 });
      setActive({ r: lastRow, c: lastCol });
      return;
    }
    // Plain Alt+Down opens a list cell's list (the spreadsheet convention).
    if (e.altKey && !e.shiftKey && e.key === 'ArrowDown') {
      e.preventDefault();
      return openMenu(f.r, f.c);
    }
    // Alt+Shift+Up/Down moves rows.
    if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      if (r0 + dir < 0 || r1 + dir > lastRow) return;
      if (!onMoveRows(r0, r0 + dir, r1 - r0 + 1)) return;
      setAnchor({ r: a.r + dir, c: a.c });
      setActive({ r: f.r + dir, c: f.c });
      return;
    }
    const ext = e.shiftKey;
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        return moveTo(jump ? 0 : f.r - 1, f.c, ext);
      case 'ArrowDown':
        e.preventDefault();
        return moveTo(jump ? lastRow : f.r + 1, f.c, ext);
      case 'ArrowLeft':
        e.preventDefault();
        return moveTo(f.r, jump ? 0 : f.c - 1, ext);
      case 'ArrowRight':
        e.preventDefault();
        return moveTo(f.r, jump ? lastCol : f.c + 1, ext);
      case 'Tab':
        // At either edge Tab leaves the grid, so keyboard users are never trapped.
        if ((e.shiftKey && f.c === 0) || (!e.shiftKey && f.c === lastCol)) return;
        e.preventDefault();
        return moveTo(f.r, f.c + (e.shiftKey ? -1 : 1));
      case 'Enter':
      case 'F2':
        e.preventDefault();
        return activate();
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        return clearRange();
      case 'Escape':
        return setAnchor(f);
      case ' ': {
        const field = fields[f.c];
        if (field === 'priority') {
          e.preventDefault();
          return onTogglePriority(f.r);
        }
        if (isToggle(field)) {
          e.preventDefault();
          return toggleRange(field as DraftField);
        }
        break;
      }
    }
    if (e.key.length === 1 && !jump && !e.altKey) {
      e.preventDefault();
      startEdit(e.key);
    }
  };

  const onCopy = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (editing !== null) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', rangeTsv());
  };

  const onCut = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (editing !== null) return;
    onCopy(e);
    clearRange();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (editing !== null) return;
    e.preventDefault();
    // REGRESSION GUARD (filtered paste): useChannelGrid.test.tsx :: refuses to
    // paste while blocked. A filtered list's "next rows" are scattered
    // channels, so a paste would silently spread across the bank.
    if (pasteBlocked) return onPasteBlocked();
    const block = parseTsv(e.clipboardData.getData('text/plain'));
    const edits: GridEdit[] = [];
    if (block.length === 1 && block[0].length === 1) {
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const field = fields[c];
          if (field !== 'priority') edits.push({ r, field, text: block[0][0] });
        }
      }
    } else {
      const { fields: target, rows } = mapPasteColumns(block, fields, c0);
      const dropped = Math.max(0, r0 + rows.length - 1 - lastRow);
      if (dropped > 0) onPasteTruncated(dropped);
      rows.forEach((row, dr) => {
        const r = r0 + dr;
        if (r > lastRow) return;
        row.forEach((text, i) => {
          const field = target[i];
          if (field && field !== 'priority') edits.push({ r, field, text });
        });
      });
    }
    if (edits.length) onApply(edits);
  };

  const cellProps = (r: number, c: number) => ({
    id: cellId(r, c),
    role: 'gridcell' as const,
    'aria-selected': isSelected(r, c),
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault();
      setMenuState(null);
      if (editing !== null) commit(null);
      setDragging(true);
      moveTo(r, c, e.shiftKey);
      focusSink();
    },
    onMouseEnter: (e: React.MouseEvent) => {
      if (!dragging) return;
      // No button held means the mouseup was lost (released outside the
      // window): the drag is over, not continuing.
      if ((e.buttons & 1) === 0) return setDragging(false);
      moveTo(r, c, true);
    },
    onMouseUp: () => {
      setDragging(false);
    },
    // mousedown already made (r, c) the active cell.
    onDoubleClick: () => activate(),
  });

  const editorProps = (r: number, c: number) => ({
    autoFocus: true,
    'aria-label': `${LABELS[fields[c]]}, ${rowName(r)}`,
    value: editing ?? '',
    // The editor renders inside the cell, whose mousedown commits the edit.
    onMouseDown: (e: React.MouseEvent<HTMLInputElement>) => e.stopPropagation(),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEditing(e.target.value),
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
      // commit/cancel move focus to the sink and have already handled the
      // edit; applying it again here would use stale state.
      if (e.relatedTarget === sinkEl()) return;
      // Focus left for somewhere outside the grid: keep the edit, don't steal focus back.
      applyEditing();
      setEditing(null);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commit({ r: r + (e.shiftKey ? -1 : 1), c });
      } else if (e.key === 'Tab') {
        e.preventDefault();
        commit({ r, c: c + (e.shiftKey ? -1 : 1) });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    },
  });

  const selectRow = (r: number, extend: boolean) => {
    // Same guard as a cell mousedown: an open edit is kept, not stranded on
    // the new active cell.
    if (editing !== null) commit(null);
    setActive({ r, c: lastCol });
    setAnchor((prev) => ({ r: extend ? prev.r : r, c: 0 }));
    focusSink();
  };

  const selectedRows = () => {
    if (rowCount === 0 || c0 !== 0 || c1 !== lastCol) return [];
    return Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i);
  };

  const menuOptions = menuState ? (listOptions(fields[menuState.c]) ?? []) : [];
  const menu = menuState ? { ...menuState, options: menuOptions } : null;

  /** Props for option i of the open list. Options keep focus on the sink and
   * do not reach the cell's mousedown (which would close the list). */
  const optionProps = (i: number) => ({
    role: 'option' as const,
    'aria-selected': menuState?.highlight === i,
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    },
    onClick: () => pickOption(i),
  });

  const sinkProps = {
    id: sinkId,
    // aria-activedescendant is not announced from a textarea, so the name
    // itself says where the user is.
    'aria-label':
      rowCount > 0
        ? `Channels grid, ${LABELS[fields[f.c]]}, ${rowName(f.r)}, ${cellText(f.r, fields[f.c]) || 'blank'}` +
          (menu ? `, list open, ${menu.options[menu.highlight]}` : '')
        : 'Channels grid',
    'aria-activedescendant': rowCount > 0 ? cellId(f.r, f.c) : undefined,
    onKeyDown,
    onCopy,
    onCut,
    onPaste,
    onFocus: (e: React.FocusEvent<HTMLTextAreaElement>) => e.currentTarget.select(),
    // Focus leaving the grid closes an open list.
    onBlur: () => setMenuState(null),
    className: 'sr-only',
  };

  return {
    active: f,
    editing,
    isSelected,
    selectedRows,
    sinkProps,
    cellProps,
    editorProps,
    selectRow,
    menu,
    openMenu,
    pickOption,
    optionProps,
    toggleAt,
  };
}
