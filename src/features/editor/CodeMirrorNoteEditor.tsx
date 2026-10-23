import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { CSSProperties } from 'react';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { writeText as writeNativeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
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
// Text that arrives in the hidden Windows input bridge is only proof of a real
// emoji panel when it actually contains a pictograph. Plain characters mean the
// bridge is swallowing ordinary typing (it was armed by a Windows key press that
// turned out to be Win+Space, a Start-menu tap, ...) and focus must go straight
// back to the editor, otherwise the caret stays invisible while typing works.
const EMOJI_LIKE_PATTERN = /\p{Extended_Pictographic}/u;

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

// How long the mouse must be held on an already-selected piece of text before
// dragging it moves the text instead of starting a new selection.
const TEXT_DRAG_HOLD_MS = 450;

// The Windows emoji-picker bridge is opt-in via Settings. Some Windows WebViews
// swallow the Period key before JavaScript can see it, so the enabled compatibility
// path must prepare the native text target on the Windows key itself.
const EMOJI_INPUT_BRIDGE_STORAGE_KEY = 'cloudpad.emojiBridge.v1';

function isEmojiInputBridgeEnabled(): boolean {
  try {
    return localStorage.getItem(EMOJI_INPUT_BRIDGE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

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
// Trace logging is opt-in even in dev builds — it used to fire unconditionally
// on every beforeinput/input event (2+ sessionStorage round-trips and 2 console
// calls per keystroke), which starved the browser of paint time during OS key
// repeat: held keys looked frozen and dumped all characters at once on release.
// Flip this on in the DevTools console only while actively reproducing a
// Windows emoji/IME bug: sessionStorage.setItem('cloudpad:emoji-trace-enabled', '1')
const EMOJI_TRACE_ENABLED_KEY = 'cloudpad:emoji-trace-enabled';

function traceWindowsEmojiInput(
  source: string,
  event: Event | null,
  view: EditorView,
  singleLine: boolean
) {
  if (!import.meta.env.DEV) return;
  if (sessionStorage.getItem(EMOJI_TRACE_ENABLED_KEY) !== '1') return;
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
    console.debug('[CloudPad emoji]', JSON.stringify(record));
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

// The synchronous ClipboardEvent write above is enough for an immediate paste
// (here or in another app) to see the new text, but on Windows it never
// reaches Clipboard History (Win+V): WebView2's JS clipboard implementation
// (both the sync ClipboardEvent API and the async navigator.clipboard one)
// does not go through the normal OpenClipboard/SetClipboardData ownership
// sequence, so Windows never sees a real clipboard-owner change to record.
// Tauri's clipboard-manager plugin writes through Rust instead, which uses
// the real Win32 clipboard APIs — so route the write through that when
// running inside the desktop app, and fall back to the browser API in the
// plain web preview (no Tauri runtime there).
function notifyWindowsClipboardHistory(text: string) {
  if (!text) return;
  void writeNativeClipboardText(text).catch(() => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  });
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
    // .cm-content is a flex item of .cm-scroller (CodeMirror's own base theme:
    // flexGrow 2 / flexShrink 1 when wrapping is on). A flex item's default
    // min-width is "auto" — its unwrapped content width — and unlike
    // overflow-wrap: anywhere, word-break: break-word does not shrink that
    // intrinsic size. Long unbroken runs (emoji strings, repeated letters
    // with no spaces) therefore stayed as wide as the whole run and the
    // editor scrolled sideways instead of wrapping. min-width: 0 lets the
    // item actually shrink to the available width so wrapping can kick in.
    minWidth: '0',
    caretColor: '#1d4ed8',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
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
          // Swapping the whole document in one change (rather than a minimal
          // diff) invalidates CodeMirror's scroll anchor, so without an
          // explicit scrollIntoView it snaps the viewport to the top instead
          // of keeping the restored cursor visible — this is what made
          // undo/redo look like they jumped to the top of a long note.
          effects: [setBoldRangesEffect.of(ranges), EditorView.scrollIntoView(selectionRanges[mainIndex].head, { y: 'nearest' })]
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
      let textDragArmTimer: number | null = null;
      let isTextDragArmed = false;

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

      // A selected word can otherwise start a native drag after just a tiny pointer
      // movement. Arm drag-to-move only after a short deliberate press.
      const cancelTextDragArm = () => {
        if (textDragArmTimer !== null) {
          window.clearTimeout(textDragArmTimer);
          textDragArmTimer = null;
        }
        isTextDragArmed = false;
        viewRef.current?.contentDOM.classList.remove('cm-text-drag-armed');
      };

      // True only when the pointer is physically over the blue selection band the
      // user can see. Comparing document positions instead counted a press on the
      // gap right before/after a highlighted word as "inside" it (a position at
      // the edge of the range), so starting a fresh drag next to a word that
      // Ctrl+B had just left selected picked that word up and moved it.
      const isPointerOverSelectionHighlight = (view: EditorView, event: MouseEvent) => {
        const bands = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-selectionBackground'));
        return bands.some((band) => {
          const rect = band.getBoundingClientRect();
          return event.clientX > rect.left + 1
            && event.clientX < rect.right - 1
            && event.clientY >= rect.top
            && event.clientY <= rect.bottom;
        });
      };

      const armTextDrag = (view: EditorView, event: MouseEvent) => {
        cancelTextDragArm();
        if (
          event.button !== 0
          || event.detail !== 1
          || event.ctrlKey
          || event.metaKey
          || event.altKey
          || event.shiftKey
        ) return;

        if (!isPointerOverSelectionHighlight(view, event)) return;

        // A deliberate "press and hold" — long enough that an ordinary pause
        // before dragging out a new selection from a highlighted word does not
        // turn into moving that word. Moving the pointer first (a normal drag)
        // never arms it.
        textDragArmTimer = window.setTimeout(() => {
          textDragArmTimer = null;
          isTextDragArmed = true;
          view.contentDOM.classList.add('cm-text-drag-armed');
        }, TEXT_DRAG_HOLD_MS);
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

              const plainText = safe ? safe.text : richText;
              if (!plainText) return false;

              // A selection that mixes an image token with other content (e.g. an
              // image plus a caption): native copy would only ever carry the raw
              // "[ภาพ:id]" text, so an app outside CloudPad shows that literal
              // string instead of the picture. Build a text/html alternative with a
              // real <img> in it so paste targets that understand HTML show the
              // image; text/plain keeps the token so pasting back into CloudPad
              // still works exactly as before.
              const externalHtml = buildExternalPasteHtml(plainText);
              event.preventDefault();
              event.clipboardData?.setData('text/plain', plainText);
              if (externalHtml) {
                event.clipboardData?.setData('text/html', externalHtml);
              }
              notifyWindowsClipboardHistory(plainText);
              if (safe) {
                view.dispatch({
                  selection: EditorSelection.create(
                    safe.ranges.map((range) => EditorSelection.range(range.from, range.to)),
                    safe.ranges.length - 1
                  )
                });
              }
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

              const plainText = safe ? safe.text : richText;
              const cutRanges = safe ? safe.ranges : (richRange ? [richRange] : null);
              if (!plainText || !cutRanges) return false;

              // See the matching comment in `copy`: give apps outside CloudPad an
              // actual <img> to paste instead of the raw "[ภาพ:id]" token text.
              const externalHtml = buildExternalPasteHtml(plainText);
              event.preventDefault();
              event.clipboardData?.setData('text/plain', plainText);
              if (externalHtml) {
                event.clipboardData?.setData('text/html', externalHtml);
              }
              notifyWindowsClipboardHistory(plainText);
              view.dispatch({
                changes: cutRanges.map((range) => ({ from: range.from, to: range.to, insert: '' })),
                selection: EditorSelection.cursor(cutRanges[0].from),
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
              armTextDrag(view, event);
              if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
                lastNonEmptySelectionRangesRef.current = [];
              }
              return false;
            },
            dragstart: (event) => {
              if (!isTextDragArmed) {
                event.preventDefault();
                return true;
              }
              cancelTextDragArm();
              return false;
            },
            dragend: () => {
              cancelTextDragArm();
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
              cancelTextDragArm();
              window.setTimeout(() => emitBoldStateForSelection(view), 0);
              return false;
            },
            keyup: (_event, view) => {
              emitBoldStateForSelection(view);
              return false;
            },
            focus: () => {
              // A normal click back into the note ends the previous native-picker
              // session. Do not leave its bridge marked active, otherwise the next
              // Win+. would skip its fresh selection/target setup.
              if (emojiBridgeActiveRef.current && document.activeElement !== emojiBridge) {
                emojiBridgeActiveRef.current = false;
                emojiBridgeSelectionRef.current = null;
                suspendExternalSyncRef.current = false;
              }
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

      // Backstop for a Windows key press that armed the bridge but never opened a
      // panel (see handleSystemShortcutKeyUp).
      let windowsKeyRestoreTimer: number | null = null;

      const clearEmojiBridgeTimers = () => {
        if (emojiBridgeCommitTimerRef.current !== null) {
          window.clearTimeout(emojiBridgeCommitTimerRef.current);
          emojiBridgeCommitTimerRef.current = null;
        }
        if (windowsKeyRestoreTimer !== null) {
          window.clearTimeout(windowsKeyRestoreTimer);
          windowsKeyRestoreTimer = null;
        }
      };

      // True only once we have POSITIVE proof a real emoji/clipboard panel opened:
      // the keyup of Win+. / Win+; / Win+V leaked through, or text flowed into the
      // bridge. A bare Windows tap (Start menu) never sets this, so its blur/refocus
      // cycle must hand focus back to the editor instead of leaving the bridge stuck.
      let emojiPanelConfirmed = false;
      let languageSwitchPending = false;
      // Keep the bridge value intact while Windows' picker is open. Some picker
      // builds stop delivering later selections when the focused target is cleared
      // after the first emoji, so this tracks the prefix already inserted instead.
      let committedEmojiBridgeText = '';
      // `beforeinput` / `input` tell us whether Windows changed its hidden
      // target by inserting a picker result or by deleting a character. The
      // latter must be mirrored as an editor deletion, never inserted again as
      // a fresh string (which previously replayed the bridge history).
      let lastEmojiBridgeInputType = '';

      const restoreEditorFromEmojiBridge = () => {
        if (!emojiBridgeActiveRef.current) return;
        const selection = emojiBridgeSelectionRef.current;
        emojiBridgeActiveRef.current = false;
        emojiBridgeSelectionRef.current = null;
        emojiPanelConfirmed = false;
        emojiBridge?.blur();
        view.focus();
        if (selection) view.dispatch({ selection });
      };

      const restoreEditorAfterAlt = () => {
        if (emojiBridgeActiveRef.current) {
          suspendExternalSyncRef.current = false;
          restoreEditorFromEmojiBridge();
          return;
        }

        // Windows/WebView can move focus to the document root while Alt opens
        // the native menu. There may be no window focus event when the menu
        // closes, so explicitly restore CodeMirror only when no other control
        // is the user's active target.
        if (!document.hasFocus()) return;
        const activeElement = document.activeElement;
        if (
          activeElement === document.body
          || activeElement === document.documentElement
          || activeElement === emojiBridge
        ) {
          emojiBridge?.blur();
          view.focus();
        }
      };

      const commitEmojiBridgeText = () => {
        if (!emojiBridge || viewRef.current !== view) return;
        const rawText = emojiBridge.value;
        const isBackwardDelete = lastEmojiBridgeInputType.startsWith('deleteContentBackward')
          || lastEmojiBridgeInputType.startsWith('deleteWordBackward');
        // Do not rely only on InputEvent.inputType. WebView2 builds used by the
        // desktop app have been observed to emit an empty inputType for native
        // Windows-picker edits. A strict prefix shrink is unambiguous: the
        // bridge's accumulated value was shortened, so it is a deletion.
        const deletedBridgeText = committedEmojiBridgeText.startsWith(rawText)
          && rawText.length < committedEmojiBridgeText.length;

        if (deletedBridgeText || isBackwardDelete) {
          // The Windows picker keeps its own accumulated value. Backspace edits
          // that value first, so translate the reduction into an actual editor
          // deletion instead of treating the remaining bridge text as new input.
          if (deletedBridgeText) {
            const selection = emojiBridgeSelectionRef.current;
            if (selection) view.dispatch({ selection });
            const activeSelection = view.state.selection.main;
            const removedLength = committedEmojiBridgeText.length - rawText.length;
            const from = activeSelection.empty
              ? Math.max(0, activeSelection.head - removedLength)
              : activeSelection.from;
            const to = activeSelection.empty ? activeSelection.head : activeSelection.to;
            view.dispatch({
              changes: { from, to, insert: '' },
              userEvent: 'delete.backward'
            });
            emojiBridgeSelectionRef.current = view.state.selection;
          }

          committedEmojiBridgeText = rawText;
          lastEmojiBridgeInputType = '';
          suspendExternalSyncRef.current = false;
          restoreEditorFromEmojiBridge();
          return;
        }

        if (!rawText) return;
        const newText = rawText.startsWith(committedEmojiBridgeText)
          ? rawText.slice(committedEmojiBridgeText.length)
          : rawText;
        if (!newText) return;
        const text = singleLine
          ? newText.replace(/\r\n?|\n/g, ' ')
          : newText.replace(/\r\n?/g, '\n');
        const selection = emojiBridgeSelectionRef.current;

        if (selection) view.dispatch({ selection });
        view.dispatch({
          ...view.state.replaceSelection(text),
          userEvent: 'input.type'
        });
        committedEmojiBridgeText = rawText;
        lastEmojiBridgeInputType = '';
        // Keep the native Windows text target active after each emoji. The
        // Windows picker stays open and may send more emoji without another
        // Win+V/Win+. shortcut. Do not focus it again when it is already the
        // active target — repeated focus calls can detach the picker after the
        // first selected emoji on some Windows builds.
        emojiBridgeSelectionRef.current = view.state.selection;
        emojiBridgeActiveRef.current = true;

        // Plain text means the user is simply typing and the bridge is in the way
        // (it was armed by a Windows key press with no emoji panel behind it, e.g.
        // the Win+Space language switch). Hand the keyboard back to CodeMirror at
        // the position the text just landed, so the caret becomes visible again.
        if (!EMOJI_LIKE_PATTERN.test(text)) {
          emojiBridge.value = '';
          committedEmojiBridgeText = '';
          suspendExternalSyncRef.current = false;
          restoreEditorFromEmojiBridge();
          return;
        }

        if (document.activeElement !== emojiBridge) {
          emojiBridge.focus({ preventScroll: true });
        }
      };

      const scheduleEmojiBridgeCommit = (event?: Event) => {
        if (event instanceof InputEvent && event.inputType) {
          lastEmojiBridgeInputType = event.inputType;
        }
        traceWindowsEmojiInput('bridge-input', null, view, singleLine);
        // Emoji flowing into the bridge is a real emoji/clipboard panel: confirm it
        // and never yank focus away from it. Plain characters are NOT proof — after
        // a Win+Space language switch the bridge keeps the keyboard, so confirming
        // here left the caret trapped in the bridge for the rest of the session
        // (typing still landed in the note, but no cursor was ever drawn).
        if (EMOJI_LIKE_PATTERN.test(emojiBridge?.value ?? '')) {
          emojiPanelConfirmed = true;
        }
        if (emojiBridgeCommitTimerRef.current !== null) {
          window.clearTimeout(emojiBridgeCommitTimerRef.current);
        }
        emojiBridgeCommitTimerRef.current = window.setTimeout(() => {
          emojiBridgeCommitTimerRef.current = null;
          commitEmojiBridgeText();
        }, 35);
      };

      const activateEmojiInputBridge = (allowUnfocusedEditor = false) => {
        if (!isEmojiInputBridgeEnabled()) return false;
        if (!emojiBridge || emojiBridgeActiveRef.current) return false;
        const activeElement = document.activeElement;
        if (
          !allowUnfocusedEditor
          && !view.hasFocus
          && !(activeElement instanceof Node && view.dom.contains(activeElement))
        ) {
          return false;
        }

        const cursor = view.coordsAtPos(view.state.selection.main.head);
        if (cursor) {
          emojiBridge.style.left = `${Math.max(0, Math.round(cursor.left))}px`;
          emojiBridge.style.top = `${Math.max(0, Math.round(cursor.top))}px`;
          emojiBridge.style.height = `${Math.max(18, Math.round(cursor.bottom - cursor.top))}px`;
        }

        clearEmojiBridgeTimers();
        emojiPanelConfirmed = false;
        committedEmojiBridgeText = '';
        lastEmojiBridgeInputType = '';
        emojiBridgeSelectionRef.current = view.state.selection;
        emojiBridgeActiveRef.current = true;
        emojiBridge.value = '';
        emojiBridge.focus({ preventScroll: true });
        return true;
      };

      const handleSystemShortcutKeyDown = (event: KeyboardEvent) => {
        const isWindowsKey = event.key === 'Meta'
          || event.code === 'MetaLeft'
          || event.code === 'MetaRight';
        const isAltKey = event.key === 'Alt'
          || event.code === 'AltLeft'
          || event.code === 'AltRight';
        const isWindowsPanelShortcut = event.metaKey
          && (event.code === 'Period' || event.code === 'Semicolon' || event.code === 'KeyV');

        if (isAltKey) {
          restoreEditorAfterAlt();
          return;
        }

        if (isWindowsKey) {
          traceWindowsEmojiInput('windows-keydown', event, view, singleLine);
          // Windows chooses the picker insertion target before it exposes the
          // Period key to WebView. This compatibility path is explicitly opt-in;
          // when disabled, a bare Windows key never affects typing focus.
          if (!emojiBridgeActiveRef.current) {
            const activeElement = document.activeElement;
            const editorFocused = view.hasFocus
              || (activeElement instanceof Node && view.dom.contains(activeElement));
            if (editorFocused) {
              // Only suspend React/external synchronization after the bridge
              // actually activated. When the setting is off, activation is a
              // no-op and normal editor synchronization must remain untouched.
              if (activateEmojiInputBridge()) {
                suspendExternalSyncRef.current = true;
              }
            }
          }
          return;
        }

        if (isWindowsPanelShortcut) {
          traceWindowsEmojiInput('panel-keydown', event, view, singleLine);
          if (emojiBridgeActiveRef.current) {
            emojiPanelConfirmed = true;
          }
        }

        // Win+Space is the normal Windows input-language switch. It is not the
        // emoji picker, so return focus immediately whenever this key is exposed.
        if (event.metaKey && (event.code === 'Space' || event.key === ' ')) {
          languageSwitchPending = true;
          if (emojiBridgeActiveRef.current) {
            suspendExternalSyncRef.current = false;
            restoreEditorFromEmojiBridge();
          }
          // Do not prevent the native language switch. The matching keyup
          // below restores the caret after Windows has handled it.
          return;
        }
        if (event.key === 'Escape' && emojiBridgeActiveRef.current) {
          suspendExternalSyncRef.current = false;
          restoreEditorFromEmojiBridge();
        }
      };

      // The shell swallows the Win+. / Win+; / Win+V keyDOWN, but the keyUP of
      // the second key leaks through to the page. Seeing one while the bridge is
      // armed is positive confirmation the emoji/clipboard panel really opened —
      // crucial on Windows builds where these panels do NOT blur the window at
      // all (observed in the field), so the no-blur restore timer must not fire.
      const handleSystemShortcutKeyUp = (event: KeyboardEvent) => {
        const isAltKey = event.key === 'Alt'
          || event.code === 'AltLeft'
          || event.code === 'AltRight';
        if (isAltKey) {
          restoreEditorAfterAlt();
          return;
        }
        // Win+Space is the language switch. Windows usually swallows its keyDOWN,
        // so languageSwitchPending never gets set and the keyUP is the only signal
        // the page ever sees — restore on it whenever the bridge is armed without a
        // confirmed panel. Without this the bridge kept the keyboard after every
        // language switch: typing still reached the note, but the caret was gone.
        if (event.code === 'Space' || event.key === ' ') {
          if (languageSwitchPending || (emojiBridgeActiveRef.current && !emojiPanelConfirmed)) {
            languageSwitchPending = false;
            suspendExternalSyncRef.current = false;
            restoreEditorAfterAlt();
            return;
          }
        }
        if (!emojiBridgeActiveRef.current) return;
        if (event.code === 'Period' || event.code === 'Semicolon' || event.code === 'KeyV') {
          traceWindowsEmojiInput('panel-keyup-confirm', event, view, singleLine);
          emojiPanelConfirmed = true;
          return;
        }

        const isWindowsKeyUp = event.key === 'Meta'
          || event.code === 'MetaLeft'
          || event.code === 'MetaRight';
        if (!isWindowsKeyUp || emojiPanelConfirmed) return;
        // The Windows key was released and no panel ever announced itself. If a
        // real panel (or the Start menu) had opened, the window would be blurred
        // and handleWindowFocus takes care of the restore; anything else means the
        // bridge is silently holding the keyboard, so give it back shortly after.
        if (windowsKeyRestoreTimer !== null) window.clearTimeout(windowsKeyRestoreTimer);
        windowsKeyRestoreTimer = window.setTimeout(() => {
          windowsKeyRestoreTimer = null;
          if (!emojiBridgeActiveRef.current || emojiPanelConfirmed) return;
          if (!document.hasFocus()) return;
          suspendExternalSyncRef.current = false;
          restoreEditorFromEmojiBridge();
        }, 400);
      };

      const handleWindowBlur = (event: FocusEvent) => {
        // Capture-phase window listeners also receive every ELEMENT's blur
        // (e.g. the editor blurring when the bridge takes focus). Only the
        // window's own blur means the OS moved focus to another window/panel.
        if (event.target !== window) return;
        traceWindowsEmojiInput('window-blur', null, view, singleLine);
        // A generic blur from switching language, an IME panel, Alt+Tab, or a
        // notification must never start an emoji session or move the caret.
        if (!emojiBridgeActiveRef.current) return;
        // Do not steal focus after Windows opens a system panel. The picker has
        // already selected CodeMirror's contenteditable as its text target.
        // While that native panel is visible, CodeMirror reports itself as blurred.
        // React would otherwise apply every local draft back into the unfocused
        // view and replace its DOM text target, which makes Windows stop inserting
        // after the first couple of emoji. Resume on window focus below.
        suspendExternalSyncRef.current = true;
        if (emojiBridgeActiveRef.current) {
          // Do NOT confirm an emoji panel here. A window blur while the bridge is
          // armed is NOT proof the emoji picker opened — pressing the Windows key
          // (Start menu), Win+Space (language switch), or alt-tab blur the window
          // too. Setting emojiPanelConfirmed=true here made handleWindowFocus skip
          // its restore, so the caret stayed trapped in the hidden bridge forever
          // and every following key/backspace went there instead of the note.
          // Real confirmation comes only from actual emoji evidence: a Period/
          // Semicolon/KeyV keyup, or text flowing into the bridge. The window-focus
          // handler restores the editor if no such evidence ever arrives.
        }
      };

      const handleWindowFocus = (event: FocusEvent) => {
        // Window's capture listener also sees focus events from every element.
        // In particular, emojiBridge.focus() used to arrive here and immediately
        // restore CodeMirror, so Windows' picker lost its native text target after
        // the first selection. Only the window itself signals that a system panel
        // has closed and the app regained focus.
        if (event.target !== window) return;
        traceWindowsEmojiInput('window-focus', null, view, singleLine);
        // The window regained focus while a bridge is armed but no real emoji/
        // clipboard panel was ever confirmed — this was a bare Windows-key press
        // (Start menu) that stole the caret. Hand focus straight back to the
        // editor instead of leaving it trapped in the hidden bridge, which forced
        // the user to click back into the note before they could keep typing.
        if (emojiBridgeActiveRef.current && !emojiPanelConfirmed) {
          suspendExternalSyncRef.current = false;
          restoreEditorFromEmojiBridge();
          return;
        }
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
      emojiBridge?.addEventListener('beforeinput', scheduleEmojiBridgeCommit);
      emojiBridge?.addEventListener('compositionend', scheduleEmojiBridgeCommit);
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
        cancelTextDragArm();
        stopCtrlDragTracking?.();
        stopNativeCtrlDoubleClickTracking?.();
        clearEmojiBridgeTimers();
        stopEmojiForensicTrace?.();
        emojiBridge?.removeEventListener('input', scheduleEmojiBridgeCommit);
        emojiBridge?.removeEventListener('beforeinput', scheduleEmojiBridgeCommit);
        emojiBridge?.removeEventListener('compositionend', scheduleEmojiBridgeCommit);
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
