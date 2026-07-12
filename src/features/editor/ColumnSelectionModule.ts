import type { SearchRange } from '../search/searchUtils';
import {
  cursorToOffset,
  getLineInfos,
  offsetToCursor,
  type CursorPosition
} from './MultiCursorModule';

export interface ColumnSelection {
  line: number;
  startColumn: number;
  endColumn: number;
}

export function normalizeColumnSelections(selections: ColumnSelection[], text: string): ColumnSelection[] {
  const lines = getLineInfos(text);
  const maxLine = Math.max(0, lines.length - 1);

  return selections
    .map((selection) => {
      const line = Math.min(Math.max(0, Math.round(selection.line)), maxLine);
      const lineLength = lines[line]?.text.length ?? 0;
      const startColumn = Math.min(Math.max(0, Math.round(Math.min(selection.startColumn, selection.endColumn))), lineLength);
      const endColumn = Math.min(Math.max(0, Math.round(Math.max(selection.startColumn, selection.endColumn))), lineLength);
      return { line, startColumn, endColumn };
    })
    .filter((selection) => selection.endColumn > selection.startColumn)
    .sort((a, b) => a.line - b.line || a.startColumn - b.startColumn);
}

export function getColumnSelectionsFromOffsets(text: string, anchorOffset: number, focusOffset: number): ColumnSelection[] {
  if (text.length === 0) return [];

  const anchor = offsetToCursor(text, anchorOffset);
  const focus = offsetToCursor(text, focusOffset);
  const startLine = Math.min(anchor.line, focus.line);
  const endLine = Math.max(anchor.line, focus.line);
  const startColumn = Math.min(anchor.column, focus.column);
  const endColumn = Math.max(anchor.column, focus.column);

  if (startColumn === endColumn) return [];

  return normalizeColumnSelections(
    Array.from({ length: endLine - startLine + 1 }, (_, index) => ({
      line: startLine + index,
      startColumn,
      endColumn
    })),
    text
  );
}

export function columnSelectionsToRanges(text: string, selections: ColumnSelection[]): SearchRange[] {
  return normalizeColumnSelections(selections, text).map((selection) => {
    const start = cursorToOffset(text, { line: selection.line, column: selection.startColumn });
    const end = cursorToOffset(text, { line: selection.line, column: selection.endColumn });
    return { start, end };
  });
}

export function getColumnCursorsFromOffsets(text: string, anchorOffset: number, focusOffset: number): CursorPosition[] {
  if (text.length === 0) return [];

  const anchor = offsetToCursor(text, anchorOffset);
  const focus = offsetToCursor(text, focusOffset);
  const startLine = Math.min(anchor.line, focus.line);
  const endLine = Math.max(anchor.line, focus.line);
  const column = focus.column;

  return Array.from({ length: endLine - startLine + 1 }, (_, index) => ({
    line: startLine + index,
    column
  }));
}

export function expandColumnSelectionWithArrow(options: {
  text: string;
  anchor: CursorPosition;
  focus: CursorPosition;
  key: string;
}): { focus: CursorPosition; selections: ColumnSelection[]; cursors: CursorPosition[] } {
  const { text, anchor, key } = options;
  const lines = getLineInfos(text);
  const maxLine = Math.max(0, lines.length - 1);
  const currentFocus = options.focus;
  let nextFocus: CursorPosition = { ...currentFocus };

  if (key === 'ArrowLeft') nextFocus.column -= 1;
  if (key === 'ArrowRight') nextFocus.column += 1;
  if (key === 'ArrowUp') nextFocus.line -= 1;
  if (key === 'ArrowDown') nextFocus.line += 1;

  nextFocus.line = Math.min(Math.max(0, nextFocus.line), maxLine);
  nextFocus.column = Math.min(Math.max(0, nextFocus.column), lines[nextFocus.line]?.text.length ?? 0);

  const anchorOffset = cursorToOffset(text, anchor);
  const focusOffset = cursorToOffset(text, nextFocus);
  const selections = getColumnSelectionsFromOffsets(text, anchorOffset, focusOffset);
  const cursors = selections.length === 0 ? getColumnCursorsFromOffsets(text, anchorOffset, focusOffset) : [];

  return { focus: nextFocus, selections, cursors };
}
