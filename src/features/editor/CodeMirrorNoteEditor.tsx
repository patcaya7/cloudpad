import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { CSSProperties } from 'react';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { openUrl } from '@tauri-apps/plugin-opener';
import { EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField, type SelectionRange } from '@codemirror/state';
import {
  crosshairCursor,
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view';
import {
  copyStoredImageToClipboard,
  getStoredImage,
  IMAGE_TOKEN_PATTERN,
  imageTokenFor,
  storeImageFromBlob
} from '../images/image-store';
import type { FindReplaceRequest } from '../search/FindReplacePanel';
import {
  buildReplacementText,
  findMatchesInText,
  type SearchDirection,
  type SearchRange
} from '../search/searchUtils';
import { withEmojiFontFallback, type FontWeight } from '../../types/note';

export interface CodeMirrorFindReplaceResult {
  message: string;
  found?: boolean;
}

export interface CodeMirrorNoteEditorHandle {
  focus: () => void;
  getValue: () => string;
  getHtml: () => string;
  hasFocus: () => boolean;
  preserveSelection: () => boolean;
  setValue: (value: string) => void;
  undo: () => boolean;
  redo: () => boolean;
  goToLine: (lineNumber: number) => void;
  toggleBold: () => boolean;
  setSelectionBold: (active: boolean) => boolean;
  setSelectionWeight: (weight: FontWeight) => boolean;
  setSelectionColor: (color: string) => boolean;
  setSelectionFontSize: (fontSize: number) => boolean;
  setSelectionFontFamily: (fontFamily: string) => boolean;
  getSelectedText: () => string;
  getSelectionRange: () => SearchRange | null;
  findReplaceFind: (direction: SearchDirection, request: FindReplaceRequest) => CodeMirrorFindReplaceResult;
  findReplaceReplace: (request: FindReplaceRequest) => CodeMirrorFindReplaceResult;
  findReplaceReplaceAll: (request: FindReplaceRequest) => CodeMirrorFindReplaceResult;
  findReplaceFormatMatches: (request: FindReplaceRequest) => CodeMirrorFindReplaceResult;
}

interface CodeMirrorNoteEditorProps {
  value: string;
  contentHtml?: string;
  style?: CSSProperties;
  placeholder?: string;
  singleLine?: boolean;
  onChange: (value: string) => void;
  onFormatChange?: (value: string, contentHtml: string) => void;
  onBoldStateChange?: (active: boolean) => void;
  onWeightStateChange?: (weight: FontWeight) => void;
  onColorStateChange?: (color: string) => void;
  onFontSizeStateChange?: (fontSize: number) => void;
  onFontFamilyStateChange?: (fontFamily: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onOpenFind?: () => void;
  onEscapeSmartSelection?: () => void;
}

interface BoldRange {
  from: number;
  to: number;
  weight?: FontWeight;
  color?: string;
  fontSize?: number;
  fontFamily?: string;
}

interface EditorHistorySnapshot {
  value: string;
  ranges: BoldRange[];
  selectionRanges: Array<{ anchor: number; head: number }>;
  mainIndex: number;
}

interface LocalEditorEcho {
  value: string;
  contentHtml: string;
}

const setBoldRangesEffect = StateEffect.define<BoldRange[]>();
let lastWordMultiSelectionAction: { time: number; from: number; to: number } | null = null;

interface DetectedLink {
  from: number;
  to: number;
  url: string;
}

const WEB_LINK_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/giu;
const EMAIL_LINK_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const TRAILING_LINK_PUNCTUATION = /[.,;:!?}\]]+$/u;

function normalizeDetectedLink(value: string): string | null {
  const trimmed = value.replace(TRAILING_LINK_PUNCTUATION, '');
  if (!trimmed) return null;

  const candidate = trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(candidate)) return `mailto:${candidate}`;

  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function findLinksInText(text: string): DetectedLink[] {
  const links: DetectedLink[] = [];
  const appendMatches = (pattern: RegExp) => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const visibleText = match[0].replace(TRAILING_LINK_PUNCTUATION, '');
      const url = normalizeDetectedLink(visibleText);
      if (url && visibleText) {
        links.push({ from: match.index, to: match.index + visibleText.length, url });
      }
    }
  };

  appendMatches(WEB_LINK_PATTERN);
  appendMatches(EMAIL_LINK_PATTERN);
  return links
    .sort((first, second) => first.from - second.from || first.to - second.to)
    .filter((link, index, all) => index === 0 || link.from >= all[index - 1].to);
}

function getLinkAtPosition(view: EditorView, position: number): DetectedLink | null {
  return findLinksInText(view.state.doc.toString()).find((link) => position >= link.from && position < link.to) ?? null;
}

async function openDetectedLink(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    // Browser preview does not have the Tauri opener plugin. Keep the feature
    // testable on the web while the installed desktop app uses the OS browser.
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

// Consecutive typing/deletion within this window collapses into one undo step
// so Ctrl+Z reverts a burst of text instead of a single character at a time.
const TYPING_UNDO_GROUP_MS = 400;

// In-app rich clipboard: remembers the formatting (colour/weight/size/font) of the
// last copied/cut selection, keyed by its plain text, so pasting that same text back
// restores its formatting. Ranges are stored relative to the start of the selection.
let internalRichClipboard: { text: string; ranges: BoldRange[] } | null = null;

// ---- Inline images -------------------------------------------------------------
// A pasted image lives in the local image store; the note text only contains a
// token like [ภาพ:<id>]. This widget replaces the token with the actual bitmap.
// Clicking the image selects its whole token so Ctrl+C / Delete treat it as a unit.

class ImageTokenWidget extends WidgetType {
  constructor(readonly imageId: string) {
    super();
  }

  eq(other: ImageTokenWidget): boolean {
    return other.imageId === this.imageId;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'cm-inline-image-wrapper';

    const dataUrl = getStoredImage(this.imageId);
    if (!dataUrl) {
      wrapper.classList.add('cm-inline-image-missing');
      wrapper.textContent = '🖼️ ไม่พบรูปบนเครื่องนี้';
      return wrapper;
    }

    const image = document.createElement('img');
    image.src = dataUrl;
    image.className = 'cm-inline-image';
    image.draggable = false;
    image.title = 'คลิกเพื่อเลือกรูป · Ctrl+C คัดลอก · Delete ลบ';
    image.addEventListener('click', (event) => {
      event.preventDefault();
      const start = view.posAtDOM(wrapper);
      const token = imageTokenFor(this.imageId);
      const slice = view.state.doc.sliceString(start, start + token.length);
      if (slice === token) {
        view.dispatch({ selection: EditorSelection.range(start, start + token.length) });
        view.focus();
      }
    });
    wrapper.appendChild(image);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildImageDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const visible of view.visibleRanges) {
    const text = view.state.doc.sliceString(visible.from, visible.to);
    IMAGE_TOKEN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_TOKEN_PATTERN.exec(text)) !== null) {
      const start = visible.from + match.index;
      builder.add(start, start + match[0].length, Decoration.replace({ widget: new ImageTokenWidget(match[1]) }));
    }
  }
  return builder.finish();
}

const imageTokenPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildImageDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildImageDecorations(update.view);
      }
    }
  },
  {
    decorations: (instance) => instance.decorations,
    provide: (plugin) =>
      // Atomic: arrow keys/backspace treat the whole token as one unit.
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none)
  }
);
const EMOJI_TRACE_STORAGE_KEY = 'cloudpad:emoji-input-trace';

function traceWindowsEmojiInput(
  source: string,
  event: Event | null,
  view: EditorView,
  singleLine: boolean
) {
  if (!import.meta.env.DEV) return;
  const inputEvent = event instanceof InputEvent ? event : null;
  const keyboardEvent = event instanceof KeyboardEvent ? event : null;
  const compositionEvent = event instanceof CompositionEvent ? event : null;
  const data = inputEvent?.data ?? compositionEvent?.data ?? '';
  const record = {
    at: Date.now(),
    source,
    editor: singleLine ? 'title' : 'body',
    eventType: event?.type ?? 'none',
    key: keyboardEvent?.key ?? '',
    code: keyboardEvent?.code ?? '',
    metaKey: keyboardEvent?.metaKey ?? false,
    inputType: inputEvent?.inputType ?? '',
    dataLength: data.length,
    codePoints: data
      ? Array.from(data).slice(0, 12).map((character) => character.codePointAt(0)?.toString(16) ?? '')
      : [],
    documentHasFocus: document.hasFocus(),
    editorHasFocus: view.hasFocus,
    activeClass: document.activeElement?.getAttribute('class') ?? ''
  };

  try {
    const previous = JSON.parse(sessionStorage.getItem(EMOJI_TRACE_STORAGE_KEY) ?? '[]') as unknown[];
    sessionStorage.setItem(
      EMOJI_TRACE_STORAGE_KEY,
      JSON.stringify([...previous.slice(-79), record])
    );
  } catch {
    sessionStorage.setItem(EMOJI_TRACE_STORAGE_KEY, JSON.stringify([record]));
  }
  console.info('[CloudPadEmojiTrace]', JSON.stringify(record));
}

function getSelectionRangeBounds(range: SelectionRange): BoldRange {
  return {
    from: Math.min(range.from, range.to),
    to: Math.max(range.from, range.to)
  };
}

function rangesIntersect(first: BoldRange, second: BoldRange): boolean {
  return Math.max(first.from, second.from) < Math.min(first.to, second.to);
}

function normalizeRangeWeight(weight: FontWeight | undefined): FontWeight {
  return weight ?? '800';
}

function isBoldWeight(weight: FontWeight | undefined): boolean {
  if (!weight) return false;
  const normalizedWeight = normalizeRangeWeight(weight);
  return normalizedWeight === '600' || normalizedWeight === '700' || normalizedWeight === '800';
}

function normalizeRangeColor(color: string | undefined): string | undefined {
  const normalizedColor = color?.trim();
  return normalizedColor || undefined;
}

function normalizeRangeFontSize(fontSize: number | undefined): number | undefined {
  if (!Number.isFinite(fontSize)) return undefined;
  return Math.max(10, Math.min(100, Math.round(Number(fontSize))));
}

function normalizeRangeFontFamily(fontFamily: string | undefined): string | undefined {
  const normalizedFamily = fontFamily?.trim().replace(/[;<>]/g, '').slice(0, 180);
  return normalizedFamily ? withEmojiFontFallback(normalizedFamily) : undefined;
}

function areRangeStylesEqual(first: BoldRange, second: BoldRange): boolean {
  return (
    first.weight === second.weight &&
    normalizeRangeColor(first.color) === normalizeRangeColor(second.color) &&
    normalizeRangeFontSize(first.fontSize) === normalizeRangeFontSize(second.fontSize) &&
    normalizeRangeFontFamily(first.fontFamily) === normalizeRangeFontFamily(second.fontFamily)
  );
}

function hasAnyRangeStyle(range: BoldRange): boolean {
  return Boolean(
    range.weight ||
    normalizeRangeColor(range.color) ||
    normalizeRangeFontSize(range.fontSize) ||
    normalizeRangeFontFamily(range.fontFamily)
  );
}

function buildRangeStyle(range: BoldRange): string {
  const styles: string[] = [];
  if (range.weight) styles.push(`font-weight: ${normalizeRangeWeight(range.weight)}`);
  const color = normalizeRangeColor(range.color);
  if (color) styles.push(`color: ${color}`);
  const fontSize = normalizeRangeFontSize(range.fontSize);
  if (fontSize) styles.push(`font-size: ${fontSize}px`);
  const fontFamily = normalizeRangeFontFamily(range.fontFamily);
  if (fontFamily) styles.push(`font-family: ${fontFamily}`);
  return styles.join('; ');
}

function uniqueSortedSelectionRanges(ranges: SelectionRange[]): SelectionRange[] {
  const seen = new Set<string>();
  return ranges
    .filter((range) => {
      const bounds = getSelectionRangeBounds(range);
      const key = `${bounds.from}:${bounds.to}:${range.anchor}:${range.head}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.from - b.from || a.to - b.to || a.anchor - b.anchor || a.head - b.head);
}

function isSelectableWordCharacter(character: string | undefined): boolean {
  return Boolean(character && !/\s/u.test(character));
}

function getMainSelectionRange(view: EditorView): SearchRange | null {
  const range = view.state.selection.main;
  const start = Math.min(range.from, range.to);
  const end = Math.max(range.from, range.to);
  return start === end ? null : { start, end };
}

function mergeStyleRanges(ranges: BoldRange[], docLength: number): BoldRange[] {
  const normalizedRanges = ranges
    .map((range) => ({
      from: Math.max(0, Math.min(docLength, Math.min(range.from, range.to))),
      to: Math.max(0, Math.min(docLength, Math.max(range.from, range.to))),
      weight: range.weight ? normalizeRangeWeight(range.weight) : undefined,
      color: normalizeRangeColor(range.color),
      fontSize: normalizeRangeFontSize(range.fontSize),
      fontFamily: normalizeRangeFontFamily(range.fontFamily)
    }))
    .filter(hasAnyRangeStyle)
    .filter((range) => range.to > range.from);

  if (normalizedRanges.length === 0) return [];

  const splitPoints = new Set<number>();
  for (const range of normalizedRanges) {
    splitPoints.add(range.from);
    splitPoints.add(range.to);
  }

  const points = Array.from(splitPoints).sort((a, b) => a - b);
  const segmentedRanges: BoldRange[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (to <= from) continue;

    const combinedRange: BoldRange = { from, to };
    for (const range of normalizedRanges) {
      if (range.from <= from && range.to >= to) {
        if (range.weight !== undefined) combinedRange.weight = range.weight;
        if (range.color !== undefined) combinedRange.color = range.color;
        if (range.fontSize !== undefined) combinedRange.fontSize = range.fontSize;
        if (range.fontFamily !== undefined) combinedRange.fontFamily = range.fontFamily;
      }
    }

    if (hasAnyRangeStyle(combinedRange)) {
      segmentedRanges.push(combinedRange);
    }
  }

  const mergedRanges: BoldRange[] = [];
  for (const range of segmentedRanges) {
    const previous = mergedRanges[mergedRanges.length - 1];
    if (previous && previous.to === range.from && areRangeStylesEqual(previous, range)) {
      previous.to = range.to;
    } else {
      mergedRanges.push({ ...range });
    }
  }
  return mergedRanges;
}

function mergeSelectionRanges(ranges: BoldRange[], docLength: number): BoldRange[] {
  const sortedRanges = ranges
    .map((range) => ({
      from: Math.max(0, Math.min(docLength, Math.min(range.from, range.to))),
      to: Math.max(0, Math.min(docLength, Math.max(range.from, range.to)))
    }))
    .filter((range) => range.to > range.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);

  const mergedRanges: BoldRange[] = [];
  for (const range of sortedRanges) {
    const previous = mergedRanges[mergedRanges.length - 1];
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      mergedRanges.push({ ...range });
    }
  }
  return mergedRanges;
}

function normalizeThaiGraphemeSelections(text: string, ranges: BoldRange[], docLength: number): BoldRange[] {
  const thaiTrailingMark = /[\u0E31\u0E33-\u0E3A\u0E47-\u0E4E]/u;
  const thaiLeadingVowel = /[\u0E40-\u0E44]/u;
  const thaiBaseCharacter = /[\u0E01-\u0E2E]/u;

  const normalizedRanges = ranges.map((range) => {
    let from = Math.max(0, Math.min(docLength, Math.min(range.from, range.to)));
    let to = Math.max(0, Math.min(docLength, Math.max(range.from, range.to)));

    while (from < docLength && thaiTrailingMark.test(text[from] ?? '')) {
      from += 1;
    }

    if (
      from > 0 &&
      thaiBaseCharacter.test(text[from] ?? '') &&
      thaiLeadingVowel.test(text[from - 1] ?? '')
    ) {
      from -= 1;
    }

    if (to < from) {
      to = from;
    }

    while (to < docLength && thaiTrailingMark.test(text[to] ?? '')) {
      to += 1;
    }

    return { from, to };
  });

  return mergeSelectionRanges(normalizedRanges, docLength);
}

// Expand selection ranges so a copy/cut never splits a Thai grapheme cluster.
// Unlike normalizeThaiGraphemeSelections (used for formatting), the START is pulled
// BACKWARD to the cluster's base consonant when it lands on a trailing mark such as
// the spacing vowel ำ — so a selection that begins mid-"ทำ" still copies "ทำ" in full.
function expandRangesToThaiClusters(text: string, ranges: BoldRange[], docLength: number): BoldRange[] {
  const thaiTrailingMark = /[ัำ-ฺ็-๎]/u;
  const thaiLeadingVowel = /[เ-ไ]/u;

  const expanded = ranges.map((range) => {
    let from = Math.max(0, Math.min(docLength, Math.min(range.from, range.to)));
    let to = Math.max(0, Math.min(docLength, Math.max(range.from, range.to)));

    // start: step back over trailing marks to reach the base, then over a leading vowel
    while (from > 0 && thaiTrailingMark.test(text[from] ?? '')) from -= 1;
    if (from > 0 && thaiLeadingVowel.test(text[from - 1] ?? '')) from -= 1;

    // end: step forward over trailing marks so the whole cluster is included
    while (to < docLength && thaiTrailingMark.test(text[to] ?? '')) to += 1;

    return { from, to };
  });

  return mergeSelectionRanges(expanded, docLength);
}

export function selectWordAtPosition(view: EditorView, position: number): SelectionRange | null {
  const safePosition = Math.min(Math.max(0, Math.round(position)), view.state.doc.length);
  const line = view.state.doc.lineAt(safePosition);
  const lineText = line.text;
  if (!lineText) return null;

  let column = Math.min(lineText.length, Math.max(0, safePosition - line.from));
  if (column >= lineText.length || !isSelectableWordCharacter(lineText[column])) {
    column = Math.max(0, column - 1);
  }
  if (!isSelectableWordCharacter(lineText[column])) return null;

  let startColumn = column;
  let endColumn = column + 1;
  while (startColumn > 0 && isSelectableWordCharacter(lineText[startColumn - 1])) {
    startColumn -= 1;
  }
  while (endColumn < lineText.length && isSelectableWordCharacter(lineText[endColumn])) {
    endColumn += 1;
  }

  return EditorSelection.range(line.from + startColumn, line.from + endColumn);
}

export function addWordToMultiSelection(
  view: EditorView,
  wordRange: SelectionRange,
  options: { suppressFastToggle?: boolean } = {}
): boolean {
  const wordBounds = getSelectionRangeBounds(wordRange);
  if (wordBounds.from === wordBounds.to) return false;

  const now = Date.now();
  if (
    options.suppressFastToggle &&
    lastWordMultiSelectionAction &&
    now - lastWordMultiSelectionAction.time <= 520 &&
    lastWordMultiSelectionAction.from === wordBounds.from &&
    lastWordMultiSelectionAction.to === wordBounds.to
  ) {
    return true;
  }
  lastWordMultiSelectionAction = { time: now, from: wordBounds.from, to: wordBounds.to };

  const existingRanges = view.state.selection.ranges;
  const hasSameWord = existingRanges.some((range) => {
    const bounds = getSelectionRangeBounds(range);
    return !range.empty && bounds.from === wordBounds.from && bounds.to === wordBounds.to;
  });

  const nextRanges = hasSameWord
    ? existingRanges.filter((range) => {
        const bounds = getSelectionRangeBounds(range);
        return range.empty || bounds.from !== wordBounds.from || bounds.to !== wordBounds.to;
      })
    : [
        ...existingRanges.filter((range) => {
          const bounds = getSelectionRangeBounds(range);
          if (range.empty) return bounds.from < wordBounds.from || bounds.from > wordBounds.to;
          return !rangesIntersect(bounds, wordBounds);
        }),
        wordRange
      ];

  const normalizedRanges = uniqueSortedSelectionRanges(nextRanges.length > 0 ? nextRanges : [EditorSelection.cursor(wordBounds.from)]);
  const mainIndex = Math.max(0, normalizedRanges.findIndex((range) => {
    const bounds = getSelectionRangeBounds(range);
    return bounds.from === wordBounds.from && bounds.to === wordBounds.to;
  }));

  view.dispatch({
    selection: EditorSelection.create(normalizedRanges, mainIndex),
    effects: EditorView.scrollIntoView(hasSameWord ? wordBounds.from : wordBounds.to, { y: 'nearest' })
  });
  view.focus();
  return true;
}

export function ctrlDoubleClickSelectWord(view: EditorView, event: MouseEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false;
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (position === null) return false;
  const wordRange = selectWordAtPosition(view, position);
  if (!wordRange) return false;

  event.preventDefault();
  event.stopPropagation();
  addWordToMultiSelection(view, wordRange, { suppressFastToggle: true });
  return true;
}

function doubleClickSelectThaiWord(view: EditorView, event: MouseEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.button !== 0) return false;
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (position === null) return false;
  const wordRange = selectWordAtPosition(view, position);
  if (!wordRange) return false;

  const selectedText = view.state.sliceDoc(wordRange.from, wordRange.to);
  if (!/[\u0E00-\u0E7F]/u.test(selectedText)) return false;

  event.preventDefault();
  event.stopPropagation();
  view.dispatch({
    selection: EditorSelection.single(wordRange.anchor, wordRange.head),
    effects: EditorView.scrollIntoView(wordRange.head, { y: 'nearest' })
  });
  view.focus();
  return true;
}

export function replaceAllSelectedWords(view: EditorView, insertText: string): boolean {
  if (view.state.selection.ranges.every((range) => range.empty)) return false;
  view.dispatch(view.state.replaceSelection(insertText));
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The internal clipboard keeps [ภาพ:id] tokens as plain text so pasting back into
// this app still works (the editor re-renders any token it finds). Pasting into
// OTHER apps needs an actual <img> though, or the user just sees that raw token
// text. Returns null when the selection has no image token (plain text is enough).
function buildExternalPasteHtml(text: string): string | null {
  if (!text.includes('[ภาพ:')) return null;
  IMAGE_TOKEN_PATTERN.lastIndex = 0;
  let html = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  let foundAny = false;
  while ((match = IMAGE_TOKEN_PATTERN.exec(text)) !== null) {
    html += escapeHtml(text.slice(cursor, match.index));
    const dataUrl = getStoredImage(match[1]);
    if (dataUrl) {
      html += `<img src="${dataUrl}" alt="" style="max-width:480px;max-height:360px;" />`;
      foundAny = true;
    } else {
      html += escapeHtml(match[0]);
    }
    cursor = match.index + match[0].length;
  }
  if (!foundAny) return null;
  html += escapeHtml(text.slice(cursor));
  return html.replace(/\n/g, '<br />');
}

function normalizeBoldRanges(ranges: BoldRange[], docLength: number): BoldRange[] {
  return mergeStyleRanges(ranges, docLength);
}

function buildBoldDecorations(ranges: BoldRange[], docLength: number): DecorationSet {
  return Decoration.set(
    normalizeBoldRanges(ranges, docLength).map((range) => {
      const weight = range.weight ? normalizeRangeWeight(range.weight) : undefined;
      return Decoration
        .mark({
          class: isBoldWeight(weight) ? 'cm-bold-text' : 'cm-style-text',
          attributes: { style: buildRangeStyle(range) }
        })
        .range(range.from, range.to);
    }),
    true
  );
}

function buildLinkDecorations(text: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const link of findLinksInText(text)) {
    builder.add(
      link.from,
      link.to,
      Decoration.mark({
        class: 'cm-link-text',
        attributes: {
          title: 'คลิกเพื่อเปิดลิงก์ • Alt + คลิกเพื่อแก้ไข',
          'data-cloudpad-link': link.url
        }
      })
    );
  }
  return builder.finish();
}

function isRangeFullyBold(range: BoldRange, boldRanges: BoldRange[]): boolean {
  return boldRanges.some((boldRange) => isBoldWeight(boldRange.weight) && boldRange.from <= range.from && boldRange.to >= range.to);
}

function isSelectedTextFullyBold(selectedRanges: BoldRange[], boldRanges: BoldRange[], text: string): boolean {
  let hasVisibleCharacter = false;

  for (const selectedRange of selectedRanges) {
    for (let position = selectedRange.from; position < selectedRange.to; position += 1) {
      const character = text[position];
      if (!character || /\s/u.test(character)) continue;
      hasVisibleCharacter = true;
      if (!isPositionBold(position, boldRanges)) return false;
    }
  }

  return hasVisibleCharacter;
}

function isPositionBold(position: number, boldRanges: BoldRange[]): boolean {
  return boldRanges.some((boldRange) => isBoldWeight(boldRange.weight) && position >= boldRange.from && position < boldRange.to);
}

function hasBoldInRanges(ranges: BoldRange[], boldRanges: BoldRange[]): boolean {
  return ranges.some((range) =>
    boldRanges.some((boldRange) => isBoldWeight(boldRange.weight) && Math.max(range.from, boldRange.from) < Math.min(range.to, boldRange.to))
  );
}

function getWeightAtPosition(position: number, ranges: BoldRange[], fallback: FontWeight): FontWeight {
  const matchingRange = ranges.find((range) => position >= range.from && position < range.to)
    ?? ranges.find((range) => position > range.from && position === range.to);
  return matchingRange?.weight ? normalizeRangeWeight(matchingRange.weight) : fallback;
}

function getColorAtPosition(position: number, ranges: BoldRange[], fallback: string): string {
  const matchingRange = ranges.find((range) => position >= range.from && position < range.to)
    ?? ranges.find((range) => position > range.from && position === range.to);
  return normalizeRangeColor(matchingRange?.color) ?? fallback;
}

function getWeightForRanges(selectedRanges: BoldRange[], weightRanges: BoldRange[], fallback: FontWeight): FontWeight {
  const weights: FontWeight[] = [];

  for (const selectedRange of selectedRanges) {
    const matchingRange = weightRanges.find((weightRange) =>
      Math.max(selectedRange.from, weightRange.from) < Math.min(selectedRange.to, weightRange.to)
    );
    weights.push(matchingRange?.weight ? normalizeRangeWeight(matchingRange.weight) : fallback);
  }

  if (weights.length === 0) return fallback;
  const firstWeight = weights[0];
  return weights.every((weight) => weight === firstWeight) ? firstWeight : firstWeight;
}

function getFontSizeAtPosition(position: number, ranges: BoldRange[], fallback: number): number {
  const matchingRange = ranges.find((range) => position >= range.from && position < range.to)
    ?? ranges.find((range) => position > range.from && position === range.to);
  return normalizeRangeFontSize(matchingRange?.fontSize) ?? fallback;
}

function getFontSizeForRanges(selectedRanges: BoldRange[], styleRanges: BoldRange[], fallback: number): number {
  const fontSizes: number[] = [];

  for (const selectedRange of selectedRanges) {
    const matchingRange = styleRanges.find((styleRange) =>
      Math.max(selectedRange.from, styleRange.from) < Math.min(selectedRange.to, styleRange.to)
    );
    fontSizes.push(normalizeRangeFontSize(matchingRange?.fontSize) ?? fallback);
  }

  if (fontSizes.length === 0) return fallback;
  return fontSizes[0];
}

function getColorForRanges(selectedRanges: BoldRange[], styleRanges: BoldRange[], fallback: string): string {
  const colors: string[] = [];

  for (const selectedRange of selectedRanges) {
    const matchingRange = styleRanges.find((styleRange) =>
      Math.max(selectedRange.from, styleRange.from) < Math.min(selectedRange.to, styleRange.to)
    );
    colors.push(normalizeRangeColor(matchingRange?.color) ?? fallback);
  }

  if (colors.length === 0) return fallback;
  return colors[0];
}

function getFontFamilyAtPosition(position: number, ranges: BoldRange[], fallback: string): string {
  const matchingRange = ranges.find((range) => position >= range.from && position < range.to)
    ?? ranges.find((range) => position > range.from && position === range.to);
  return normalizeRangeFontFamily(matchingRange?.fontFamily) ?? fallback;
}

function getFontFamilyForRanges(selectedRanges: BoldRange[], styleRanges: BoldRange[], fallback: string): string {
  for (const selectedRange of selectedRanges) {
    const matchingRange = styleRanges.find((styleRange) =>
      Math.max(selectedRange.from, styleRange.from) < Math.min(selectedRange.to, styleRange.to)
    );
    if (matchingRange) return normalizeRangeFontFamily(matchingRange.fontFamily) ?? fallback;
  }
  return fallback;
}

function removeBoldFromRanges(boldRanges: BoldRange[], selectedRanges: BoldRange[], docLength: number): BoldRange[] {
  let nextRanges = normalizeBoldRanges(boldRanges, docLength);
  for (const selectedRange of selectedRanges) {
    nextRanges = nextRanges.flatMap((boldRange) => {
      if (selectedRange.to <= boldRange.from || selectedRange.from >= boldRange.to) return [boldRange];
      const pieces: BoldRange[] = [];
      if (selectedRange.from > boldRange.from) {
        pieces.push({ ...boldRange, from: boldRange.from, to: selectedRange.from });
      }
      const middleFrom = Math.max(selectedRange.from, boldRange.from);
      const middleTo = Math.min(selectedRange.to, boldRange.to);
      const middleRange = {
        ...boldRange,
        from: middleFrom,
        to: middleTo,
        weight: undefined
      };
      if (hasAnyRangeStyle(middleRange)) {
        pieces.push(middleRange);
      }
      if (selectedRange.to < boldRange.to) {
        pieces.push({ ...boldRange, from: selectedRange.to, to: boldRange.to });
      }
      return pieces;
    });
  }
  return normalizeBoldRanges(nextRanges, docLength);
}

function removeStyleFromRanges(styleRanges: BoldRange[], selectedRanges: BoldRange[], docLength: number): BoldRange[] {
  let nextRanges = normalizeBoldRanges(styleRanges, docLength);
  for (const selectedRange of selectedRanges) {
    nextRanges = nextRanges.flatMap((styleRange) => {
      if (selectedRange.to <= styleRange.from || selectedRange.from >= styleRange.to) return [styleRange];
      const pieces: BoldRange[] = [];
      if (selectedRange.from > styleRange.from) {
        pieces.push({ ...styleRange, from: styleRange.from, to: selectedRange.from });
      }
      if (selectedRange.to < styleRange.to) {
        pieces.push({ ...styleRange, from: selectedRange.to, to: styleRange.to });
      }
      return pieces;
    });
  }
  return normalizeBoldRanges(nextRanges, docLength);
}

function getStyleAtPosition(
  position: number,
  ranges: BoldRange[],
  fallback: Partial<Pick<BoldRange, 'weight' | 'color' | 'fontSize' | 'fontFamily'>> = {},
  matchEndBoundary = true
): Partial<Pick<BoldRange, 'weight' | 'color' | 'fontSize' | 'fontFamily'>> {
  // The end-boundary fallback (position === range.to) is for "continue style at the
  // caret after a styled run". It must NOT be used when resolving the style of a
  // freshly split segment, or an adjacent run's colour bleeds into the next segment.
  const matchingRange = ranges.find((range) => position >= range.from && position < range.to)
    ?? (matchEndBoundary ? ranges.find((range) => position > range.from && position === range.to) : undefined);
  return {
    weight: matchingRange?.weight ?? fallback.weight,
    color: matchingRange?.color ?? fallback.color,
    fontSize: matchingRange?.fontSize ?? fallback.fontSize,
    fontFamily: matchingRange?.fontFamily ?? fallback.fontFamily
  };
}

function patchStyleInRanges(
  currentRanges: BoldRange[],
  selectedRanges: BoldRange[],
  stylePatch: Partial<Pick<BoldRange, 'weight' | 'color' | 'fontSize' | 'fontFamily'>>,
  docLength: number,
  fallbackStyle: Partial<Pick<BoldRange, 'weight' | 'color' | 'fontSize' | 'fontFamily'>> = {}
): BoldRange[] {
  const normalizedCurrentRanges = normalizeBoldRanges(currentRanges, docLength);
  const outsideRanges = removeStyleFromRanges(normalizedCurrentRanges, selectedRanges, docLength);
  const patchedRanges: BoldRange[] = [];
  const normalizedFallbackStyle = {
    weight: fallbackStyle.weight ? normalizeRangeWeight(fallbackStyle.weight) : undefined,
    color: normalizeRangeColor(fallbackStyle.color),
    fontSize: normalizeRangeFontSize(fallbackStyle.fontSize),
    fontFamily: normalizeRangeFontFamily(fallbackStyle.fontFamily)
  };

  for (const selectedRange of selectedRanges) {
    const splitPoints = new Set<number>([selectedRange.from, selectedRange.to]);

    for (const styleRange of normalizedCurrentRanges) {
      if (selectedRange.to <= styleRange.from || selectedRange.from >= styleRange.to) continue;
      splitPoints.add(Math.max(selectedRange.from, styleRange.from));
      splitPoints.add(Math.min(selectedRange.to, styleRange.to));
    }

    const points = Array.from(splitPoints).sort((a, b) => a - b);
    for (let index = 0; index < points.length - 1; index += 1) {
      const from = points[index];
      const to = points[index + 1];
      if (to <= from) continue;

      const existingStyle = getStyleAtPosition(from, normalizedCurrentRanges, {}, false);
      const nextRange = {
        from,
        to,
        ...normalizedFallbackStyle,
        ...existingStyle,
        ...stylePatch
      };
      if (hasAnyRangeStyle(nextRange)) {
        patchedRanges.push(nextRange);
      }
    }
  }

  return normalizeBoldRanges([...outsideRanges, ...patchedRanges], docLength);
}

function boldRangesToHtml(text: string, ranges: BoldRange[]): string {
  const normalizedRanges = normalizeBoldRanges(ranges, text.length);
  let cursor = 0;
  let html = '';
  for (const range of normalizedRanges) {
    html += escapeHtml(text.slice(cursor, range.from));
    html += `<span style="${buildRangeStyle(range)};">${escapeHtml(text.slice(range.from, range.to))}</span>`;
    cursor = range.to;
  }
  html += escapeHtml(text.slice(cursor));
  return html.replace(/\n/g, '<br />');
}

function parseBoldRangesFromHtml(contentHtml: string | undefined, plainText: string): BoldRange[] {
  if (!contentHtml || typeof document === 'undefined') return [];
  const container = document.createElement('div');
  container.innerHTML = contentHtml;
  let offset = 0;
  let parsedText = '';
  const ranges: BoldRange[] = [];

  const walk = (node: ChildNode, inheritedStyle: Partial<Pick<BoldRange, 'weight' | 'color' | 'fontSize' | 'fontFamily'>>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      const from = offset;
      parsedText += text;
      offset += text.length;
      if (text.length > 0) ranges.push({ from, to: offset, ...inheritedStyle });
      return;
    }

    if (node.nodeName === 'BR') {
      parsedText += '\n';
      offset += 1;
      return;
    }

    if (node instanceof HTMLElement) {
      const fontWeight = Number(node.style.fontWeight);
      const nextWeight = ['300', '400', '600', '700', '800'].includes(String(fontWeight))
        ? (String(fontWeight) as FontWeight)
        : node.tagName === 'B' || node.tagName === 'STRONG'
          ? '800'
          : inheritedStyle.weight;
      const parsedFontSize = Number.parseInt(node.style.fontSize, 10);
      const nextStyle = {
        weight: nextWeight,
        color: normalizeRangeColor(node.style.color) ?? inheritedStyle.color,
        fontSize: normalizeRangeFontSize(Number.isFinite(parsedFontSize) ? parsedFontSize : inheritedStyle.fontSize),
        fontFamily: normalizeRangeFontFamily(node.style.fontFamily) ?? inheritedStyle.fontFamily
      };
      node.childNodes.forEach((child) => walk(child, nextStyle));
    }
  };

  container.childNodes.forEach((child) => walk(child, {}));
  if (parsedText.endsWith('\n') && !plainText.endsWith('\n')) {
    parsedText = parsedText.slice(0, -1);
  }
  if (parsedText && parsedText !== plainText) return [];
  return normalizeBoldRanges(ranges, plainText.length);
}

const boldDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let nextDecorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setBoldRangesEffect)) {
        nextDecorations = buildBoldDecorations(effect.value, transaction.state.doc.length);
      }
    }
    return nextDecorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const linkDecorationField = StateField.define<DecorationSet>({
  create: (state) => buildLinkDecorations(state.doc.toString()),
  update: (decorations, transaction) => (
    transaction.docChanged
      ? buildLinkDecorations(transaction.state.doc.toString())
      : decorations.map(transaction.changes)
  ),
  provide: (field) => EditorView.decorations.from(field)
});

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: '100%',
    color: 'var(--cloudpad-editor-color)',
    backgroundColor: '#ffffff',
    fontFamily: 'var(--cloudpad-editor-font)',
    fontSize: 'var(--cloudpad-editor-font-size)',
    fontWeight: 'var(--cloudpad-editor-font-weight)'
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'inherit',
    lineHeight: '1.72',
    padding: '34px 42px',
    textRendering: 'geometricPrecision',
    WebkitFontSmoothing: 'subpixel-antialiased'
  },
  '.cm-content': {
    minHeight: '100%',
    caretColor: '#1d4ed8',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  },
  '.cm-line': {
    padding: '0 2px'
  },
  '.cm-selectionBackground': {
    background: 'rgba(37, 99, 235, 0.25) !important',
    borderRadius: '4px'
  },
  '&.cm-focused .cm-selectionBackground': {
    background: 'rgba(37, 99, 235, 0.34) !important'
  },
  '.cm-cursor': {
    borderLeftColor: '#1d4ed8',
    borderLeftWidth: '2px'
  },
  '.cm-cursor-secondary': {
    borderLeftColor: '#60a5fa',
    borderLeftWidth: '2px'
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(239, 246, 255, 0.72)'
  },
  '.cm-gutters': {
    display: 'none'
  },
  '.cm-placeholder': {
    color: '#94a3b8'
  },
  '.cm-bold-text': {
    fontWeight: '800'
  },
  '.cm-link-text': {
    color: '#2563eb',
    textDecoration: 'underline',
    textDecorationThickness: '1.5px',
    textUnderlineOffset: '2px',
    cursor: 'pointer'
  }
});

export const CodeMirrorNoteEditor = forwardRef<CodeMirrorNoteEditorHandle, CodeMirrorNoteEditorProps>(
  function CodeMirrorNoteEditor({ value, contentHtml, style, placeholder, singleLine = false, onChange, onFormatChange, onBoldStateChange, onWeightStateChange, onColorStateChange, onFontSizeStateChange, onFontFamilyStateChange, onFocus, onBlur, onOpenFind, onEscapeSmartSelection }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const emojiInputBridgeRef = useRef<HTMLTextAreaElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onFormatChangeRef = useRef(onFormatChange);
    const onBoldStateChangeRef = useRef(onBoldStateChange);
    const onWeightStateChangeRef = useRef(onWeightStateChange);
    const onColorStateChangeRef = useRef(onColorStateChange);
    const onFontSizeStateChangeRef = useRef(onFontSizeStateChange);
    const onFontFamilyStateChangeRef = useRef(onFontFamilyStateChange);
    const onFocusRef = useRef(onFocus);
    const onBlurRef = useRef(onBlur);
    const onOpenFindRef = useRef(onOpenFind);
    const valueRef = useRef(value);
    const contentHtmlRef = useRef(contentHtml);
    const boldRangesRef = useRef<BoldRange[]>([]);
    const lastNonEmptySelectionRangesRef = useRef<BoldRange[]>([]);
    const fallbackFontWeightRef = useRef<FontWeight>('400');
    const fallbackFontSizeRef = useRef(20);
    const fallbackTextColorRef = useRef('#172033');
    const fallbackFontFamilyRef = useRef(withEmojiFontFallback('"Google Sans Text", "Google Sans", Inter, ui-sans-serif, system-ui'));
    const columnAnchorRef = useRef<number | null>(null);
    const undoSnapshotsRef = useRef<EditorHistorySnapshot[]>([]);
    const redoSnapshotsRef = useRef<EditorHistorySnapshot[]>([]);
    const lastUndoPushTimeRef = useRef(0);
    const lastUndoWasTypingRef = useRef(false);
    const localEchoesRef = useRef<LocalEditorEcho[]>([]);
    const isRestoringSnapshotRef = useRef(false);
    const isApplyingExternalValueRef = useRef(false);
    const suspendExternalSyncRef = useRef(false);
    const resumeExternalSyncTimerRef = useRef<number | null>(null);
    const emojiBridgeSelectionRef = useRef<EditorSelection | null>(null);
    const emojiBridgeActiveRef = useRef(false);
    const emojiBridgeCommitTimerRef = useRef<number | null>(null);
    // How long a pre-armed bridge waits for the window blur that a real panel
    // (emoji picker / clipboard history / start menu) causes. If no blur comes,
    // the Win press wasn't a panel shortcut and focus goes straight back.
    const WIN_EMOJI_NO_BLUR_RESTORE_MS = 600;
    // Timestamp of the last Windows/Meta key press. The emoji bridge only steals
    // focus on a window blur that follows a recent Win press (i.e. the Win+. emoji
    // picker) — plain alt-tab / click-away / spurious OS blur must NOT disturb editing.
    const lastMetaKeyDownAtRef = useRef(0);
    const WIN_EMOJI_BLUR_WINDOW_MS = 1500;

    useEffect(() => {
      onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
      onFormatChangeRef.current = onFormatChange;
    }, [onFormatChange]);

    useEffect(() => {
      onBoldStateChangeRef.current = onBoldStateChange;
    }, [onBoldStateChange]);

    useEffect(() => {
      onWeightStateChangeRef.current = onWeightStateChange;
    }, [onWeightStateChange]);

    useEffect(() => {
      onColorStateChangeRef.current = onColorStateChange;
    }, [onColorStateChange]);

    useEffect(() => {
      onFontSizeStateChangeRef.current = onFontSizeStateChange;
    }, [onFontSizeStateChange]);

    useEffect(() => {
      onFontFamilyStateChangeRef.current = onFontFamilyStateChange;
    }, [onFontFamilyStateChange]);

    useEffect(() => {
      onFocusRef.current = onFocus;
    }, [onFocus]);

    useEffect(() => {
      onBlurRef.current = onBlur;
    }, [onBlur]);

    useEffect(() => {
      onOpenFindRef.current = onOpenFind;
    }, [onOpenFind]);

    useEffect(() => {
      contentHtmlRef.current = contentHtml;
    }, [contentHtml]);

    useEffect(() => {
      const weight = String(style?.fontWeight ?? '400');
      fallbackFontWeightRef.current = ['300', '400', '600', '700', '800'].includes(weight)
        ? (weight as FontWeight)
        : '400';
    }, [style?.fontWeight]);

    useEffect(() => {
      const rawFontSize = typeof style?.fontSize === 'number'
        ? style.fontSize
        : Number.parseInt(String(style?.fontSize ?? '20'), 10);
      fallbackFontSizeRef.current = normalizeRangeFontSize(rawFontSize) ?? 20;
    }, [style?.fontSize]);

    useEffect(() => {
      fallbackTextColorRef.current = normalizeRangeColor(String(style?.color ?? '#172033')) ?? '#172033';
    }, [style?.color]);

    useEffect(() => {
      fallbackFontFamilyRef.current = withEmojiFontFallback(
        normalizeRangeFontFamily(String(style?.fontFamily ?? ''))
          ?? '"Google Sans Text", "Google Sans", Inter, ui-sans-serif, system-ui'
      );
    }, [style?.fontFamily]);

    const getFallbackFontWeight = (): FontWeight => {
      return fallbackFontWeightRef.current;
    };

    const getFallbackFontSize = (): number => {
      return fallbackFontSizeRef.current;
    };

    const getFallbackTextColor = (): string => {
      return fallbackTextColorRef.current;
    };

    const getFallbackFontFamily = (): string => {
      return fallbackFontFamilyRef.current;
    };

    const getFallbackRangeStyle = (): Partial<Pick<BoldRange, 'weight' | 'color' | 'fontSize' | 'fontFamily'>> => ({
      weight: getFallbackFontWeight(),
      color: getFallbackTextColor(),
      fontSize: getFallbackFontSize(),
      fontFamily: getFallbackFontFamily()
    });

    const areHistorySnapshotsEqual = (first: EditorHistorySnapshot, second: EditorHistorySnapshot) => {
      return first.value === second.value && JSON.stringify(first.ranges) === JSON.stringify(second.ranges);
    };

    const getEditorHistorySnapshot = (
      view: EditorView,
      valueOverride = view.state.doc.toString(),
      rangesOverride = boldRangesRef.current
    ): EditorHistorySnapshot => ({
      value: valueOverride,
      ranges: normalizeBoldRanges(rangesOverride, valueOverride.length),
      selectionRanges: view.state.selection.ranges.map((range) => ({
        anchor: Math.max(0, Math.min(valueOverride.length, range.anchor)),
        head: Math.max(0, Math.min(valueOverride.length, range.head))
      })),
      mainIndex: Math.max(0, Math.min(view.state.selection.ranges.length - 1, view.state.selection.mainIndex ?? 0))
    });

    const pushUndoSnapshot = (snapshot: EditorHistorySnapshot) => {
      const stack = undoSnapshotsRef.current;
      if (stack.length === 0 || !areHistorySnapshotsEqual(stack[stack.length - 1], snapshot)) {
        stack.push(snapshot);
        if (stack.length > 120) stack.shift();
      }
      redoSnapshotsRef.current = [];
    };

    const rememberLocalEcho = (value: string, contentHtml: string) => {
      localEchoesRef.current.push({ value, contentHtml });
      if (localEchoesRef.current.length > 40) {
        localEchoesRef.current.splice(0, localEchoesRef.current.length - 40);
      }
    };

    const consumeLocalEcho = (value: string, contentHtml: string) => {
      const index = localEchoesRef.current.findIndex((echo) => echo.value === value && echo.contentHtml === contentHtml);
      if (index < 0) return false;
      localEchoesRef.current.splice(index, 1);
      return true;
    };

    const restoreEditorSnapshot = (view: EditorView, snapshot: EditorHistorySnapshot) => {
      const ranges = normalizeBoldRanges(snapshot.ranges, snapshot.value.length);
      const selectionRanges = snapshot.selectionRanges.length > 0
        ? snapshot.selectionRanges.map((range) => {
            const anchor = Math.max(0, Math.min(snapshot.value.length, range.anchor));
            const head = Math.max(0, Math.min(snapshot.value.length, range.head));
            return anchor === head ? EditorSelection.cursor(anchor) : EditorSelection.range(anchor, head);
          })
        : [EditorSelection.cursor(Math.min(snapshot.value.length, view.state.selection.main.head))];
      const mainIndex = Math.max(0, Math.min(selectionRanges.length - 1, snapshot.mainIndex));

      isRestoringSnapshotRef.current = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: snapshot.value },
          selection: EditorSelection.create(selectionRanges, mainIndex),
          effects: setBoldRangesEffect.of(ranges)
        });
      } finally {
        isRestoringSnapshotRef.current = false;
      }

      valueRef.current = snapshot.value;
      boldRangesRef.current = ranges;
      lastNonEmptySelectionRangesRef.current = selectionRanges
        .filter((range) => !range.empty)
        .map((range) => ({ from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) }));
      const snapshotHtml = boldRangesToHtml(snapshot.value, ranges);
      rememberLocalEcho(snapshot.value, snapshotHtml);
      onChangeRef.current(snapshot.value);
      onFormatChangeRef.current?.(snapshot.value, snapshotHtml);
      emitBoldStateForSelection(view);
      view.focus();
    };

    // Remember the formatting of the given (single, contiguous) copied/cut range for
    // an in-app rich paste. `range`/`text` are passed in explicitly so this works
    // whether the caller used the raw selection or a Thai-grapheme-expanded one.
    // Multi-cursor copies (more than one range) are intentionally left as plain text.
    const captureRichClipboard = (view: EditorView, range: BoldRange | null, text: string) => {
      if (!range || range.to <= range.from) {
        internalRichClipboard = null;
        return;
      }
      const { from, to } = range;
      const ranges = normalizeBoldRanges(boldRangesRef.current, view.state.doc.length)
        .filter((r) => Math.max(r.from, from) < Math.min(r.to, to))
        .map((r) => ({
          ...r,
          from: Math.max(r.from, from) - from,
          to: Math.min(r.to, to) - from
        }));
      internalRichClipboard = { text, ranges };
    };

    // Paste text that was copied/cut from within this app, restoring its formatting.
    // Mirrors restoreEditorSnapshot's proven pattern: the text change and the
    // formatting effect are dispatched together while isRestoringSnapshotRef
    // suppresses the generic updateListener bookkeeping (which would otherwise just
    // remap the OLD ranges around the change and miss the newly pasted formatting),
    // then this function does that bookkeeping itself with the final, correct value.
    const applyRichPaste = (view: EditorView, clip: { text: string; ranges: BoldRange[] }): boolean => {
      const sel = view.state.selection.main;
      const from = Math.min(sel.from, sel.to);
      const to = Math.max(sel.from, sel.to);
      const insert = clip.text;
      const changes = view.state.changes({ from, to, insert });
      const newLength = view.state.doc.length + insert.length - (to - from);

      const remappedExisting = normalizeBoldRanges(boldRangesRef.current, view.state.doc.length)
        .map((range) => ({ ...range, from: changes.mapPos(range.from, 1), to: changes.mapPos(range.to, -1) }))
        .filter((range) => range.to > range.from);
      const pastedRanges = clip.ranges
        .map((range) => ({ ...range, from: range.from + from, to: range.to + from }))
        .filter((range) => range.to > range.from);
      const cleared = removeStyleFromRanges(remappedExisting, [{ from, to: from + insert.length }], newLength);
      const nextRanges = normalizeBoldRanges([...cleared, ...pastedRanges], newLength);

      pushUndoSnapshot(getEditorHistorySnapshot(view));

      isRestoringSnapshotRef.current = true;
      try {
        view.dispatch({
          changes,
          selection: EditorSelection.cursor(from + insert.length),
          effects: setBoldRangesEffect.of(nextRanges),
          userEvent: 'input.paste'
        });
      } finally {
        isRestoringSnapshotRef.current = false;
      }
      lastUndoWasTypingRef.current = false;

      valueRef.current = view.state.doc.toString();
      boldRangesRef.current = nextRanges;
      const finalHtml = boldRangesToHtml(valueRef.current, nextRanges);
      rememberLocalEcho(valueRef.current, finalHtml);
      onChangeRef.current(valueRef.current);
      onFormatChangeRef.current?.(valueRef.current, finalHtml);
      emitBoldStateForSelection(view);
      view.focus();
      return true;
    };

    const undoEditorAction = (view: EditorView) => {
      const previousSnapshot = undoSnapshotsRef.current.pop();
      if (!previousSnapshot) return false;
      redoSnapshotsRef.current.push(getEditorHistorySnapshot(view));
      restoreEditorSnapshot(view, previousSnapshot);
      lastUndoWasTypingRef.current = false;
      return true;
    };

    const redoEditorAction = (view: EditorView) => {
      const nextSnapshot = redoSnapshotsRef.current.pop();
      if (!nextSnapshot) return false;
      undoSnapshotsRef.current.push(getEditorHistorySnapshot(view));
      restoreEditorSnapshot(view, nextSnapshot);
      lastUndoWasTypingRef.current = false;
      return true;
    };

    const applyBoldRangesToView = (view: EditorView, ranges: BoldRange[]) => {
      const nextRanges = normalizeBoldRanges(ranges, view.state.doc.length);
      const text = view.state.doc.toString();
      boldRangesRef.current = nextRanges;
      view.dispatch({ effects: setBoldRangesEffect.of(nextRanges) });
      const nextHtml = boldRangesToHtml(text, nextRanges);
      rememberLocalEcho(text, nextHtml);
      onChangeRef.current(text);
      onFormatChangeRef.current?.(text, nextHtml);
      const selectedRanges = view.state.selection.ranges
        .filter((range) => !range.empty)
        .map((range) => ({ from: range.from, to: range.to }));

      if (selectedRanges.length === 0) {
        const currentWeight = getWeightAtPosition(view.state.selection.main.head, nextRanges, getFallbackFontWeight());
        const currentColor = getColorAtPosition(view.state.selection.main.head, nextRanges, getFallbackTextColor());
        const currentFontSize = getFontSizeAtPosition(view.state.selection.main.head, nextRanges, getFallbackFontSize());
        const currentFontFamily = getFontFamilyAtPosition(view.state.selection.main.head, nextRanges, getFallbackFontFamily());
        onBoldStateChangeRef.current?.(isBoldWeight(currentWeight));
        onWeightStateChangeRef.current?.(currentWeight);
        onColorStateChangeRef.current?.(currentColor);
        onFontSizeStateChangeRef.current?.(currentFontSize);
        onFontFamilyStateChangeRef.current?.(currentFontFamily);
        return;
      }

      const currentWeight = getWeightForRanges(selectedRanges, nextRanges, getFallbackFontWeight());
      const currentColor = getColorForRanges(selectedRanges, nextRanges, getFallbackTextColor());
      const currentFontSize = getFontSizeForRanges(selectedRanges, nextRanges, getFallbackFontSize());
      const currentFontFamily = getFontFamilyForRanges(selectedRanges, nextRanges, getFallbackFontFamily());
      onBoldStateChangeRef.current?.(isBoldWeight(currentWeight));
      onWeightStateChangeRef.current?.(currentWeight);
      onColorStateChangeRef.current?.(currentColor);
      onFontSizeStateChangeRef.current?.(currentFontSize);
      onFontFamilyStateChangeRef.current?.(currentFontFamily);
    };


    const toggleBoldAtSelection = (view: EditorView) => {
      const selectedRanges = getSelectedWeightRanges(view);

      if (selectedRanges.length === 0) return false;

      const docLength = view.state.doc.length;
      const currentBoldRanges = normalizeBoldRanges(boldRangesRef.current, docLength);
      const shouldRemoveBold =
        selectedRanges.every((range) => isRangeFullyBold(range, currentBoldRanges)) ||
        isSelectedTextFullyBold(selectedRanges, currentBoldRanges, view.state.doc.toString());
      return setWeightAtSelection(view, shouldRemoveBold ? '400' : '800');
    };

    const setBoldAtSelection = (view: EditorView, active: boolean) => {
      return setWeightAtSelection(view, active ? '800' : '400');
    };

    const getSelectedWeightRanges = (view: EditorView): BoldRange[] => {
      const text = view.state.doc.toString();
      const docLength = view.state.doc.length;
      const liveRanges = view.state.selection.ranges
        .filter((range) => !range.empty)
        .map((range) => ({ from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) }));

      if (liveRanges.length > 0) {
        const normalizedLiveRanges = normalizeThaiGraphemeSelections(text, liveRanges, docLength);
        lastNonEmptySelectionRangesRef.current = normalizedLiveRanges;
        return normalizedLiveRanges;
      }

      return normalizeThaiGraphemeSelections(text, lastNonEmptySelectionRangesRef.current, docLength)
        .map((range) => ({
          from: Math.max(0, Math.min(docLength, range.from)),
          to: Math.max(0, Math.min(docLength, range.to))
        }))
        .filter((range) => range.to > range.from);
    };

    // When a selection boundary lands inside a Thai grapheme cluster (e.g. between
    // ท and the spacing vowel ำ), the highlight visually covers the whole cluster
    // but copy/cut would only grab the raw offsets and drop the trailing mark.
    // Return the selection text snapped to full clusters, or null if no fix needed.
    const buildThaiSafeClipboard = (view: EditorView) => {
      const text = view.state.doc.toString();
      const docLength = view.state.doc.length;
      const rawRanges = view.state.selection.ranges
        .filter((range) => !range.empty)
        .map((range) => ({ from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) }))
        .sort((a, b) => a.from - b.from);
      if (rawRanges.length === 0) return null;

      const normalized = expandRangesToThaiClusters(text, rawRanges, docLength)
        .sort((a, b) => a.from - b.from);
      const defaultText = rawRanges.map((range) => text.slice(range.from, range.to)).join('\n');
      const normalizedText = normalized.map((range) => text.slice(range.from, range.to)).join('\n');
      if (normalizedText === defaultText) return null;

      return { text: normalizedText, ranges: normalized };
    };

    const showAppliedSelectionRanges = (view: EditorView, ranges: BoldRange[]) => {
      const currentRanges = view.state.selection.ranges
        .filter((range) => !range.empty)
        .map((range) => ({ from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) }));
      const current = mergeSelectionRanges(currentRanges, view.state.doc.length);
      const unchanged =
        current.length === ranges.length &&
        current.every((range, index) => range.from === ranges[index].from && range.to === ranges[index].to);
      if (unchanged) return;

      view.dispatch({
        selection: EditorSelection.create(
          ranges.map((range) => EditorSelection.range(range.from, range.to)),
          Math.max(0, ranges.length - 1)
        )
      });
    };

    const preserveCurrentSelection = (view: EditorView): boolean => {
      const docLength = view.state.doc.length;
      const liveRanges = view.state.selection.ranges
        .filter((range) => !range.empty)
        .map((range) => ({
          from: Math.min(range.from, range.to),
          to: Math.max(range.from, range.to)
        }));

      if (liveRanges.length === 0) {
        return lastNonEmptySelectionRangesRef.current.length > 0;
      }

      lastNonEmptySelectionRangesRef.current = mergeSelectionRanges(liveRanges, docLength);
      return true;
    };

    const setWeightAtSelection = (view: EditorView, weight: FontWeight) => {
      const selectedRanges = getSelectedWeightRanges(view);

      if (selectedRanges.length === 0) return false;

      const docLength = view.state.doc.length;
      const currentBoldRanges = normalizeBoldRanges(boldRangesRef.current, docLength);
      const nextBoldRanges = patchStyleInRanges(
        currentBoldRanges,
        selectedRanges,
        { weight },
        docLength,
        getStyleAtPosition(selectedRanges[0].from, currentBoldRanges, getFallbackRangeStyle())
      );

      pushUndoSnapshot(getEditorHistorySnapshot(view, view.state.doc.toString(), currentBoldRanges));
      showAppliedSelectionRanges(view, selectedRanges);
      applyBoldRangesToView(view, nextBoldRanges);
      lastNonEmptySelectionRangesRef.current = selectedRanges;
      return true;
    };

    const setStyleAtSelection = (
      view: EditorView,
      stylePatch: Partial<Pick<BoldRange, 'weight' | 'color' | 'fontSize' | 'fontFamily'>>
    ) => {
      const selectedRanges = getSelectedWeightRanges(view);

      if (selectedRanges.length === 0) return false;

      const docLength = view.state.doc.length;
      const currentStyleRanges = normalizeBoldRanges(boldRangesRef.current, docLength);
      const nextStyleRanges = patchStyleInRanges(
        currentStyleRanges,
        selectedRanges,
        stylePatch,
        docLength,
        getStyleAtPosition(selectedRanges[0].from, currentStyleRanges, getFallbackRangeStyle())
      );

      pushUndoSnapshot(getEditorHistorySnapshot(view, view.state.doc.toString(), currentStyleRanges));
      showAppliedSelectionRanges(view, selectedRanges);
      applyBoldRangesToView(view, nextStyleRanges);
      lastNonEmptySelectionRangesRef.current = selectedRanges;
      return true;
    };

    const setColorAtSelection = (view: EditorView, color: string) => {
      const normalizedColor = normalizeRangeColor(color);
      if (!normalizedColor) return false;
      return setStyleAtSelection(view, { color: normalizedColor });
    };

    const setFontSizeAtSelection = (view: EditorView, fontSize: number) => {
      const normalizedFontSize = normalizeRangeFontSize(fontSize);
      if (!normalizedFontSize) return false;
      return setStyleAtSelection(view, { fontSize: normalizedFontSize });
    };

    const setFontFamilyAtSelection = (view: EditorView, fontFamily: string) => {
      const normalizedFamily = normalizeRangeFontFamily(fontFamily);
      if (!normalizedFamily) return false;
      return setStyleAtSelection(view, { fontFamily: normalizedFamily });
    };

    const emitBoldStateForSelection = (view: EditorView) => {
      const selectedRanges = view.state.selection.ranges
        .filter((range) => !range.empty)
        .map((range) => ({ from: range.from, to: range.to }));

      if (selectedRanges.length > 0) {
        lastNonEmptySelectionRangesRef.current = selectedRanges;
      }

      if (selectedRanges.length === 0) {
        const currentWeight = getWeightAtPosition(view.state.selection.main.head, boldRangesRef.current, getFallbackFontWeight());
        const currentColor = getColorAtPosition(view.state.selection.main.head, boldRangesRef.current, getFallbackTextColor());
        const currentFontSize = getFontSizeAtPosition(view.state.selection.main.head, boldRangesRef.current, getFallbackFontSize());
        const currentFontFamily = getFontFamilyAtPosition(view.state.selection.main.head, boldRangesRef.current, getFallbackFontFamily());
        onBoldStateChangeRef.current?.(isBoldWeight(currentWeight));
        onWeightStateChangeRef.current?.(currentWeight);
        onColorStateChangeRef.current?.(currentColor);
        onFontSizeStateChangeRef.current?.(currentFontSize);
        onFontFamilyStateChangeRef.current?.(currentFontFamily);
        return;
      }

      const currentWeight = getWeightForRanges(selectedRanges, boldRangesRef.current, getFallbackFontWeight());
      const currentColor = getColorForRanges(selectedRanges, boldRangesRef.current, getFallbackTextColor());
      const currentFontSize = getFontSizeForRanges(selectedRanges, boldRangesRef.current, getFallbackFontSize());
      const currentFontFamily = getFontFamilyForRanges(selectedRanges, boldRangesRef.current, getFallbackFontFamily());
      onBoldStateChangeRef.current?.(isBoldWeight(currentWeight));
      onWeightStateChangeRef.current?.(currentWeight);
      onColorStateChangeRef.current?.(currentColor);
      onFontSizeStateChangeRef.current?.(currentFontSize);
      onFontFamilyStateChangeRef.current?.(currentFontFamily);
    };

    const getSearchRangeForRequest = (view: EditorView, request: FindReplaceRequest): SearchRange | null | 'missing' => {
      if (!request.inSelection) return null;
      return getMainSelectionRange(view) ?? 'missing';
    };

    const findInCodeMirror = (
      view: EditorView,
      direction: SearchDirection,
      request: FindReplaceRequest
    ): CodeMirrorFindReplaceResult => {
      const text = view.state.doc.toString();
      const searchRange = getSearchRangeForRequest(view, request);
      if (searchRange === 'missing') return { message: 'เลือกข้อความก่อนใช้เฉพาะส่วนที่เลือก' };

      const result = findMatchesInText(text, request.query, request, searchRange);
      if (result.error) return { message: result.error };
      if (result.matches.length === 0) return { message: 'ไม่พบข้อความที่ค้นหา' };

      const currentSelection = view.state.selection.main;
      const cursorStart = Math.min(currentSelection.from, currentSelection.to);
      const cursorEnd = Math.max(currentSelection.from, currentSelection.to);
      let matchIndex = direction === 'next'
        ? result.matches.findIndex((match) => match.start >= cursorEnd)
        : (() => {
            for (let index = result.matches.length - 1; index >= 0; index -= 1) {
              if (result.matches[index].end <= cursorStart) return index;
            }
            return -1;
          })();

      if (matchIndex < 0 && request.wrapAround) {
        matchIndex = direction === 'next' ? 0 : result.matches.length - 1;
      }
      if (matchIndex < 0) {
        return { message: direction === 'next' ? 'ถึงท้ายเอกสารแล้ว' : 'ถึงต้นเอกสารแล้ว' };
      }

      const match = result.matches[matchIndex];
      view.dispatch({
        selection: EditorSelection.single(match.start, match.end),
        effects: EditorView.scrollIntoView(match.start, { y: 'center' })
      });
      emitBoldStateForSelection(view);
      return { message: `พบ ${matchIndex + 1} จาก ${result.matches.length} รายการ`, found: true };
    };

    const replaceInCodeMirror = (view: EditorView, request: FindReplaceRequest): CodeMirrorFindReplaceResult => {
      const text = view.state.doc.toString();
      const searchRange = getSearchRangeForRequest(view, request);
      if (searchRange === 'missing') return { message: 'เลือกข้อความก่อนใช้เฉพาะส่วนที่เลือก' };

      const result = findMatchesInText(text, request.query, request, searchRange);
      if (result.error) return { message: result.error };
      if (result.matches.length === 0) return { message: 'ไม่พบข้อความที่ต้องการแทนที่' };

      const selectedRange = getMainSelectionRange(view);
      const selectedMatch = selectedRange
        ? result.matches.find((match) => match.start === selectedRange.start && match.end === selectedRange.end)
        : undefined;

      if (!selectedMatch) {
        return findInCodeMirror(view, request.backward ? 'previous' : 'next', request);
      }

      const replacement = buildReplacementText(selectedMatch, request.query, request.replacement, request);
      if (replacement.error) return { message: replacement.error };

      view.dispatch({
        changes: { from: selectedMatch.start, to: selectedMatch.end, insert: replacement.value },
        selection: EditorSelection.cursor(selectedMatch.start + replacement.value.length),
        effects: EditorView.scrollIntoView(selectedMatch.start, { y: 'center' })
      });
      return { message: 'แทนที่แล้ว 1 รายการ', found: true };
    };

    const replaceAllInCodeMirror = (view: EditorView, request: FindReplaceRequest): CodeMirrorFindReplaceResult => {
      const text = view.state.doc.toString();
      const searchRange = getSearchRangeForRequest(view, request);
      if (searchRange === 'missing') return { message: 'เลือกข้อความก่อนใช้เฉพาะส่วนที่เลือก' };

      const result = findMatchesInText(text, request.query, request, searchRange);
      if (result.error) return { message: result.error };
      if (result.matches.length === 0) return { message: 'ไม่พบข้อความที่ต้องการแทนที่' };

      const replacements = result.matches.map((match) => buildReplacementText(match, request.query, request.replacement, request));
      const replacementError = replacements.find((replacement) => replacement.error);
      if (replacementError?.error) return { message: replacementError.error };

      view.dispatch({
        changes: result.matches.map((match, index) => ({
          from: match.start,
          to: match.end,
          insert: replacements[index].value
        })),
        effects: EditorView.scrollIntoView(result.matches[0].start, { y: 'center' })
      });
      return { message: `แทนที่ทั้งหมด ${result.matches.length} รายการ`, found: true };
    };

    const formatMatchesInCodeMirror = (view: EditorView, request: FindReplaceRequest): CodeMirrorFindReplaceResult => {
      const text = view.state.doc.toString();
      const searchRange = getSearchRangeForRequest(view, request);
      if (searchRange === 'missing') return { message: 'เลือกข้อความก่อนใช้เฉพาะส่วนที่เลือก' };

      const result = findMatchesInText(text, request.query, request, searchRange);
      if (result.error) return { message: result.error };
      if (result.matches.length === 0) return { message: 'ไม่พบคำที่ต้องการปรับแต่ง' };

      const fontFamily = normalizeRangeFontFamily(request.textStyle.fontFamily);
      const fontSize = normalizeRangeFontSize(request.textStyle.fontSize);
      const color = normalizeRangeColor(request.textStyle.color);
      const fontWeight = ['300', '400', '600', '700', '800'].includes(request.textStyle.fontWeight)
        ? request.textStyle.fontWeight
        : '400';
      if (!fontFamily || !fontSize || !color) {
        return { message: 'รูปแบบตัวอักษรไม่ถูกต้อง' };
      }

      const matchRanges = result.matches.map((match) => ({ from: match.start, to: match.end }));
      const nextStyleRanges = patchStyleInRanges(
        boldRangesRef.current,
        matchRanges,
        { fontFamily, fontSize, weight: fontWeight, color },
        view.state.doc.length,
        getFallbackRangeStyle()
      );

      pushUndoSnapshot(getEditorHistorySnapshot(view));
      applyBoldRangesToView(view, nextStyleRanges);
      const firstMatch = result.matches[0];
      view.dispatch({
        selection: EditorSelection.single(firstMatch.start, firstMatch.end),
        effects: EditorView.scrollIntoView(firstMatch.start, { y: 'center' })
      });
      lastNonEmptySelectionRangesRef.current = [{ from: firstMatch.start, to: firstMatch.end }];
      emitBoldStateForSelection(view);
      return { message: `ปรับแต่งคำที่พบแล้ว ${result.matches.length} รายการ`, found: true };
    };

    useImperativeHandle(ref, () => ({
      focus: () => viewRef.current?.focus(),
      getValue: () => viewRef.current?.state.doc.toString() ?? valueRef.current,
      getHtml: () => boldRangesToHtml(viewRef.current?.state.doc.toString() ?? valueRef.current, boldRangesRef.current),
      hasFocus: () => Boolean(viewRef.current?.hasFocus),
      preserveSelection: () => {
        const view = viewRef.current;
        return view ? preserveCurrentSelection(view) : false;
      },
      setValue: (nextValue: string) => {
        const view = viewRef.current;
        valueRef.current = nextValue;
        if (!view) return;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: nextValue }
        });
      },
      undo: () => {
        const view = viewRef.current;
        if (!view) return false;
        const handled = undoEditorAction(view);
        if (handled) {
          window.setTimeout(() => emitBoldStateForSelection(view), 0);
        }
        return handled;
      },
      redo: () => {
        const view = viewRef.current;
        if (!view) return false;
        const handled = redoEditorAction(view);
        if (handled) {
          window.setTimeout(() => emitBoldStateForSelection(view), 0);
        }
        return handled;
      },
      goToLine: (lineNumber: number) => {
        const view = viewRef.current;
        if (!view) return;
        const line = view.state.doc.line(Math.min(Math.max(1, Math.floor(lineNumber)), view.state.doc.lines));
        view.dispatch({
          selection: EditorSelection.cursor(line.from),
          effects: EditorView.scrollIntoView(line.from, { y: 'center' })
        });
        view.focus();
      },
      toggleBold: () => {
        const view = viewRef.current;
        if (!view) return false;
        return toggleBoldAtSelection(view);
      },
      setSelectionBold: (active) => {
        const view = viewRef.current;
        if (!view) return false;
        return setBoldAtSelection(view, active);
      },
        setSelectionWeight: (weight) => {
          const view = viewRef.current;
          if (!view) return false;
          return setWeightAtSelection(view, weight);
        },
        setSelectionColor: (color) => {
          const view = viewRef.current;
          if (!view) return false;
          return setColorAtSelection(view, color);
        },
        setSelectionFontSize: (fontSize) => {
          const view = viewRef.current;
          if (!view) return false;
          return setFontSizeAtSelection(view, fontSize);
        },
        setSelectionFontFamily: (fontFamily) => {
          const view = viewRef.current;
          if (!view) return false;
          return setFontFamilyAtSelection(view, fontFamily);
        },
      getSelectedText: () => {
        const view = viewRef.current;
        if (!view) return '';
        return view.state.selection.ranges
          .filter((range) => !range.empty)
          .map((range) => view.state.sliceDoc(Math.min(range.from, range.to), Math.max(range.from, range.to)))
          .join('\n');
      },
      getSelectionRange: () => {
        const view = viewRef.current;
        if (!view) return null;
        const liveRange = getMainSelectionRange(view);
        if (liveRange) return liveRange;
        const storedRange = lastNonEmptySelectionRangesRef.current[0];
        return storedRange ? { start: storedRange.from, end: storedRange.to } : null;
      },
      findReplaceFind: (direction, request) => {
        const view = viewRef.current;
        return view ? findInCodeMirror(view, direction, request) : { message: 'ยังไม่มีแผ่นงานให้ค้นหา' };
      },
      findReplaceReplace: (request) => {
        const view = viewRef.current;
        return view ? replaceInCodeMirror(view, request) : { message: 'ยังไม่มีแผ่นงานให้แทนที่' };
      },
      findReplaceReplaceAll: (request) => {
        const view = viewRef.current;
        return view ? replaceAllInCodeMirror(view, request) : { message: 'ยังไม่มีแผ่นงานให้แทนที่' };
      },
      findReplaceFormatMatches: (request) => {
        const view = viewRef.current;
        return view ? formatMatchesInCodeMirror(view, request) : { message: 'ยังไม่มีแผ่นงานให้ปรับแต่ง' };
      }
    }), []);

    useEffect(() => {
      if (!hostRef.current || viewRef.current) return;
      let stopCtrlDragTracking: (() => void) | null = null;
      let stopNativeCtrlDoubleClickTracking: (() => void) | null = null;

      const keepUsefulRanges = (selection: EditorSelection) => {
        return selection.ranges;
      };

      const uniqueSelectionRanges = (ranges: readonly EditorSelection['main'][]) => {
        const seen = new Set<string>();
        return ranges.filter((range) => {
          const key = `${range.from}:${range.to}:${range.anchor}:${range.head}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };

      const posFromMouseEvent = (view: EditorView, event: MouseEvent) => {
        return view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      };

      const startCtrlDragSelection = (view: EditorView, event: MouseEvent) => {
        if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false;

        const anchor = posFromMouseEvent(view, event);
        const baseRanges = keepUsefulRanges(view.state.selection);
        const startX = event.clientX;
        const startY = event.clientY;
        let moved = false;

        event.preventDefault();
        event.stopPropagation();
        view.focus();

        const updateRange = (head: number) => {
          const activeRange = anchor === head ? EditorSelection.cursor(anchor) : EditorSelection.range(anchor, head);
          const ranges = uniqueSelectionRanges([...baseRanges, activeRange]);
          view.dispatch({
            selection: EditorSelection.create(ranges, Math.max(0, ranges.length - 1)),
            effects: EditorView.scrollIntoView(head, { y: 'nearest' })
          });
        };

        const handleMouseMove = (moveEvent: MouseEvent) => {
          moveEvent.preventDefault();
          moveEvent.stopPropagation();
          const distance = Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY);
          if (distance > 3) moved = true;
          updateRange(posFromMouseEvent(view, moveEvent));
        };

        const handleMouseUp = (upEvent: MouseEvent) => {
          upEvent.preventDefault();
          upEvent.stopPropagation();
          const head = posFromMouseEvent(view, upEvent);
          if (!moved) {
            const wordRange = selectWordAtPosition(view, head);
            if (wordRange && addWordToMultiSelection(view, wordRange, { suppressFastToggle: true })) {
              document.removeEventListener('mousemove', handleMouseMove, true);
              document.removeEventListener('mouseup', handleMouseUp, true);
              stopCtrlDragTracking = null;
              return;
            }
            const cursor = EditorSelection.cursor(head);
            const ranges = uniqueSelectionRanges([...baseRanges, cursor]);
            view.dispatch({
              selection: EditorSelection.create(ranges, Math.max(0, ranges.length - 1)),
              effects: EditorView.scrollIntoView(head, { y: 'nearest' })
            });
          } else {
            updateRange(head);
          }
          document.removeEventListener('mousemove', handleMouseMove, true);
          document.removeEventListener('mouseup', handleMouseUp, true);
          stopCtrlDragTracking = null;
        };

        stopCtrlDragTracking?.();
        stopCtrlDragTracking = () => {
          document.removeEventListener('mousemove', handleMouseMove, true);
          document.removeEventListener('mouseup', handleMouseUp, true);
        };
        document.addEventListener('mousemove', handleMouseMove, true);
        document.addEventListener('mouseup', handleMouseUp, true);
        return true;
      };

      const expandColumnSelection = (view: EditorView, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => {
        const doc = view.state.doc;
        const currentSelection = view.state.selection.main;
        const anchor = columnAnchorRef.current ?? currentSelection.anchor;
        const anchorLine = doc.lineAt(anchor);
        const anchorColumn = anchor - anchorLine.from;
        const focusLine = doc.lineAt(currentSelection.head);
        let nextLineNumber = focusLine.number;
        let nextColumn = currentSelection.head - focusLine.from;

        if (key === 'ArrowLeft') nextColumn = Math.max(0, nextColumn - 1);
        if (key === 'ArrowRight') nextColumn += 1;
        if (key === 'ArrowUp') nextLineNumber = Math.max(1, nextLineNumber - 1);
        if (key === 'ArrowDown') nextLineNumber = Math.min(doc.lines, nextLineNumber + 1);

        const fromLine = Math.min(anchorLine.number, nextLineNumber);
        const toLine = Math.max(anchorLine.number, nextLineNumber);
        const startColumn = Math.min(anchorColumn, nextColumn);
        const endColumn = Math.max(anchorColumn, nextColumn);
        const ranges = [];

        for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
          const line = doc.line(lineNumber);
          const from = line.from + Math.min(startColumn, line.length);
          const to = line.from + Math.min(endColumn, line.length);
          ranges.push(from === to ? EditorSelection.cursor(from) : EditorSelection.range(from, to));
        }

        columnAnchorRef.current = anchor;
        view.dispatch({
          selection: EditorSelection.create(ranges, Math.max(0, ranges.length - 1)),
          effects: EditorView.scrollIntoView(ranges[ranges.length - 1].head, { y: 'nearest' })
        });
        return true;
      };

      const state = EditorState.create({
        doc: valueRef.current,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          boldDecorationField,
          linkDecorationField,
          // Inline images only in the note body — a bitmap in the one-line title
          // field would break its layout.
          ...(singleLine ? [] : [imageTokenPlugin]),
          lineNumbers(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          editorTheme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': placeholder ?? 'CloudPad note editor',
            'aria-multiline': singleLine ? 'false' : 'true',
            inputmode: 'text',
            spellcheck: 'false'
          }),
          EditorView.domEventObservers({
            beforeinput: (event, view) => {
              traceWindowsEmojiInput('editor-beforeinput', event, view, singleLine);
            },
            input: (event, view) => {
              traceWindowsEmojiInput('editor-input', event, view, singleLine);
            },
            compositionstart: (event, view) => {
              traceWindowsEmojiInput('editor-compositionstart', event, view, singleLine);
            },
            compositionupdate: (event, view) => {
              traceWindowsEmojiInput('editor-compositionupdate', event, view, singleLine);
            },
            compositionend: (event, view) => {
              traceWindowsEmojiInput('editor-compositionend', event, view, singleLine);
            },
            paste: (event, view) => {
              traceWindowsEmojiInput('editor-paste', event, view, singleLine);
            }
          }),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet) {
              emitBoldStateForSelection(update.view);
            }
            if (!update.docChanged) return;
            const previousValue = update.startState.doc.toString();
            const previousRanges = normalizeBoldRanges(boldRangesRef.current, previousValue.length);
            if (!isRestoringSnapshotRef.current && !isApplyingExternalValueRef.current) {
              const now = Date.now();
              const isTypingEdit = update.transactions.some((tr) =>
                tr.isUserEvent('input.type')
                || tr.isUserEvent('delete.backward')
                || tr.isUserEvent('delete.forward'));
              // Collapse a continuous burst of typing/deletion into a single undo step;
              // non-typing edits (paste, replace, format) always get their own snapshot.
              const continuesTypingGroup = isTypingEdit
                && lastUndoWasTypingRef.current
                && now - lastUndoPushTimeRef.current < TYPING_UNDO_GROUP_MS;
              if (!continuesTypingGroup) {
                pushUndoSnapshot(getEditorHistorySnapshot(update.view, previousValue, previousRanges));
              }
              lastUndoPushTimeRef.current = now;
              lastUndoWasTypingRef.current = isTypingEdit;
            }
            const nextValue = update.state.doc.toString();
            valueRef.current = nextValue;
            if (isRestoringSnapshotRef.current) {
              return;
            }
            boldRangesRef.current = normalizeBoldRanges(
              boldRangesRef.current.map((range) => ({
                from: update.changes.mapPos(range.from, 1),
                to: update.changes.mapPos(range.to, -1),
                weight: range.weight,
                color: range.color,
                fontSize: range.fontSize,
                fontFamily: range.fontFamily
              })),
              nextValue.length
            );
            const nextHtml = boldRangesToHtml(nextValue, boldRangesRef.current);
            rememberLocalEcho(nextValue, nextHtml);
            onChangeRef.current(nextValue);
          }),
          EditorView.domEventHandlers({
            click: (event, view) => {
              // Normal click opens a detected http(s), www, or email link. Holding
              // Alt keeps the click in editing mode so a URL can still be changed.
              if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
              const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (position === null) return false;
              const link = getLinkAtPosition(view, position);
              if (!link) return false;
              event.preventDefault();
              event.stopPropagation();
              void openDetectedLink(link.url);
              return true;
            },
            keydown: (event, view) => {
              if (singleLine && event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                return true;
              }
              const isBoldShortcut =
                (event.ctrlKey || event.metaKey) &&
                (event.key.toLowerCase() === 'b' || event.code === 'KeyB');
              if (isBoldShortcut) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                return toggleBoldAtSelection(view);
              }
              return false;
            },
            copy: (event, view) => {
              // A lone image token selected -> copy the actual bitmap, so it can be
              // pasted into other apps (or back here) as a picture.
              const selMain = view.state.selection.main;
              if (!selMain.empty) {
                const selText = view.state.sliceDoc(
                  Math.min(selMain.from, selMain.to),
                  Math.max(selMain.from, selMain.to)
                ).trim();
                const imageMatch = /^\[ภาพ:([0-9a-fA-F][0-9a-fA-F-]{7,})\]$/.exec(selText);
                if (imageMatch && getStoredImage(imageMatch[1])) {
                  event.preventDefault();
                  internalRichClipboard = null;
                  void copyStoredImageToClipboard(imageMatch[1]);
                  return true;
                }
              }
              const mainSelection = getMainSelectionRange(view);
              const safe = buildThaiSafeClipboard(view);
              // Prefer the Thai-cluster-expanded single range when there is exactly
              // one (the common case) so the two fixes compose instead of racing.
              const richRange: BoldRange | null = safe && safe.ranges.length === 1
                ? { from: safe.ranges[0].from, to: safe.ranges[0].to }
                : mainSelection
                  ? { from: mainSelection.start, to: mainSelection.end }
                  : null;
              const richText = richRange ? view.state.sliceDoc(richRange.from, richRange.to) : '';
              captureRichClipboard(view, richRange, richText);

              // A selection that mixes an image token with other content (e.g. an
              // image plus a caption): native copy would only ever carry the raw
              // "[ภาพ:id]" text, so an app outside CloudPad shows that literal
              // string instead of the picture. Build a text/html alternative with a
              // real <img> in it so paste targets that understand HTML show the
              // image; text/plain keeps the token so pasting back into CloudPad
              // still works exactly as before.
              const externalHtml = buildExternalPasteHtml(safe ? safe.text : richText);
              if (externalHtml) {
                event.preventDefault();
                event.clipboardData?.setData('text/plain', safe ? safe.text : richText);
                event.clipboardData?.setData('text/html', externalHtml);
                if (safe) {
                  view.dispatch({
                    selection: EditorSelection.create(
                      safe.ranges.map((range) => EditorSelection.range(range.from, range.to)),
                      safe.ranges.length - 1
                    )
                  });
                }
                return true;
              }

              if (!safe) return false;
              event.clipboardData?.setData('text/plain', safe.text);
              event.preventDefault();
              view.dispatch({
                selection: EditorSelection.create(
                  safe.ranges.map((range) => EditorSelection.range(range.from, range.to)),
                  safe.ranges.length - 1
                )
              });
              return true;
            },
            cut: (event, view) => {
              const mainSelection = getMainSelectionRange(view);
              const safe = buildThaiSafeClipboard(view);
              const richRange: BoldRange | null = safe && safe.ranges.length === 1
                ? { from: safe.ranges[0].from, to: safe.ranges[0].to }
                : mainSelection
                  ? { from: mainSelection.start, to: mainSelection.end }
                  : null;
              const richText = richRange ? view.state.sliceDoc(richRange.from, richRange.to) : '';
              captureRichClipboard(view, richRange, richText);

              // See the matching comment in `copy`: give apps outside CloudPad an
              // actual <img> to paste instead of the raw "[ภาพ:id]" token text.
              const externalHtml = buildExternalPasteHtml(safe ? safe.text : richText);
              if (externalHtml && richRange) {
                event.preventDefault();
                event.clipboardData?.setData('text/plain', safe ? safe.text : richText);
                event.clipboardData?.setData('text/html', externalHtml);
                const cutRanges = safe ? safe.ranges : [richRange];
                view.dispatch({
                  changes: cutRanges.map((range) => ({ from: range.from, to: range.to, insert: '' })),
                  selection: EditorSelection.cursor(cutRanges[0].from),
                  userEvent: 'delete.cut'
                });
                return true;
              }

              if (!safe) return false;
              event.clipboardData?.setData('text/plain', safe.text);
              event.preventDefault();
              view.dispatch({
                changes: safe.ranges.map((range) => ({ from: range.from, to: range.to, insert: '' })),
                selection: EditorSelection.cursor(safe.ranges[0].from),
                userEvent: 'delete.cut'
              });
              return true;
            },
            paste: (event, view) => {
              // Image on the clipboard (screenshot, copied picture, image copied
              // from a note) -> store the bitmap locally and insert its token.
              if (!singleLine && event.clipboardData) {
                const imageItem = Array.from(event.clipboardData.items).find(
                  (item) => item.kind === 'file' && item.type.startsWith('image/')
                );
                const file = imageItem?.getAsFile();
                if (file) {
                  event.preventDefault();
                  void (async () => {
                    const imageId = await storeImageFromBlob(file);
                    if (!imageId) {
                      window.alert('วางรูปไม่สำเร็จ: พื้นที่เก็บรูปในเครื่องเต็ม ลองลบรูปเก่าออกก่อนค่ะ');
                      return;
                    }
                    const liveView = viewRef.current;
                    if (!liveView) return;
                    const sel = liveView.state.selection.main;
                    const from = Math.min(sel.from, sel.to);
                    const to = Math.max(sel.from, sel.to);
                    const token = imageTokenFor(imageId);
                    liveView.dispatch({
                      changes: { from, to, insert: token },
                      selection: EditorSelection.cursor(from + token.length),
                      userEvent: 'input.paste'
                    });
                    liveView.focus();
                  })();
                  return true;
                }
              }
              const pastedText = event.clipboardData?.getData('text/plain') ?? '';
              if (
                internalRichClipboard
                && internalRichClipboard.ranges.length > 0
                && pastedText.length > 0
                && pastedText === internalRichClipboard.text
              ) {
                event.preventDefault();
                return applyRichPaste(view, internalRichClipboard);
              }
              return false;
            },
            mousedown: (event, view) => {
              if (event.detail >= 2 && ctrlDoubleClickSelectWord(view, event)) return true;
              if (startCtrlDragSelection(view, event)) return true;
              if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
                lastNonEmptySelectionRangesRef.current = [];
              }
              return false;
            },
            dblclick: (event, view) => {
              if (ctrlDoubleClickSelectWord(view, event)) return true;
              if (doubleClickSelectThaiWord(view, event)) return true;
              return false;
            },
            mousemove: () => {
              return false;
            },
            mouseup: (_event, view) => {
              window.setTimeout(() => emitBoldStateForSelection(view), 0);
              return false;
            },
            keyup: (_event, view) => {
              emitBoldStateForSelection(view);
              return false;
            },
            focus: () => {
              onFocusRef.current?.();
              return false;
            },
            blur: () => {
              onBlurRef.current?.();
              return false;
            }
          }),
          keymap.of([
            {
              key: 'Mod-z',
              preventDefault: true,
              run: (view) => undoEditorAction(view)
            },
            {
              key: 'Mod-y',
              preventDefault: true,
              run: (view) => redoEditorAction(view)
            },
            {
              key: 'Mod-Shift-z',
              preventDefault: true,
              run: (view) => redoEditorAction(view)
            },
            {
              key: 'Mod-f',
              run: () => {
                onOpenFindRef.current?.();
                return true;
              }
            },
            {
              key: 'Mod-a',
              preventDefault: true,
              run: (view) => {
                view.dispatch({
                  selection: EditorSelection.single(0, view.state.doc.length),
                  scrollIntoView: true
                });
                emitBoldStateForSelection(view);
                return true;
              }
            },
            {
              key: 'Escape',
              run: (view) => {
                columnAnchorRef.current = null;
                lastNonEmptySelectionRangesRef.current = [];
                if (view.state.selection.ranges.length > 1 || !view.state.selection.main.empty) {
                  view.dispatch({
                    selection: EditorSelection.cursor(view.state.selection.main.head)
                  });
                  onEscapeSmartSelection?.();
                  return true;
                }
                onEscapeSmartSelection?.();
                return false;
              }
            },
            {
              key: 'Alt-Shift-ArrowLeft',
              run: (view) => expandColumnSelection(view, 'ArrowLeft')
            },
            {
              key: 'Alt-Shift-ArrowRight',
              run: (view) => expandColumnSelection(view, 'ArrowRight')
            },
            {
              key: 'Alt-Shift-ArrowUp',
              run: (view) => expandColumnSelection(view, 'ArrowUp')
            },
            {
              key: 'Alt-Shift-ArrowDown',
              run: (view) => expandColumnSelection(view, 'ArrowDown')
            },
            {
              key: 'ArrowLeft',
              run: () => {
                columnAnchorRef.current = null;
                return false;
              }
            },
            {
              key: 'ArrowRight',
              run: () => {
                columnAnchorRef.current = null;
                return false;
              }
            },
            {
              key: 'ArrowUp',
              run: () => {
                columnAnchorRef.current = null;
                return false;
              }
            },
            {
              key: 'ArrowDown',
              run: () => {
                columnAnchorRef.current = null;
                return false;
              }
            },
            indentWithTab,
            ...searchKeymap,
            ...defaultKeymap
          ])
        ]
      });

      const view = new EditorView({
        state,
        parent: hostRef.current
      });
      viewRef.current = view;

      const emojiBridge = emojiInputBridgeRef.current;

      const clearEmojiBridgeTimers = () => {
        if (emojiBridgeCommitTimerRef.current !== null) {
          window.clearTimeout(emojiBridgeCommitTimerRef.current);
          emojiBridgeCommitTimerRef.current = null;
        }
      };

      let emojiPreArmRestoreTimer: number | null = null;

      const cancelEmojiPreArmRestore = () => {
        if (emojiPreArmRestoreTimer !== null) {
          window.clearTimeout(emojiPreArmRestoreTimer);
          emojiPreArmRestoreTimer = null;
        }
      };

      const restoreEditorFromEmojiBridge = () => {
        cancelEmojiPreArmRestore();
        if (!emojiBridgeActiveRef.current) return;
        const selection = emojiBridgeSelectionRef.current;
        emojiBridgeActiveRef.current = false;
        emojiBridgeSelectionRef.current = null;
        emojiBridge?.blur();
        view.focus();
        if (selection) view.dispatch({ selection });
      };

      // Undo a pre-arm when it turns out no panel is opening (window still has
      // focus): hand focus straight back to the editor.
      const restorePreArmedBridge = () => {
        cancelEmojiPreArmRestore();
        if (!emojiBridgeActiveRef.current || !document.hasFocus()) return;
        suspendExternalSyncRef.current = false;
        restoreEditorFromEmojiBridge();
      };

      const commitEmojiBridgeText = () => {
        if (!emojiBridge || viewRef.current !== view) return;
        const rawText = emojiBridge.value;
        if (!rawText) return;
        const text = singleLine
          ? rawText.replace(/\r\n?|\n/g, ' ')
          : rawText.replace(/\r\n?/g, '\n');
        const selection = emojiBridgeSelectionRef.current;

        emojiBridge.value = '';
        if (selection) view.dispatch({ selection });
        view.dispatch({
          ...view.state.replaceSelection(text),
          userEvent: 'input.type'
        });
        // Keep the native Windows text target active after each emoji. The
        // Windows picker stays open and may send more emoji without another
        // Win+V/Win+. shortcut. Closing this bridge here made only the first
        // emoji work.
        emojiBridgeSelectionRef.current = view.state.selection;
        emojiBridgeActiveRef.current = true;
        emojiBridge.focus({ preventScroll: true });
      };

      const scheduleEmojiBridgeCommit = () => {
        traceWindowsEmojiInput('bridge-input', null, view, singleLine);
        // Content is flowing into the bridge — never yank focus away from it.
        cancelEmojiPreArmRestore();
        if (emojiBridgeCommitTimerRef.current !== null) {
          window.clearTimeout(emojiBridgeCommitTimerRef.current);
        }
        emojiBridgeCommitTimerRef.current = window.setTimeout(() => {
          emojiBridgeCommitTimerRef.current = null;
          commitEmojiBridgeText();
        }, 12);
      };

      const activateEmojiInputBridge = () => {
        if (!emojiBridge || emojiBridgeActiveRef.current) return;
        const activeElement = document.activeElement;
        if (!view.hasFocus && !(activeElement instanceof Node && view.dom.contains(activeElement))) {
          return;
        }

        const cursor = view.coordsAtPos(view.state.selection.main.head);
        if (cursor) {
          emojiBridge.style.left = `${Math.max(0, Math.round(cursor.left))}px`;
          emojiBridge.style.top = `${Math.max(0, Math.round(cursor.top))}px`;
          emojiBridge.style.height = `${Math.max(18, Math.round(cursor.bottom - cursor.top))}px`;
        }

        clearEmojiBridgeTimers();
        emojiBridgeSelectionRef.current = view.state.selection;
        emojiBridgeActiveRef.current = true;
        emojiBridge.value = '';
        emojiBridge.focus({ preventScroll: true });
      };

      const handleSystemShortcutKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Meta' || event.metaKey || event.code === 'MetaLeft' || event.code === 'MetaRight') {
          lastMetaKeyDownAtRef.current = Date.now();
          traceWindowsEmojiInput('window-keydown', event, view, singleLine);
          if (event.key === 'Meta' || event.code === 'MetaLeft' || event.code === 'MetaRight') {
            // Pre-arm the bridge on the Win press itself, BEFORE the emoji /
            // clipboard panel opens: Windows binds the panel to whichever text
            // control has focus at open time. Arming only after the blur meant
            // the panel first bound to the editor, so the first emoji click was
            // delivered to a no-longer-focused control and dropped — only the
            // second click landed.
            if (!emojiBridgeActiveRef.current) {
              const activeElement = document.activeElement;
              const editorFocused = view.hasFocus
                || (activeElement instanceof Node && view.dom.contains(activeElement));
              if (editorFocused) {
                suspendExternalSyncRef.current = true;
                activateEmojiInputBridge();
                cancelEmojiPreArmRestore();
                emojiPreArmRestoreTimer = window.setTimeout(() => {
                  emojiPreArmRestoreTimer = null;
                  restorePreArmedBridge();
                }, WIN_EMOJI_NO_BLUR_RESTORE_MS);
              }
            }
          } else if (event.key === ' ') {
            // Win+Space (keyboard language switch) keeps window focus — no panel
            // is opening, so hand focus back to the editor immediately.
            restorePreArmedBridge();
          }
        }
        if (event.key === 'Escape' && emojiBridgeActiveRef.current) {
          suspendExternalSyncRef.current = false;
          restoreEditorFromEmojiBridge();
        }
      };

      const handleDocumentPointerDown = (event: PointerEvent) => {
        if (!emojiBridgeActiveRef.current || event.target === emojiBridge) return;
        suspendExternalSyncRef.current = false;
        restoreEditorFromEmojiBridge();
      };

      // The shell swallows the Win+. / Win+; / Win+V keyDOWN, but the keyUP of
      // the second key leaks through to the page. Seeing one while the bridge is
      // armed is positive confirmation the emoji/clipboard panel really opened —
      // crucial on Windows builds where these panels do NOT blur the window at
      // all (observed in the field), so the no-blur restore timer must not fire.
      const handleSystemShortcutKeyUp = (event: KeyboardEvent) => {
        if (!emojiBridgeActiveRef.current) return;
        if (event.code === 'Period' || event.code === 'Semicolon' || event.code === 'KeyV') {
          traceWindowsEmojiInput('panel-keyup-confirm', event, view, singleLine);
          cancelEmojiPreArmRestore();
        }
      };

      const handleWindowBlur = (event: FocusEvent) => {
        // Capture-phase window listeners also receive every ELEMENT's blur
        // (e.g. the editor blurring when the bridge takes focus). Only the
        // window's own blur means the OS moved focus to another window/panel.
        if (event.target !== window) return;
        traceWindowsEmojiInput('window-blur', null, view, singleLine);
        // Hand off to the emoji bridge ONLY when this blur is the Windows emoji
        // picker opening (a Win press happened just before). Alt-tab, clicking
        // another app, or a spurious OS focus blip must leave editing untouched.
        if (Date.now() - lastMetaKeyDownAtRef.current > WIN_EMOJI_BLUR_WINDOW_MS) return;
        // A panel really opened — keep a pre-armed bridge focused for as long as
        // the panel is up instead of auto-restoring.
        cancelEmojiPreArmRestore();
        if (emojiBridgeActiveRef.current) return;
        const activeElement = document.activeElement;
        if (
          view.hasFocus
          || (activeElement instanceof Node && view.dom.contains(activeElement))
        ) {
          suspendExternalSyncRef.current = true;
          activateEmojiInputBridge();
        }
      };

      const handleWindowFocus = () => {
        traceWindowsEmojiInput('window-focus', null, view, singleLine);
        // Keep the native text control focused while the Windows emoji panel
        // is open. Restoring here used to happen before the user could click
        // an emoji, so Windows had no active text target to insert into.
        if (emojiBridgeActiveRef.current && document.activeElement === emojiBridge) {
          return;
        }
        if (resumeExternalSyncTimerRef.current !== null) {
          window.clearTimeout(resumeExternalSyncTimerRef.current);
        }
        resumeExternalSyncTimerRef.current = window.setTimeout(() => {
          resumeExternalSyncTimerRef.current = null;
          suspendExternalSyncRef.current = false;
        }, 120);
      };

      emojiBridge?.addEventListener('input', scheduleEmojiBridgeCommit);
      document.addEventListener('pointerdown', handleDocumentPointerDown, true);
      window.addEventListener('keydown', handleSystemShortcutKeyDown, true);
      window.addEventListener('keyup', handleSystemShortcutKeyUp, true);
      window.addEventListener('blur', handleWindowBlur, true);
      window.addEventListener('focus', handleWindowFocus, true);

      // DEV-only forensic tracing: log every text-delivery-related event on both
      // the bridge and the editor's contentDOM, so a real Win+. / Win+V session
      // shows exactly where (or whether) each emoji/paste arrives. Pure logging;
      // never interferes with handling.
      let stopEmojiForensicTrace: (() => void) | null = null;
      if (import.meta.env.DEV) {
        const forensicEvents = [
          'beforeinput', 'input', 'compositionstart', 'compositionupdate',
          'compositionend', 'paste', 'keydown', 'keyup', 'focus', 'blur'
        ];
        const targets: Array<[string, EventTarget | null]> = [
          ['bridge', emojiBridge],
          ['editorDom', view.contentDOM]
        ];
        const attached: Array<[EventTarget, string, EventListener]> = [];
        for (const [label, target] of targets) {
          if (!target) continue;
          for (const type of forensicEvents) {
            const listener: EventListener = (event) => {
              traceWindowsEmojiInput(`${label}:${type}`, event, view, singleLine);
            };
            target.addEventListener(type, listener, true);
            attached.push([target, type, listener]);
          }
        }
        stopEmojiForensicTrace = () => {
          for (const [target, type, listener] of attached) {
            target.removeEventListener(type, listener, true);
          }
        };
      }

      const handleNativeCtrlDoubleClick = (event: MouseEvent) => {
        if (!(event.ctrlKey || event.metaKey) || event.button !== 0 || event.detail < 2) return;
        if (ctrlDoubleClickSelectWord(view, event)) {
          event.stopImmediatePropagation();
        }
      };

      hostRef.current.addEventListener('mousedown', handleNativeCtrlDoubleClick, true);
      hostRef.current.addEventListener('dblclick', handleNativeCtrlDoubleClick, true);
      stopNativeCtrlDoubleClickTracking = () => {
        hostRef.current?.removeEventListener('mousedown', handleNativeCtrlDoubleClick, true);
        hostRef.current?.removeEventListener('dblclick', handleNativeCtrlDoubleClick, true);
      };

      const initialBoldRanges = parseBoldRangesFromHtml(contentHtmlRef.current, valueRef.current);
      if (initialBoldRanges.length > 0) {
        boldRangesRef.current = initialBoldRanges;
        view.dispatch({ effects: setBoldRangesEffect.of(initialBoldRanges) });
      }

      return () => {
        stopCtrlDragTracking?.();
        stopNativeCtrlDoubleClickTracking?.();
        clearEmojiBridgeTimers();
        cancelEmojiPreArmRestore();
        stopEmojiForensicTrace?.();
        emojiBridge?.removeEventListener('input', scheduleEmojiBridgeCommit);
        document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
        window.removeEventListener('keydown', handleSystemShortcutKeyDown, true);
        window.removeEventListener('keyup', handleSystemShortcutKeyUp, true);
        window.removeEventListener('blur', handleWindowBlur, true);
        window.removeEventListener('focus', handleWindowFocus, true);
        if (resumeExternalSyncTimerRef.current !== null) {
          window.clearTimeout(resumeExternalSyncTimerRef.current);
          resumeExternalSyncTimerRef.current = null;
        }
        suspendExternalSyncRef.current = false;
        emojiBridgeActiveRef.current = false;
        emojiBridgeSelectionRef.current = null;
        view.destroy();
        viewRef.current = null;
      };
    }, [onEscapeSmartSelection, placeholder, singleLine]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) {
        valueRef.current = value;
        boldRangesRef.current = parseBoldRangesFromHtml(contentHtml, value);
        return;
      }
      if (suspendExternalSyncRef.current) {
        return;
      }
      const currentValue = view.state.doc.toString();
      const nextBoldRanges = parseBoldRangesFromHtml(contentHtml, value);

      if (currentValue !== value && consumeLocalEcho(value, contentHtml ?? '')) {
        return;
      }

      if (view.hasFocus && currentValue !== value) {
        return;
      }

      valueRef.current = value;
      boldRangesRef.current = nextBoldRanges;

      if (view.hasFocus && currentValue === value && consumeLocalEcho(value, contentHtml ?? '')) {
        return;
      }

      if (currentValue === value) {
        if (view.hasFocus) {
          valueRef.current = value;
          return;
        }
        view.dispatch({ effects: setBoldRangesEffect.of(nextBoldRanges) });
        emitBoldStateForSelection(view);
        return;
      }

      undoSnapshotsRef.current = [];
      redoSnapshotsRef.current = [];
      isApplyingExternalValueRef.current = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: value },
          effects: [
            StateEffect.appendConfig.of([]),
            setBoldRangesEffect.of(nextBoldRanges)
          ]
        });
      } finally {
        isApplyingExternalValueRef.current = false;
      }
      emitBoldStateForSelection(view);
    }, [contentHtml, value]);

    const editorStyle = {
      '--cloudpad-editor-font': style?.fontFamily ?? 'inherit',
      '--cloudpad-editor-font-size': style?.fontSize ?? '20px',
      '--cloudpad-editor-font-weight': style?.fontWeight ?? '400',
      '--cloudpad-editor-color': style?.color ?? '#0f172a'
    } as CSSProperties;

    return (
      <div
        ref={hostRef}
        className={`codemirror-note-editor ${singleLine ? 'single-line' : ''}`}
        style={editorStyle}
      >
        <textarea
          ref={emojiInputBridgeRef}
          className="emoji-input-bridge"
          aria-label="รับอิโมจิจาก Windows"
          tabIndex={-1}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
    );
  }
);
