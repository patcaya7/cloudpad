import type { SearchRange } from '../search/searchUtils';

export interface EditorTextSnapshot {
  nodes: Text[];
  text: string;
}

export interface CursorPosition {
  line: number;
  column: number;
}

export interface MultiCursorEditRequest {
  insertText?: string;
  deleteBackward?: boolean;
  deleteForward?: boolean;
}

export type CreateEditorRange = (nodes: Text[], start: number, end: number) => Range | null;

export interface LineInfo {
  line: number;
  start: number;
  end: number;
  text: string;
}

export function getLineInfos(text: string): LineInfo[] {
  const lines = text.split('\n');
  let cursor = 0;
  return lines.map((lineText, line) => {
    const start = cursor;
    const end = start + lineText.length;
    cursor = end + (line < lines.length - 1 ? 1 : 0);
    return { line, start, end, text: lineText };
  });
}

export function normalizeMultiCursorOffsets(offsets: number[], maxOffset: number): number[] {
  return Array.from(
    new Set(offsets.map((offset) => Math.min(maxOffset, Math.max(0, Math.round(offset)))))
  ).sort((a, b) => a - b);
}

export function offsetToCursor(text: string, offset: number): CursorPosition {
  const safeOffset = Math.min(text.length, Math.max(0, Math.round(offset)));
  const before = text.slice(0, safeOffset);
  const parts = before.split('\n');
  return {
    line: parts.length - 1,
    column: parts[parts.length - 1]?.length ?? 0
  };
}

export function cursorToOffset(text: string, cursor: CursorPosition): number {
  const lines = getLineInfos(text);
  const line = lines[Math.min(Math.max(0, cursor.line), Math.max(0, lines.length - 1))];
  if (!line) return 0;
  return line.start + Math.min(Math.max(0, cursor.column), line.text.length);
}

export function normalizeCursors(cursors: CursorPosition[], text: string): CursorPosition[] {
  const seen = new Set<string>();
  const lines = getLineInfos(text);
  const maxLine = Math.max(0, lines.length - 1);

  return cursors
    .map((cursor) => {
      const line = Math.min(Math.max(0, Math.round(cursor.line)), maxLine);
      const lineInfo = lines[line];
      const column = Math.min(Math.max(0, Math.round(cursor.column)), lineInfo?.text.length ?? 0);
      return { line, column };
    })
    .filter((cursor) => {
      const key = `${cursor.line}:${cursor.column}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

export function cursorsToOffsets(text: string, cursors: CursorPosition[]): number[] {
  return normalizeCursors(cursors, text).map((cursor) => cursorToOffset(text, cursor));
}

export function offsetsToCursors(text: string, offsets: number[]): CursorPosition[] {
  return normalizeMultiCursorOffsets(offsets, text.length).map((offset) => offsetToCursor(text, offset));
}

export function renderMultiCursorHighlight(options: {
  cursors?: CursorPosition[];
  offsets?: number[];
  snapshot: EditorTextSnapshot | null;
  createEditorRangeFromOffsets: CreateEditorRange;
  highlightName?: string;
}): void {
  const { cursors, snapshot, createEditorRangeFromOffsets, highlightName = 'cloudpad-multi-cursor' } = options;
  const cssWithHighlights = CSS as unknown as {
    highlights?: {
      set: (name: string, highlight: unknown) => void;
      delete: (name: string) => void;
    };
  };
  const highlightConstructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!cssWithHighlights.highlights || !highlightConstructor) return;

  if (!snapshot || snapshot.text.length === 0) {
    cssWithHighlights.highlights.delete(highlightName);
    cssWithHighlights.highlights.delete('cloudpad-primary-multi-cursor');
    return;
  }

  const offsets = cursors
    ? cursorsToOffsets(snapshot.text, cursors)
    : normalizeMultiCursorOffsets(options.offsets ?? [], snapshot.text.length);

  if (offsets.length === 0) {
    cssWithHighlights.highlights.delete(highlightName);
    cssWithHighlights.highlights.delete('cloudpad-primary-multi-cursor');
    return;
  }

  const domRanges = offsets
    .map((offset) => {
      const start = offset >= snapshot.text.length ? Math.max(0, snapshot.text.length - 1) : offset;
      return createEditorRangeFromOffsets(snapshot.nodes, start, Math.min(snapshot.text.length, start + 1));
    })
    .filter((range): range is Range => range !== null && !range.collapsed);

  if (domRanges.length === 0) {
    cssWithHighlights.highlights.delete(highlightName);
    cssWithHighlights.highlights.delete('cloudpad-primary-multi-cursor');
    return;
  }

  const primaryRange = domRanges[domRanges.length - 1];
  const secondaryRanges = domRanges.slice(0, -1);
  if (secondaryRanges.length > 0) {
    cssWithHighlights.highlights.set(highlightName, new highlightConstructor(...secondaryRanges));
  } else {
    cssWithHighlights.highlights.delete(highlightName);
  }
  cssWithHighlights.highlights.set('cloudpad-primary-multi-cursor', new highlightConstructor(primaryRange));
}

export function applyMultiCursorEdit(options: {
  snapshot: EditorTextSnapshot | null;
  cursors?: CursorPosition[];
  offsets?: number[];
  edit: MultiCursorEditRequest;
  createEditorRangeFromOffsets: CreateEditorRange;
}): { changed: boolean; nextCursors: CursorPosition[]; nextOffsets: number[] } {
  const { snapshot, cursors, edit, createEditorRangeFromOffsets } = options;
  const safeOffsets = snapshot
    ? cursors
      ? cursorsToOffsets(snapshot.text, cursors)
      : normalizeMultiCursorOffsets(options.offsets ?? [], snapshot.text.length)
    : [];

  if (!snapshot || safeOffsets.length === 0) {
    return { changed: false, nextCursors: [], nextOffsets: safeOffsets };
  }

  const nextOffsets: number[] = [];
  const insertText = edit.insertText ?? '';

  for (const offset of [...safeOffsets].sort((a, b) => b - a)) {
    let start = offset;
    let end = offset;
    let nextOffset = offset;

    if (edit.deleteBackward) {
      if (offset <= 0) {
        nextOffsets.push(0);
        continue;
      }
      start = offset - 1;
      nextOffset = offset - 1;
    } else if (edit.deleteForward) {
      if (offset >= snapshot.text.length) {
        nextOffsets.push(offset);
        continue;
      }
      end = offset + 1;
    } else {
      nextOffset = offset + insertText.length;
    }

    const range = createEditorRangeFromOffsets(snapshot.nodes, start, end);
    if (!range) {
      nextOffsets.push(nextOffset);
      continue;
    }

    if (end > start) {
      range.deleteContents();
    }

    if (insertText) {
      range.insertNode(document.createTextNode(insertText));
    }

    nextOffsets.push(nextOffset);
  }

  return {
    changed: true,
    nextOffsets,
    nextCursors: offsetsToCursors(snapshot.text, nextOffsets)
  };
}

export function applyRangeSelectionEdit(options: {
  snapshot: EditorTextSnapshot | null;
  ranges: SearchRange[];
  edit: MultiCursorEditRequest;
  createEditorRangeFromOffsets: CreateEditorRange;
}): { changed: boolean; nextCursors: CursorPosition[]; nextOffsets: number[] } {
  const { snapshot, ranges, edit, createEditorRangeFromOffsets } = options;
  if (!snapshot || ranges.length === 0) return { changed: false, nextCursors: [], nextOffsets: [] };

  const insertText = edit.insertText ?? '';
  const nextOffsets: number[] = [];

  for (const rangeValue of [...ranges].sort((a, b) => Math.max(b.start, b.end) - Math.max(a.start, a.end))) {
    let start = Math.min(rangeValue.start, rangeValue.end);
    let end = Math.max(rangeValue.start, rangeValue.end);

    if (edit.deleteBackward && start === end && start > 0) start -= 1;
    if (edit.deleteForward && start === end && end < snapshot.text.length) end += 1;

    const range = createEditorRangeFromOffsets(snapshot.nodes, start, end);
    if (!range) continue;

    if (end > start) {
      range.deleteContents();
    }

    if (insertText) {
      range.insertNode(document.createTextNode(insertText));
      nextOffsets.push(start + insertText.length);
    } else {
      nextOffsets.push(start);
    }
  }

  return {
    changed: true,
    nextOffsets,
    nextCursors: offsetsToCursors(snapshot.text, nextOffsets)
  };
}
