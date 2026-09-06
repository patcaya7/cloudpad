import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog, save } from '@tauri-apps/plugin-dialog';
import { supabase } from './cloud/supabase';
import type { FontWeight, Note, NoteTypography } from './types/note';
import { DEFAULT_FONT_FAMILY, withEmojiFontFallback } from './types/note';
import {
  createNote,
  listAllNotes,
  listDeletedNotes,
  listNotes,
  permanentlyDeleteNote,
  restoreDeletedNote,
  setupNotes,
  softDeleteNote,
  updateNoteListOrder,
  updateNotePin,
  updateNote
} from './features/notes/note-repository';
import { syncNotes } from './features/sync/sync-service';
import { useAuthStore } from './features/auth/auth-store';
import { FindReplacePanel, type FindReplaceRequest } from './features/search/FindReplacePanel';
import { CodeMirrorNoteEditor, type CodeMirrorNoteEditorHandle } from './features/editor/CodeMirrorNoteEditor';
import {
  columnSelectionsToRanges,
  expandColumnSelectionWithArrow,
  getColumnCursorsFromOffsets,
  getColumnSelectionsFromOffsets,
  type ColumnSelection
} from './features/editor/ColumnSelectionModule';
import {
  applyMultiCursorEdit as applyMultiCursorEditFromModule,
  applyRangeSelectionEdit,
  cursorsToOffsets,
  offsetToCursor,
  normalizeMultiCursorOffsets,
  renderMultiCursorHighlight as renderMultiCursorHighlightFromModule,
  type CursorPosition
} from './features/editor/MultiCursorModule';
import {
  buildReplacementText,
  findMatchesInText,
  type SearchDirection,
  type SearchMatch,
  type SearchRange
} from './features/search/searchUtils';
import { embedImagesInContentHtml, hydrateImagesFromContentHtml } from './features/images/image-store';
import { CHANGELOG } from './features/changelog/changelog-data';
import { WhatsNewModal } from './features/changelog/WhatsNewModal';

const APP_VERSION = __APP_VERSION__;
const LAST_SEEN_VERSION_STORAGE_KEY = 'cloudpad.lastSeenVersion.v1';
const WHATS_NEW_VISIBLE_COUNT = 3;

type SyncState = 'local' | 'ready' | 'syncing' | 'synced' | 'error';

interface EditorTextSnapshot {
  nodes: Text[];
  text: string;
}

interface TextPoint {
  node: Text;
  offset: number;
}

interface FormatContextMenuState {
  open: boolean;
  x: number;
  y: number;
}

type EditorMultiLineRange = SearchRange;

type FindWindowActionPayload =
  | { action: 'find'; direction: SearchDirection; request: FindReplaceRequest }
  | { action: 'replace'; request: FindReplaceRequest }
  | { action: 'replaceAll'; request: FindReplaceRequest }
  | { action: 'formatMatches'; request: FindReplaceRequest }
  | { action: 'close' };

const FONT_OPTIONS = [
  { label: 'Google Sans Text', value: DEFAULT_FONT_FAMILY },
  { label: 'Inter', value: withEmojiFontFallback('Inter, ui-sans-serif, system-ui') },
  { label: 'Segoe UI', value: withEmojiFontFallback('"Segoe UI", Tahoma, Geneva, Verdana, sans-serif') },
  { label: 'Tahoma', value: withEmojiFontFallback('Tahoma, Geneva, Verdana, sans-serif') },
  { label: 'Georgia', value: withEmojiFontFallback('Georgia, "Times New Roman", serif') },
  { label: 'Times New Roman', value: withEmojiFontFallback('"Times New Roman", Times, serif') },
  { label: 'Courier New', value: withEmojiFontFallback('"Courier New", Courier, monospace') },
  { label: 'Kanit', value: withEmojiFontFallback('Kanit, "Segoe UI", sans-serif') },
  { label: 'Sarabun', value: withEmojiFontFallback('Sarabun, "Segoe UI", sans-serif') }
];

const SIZE_PRESETS = [
  { label: 'เล็ก', value: 14 },
  { label: 'ปกติ', value: 16 },
  { label: 'ใหญ่', value: 22 },
  { label: 'ใหญ่มาก', value: 28 }
];

const WEIGHT_OPTIONS: Array<{ label: string; value: FontWeight }> = [
  { label: 'บาง', value: '300' },
  { label: 'ปกติ', value: '400' },
  { label: 'กึ่งหนา', value: '600' },
  { label: 'หนา', value: '700' },
  { label: 'หนามาก', value: '800' }
];

const COLOR_PRESETS = ['#172033', '#dc2626', '#ea580c', '#16a34a', '#2563eb', '#7c3aed', '#db2777'];

function normalizeColorInputValue(color: string | undefined, fallback = '#172033'): string {
  const value = color?.trim();
  if (!value) return fallback;

  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const [, r, g, b] = value;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  const rgbMatch = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgbMatch) {
    const toHex = (part: string) => Math.max(0, Math.min(255, Number(part)))
      .toString(16)
      .padStart(2, '0');
    return `#${toHex(rgbMatch[1])}${toHex(rgbMatch[2])}${toHex(rgbMatch[3])}`;
  }

  return fallback;
}

const ZOOM_STORAGE_KEY = 'cloudpad.appZoom.v1';
const NOTE_ZOOM_STORAGE_KEY = 'cloudpad.noteZoom.v2';
const WINDOW_SIZE_STORAGE_KEY = 'cloudpad.windowSize.v1';
const SYNC_INTERVAL_STORAGE_KEY = 'cloudpad.syncIntervalSec.v1';
// Must match EMOJI_INPUT_BRIDGE_STORAGE_KEY in CodeMirrorNoteEditor — the editor
// reads this same flag to decide whether the Windows emoji bridge may activate.
const EMOJI_BRIDGE_STORAGE_KEY = 'cloudpad.emojiBridge.v1';
const DEFAULT_SYNC_INTERVAL_SEC = 60;
const SYNC_INTERVAL_MIN_SEC = 15;
const SYNC_INTERVAL_MAX_SEC = 3600;
const SYNC_INTERVAL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 15, label: '15 วินาที' },
  { value: 30, label: '30 วินาที' },
  { value: 60, label: '1 นาที' },
  { value: 120, label: '2 นาที' },
  { value: 300, label: '5 นาที' },
  { value: 600, label: '10 นาที' },
  { value: 1800, label: '30 นาที' },
  { value: 3600, label: '1 ชั่วโมง' }
];
const WINDOW_MIN_WIDTH = 900;
const WINDOW_MIN_HEIGHT = 600;
const FIND_WINDOW_WIDTH = 900;
const FIND_WINDOW_HEIGHT = 640;
const FIND_WINDOW_MIN_WIDTH = 600;
const FIND_WINDOW_MIN_HEIGHT = 420;
const FIND_WINDOW_GAP = 12;
const DEFAULT_APP_ZOOM = 1.3;
// 100% now means "the sheet exactly fits the pane" (the fit is applied on top of
// this), so the old 1.2 default would start everyone off with the sheet 20% wider
// than the pane and a permanent sideways scrollbar. The storage key below is
// bumped to v2 for the same reason: the number means something different now.
const DEFAULT_NOTE_ZOOM = 1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;
// The note body is laid out on a sheet of this fixed width and then scaled to fit
// the pane, so a line always breaks at the same word no matter how wide the
// window, the sidebar or the app zoom happen to be. Only the drawn size changes.
const NOTE_SHEET_WIDTH = 880;
// Keep the automatic fit inside sane bounds: unreadably small on a very narrow
// pane, or comically large on an ultrawide one. The manual "แผ่น %" control still
// scales on top of whatever the fit picks.
const NOTE_FIT_MIN = 0.4;
const NOTE_FIT_MAX = 1.6;

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 20 20" fill="none">
      <path className="file-action-icon-arrow" d="M10 3.6v8.1m0 0 3.15-3.15M10 11.7 6.85 8.55" />
      <path className="file-action-icon-tray" d="M4.9 12.95v2.35c0 .74.61 1.35 1.35 1.35h7.5c.74 0 1.35-.61 1.35-1.35v-2.35" />
    </svg>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 20 20" fill="none">
      <path className="file-action-icon-arrow" d="M10 11.7V3.6m0 0 3.15 3.15M10 3.6 6.85 6.75" />
      <path className="file-action-icon-tray" d="M4.9 12.95v2.35c0 .74.61 1.35 1.35 1.35h7.5c.74 0 1.35-.61 1.35-1.35v-2.35" />
    </svg>
  );
}

// Badge shown on each note card. 'syncing' is a live view state (a sync is in
// flight for a note that still has local edits), not a stored sync_status.
type NoteBadgeStatus = 'synced' | 'pending' | 'syncing';

const NOTE_BADGE_LABEL: Record<NoteBadgeStatus, string> = {
  synced: 'synced',
  pending: 'pending',
  syncing: 'syncing'
};

const NOTE_BADGE_TITLE: Record<NoteBadgeStatus, string> = {
  synced: 'ซิงก์แล้ว (synced)',
  pending: 'รอซิงก์ (pending)',
  syncing: 'กำลังซิงก์ขึ้น Cloud (syncing)'
};

// A note with local edits reads as 'syncing' while a sync is actually in flight,
// so the card animates live instead of sitting on a frozen-looking "pending".
function noteBadgeStatus(note: Note, syncState: SyncState): NoteBadgeStatus {
  if (note.syncStatus === 'synced') return 'synced';
  return syncState === 'syncing' ? 'syncing' : 'pending';
}

function SyncStatusIcon({ status }: { status: NoteBadgeStatus }) {
  return (
    <svg className={`sync-status-icon ${status}`} aria-hidden="true" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="2.1" />
      {status === 'synced' ? (
        <path d="m6.7 10.15 2.05 2.05 4.55-4.6" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      ) : status === 'syncing' ? (
        <path className="sync-status-icon-arc" d="M10 2.75a7.25 7.25 0 0 1 7.25 7.25" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      ) : (
        <circle className="sync-status-icon-dot" cx="10" cy="10" r="2.15" fill="currentColor" />
      )}
    </svg>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Themed replacement for the browser's native `title` tooltip. Any element with a
// `data-tooltip` attribute gets a light CloudPad-styled bubble on hover — themeable,
// multi-line, and clamped inside the window. One delegated listener covers the whole
// app, so adding a tooltip anywhere is just `data-tooltip="..."`.
function CustomTooltip() {
  const [content, setContent] = useState<{ text: string; x: number; y: number } | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const targetRef = useRef<Element | null>(null);
  const cursorRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const SHOW_DELAY_MS = 320;

    const clearTimer = () => {
      if (showTimerRef.current !== null) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    };

    const hide = () => {
      clearTimer();
      targetRef.current = null;
      setContent(null);
      setCoords(null);
    };

    const findTarget = (node: EventTarget | null): Element | null =>
      node instanceof Element ? node.closest('[data-tooltip]') : null;

    const handleOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const target = findTarget(event.target);
      if (!target) {
        if (targetRef.current) hide();
        return;
      }
      const text = target.getAttribute('data-tooltip');
      if (!text) {
        hide();
        return;
      }
      if (target === targetRef.current) return;
      targetRef.current = target;
      cursorRef.current = { x: event.clientX, y: event.clientY };
      clearTimer();
      setContent(null);
      setCoords(null);
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        setContent({ text, x: cursorRef.current.x, y: cursorRef.current.y });
      }, SHOW_DELAY_MS);
    };

    const handleMove = (event: PointerEvent) => {
      if (!targetRef.current) return;
      cursorRef.current = { x: event.clientX, y: event.clientY };
      if (findTarget(event.target) !== targetRef.current) hide();
    };

    document.addEventListener('pointerover', handleOver, true);
    document.addEventListener('pointermove', handleMove, true);
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      clearTimer();
      document.removeEventListener('pointerover', handleOver, true);
      document.removeEventListener('pointermove', handleMove, true);
      document.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!content || !tipRef.current) return;
    const MARGIN = 8;
    const OFFSET_X = 14;
    const OFFSET_Y = 16;
    const rect = tipRef.current.getBoundingClientRect();
    let left = content.x + OFFSET_X;
    let top = content.y + OFFSET_Y;
    if (left + rect.width > window.innerWidth - MARGIN) {
      left = window.innerWidth - rect.width - MARGIN;
    }
    if (top + rect.height > window.innerHeight - MARGIN) {
      top = content.y - rect.height - OFFSET_Y;
    }
    setCoords({
      left: Math.max(MARGIN, left),
      top: Math.max(MARGIN, top)
    });
  }, [content]);

  if (!content) return null;

  return createPortal(
    <div
      ref={tipRef}
      className="custom-tooltip"
      role="tooltip"
      style={{
        left: coords ? coords.left : content.x + 14,
        top: coords ? coords.top : content.y + 16,
        visibility: coords ? 'visible' : 'hidden'
      }}
    >
      {content.text}
    </div>,
    document.body
  );
}

// Read a persisted zoom value, falling back to the intended default when the key
// is missing/blank. (Number(null) === 0 is finite, which previously forced 50%.)
function readStoredZoom(key: string, fallback: number): number {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? clamp(value, ZOOM_MIN, ZOOM_MAX) : fallback;
}

// Auto-sync interval (seconds). Kept within safe bounds so a corrupt/hand-edited
// value can never hammer the server or effectively disable syncing.
function readStoredSyncIntervalSec(): number {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SYNC_INTERVAL_STORAGE_KEY) : null;
  if (raw === null || raw.trim() === '') return DEFAULT_SYNC_INTERVAL_SEC;
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.round(clamp(value, SYNC_INTERVAL_MIN_SEC, SYNC_INTERVAL_MAX_SEC))
    : DEFAULT_SYNC_INTERVAL_SEC;
}

function formatSyncInterval(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600} ชั่วโมง`;
  if (sec % 60 === 0) return `${sec / 60} นาที`;
  return `${sec} วินาที`;
}

function compareNotesForList(a: Note, b: Note): number {
  const pinnedDiff = Number(b.isPinned) - Number(a.isPinned);
  if (pinnedDiff !== 0) return pinnedDiff;
  const orderDiff = a.noteOrder - b.noteOrder;
  if (orderDiff !== 0) return orderDiff;
  return b.updatedAt.localeCompare(a.updatedAt);
}

function sortNotesForList(notes: Note[]): Note[] {
  return [...notes].sort(compareNotesForList);
}

function getNoteInitial(note: Note): string {
  const title = (note.title || 'ไม่มีชื่อ').normalize('NFKC').trim();
  const initial = Array.from(title).find((character) => /[\p{L}\p{N}]/u.test(character));
  return initial && /[a-z]/i.test(initial) ? initial.toUpperCase() : initial ?? '#';
}

function compareNoteInitials(a: string, b: string): number {
  const rank = (value: string) => {
    if (/^[A-Z]$/i.test(value)) return 0;
    if (/^[\u0E00-\u0E7F]$/.test(value)) return 1;
    if (/^\d$/.test(value)) return 2;
    return 3;
  };
  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) return rankDiff;
  return a.localeCompare(b, ['en', 'th'], { sensitivity: 'base', numeric: true });
}

function renderSearchHighlight(text: string, query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return text;

  const normalizedText = text.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = normalizedText.indexOf(normalizedQuery);

  while (matchIndex >= 0) {
    if (matchIndex > cursor) parts.push(text.slice(cursor, matchIndex));
    const matchEnd = matchIndex + normalizedQuery.length;
    parts.push(
      <mark className="note-search-highlight" key={`${matchIndex}-${matchEnd}`}>
        {text.slice(matchIndex, matchEnd)}
      </mark>
    );
    cursor = matchEnd;
    matchIndex = normalizedText.indexOf(normalizedQuery, cursor);
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : text;
}

function normalizeEditorRanges(ranges: EditorMultiLineRange[]): EditorMultiLineRange[] {
  const sortedRanges = ranges
    .map((range) => ({
      start: Math.min(range.start, range.end),
      end: Math.max(range.start, range.end)
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const mergedRanges: EditorMultiLineRange[] = [];
  for (const range of sortedRanges) {
    const previous = mergedRanges[mergedRanges.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      mergedRanges.push({ ...range });
    }
  }
  return mergedRanges;
}

function normalizeSelectedLines(lines: number[]): number[] {
  return Array.from(new Set(lines.filter((line) => Number.isInteger(line) && line >= 0))).sort((a, b) => a - b);
}

function promoteNoteToTopInList(
  notes: Note[],
  noteId: string,
  patch: Partial<Note>,
  updatedAt: string
): Note[] {
  const existingNote = notes.find((note) => note.id === noteId);
  if (!existingNote) return notes;

  const promotedNote: Note = {
    ...existingNote,
    ...patch,
    updatedAt,
    syncStatus: 'pending'
  };

  if (existingNote.isPinned || promotedNote.isPinned) {
    return notes.map((note) =>
      note.id === noteId
        ? {
            ...promotedNote,
            noteOrder: existingNote.noteOrder
          }
        : note
    );
  }

  const pinnedNotes = notes.filter((note) => note.id !== noteId && note.isPinned);
  const unpinnedNotes = notes.filter((note) => note.id !== noteId && !note.isPinned);
  const reorderedNotes = [...pinnedNotes, promotedNote, ...unpinnedNotes];

  return reorderedNotes.map((note, index) => ({
    ...note,
    noteOrder: (index + 1) * 1000
  }));
}

function moveNoteBefore(notes: Note[], sourceId: string, targetId: string): Note[] {
  if (sourceId === targetId) return notes;
  const source = notes.find((note) => note.id === sourceId);
  const targetIndex = notes.findIndex((note) => note.id === targetId);
  if (!source || targetIndex < 0) return notes;

  const withoutSource = notes.filter((note) => note.id !== sourceId);
  const nextTargetIndex = withoutSource.findIndex((note) => note.id === targetId);
  if (nextTargetIndex < 0) return notes;

  return [
    ...withoutSource.slice(0, nextTargetIndex),
    source,
    ...withoutSource.slice(nextTargetIndex)
  ];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}

function escapePlainTextForEditor(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeImportedTextForEditor(value: string): string {
  return escapePlainTextForEditor(normalizePastedText(value));
}

// No \s* after the closing comment: combineTitleAndBodyHtml never inserts a
// separator there, and body content legitimately starting with whitespace (e.g.
// a leading space) must not be eaten when the prefix is stripped back off — doing
// so desyncs contentHtml from the plain-text value and silently drops all of the
// body's formatting (parseBoldRangesFromHtml's text-match safety check then fails).
const TITLE_HTML_METADATA_PATTERN = /^<!--cloudpad-title-html:([A-Za-z0-9+/=]+)-->/;

function encodeTitleHtmlMetadata(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
}

function decodeTitleHtmlMetadata(value: string): string | null {
  try {
    const binary = window.atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function getBodyContentHtml(contentHtml: string): string {
  return contentHtml.replace(TITLE_HTML_METADATA_PATTERN, '');
}

function getTitleContentHtml(contentHtml: string, title: string): string {
  const match = contentHtml.match(TITLE_HTML_METADATA_PATTERN);
  const decoded = match?.[1] ? decodeTitleHtmlMetadata(match[1]) : null;
  return decoded ?? escapePlainTextForEditor(title);
}

function combineTitleAndBodyHtml(titleHtml: string, bodyHtml: string): string {
  const cleanBodyHtml = getBodyContentHtml(bodyHtml);
  // Embedding the referenced image bitmaps here makes them part of content_html,
  // which already syncs to the cloud — so pasted images follow the note across
  // devices with no extra storage setup.
  return embedImagesInContentHtml(
    `<!--cloudpad-title-html:${encodeTitleHtmlMetadata(titleHtml)}-->${cleanBodyHtml}`
  );
}

async function readImportedTextFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  const utf8ReplacementCount = (utf8Text.match(/\uFFFD/g) ?? []).length;

  if (utf8ReplacementCount === 0) return utf8Text;

  try {
    const thaiText = new TextDecoder('windows-874', { fatal: false }).decode(buffer);
    const thaiReplacementCount = (thaiText.match(/\uFFFD/g) ?? []).length;
    return thaiReplacementCount < utf8ReplacementCount ? thaiText : utf8Text;
  } catch {
    return utf8Text;
  }
}

function filenameToNoteTitle(filename: string): string {
  const withoutExtension = filename.replace(/\.(txt|text|log|md)$/i, '').trim();
  return withoutExtension || 'นำเข้าไฟล์ข้อความ';
}

function safeTextFilename(title: string): string {
  const safeName = title.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ');
  return `${safeName || 'cloudpad-note'}.txt`;
}

function buildUniqueExportFiles(notes: Note[]): Array<{ filename: string; content: string }> {
  const usedNames = new Set<string>();

  return notes.map((note) => {
    const originalFilename = safeTextFilename(note.title);
    const baseName = originalFilename.replace(/\.txt$/i, '');
    let filename = originalFilename;
    let copyNumber = 2;

    while (usedNames.has(filename.toLocaleLowerCase())) {
      filename = `${baseName} (${copyNumber}).txt`;
      copyNumber += 1;
    }

    usedNames.add(filename.toLocaleLowerCase());
    return { filename, content: note.content };
  });
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function getFindWindowInitialPlacement(): Promise<{ x: number; y: number }> {
  const mainWindow = getCurrentWindow();
  const [mainPosition, mainSize, monitor, scaleFactor] = await Promise.all([
    mainWindow.outerPosition(),
    mainWindow.outerSize(),
    currentMonitor(),
    mainWindow.scaleFactor()
  ]);
  const effectiveScale = monitor?.scaleFactor || scaleFactor || 1;
  const appX = mainPosition.x / effectiveScale;
  const appY = mainPosition.y / effectiveScale;
  const appWidth = mainSize.width / effectiveScale;
  const appHeight = mainSize.height / effectiveScale;

  const workAreaX = monitor ? monitor.workArea.position.x / effectiveScale : 0;
  const workAreaY = monitor ? monitor.workArea.position.y / effectiveScale : 0;
  const workAreaWidth = monitor ? monitor.workArea.size.width / effectiveScale : window.screen.availWidth;
  const workAreaHeight = monitor ? monitor.workArea.size.height / effectiveScale : window.screen.availHeight;
  const workRight = workAreaX + workAreaWidth;
  const workBottom = workAreaY + workAreaHeight;

  const rightSideX = appX + appWidth + FIND_WINDOW_GAP;
  const insideAppX = appX + appWidth - FIND_WINDOW_WIDTH - FIND_WINDOW_GAP;
  const fallbackX = workRight - FIND_WINDOW_WIDTH - FIND_WINDOW_GAP;
  const x = rightSideX + FIND_WINDOW_WIDTH <= workRight - FIND_WINDOW_GAP
    ? rightSideX
    : Math.max(workAreaX + FIND_WINDOW_GAP, Math.min(insideAppX, fallbackX));

  const preferredY = appY + Math.min(72, Math.max(0, appHeight - FIND_WINDOW_HEIGHT) / 2);
  const y = Math.max(
    workAreaY + FIND_WINDOW_GAP,
    Math.min(preferredY, workBottom - FIND_WINDOW_HEIGHT - FIND_WINDOW_GAP)
  );

  return {
    x: Math.round(x),
    y: Math.round(y)
  };
}

function readStoredWindowSize(): { width: number; height: number } | null {
  try {
    const rawValue = localStorage.getItem(WINDOW_SIZE_STORAGE_KEY);
    if (!rawValue) return null;
    const parsed = JSON.parse(rawValue) as { width?: unknown; height?: unknown };
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;

    return {
      width: Math.round(clamp(width, WINDOW_MIN_WIDTH, Math.max(WINDOW_MIN_WIDTH, window.screen.availWidth || width))),
      height: Math.round(clamp(height, WINDOW_MIN_HEIGHT, Math.max(WINDOW_MIN_HEIGHT, window.screen.availHeight || height)))
    };
  } catch {
    return null;
  }
}

function writeCurrentWindowSize(): void {
  if (typeof window === 'undefined') return;

  const width = Math.round(Math.max(WINDOW_MIN_WIDTH, window.outerWidth || window.innerWidth));
  const height = Math.round(Math.max(WINDOW_MIN_HEIGHT, window.outerHeight || window.innerHeight));
  localStorage.setItem(WINDOW_SIZE_STORAGE_KEY, JSON.stringify({ width, height }));
}

function fontCommandValue(fontFamily: string): string {
  return fontFamily.split(',')[0]?.trim().replace(/^"|"$/g, '') || fontFamily;
}

function normalizePastedText(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function noteHtmlForEditor(note: Note): string {
  if (!note.contentHtml) return normalizeImportedTextForEditor(note.content);
  if (note.contentHtml === escapeHtml(note.content)) {
    return normalizeImportedTextForEditor(note.content);
  }
  return note.contentHtml;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function selectionFontSize(editor: HTMLElement, fallback: number): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return fallback;

  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return fallback;

  let targetNode: Node | null = range.startContainer;
  if (targetNode.nodeType === Node.TEXT_NODE) {
    targetNode = targetNode.parentElement;
  }
  const targetElement = targetNode instanceof Element ? targetNode : editor;

  const fontSize = Number.parseFloat(window.getComputedStyle(targetElement).fontSize);
  return Number.isFinite(fontSize) ? clamp(Math.round(fontSize), 10, 100) : fallback;
}

function wrapRangeWithStyle(range: Range, style: Partial<CSSStyleDeclaration>): HTMLSpanElement {
  const span = document.createElement('span');
  Object.assign(span.style, style);

  span.appendChild(range.extractContents());
  range.insertNode(span);
  span.normalize();
  return span;
}

function SmoothSyncStatus({
  state,
  message,
  transient = false
}: {
  state: SyncState | 'saved';
  message: string;
  transient?: boolean;
}) {
  // The pill sizes itself to its text via CSS (inline-flex + width: fit-content).
  // No JS measurement / explicit width lock: that approach could freeze a too-wide
  // width (e.g. measured before the font loaded, or off a longer transient message),
  // leaving the border overflowing the text. Natural sizing always hugs the current
  // message exactly and re-fits on font load, zoom, or message change.
  return (
    <span
      className={`status-pill ${state} ${transient ? 'transient' : ''}`}
      aria-live="polite"
      aria-atomic="true"
      title={message}
    >
      <span className="status-pill-message">{message}</span>
    </span>
  );
}

export default function App() {
  const auth = useAuthStore();
  const [notes, setNotes] = useState<Note[]>([]);
  const [deletedNotes, setDeletedNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [initialFilter, setInitialFilter] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('local');
  const [syncMessage, setSyncMessage] = useState('กำลังเตรียมข้อมูลในเครื่อง...');
  const [isSaving, setIsSaving] = useState(false);
  const [lastSavedMessage, setLastSavedMessage] = useState<string | null>(null);
  const [appZoom, setAppZoom] = useState(() => readStoredZoom(ZOOM_STORAGE_KEY, DEFAULT_APP_ZOOM));
  const [noteZoom, setNoteZoom] = useState(() => readStoredZoom(NOTE_ZOOM_STORAGE_KEY, DEFAULT_NOTE_ZOOM));
  // Live width of the pane the note sheet is drawn in; drives the automatic fit.
  const [noteCanvasWidth, setNoteCanvasWidth] = useState(0);
  const [syncIntervalSec, setSyncIntervalSec] = useState(() => readStoredSyncIntervalSec());
  const [syncIntervalDraft, setSyncIntervalDraft] = useState(() => readStoredSyncIntervalSec());
  const [emojiBridgeEnabled, setEmojiBridgeEnabled] = useState(() => {
    try {
      return localStorage.getItem(EMOJI_BRIDGE_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [activeFormatTarget, setActiveFormatTarget] = useState<'title' | 'body'>('body');
  const [formatContextMenu, setFormatContextMenu] = useState<FormatContextMenuState>({
    open: false,
    x: 0,
    y: 0
  });
  const [isFileActionsOpen, setIsFileActionsOpen] = useState(false);
  const [isTrashOpen, setIsTrashOpen] = useState(false);
  const [isExportPickerOpen, setIsExportPickerOpen] = useState(false);
  const [exportSelectedIds, setExportSelectedIds] = useState<string[]>([]);
  const [pendingDeleteNote, setPendingDeleteNote] = useState<Note | null>(null);
  const [pendingPermanentDeleteNote, setPendingPermanentDeleteNote] = useState<Note | null>(null);
  const [isClearTrashConfirmOpen, setIsClearTrashConfirmOpen] = useState(false);
  const [isNoteSelectMode, setIsNoteSelectMode] = useState(false);
  const [bulkSelectedNoteIds, setBulkSelectedNoteIds] = useState<string[]>([]);
  const [isBulkDeleteConfirmOpen, setIsBulkDeleteConfirmOpen] = useState(false);
  const [isTrashSelectMode, setIsTrashSelectMode] = useState(false);
  const [bulkSelectedTrashIds, setBulkSelectedTrashIds] = useState<string[]>([]);
  const [isBulkPermanentDeleteConfirmOpen, setIsBulkPermanentDeleteConfirmOpen] = useState(false);
  const [isWhatsNewOpen, setIsWhatsNewOpen] = useState(false);
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  const [dragOverNoteId, setDragOverNoteId] = useState<string | null>(null);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [findInitialQuery, setFindInitialQuery] = useState('');
  const [findResultMessage, setFindResultMessage] = useState('');
  const [isGoToLineOpen, setIsGoToLineOpen] = useState(false);
  const [goToLineInput, setGoToLineInput] = useState('1');
  const [fontSizeInput, setFontSizeInput] = useState('20');
  const [fontWeightInput, setFontWeightInput] = useState<FontWeight>('400');
  const [textColorInput, setTextColorInput] = useState('#172033');
  const [fontFamilyInput, setFontFamilyInput] = useState(DEFAULT_FONT_FAMILY);
  const [selectedLines, setSelectedLines] = useState<number[]>([]);
  const [multiCursorOffsets, setMultiCursorOffsets] = useState<number[]>([]);
  const [cursors, setCursors] = useState<CursorPosition[]>([]);
  const [columnSelections, setColumnSelections] = useState<ColumnSelection[]>([]);
  const [isBoldButtonActive, setIsBoldButtonActive] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [authView, setAuthView] = useState<'login' | 'reset-request' | 'reset-confirm'>('login');
  const [resetOtp, setResetOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const editorRef = useRef<HTMLDivElement | null>(null);
  const noteCanvasRef = useRef<HTMLDivElement | null>(null);
  const codeEditorRef = useRef<CodeMirrorNoteEditorHandle | null>(null);
  const titleCodeEditorRef = useRef<CodeMirrorNoteEditorHandle | null>(null);
  const activeFormatTargetRef = useRef<'title' | 'body'>('body');
  const formatMenuRef = useRef<HTMLDivElement | null>(null);
  const codeEditorValueRef = useRef('');
  const titleHtmlRef = useRef('');
  const isApplyingWeightFromToolbarRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const noteListRef = useRef<HTMLDivElement | null>(null);
  const notesRef = useRef<Note[]>([]);
  const activeFindSelectionRef = useRef<SearchRange | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const multiLineSelectionRef = useRef<EditorMultiLineRange[]>([]);
  const selectedLinesRef = useRef<number[]>([]);
  const lineSelectionAnchorRef = useRef<number | null>(null);
  const multiCursorOffsetsRef = useRef<number[]>([]);
  const cursorsRef = useRef<CursorPosition[]>([]);
  const columnSelectionsRef = useRef<ColumnSelection[]>([]);
  const columnSelectionAnchorOffsetRef = useRef<number | null>(null);
  const columnSelectionAnchorCursorRef = useRef<CursorPosition | null>(null);
  const columnSelectionFocusCursorRef = useRef<CursorPosition | null>(null);
  const isColumnSelectingRef = useRef(false);
  const pointerDragRef = useRef<{
    sourceId: string;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const skipNoteClickRef = useRef(false);
  const editorSaveTimeoutRef = useRef<number | null>(null);
  const editorUndoStackRef = useRef<string[]>([]);
  const editorRedoStackRef = useRef<string[]>([]);
  const editorDraftRef = useRef<{
    noteId: string;
    userId: string | null;
    content: string;
    contentHtml: string;
  } | null>(null);
  // Throttles the expensive "resort + re-render the whole sidebar" step that follows
  // a title edit. The DB write itself still happens on every keystroke (no data-loss
  // window is introduced) — only the sidebar reflow is batched to stop rapid title
  // typing from re-rendering the full note list on every keypress.
  const pendingTitlePromoteRef = useRef<{ noteId: string; patch: Partial<Note>; updatedAt: string } | null>(null);
  const titlePromoteTimeoutRef = useRef<number | null>(null);
  // Last time the user changed note content (title or body). The periodic
  // background sync checks this so it never fires mid-keystroke and stutters typing.
  const lastEditActivityAtRef = useRef(0);

  const canUseNotes = !auth.cloudEnabled || Boolean(auth.user);
  const selectedNote = notes.find((note) => note.id === selectedId) ?? notes[0] ?? null;
  const appStyle = { '--app-zoom': String(appZoom) } as CSSProperties;
  const noteFit = noteCanvasWidth > 0
    ? clamp(noteCanvasWidth / NOTE_SHEET_WIDTH, NOTE_FIT_MIN, NOTE_FIT_MAX)
    : 1;
  const selectedNoteStyle: CSSProperties | undefined = selectedNote
    ? {
        '--note-zoom': String(noteZoom),
        '--note-fit': noteFit.toFixed(4),
        '--note-sheet-width': `${NOTE_SHEET_WIDTH}px`,
        color: selectedNote.textColor.toLowerCase() === '#172033' ? '#0f172a' : selectedNote.textColor,
        fontFamily: selectedNote.fontFamily,
        fontSize: `${selectedNote.fontSize}px`,
        fontWeight: selectedNote.fontWeight
      } as CSSProperties
    : undefined;
  const titleInputStyle: CSSProperties | undefined = selectedNote
    ? {
        color: selectedNote.textColor.toLowerCase() === '#172033' ? '#050b18' : selectedNote.textColor,
        fontFamily: selectedNote.fontFamily,
        fontSize: `${clamp(Math.round(selectedNote.fontSize * 1.35), 22, 52)}px`,
        fontWeight: selectedNote.fontWeight === '300' || selectedNote.fontWeight === '400' ? '800' : selectedNote.fontWeight
      }
    : undefined;
  const noteIsBoldActive = selectedNote ? selectedNote.fontWeight === '700' || selectedNote.fontWeight === '800' : false;
  const isBoldActive = isBoldButtonActive;

  const alphabetEntries = useMemo(() => {
    const counts = new Map<string, number>();
    notes.forEach((note) => {
      const initial = getNoteInitial(note);
      counts.set(initial, (counts.get(initial) ?? 0) + 1);
    });
    return Array.from(counts, ([initial, count]) => ({ initial, count }))
      .sort((a, b) => compareNoteInitials(a.initial, b.initial));
  }, [notes]);

  const queryMatchedNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return notes;
    return notes.filter((note) =>
      `${note.title} ${note.content}`.toLocaleLowerCase().includes(normalizedQuery)
    );
  }, [notes, query]);

  const filteredNotes = useMemo(() => {
    if (!initialFilter) return queryMatchedNotes;
    return queryMatchedNotes.filter((note) => getNoteInitial(note) === initialFilter);
  }, [initialFilter, queryMatchedNotes]);

  useEffect(() => {
    if (initialFilter && !alphabetEntries.some((entry) => entry.initial === initialFilter)) {
      setInitialFilter(null);
    }
  }, [alphabetEntries, initialFilter]);

  const scrollNoteIntoView = useCallback((noteId: string) => {
    window.requestAnimationFrame(() => {
      const list = noteListRef.current;
      if (!list) return;
      const card = Array.from(list.querySelectorAll<HTMLElement>('[data-note-id]'))
        .find((element) => element.dataset.noteId === noteId);
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, []);

  const reloadNotes = useCallback(async (nextSelectedId?: string | null) => {
    // A reload is about to replace the whole in-memory note list with fresh data
    // from disk/cloud. Discard (don't apply) any still-pending title resort so it
    // can't reapply a stale patch on top of the freshly reloaded notes — the title
    // itself was already persisted to the DB when the keystroke happened, so nothing
    // is lost, this only cancels a now-redundant in-memory resort.
    if (titlePromoteTimeoutRef.current) {
      window.clearTimeout(titlePromoteTimeoutRef.current);
      titlePromoteTimeoutRef.current = null;
    }
    pendingTitlePromoteRef.current = null;

    if (auth.cloudEnabled && !auth.user) {
      setNotes([]);
      setDeletedNotes([]);
      setSelectedId(null);
      return;
    }

    const listOptions = {
      userId: auth.user?.id ?? null,
      includeUnassigned: !auth.cloudEnabled
    };
    const [nextNotes, nextDeletedNotes] = await Promise.all([
      listNotes(listOptions),
      listDeletedNotes(listOptions)
    ]);
    // Unpack image bitmaps that arrived embedded in content_html (e.g. from a
    // cloud sync originating on another device) into this device's image store,
    // BEFORE the notes render so their tokens draw as pictures, not placeholders.
    nextNotes.forEach((note) => hydrateImagesFromContentHtml(note.contentHtml));
    setNotes(sortNotesForList(nextNotes));
    setDeletedNotes(nextDeletedNotes);
    setSelectedId((currentId) => {
      if (nextSelectedId !== undefined) return nextSelectedId;
      if (currentId && nextNotes.some((note) => note.id === currentId)) return currentId;
      return nextNotes[0]?.id ?? null;
    });
  }, [auth.cloudEnabled, auth.user]);

  // The note list keeps an optimistic 'pending' badge the moment an edit is saved
  // (see promoteNoteToTopInList). That marker can outlive the real state: if a sync
  // uploads the note while the save is still awaiting its DB write, the badge is set
  // back to 'pending' after the sync already reported 'synced'. Nothing then clears
  // it — a later sync finds nothing to do and returns 0/0 — so the card sat on
  // "pending" forever. Reconcile against the DB (the source of truth) after every
  // sync, regardless of the counts.
  const reconcileSyncStatuses = useCallback(async () => {
    const stored = await listAllNotes();
    const statusById = new Map(stored.map((note) => [note.id, note.syncStatus]));
    setNotes((current) => {
      let changed = false;
      const next = current.map((note) => {
        const actual = statusById.get(note.id);
        if (!actual || actual === note.syncStatus) return note;
        changed = true;
        return { ...note, syncStatus: actual };
      });
      return changed ? next : current;
    });
  }, []);

  const handleSync = useCallback(async () => {
    if (!auth.cloudEnabled) {
      setSyncState('local');
      setSyncMessage('Local-only · ยังไม่ได้ตั้งค่า Supabase');
      return;
    }
    if (!auth.user) {
      setSyncState('local');
      setSyncMessage('Local-only · เข้าสู่ระบบเพื่อซิงก์ Cloud');
      return;
    }

    try {
      setSyncState('syncing');
      setSyncMessage('กำลังซิงก์...');
      const result = await syncNotes();
      setSyncState(result.ok ? 'synced' : 'local');
      setSyncMessage(result.message);
      // Only reload when the cloud actually sent down newer content. Uploading our
      // own pending edits does not change local content, so a full reload there just
      // re-renders the whole note list and makes the UI stutter while typing.
      if (result.downloadedCount > 0) {
        await reloadNotes();
      } else {
        // Never blanket-flip every 'pending' card to 'synced' here: a note edited
        // during this sync is genuinely still pending and would show a false
        // "synced". Read the real per-note status back instead.
        await reconcileSyncStatuses();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';
      setSyncState('error');
      setSyncMessage(`ซิงก์ไม่สำเร็จ: ${message}`);
    }
  }, [auth.cloudEnabled, auth.user, reconcileSyncStatuses, reloadNotes]);

  const handleSaveSyncInterval = useCallback(() => {
    const next = Math.round(clamp(syncIntervalDraft, SYNC_INTERVAL_MIN_SEC, SYNC_INTERVAL_MAX_SEC));
    setSyncIntervalDraft(next);
    setSyncIntervalSec(next);
    try {
      localStorage.setItem(SYNC_INTERVAL_STORAGE_KEY, String(next));
    } catch {
      // localStorage may be unavailable (private mode); the in-memory value still applies.
    }
    // Restarting the sync loop is handled by the effect that depends on syncIntervalSec:
    // it clears the pending timer and ticks immediately, so the new cadence is exact and
    // takes effect right away. Sync now for instant confirmation the setting landed.
    void handleSync();
    setAccountMessage(`บันทึกแล้ว · ซิงก์อัตโนมัติทุก ${formatSyncInterval(next)}`);
  }, [handleSync, syncIntervalDraft]);

  useEffect(() => {
    async function boot() {
      await setupNotes();
      await reloadNotes();
    }
    void boot();
  }, [reloadNotes]);

  useEffect(() => {
    if (!auth.cloudEnabled) {
      setSyncState('local');
      setSyncMessage('Local-only · ยังไม่ได้ตั้งค่า Supabase');
      return;
    }
    if (auth.loading) return;
    if (!auth.user) {
      setSyncState('ready');
      setSyncMessage('Cloud พร้อมใช้งาน · เข้าสู่ระบบเพื่อเริ่มซิงก์');
    }
  }, [auth.cloudEnabled, auth.loading, auth.user]);

  useEffect(() => {
    // Wait for auth to resolve before deciding the cloud status, otherwise a
    // logged-in refresh briefly shows "เข้าสู่ระบบเพื่อเริ่มซิงก์" before syncing.
    if (auth.cloudEnabled && auth.loading) return;
    if (!auth.user) {
      if (auth.cloudEnabled) {
        setSyncState('ready');
        setSyncMessage('Cloud พร้อมใช้งาน · เข้าสู่ระบบเพื่อเริ่มซิงก์');
      }
      return;
    }

    // Background sync must never land mid-keystroke — its state updates (syncing/
    // synced pill, note-list refresh) re-render enough of the tree to visibly
    // stutter active typing. If the user edited very recently, push this tick back
    // a few seconds and recheck, instead of syncing immediately or waiting a full
    // interval.
    const SYNC_INTERVAL_MS = syncIntervalSec * 1000;
    const SYNC_IDLE_THRESHOLD_MS = 2000;
    const SYNC_RETRY_MS = 3000;
    let timeoutId: number | null = null;

    // Schedule the next tick at exactly the configured interval, measured from the
    // moment a sync actually ran — so short retries caused by active typing never
    // drift the cadence. Re-runs of this effect (e.g. after saving a new interval)
    // clear the pending timer and restart from now, so the change applies at once.
    const scheduleNext = (delayMs: number) => {
      timeoutId = window.setTimeout(tick, delayMs);
    };

    function tick() {
      const idleFor = Date.now() - lastEditActivityAtRef.current;
      if (idleFor < SYNC_IDLE_THRESHOLD_MS) {
        scheduleNext(SYNC_RETRY_MS);
        return;
      }
      void handleSync();
      scheduleNext(SYNC_INTERVAL_MS);
    }

    tick();
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [auth.cloudEnabled, auth.loading, auth.user, handleSync, syncIntervalSec]);

  useEffect(() => {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(appZoom));
  }, [appZoom]);

  useEffect(() => {
    localStorage.setItem(NOTE_ZOOM_STORAGE_KEY, String(noteZoom));
  }, [noteZoom]);

  // Track the pane the sheet is drawn in. clientWidth is a LAYOUT width, so it is
  // already free of the app-zoom transform — exactly the number the sheet's own
  // scale has to be derived from. `scrollbar-gutter: stable` on the pane keeps a
  // vertical scrollbar from changing this width, so there is no observer loop.
  useEffect(() => {
    const canvas = noteCanvasRef.current;
    if (!canvas) {
      setNoteCanvasWidth(0);
      return;
    }
    const measure = () => {
      const width = canvas.clientWidth;
      if (width > 0) setNoteCanvasWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [selectedNote?.id]);

  useEffect(() => {
    // Show the What's New panel automatically once per version bump — but never
    // on someone's very first launch (nothing to compare against yet), only when
    // we can see they already had an older version installed.
    const lastSeenVersion = localStorage.getItem(LAST_SEEN_VERSION_STORAGE_KEY);
    if (lastSeenVersion && lastSeenVersion !== APP_VERSION) {
      setIsWhatsNewOpen(true);
    }
    localStorage.setItem(LAST_SEEN_VERSION_STORAGE_KEY, APP_VERSION);
  }, []);

  useEffect(() => {
    if (!formatContextMenu.open) return;

    const closeMenu = () => {
      setFormatContextMenu((current) => (current.open ? { ...current, open: false } : current));
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (formatMenuRef.current?.contains(event.target as Node)) return;
      closeMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };

    const handleWindowChange = () => {
      closeMenu();
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('scroll', handleWindowChange, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('scroll', handleWindowChange, true);
    };
  }, [formatContextMenu.open]);

  useEffect(() => {
    if (activeFormatTarget === 'title') {
      setIsBoldButtonActive(noteIsBoldActive);
    }
  }, [activeFormatTarget, noteIsBoldActive]);

  useEffect(() => {
    if (!formatContextMenu.open || !formatMenuRef.current) return;

    const menuRect = formatMenuRef.current.getBoundingClientRect();
    const nextX = Math.min(
      Math.max(12, formatContextMenu.x),
      Math.max(12, window.innerWidth - menuRect.width - 12)
    );
    const nextY = Math.min(
      Math.max(12, formatContextMenu.y),
      Math.max(12, window.innerHeight - menuRect.height - 12)
    );

    if (nextX !== formatContextMenu.x || nextY !== formatContextMenu.y) {
      setFormatContextMenu((current) => ({ ...current, x: nextX, y: nextY }));
    }
  }, [formatContextMenu]);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  const promoteSavedNote = useCallback((noteId: string, patch: Partial<Note>, updatedAt: string) => {
    const nextNotes = promoteNoteToTopInList(notesRef.current, noteId, patch, updatedAt);
    notesRef.current = nextNotes;
    setNotes(nextNotes);
    void updateNoteListOrder(nextNotes.map((note) => note.id));
  }, []);

  useEffect(() => {
    if (selectedNote) {
      setFontSizeInput(String(selectedNote.fontSize));
      setFontWeightInput(selectedNote.fontWeight);
      setTextColorInput(normalizeColorInputValue(selectedNote.textColor));
      setFontFamilyInput(selectedNote.fontFamily);
      titleHtmlRef.current = getTitleContentHtml(selectedNote.contentHtml, selectedNote.title);
    }
    setFormatContextMenu((current) => (current.open ? { ...current, open: false } : current));
    const cssWithHighlights = CSS as unknown as { highlights?: { delete: (name: string) => void } };
    cssWithHighlights.highlights?.delete('cloudpad-saved-selection');
    cssWithHighlights.highlights?.delete('cloudpad-multi-line-selection');
    cssWithHighlights.highlights?.delete('cloudpad-multi-cursor');
    cssWithHighlights.highlights?.delete('cloudpad-primary-multi-cursor');
    multiLineSelectionRef.current = [];
    selectedLinesRef.current = [];
    lineSelectionAnchorRef.current = null;
    multiCursorOffsetsRef.current = [];
    cursorsRef.current = [];
    columnSelectionsRef.current = [];
    columnSelectionAnchorOffsetRef.current = null;
    columnSelectionAnchorCursorRef.current = null;
    columnSelectionFocusCursorRef.current = null;
    isColumnSelectingRef.current = false;
    editorUndoStackRef.current = [];
    editorRedoStackRef.current = [];
    setSelectedLines([]);
    setMultiCursorOffsets([]);
    setCursors([]);
    setColumnSelections([]);
  }, [selectedNote?.id, selectedNote?.fontSize, selectedNote?.fontWeight]);

  useEffect(() => {
    if (!selectedNote) {
      codeEditorValueRef.current = '';
      return;
    }
    codeEditorValueRef.current = selectedNote.content;
  }, [selectedNote?.id, selectedNote?.contentHtml, selectedNote?.content]);

  useEffect(() => {
    if (!lastSavedMessage) return;
    const timeoutId = window.setTimeout(() => setLastSavedMessage(null), 2400);
    return () => window.clearTimeout(timeoutId);
  }, [lastSavedMessage]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    const appWindow = getCurrentWindow();
    const storedSize = readStoredWindowSize();
    if (storedSize) {
      void appWindow.setSize(new LogicalSize(storedSize.width, storedSize.height));
    }

    let resizeTimeoutId: number | null = null;
    const queueSaveWindowSize = () => {
      if (resizeTimeoutId) window.clearTimeout(resizeTimeoutId);
      resizeTimeoutId = window.setTimeout(writeCurrentWindowSize, 180);
    };

    const unlistenResizePromise = appWindow.onResized(queueSaveWindowSize);

    window.addEventListener('resize', queueSaveWindowSize);
    window.addEventListener('beforeunload', writeCurrentWindowSize);

    return () => {
      if (resizeTimeoutId) window.clearTimeout(resizeTimeoutId);
      window.removeEventListener('resize', queueSaveWindowSize);
      window.removeEventListener('beforeunload', writeCurrentWindowSize);
      void unlistenResizePromise.then((unlisten) => unlisten());
    };
  }, []);

  async function handleCreateNote() {
    if (!canUseNotes) {
      setAccountMessage('กรุณาเข้าสู่ระบบก่อนสร้างหรือดูโน้ต');
      return;
    }

    const note = await createNote({
      title: 'โน้ตใหม่',
      content: '',
      contentHtml: '',
      userId: auth.user?.id ?? null
    });
    await reloadNotes(note.id);
  }

  async function handleImportTextFile(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    if (!canUseNotes) {
      setAccountMessage('กรุณาเข้าสู่ระบบก่อนนำเข้าไฟล์ข้อความ');
      return;
    }

    let lastImportedId: string | null = null;
    const failedFiles: string[] = [];

    for (const file of files) {
      try {
        const text = await readImportedTextFile(file);
        const note = await createNote({
          title: filenameToNoteTitle(file.name),
          content: text,
          contentHtml: normalizeImportedTextForEditor(text),
          userId: auth.user?.id ?? null
        });
        lastImportedId = note.id;
      } catch {
        failedFiles.push(file.name);
      }
    }

    if (lastImportedId) {
      await reloadNotes(lastImportedId);
    }

    const importedCount = files.length - failedFiles.length;
    if (importedCount > 0) {
      setLastSavedMessage(`นำเข้าสำเร็จ ${importedCount} ไฟล์`);
    }
    if (failedFiles.length > 0) {
      setAccountMessage(`นำเข้าไม่สำเร็จ ${failedFiles.length} ไฟล์: ${failedFiles.join(', ')}`);
    }
  }

  function openExportPicker() {
    if (!selectedNote) return;
    setExportSelectedIds([selectedNote.id]);
    setIsExportPickerOpen(true);
  }

  function toggleExportSelection(noteId: string) {
    setExportSelectedIds((currentIds) =>
      currentIds.includes(noteId)
        ? currentIds.filter((id) => id !== noteId)
        : [...currentIds, noteId]
    );
  }

  async function handleExportTextFiles() {
    if (exportSelectedIds.length === 0) return;

    try {
      flushTitlePromote();
      await flushEditorDraft();
      const selectedIds = new Set(exportSelectedIds);
      const exportNotes = notesRef.current.filter((note) => selectedIds.has(note.id));
      if (exportNotes.length === 0) return;
      const exportFiles = buildUniqueExportFiles(exportNotes);

      if (isTauriRuntime()) {
        if (exportFiles.length === 1) {
          const targetPath = await save({
            defaultPath: exportFiles[0].filename,
            filters: [{ name: 'Text', extensions: ['txt'] }]
          });
          if (!targetPath) return;

          await invoke('write_text_file', {
            path: targetPath,
            content: exportFiles[0].content
          });
        } else {
          const targetFolder = await openDialog({
            directory: true,
            multiple: false,
            title: `เลือกโฟลเดอร์สำหรับบันทึก ${exportFiles.length} ไฟล์`
          });
          if (typeof targetFolder !== 'string') return;

          await invoke('write_text_files', {
            folder: targetFolder,
            files: exportFiles.map((file) => [file.filename, file.content])
          });
        }
      } else {
        exportFiles.forEach((file) => {
          const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const downloadLink = document.createElement('a');
          downloadLink.href = url;
          downloadLink.download = file.filename;
          document.body.appendChild(downloadLink);
          downloadLink.click();
          downloadLink.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
      }

      setIsExportPickerOpen(false);
      setExportSelectedIds([]);
      setLastSavedMessage(`ส่งออกสำเร็จ ${exportFiles.length} ไฟล์`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ส่งออกไฟล์ไม่สำเร็จ';
      setAccountMessage(`ส่งออกไฟล์ไม่สำเร็จ: ${message}`);
    }
  }

  async function handleDeleteNote() {
    if (!selectedNote) return;
    setPendingDeleteNote(selectedNote);
  }

  function toggleNoteSelectMode() {
    setIsNoteSelectMode((current) => !current);
    setBulkSelectedNoteIds([]);
  }

  function toggleBulkNoteSelection(noteId: string) {
    setBulkSelectedNoteIds((currentIds) =>
      currentIds.includes(noteId)
        ? currentIds.filter((id) => id !== noteId)
        : [...currentIds, noteId]
    );
  }

  async function confirmBulkDeleteNotes() {
    if (bulkSelectedNoteIds.length === 0) return;
    const deletedIds = new Set(bulkSelectedNoteIds);
    for (const noteId of bulkSelectedNoteIds) {
      await softDeleteNote(noteId);
    }
    const remaining = notes.filter((note) => !deletedIds.has(note.id));
    setIsBulkDeleteConfirmOpen(false);
    setBulkSelectedNoteIds([]);
    setIsNoteSelectMode(false);
    setLastSavedMessage(`ย้ายโน้ต ${deletedIds.size} รายการไปถังขยะแล้ว`);
    await reloadNotes(remaining[0]?.id ?? null);
  }

  async function handleToggleNotePin(note: Note) {
    const nextPinned = !note.isPinned;
    const updatedNotes = sortNotesForList(
      notes.map((item) => (item.id === note.id ? { ...item, isPinned: nextPinned } : item))
    ).map((item, index) => ({ ...item, noteOrder: (index + 1) * 1000 }));

    setNotes(updatedNotes);
    setLastSavedMessage(nextPinned ? 'ปักหมุดโน้ตแล้ว' : 'ยกเลิกปักหมุดโน้ตแล้ว');
    await updateNotePin(note.id, nextPinned);
    await updateNoteListOrder(updatedNotes.map((item) => item.id));
  }

  async function handleDropNote(targetNote: Note) {
    if (!draggingNoteId || draggingNoteId === targetNote.id) {
      setDraggingNoteId(null);
      setDragOverNoteId(null);
      return;
    }

    const draggingNote = notes.find((note) => note.id === draggingNoteId);
    if (!draggingNote) {
      setDraggingNoteId(null);
      setDragOverNoteId(null);
      return;
    }

    const movedNotes = moveNoteBefore(notes, draggingNoteId, targetNote.id).map((note, index) => ({
      ...note,
      isPinned: note.id === draggingNoteId ? targetNote.isPinned : note.isPinned,
      noteOrder: (index + 1) * 1000
    }));

    setNotes(movedNotes);
    setDraggingNoteId(null);
    setDragOverNoteId(null);

    if (draggingNote.isPinned !== targetNote.isPinned) {
      await updateNotePin(draggingNoteId, targetNote.isPinned);
    }
    await updateNoteListOrder(movedNotes.map((note) => note.id));
    setLastSavedMessage('จัดลำดับรายการโน้ตแล้ว');
  }

  function getNoteIdAtPoint(clientX: number, clientY: number): string | null {
    const element = document.elementFromPoint(clientX, clientY);
    const noteCard = element?.closest<HTMLElement>('[data-note-id]');
    return noteCard?.dataset.noteId ?? null;
  }

  function beginPointerNoteDrag(event: ReactPointerEvent<HTMLDivElement>, note: Note) {
    if (event.button !== 0) return;
    pointerDragRef.current = {
      sourceId: note.id,
      startX: event.clientX,
      startY: event.clientY,
      active: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updatePointerNoteDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = pointerDragRef.current;
    if (!dragState) return;

    const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
    if (!dragState.active && distance < 6) return;

    if (!dragState.active) {
      dragState.active = true;
      skipNoteClickRef.current = true;
      setDraggingNoteId(dragState.sourceId);
    }

    event.preventDefault();
    const targetId = getNoteIdAtPoint(event.clientX, event.clientY);
    setDragOverNoteId(targetId && targetId !== dragState.sourceId ? targetId : null);
  }

  function finishPointerNoteDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = pointerDragRef.current;
    if (!dragState) return;

    pointerDragRef.current = null;
    if (!dragState.active) return;

    event.preventDefault();
    const targetId = getNoteIdAtPoint(event.clientX, event.clientY) ?? dragOverNoteId;
    const targetNote = targetId ? notes.find((note) => note.id === targetId) : null;

    if (targetNote && targetNote.id !== dragState.sourceId) {
      void handleDropNote(targetNote);
    } else {
      setDraggingNoteId(null);
      setDragOverNoteId(null);
    }

    window.requestAnimationFrame(() => {
      skipNoteClickRef.current = false;
    });
  }

  async function confirmDeleteNote() {
    if (!pendingDeleteNote) return;
    await softDeleteNote(pendingDeleteNote.id);
    const remaining = notes.filter((note) => note.id !== pendingDeleteNote.id);
    setPendingDeleteNote(null);
    setLastSavedMessage('ย้ายโน้ตไปถังขยะแล้ว');
    await reloadNotes(remaining[0]?.id ?? null);
  }

  async function handleRestoreNote(noteId: string) {
    await restoreDeletedNote(noteId);
    setLastSavedMessage('กู้คืนโน้ตจากถังขยะแล้ว');
    await reloadNotes(noteId);
  }

  async function handleRestoreAllNotes() {
    if (deletedNotes.length === 0) return;
    const restoredCount = deletedNotes.length;
    for (const note of deletedNotes) {
      await restoreDeletedNote(note.id);
    }
    setLastSavedMessage(`กู้คืนโน้ต ${restoredCount} รายการแล้ว`);
    await reloadNotes();
  }

  async function confirmPermanentDeleteNote() {
    if (!pendingPermanentDeleteNote) return;

    try {
      if (supabase && auth.user && pendingPermanentDeleteNote.cloudId) {
        const { error } = await supabase
          .from('notes')
          .delete()
          .eq('id', pendingPermanentDeleteNote.cloudId)
          .eq('user_id', auth.user.id);

        if (error) throw error;
      }

      await permanentlyDeleteNote(pendingPermanentDeleteNote.id);
      setPendingPermanentDeleteNote(null);
      setLastSavedMessage('ลบโน้ตถาวรแล้ว');
      await reloadNotes();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ลบถาวรไม่สำเร็จ';
      setAccountMessage(`ลบถาวรไม่สำเร็จ: ${message}`);
    }
  }

  async function confirmClearTrash() {
    if (deletedNotes.length === 0) {
      setIsClearTrashConfirmOpen(false);
      return;
    }

    try {
      if (supabase && auth.user) {
        const cloudIds = deletedNotes
          .map((note) => note.cloudId)
          .filter((cloudId): cloudId is string => Boolean(cloudId));

        if (cloudIds.length > 0) {
          const { error } = await supabase
            .from('notes')
            .delete()
            .in('id', cloudIds)
            .eq('user_id', auth.user.id);

          if (error) throw error;
        }
      }

      for (const note of deletedNotes) {
        await permanentlyDeleteNote(note.id);
      }

      setDeletedNotes([]);
      setIsClearTrashConfirmOpen(false);
      setLastSavedMessage('ลบโน้ตในถังขยะทั้งหมดแล้ว');
      await reloadNotes();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ลบทั้งหมดไม่สำเร็จ';
      setAccountMessage(`ลบทั้งหมดไม่สำเร็จ: ${message}`);
    }
  }

  function toggleTrashSelectMode() {
    setIsTrashSelectMode((current) => !current);
    setBulkSelectedTrashIds([]);
  }

  function toggleTrashPanel() {
    setIsTrashOpen((open) => !open);
  }

  function toggleBulkTrashSelection(noteId: string) {
    setBulkSelectedTrashIds((currentIds) =>
      currentIds.includes(noteId)
        ? currentIds.filter((id) => id !== noteId)
        : [...currentIds, noteId]
    );
  }

  async function handleRestoreSelectedTrash() {
    if (bulkSelectedTrashIds.length === 0) return;
    const restoredCount = bulkSelectedTrashIds.length;
    for (const noteId of bulkSelectedTrashIds) {
      await restoreDeletedNote(noteId);
    }
    setBulkSelectedTrashIds([]);
    setIsTrashSelectMode(false);
    setLastSavedMessage(`กู้คืนโน้ต ${restoredCount} รายการแล้ว`);
    await reloadNotes();
  }

  async function confirmBulkPermanentDeleteTrash() {
    if (bulkSelectedTrashIds.length === 0) return;
    const targetIds = new Set(bulkSelectedTrashIds);
    const targets = deletedNotes.filter((note) => targetIds.has(note.id));

    try {
      if (supabase && auth.user) {
        const cloudIds = targets
          .map((note) => note.cloudId)
          .filter((cloudId): cloudId is string => Boolean(cloudId));

        if (cloudIds.length > 0) {
          const { error } = await supabase
            .from('notes')
            .delete()
            .in('id', cloudIds)
            .eq('user_id', auth.user.id);

          if (error) throw error;
        }
      }

      for (const note of targets) {
        await permanentlyDeleteNote(note.id);
      }

      setIsBulkPermanentDeleteConfirmOpen(false);
      setBulkSelectedTrashIds([]);
      setIsTrashSelectMode(false);
      setLastSavedMessage(`ลบถาวร ${targets.length} รายการแล้ว`);
      await reloadNotes();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ลบถาวรไม่สำเร็จ';
      setAccountMessage(`ลบถาวรไม่สำเร็จ: ${message}`);
    }
  }

  const patchSelectedNote = useCallback(async (
    patch: Partial<Pick<Note, 'title' | 'content' | 'contentHtml'> & NoteTypography>
  ) => {
    if (!selectedNote) return;
    setIsSaving(true);
    setLastSavedMessage(null);
    const updatedAt = new Date().toISOString();
    promoteSavedNote(selectedNote.id, patch, updatedAt);

    try {
      await updateNote(selectedNote.id, {
        ...patch,
        userId: selectedNote.userId ?? auth.user?.id ?? null
      });
    } finally {
      setIsSaving(false);
    }
  }, [auth.user?.id, promoteSavedNote, selectedNote]);

  // Apply a pending title resort/re-render immediately (e.g. right before switching
  // notes) so the sidebar never shows a stale title/order for longer than necessary.
  const flushTitlePromote = useCallback(() => {
    if (titlePromoteTimeoutRef.current) {
      window.clearTimeout(titlePromoteTimeoutRef.current);
      titlePromoteTimeoutRef.current = null;
    }
    const pending = pendingTitlePromoteRef.current;
    if (!pending) return;
    pendingTitlePromoteRef.current = null;
    promoteSavedNote(pending.noteId, pending.patch, pending.updatedAt);
  }, [promoteSavedNote]);

  // Title changes fast (every keystroke). The DB write happens immediately here —
  // exactly as before, so there is no new data-loss window — but the expensive
  // "resort the whole note list + re-render every sidebar card" step is batched to
  // fire once shortly after typing pauses, instead of on every keypress.
  const patchSelectedNoteTitleThrottled = useCallback((patch: Partial<Pick<Note, 'title' | 'contentHtml'>>) => {
    if (!selectedNote) return;
    const updatedAt = new Date().toISOString();
    lastEditActivityAtRef.current = Date.now();

    void updateNote(selectedNote.id, {
      ...patch,
      userId: selectedNote.userId ?? auth.user?.id ?? null
    });

    pendingTitlePromoteRef.current = { noteId: selectedNote.id, patch, updatedAt };
    if (titlePromoteTimeoutRef.current) window.clearTimeout(titlePromoteTimeoutRef.current);
    titlePromoteTimeoutRef.current = window.setTimeout(() => {
      titlePromoteTimeoutRef.current = null;
      flushTitlePromote();
    }, 250);
  }, [flushTitlePromote, selectedNote]);

  const flushEditorDraft = useCallback(async () => {
    if (editorSaveTimeoutRef.current) {
      window.clearTimeout(editorSaveTimeoutRef.current);
      editorSaveTimeoutRef.current = null;
    }

    const draft = editorDraftRef.current;
    if (!draft) return;
    editorDraftRef.current = null;

    await updateNote(draft.noteId, {
      content: draft.content,
      contentHtml: draft.contentHtml,
      userId: draft.userId
    });

    const pendingDraft = editorDraftRef.current as { noteId: string } | null;
    if (pendingDraft?.noteId === draft.noteId) return;

    const updatedAt = new Date().toISOString();
    promoteSavedNote(draft.noteId, {
      content: draft.content,
      contentHtml: draft.contentHtml
    }, updatedAt);
  }, [promoteSavedNote]);

  const getEditorPlainText = useCallback(() => {
    return codeEditorRef.current?.getValue()
      ?? codeEditorValueRef.current
      ?? editorRef.current?.innerText.replace(/\n$/, '')
      ?? selectedNote?.content
      ?? '';
  }, [selectedNote?.content]);

  const getEditorContentHtml = useCallback(() => {
    const editorHtml = codeEditorRef.current?.getHtml();
    if (editorHtml !== undefined) {
      return combineTitleAndBodyHtml(
        titleCodeEditorRef.current?.getHtml() ?? titleHtmlRef.current,
        editorHtml
      );
    }
    const text = getEditorPlainText();
    return combineTitleAndBodyHtml(
      titleCodeEditorRef.current?.getHtml() ?? titleHtmlRef.current,
      escapePlainTextForEditor(text)
    );
  }, [getEditorPlainText]);

  const handleManualSave = useCallback(async () => {
    if (!selectedNote) return;
    if (editorSaveTimeoutRef.current) {
      window.clearTimeout(editorSaveTimeoutRef.current);
      editorSaveTimeoutRef.current = null;
    }

    const editorContent = getEditorPlainText();
    const editorContentHtml = getEditorContentHtml();
    editorDraftRef.current = null;

    setIsSaving(true);
    setLastSavedMessage(null);
    try {
      await updateNote(selectedNote.id, {
        title: selectedNote.title,
        content: editorContent,
        contentHtml: editorContentHtml,
        fontSize: selectedNote.fontSize,
        textColor: selectedNote.textColor,
        fontWeight: selectedNote.fontWeight,
        fontFamily: selectedNote.fontFamily,
        userId: selectedNote.userId ?? auth.user?.id ?? null
      });
      promoteSavedNote(selectedNote.id, {
        content: editorContent,
        contentHtml: editorContentHtml
      }, new Date().toISOString());
      setLastSavedMessage('บันทึกแล้ว');
    } finally {
      setIsSaving(false);
    }

    // Ctrl+S means "save it now", not "save it locally and wait up to a full sync
    // interval". Without this the card sat on 'pending' until the next background
    // tick even though the user had explicitly asked to save. Fire-and-forget: the
    // sync's own state updates drive the badge (pending → syncing → synced).
    void handleSync();
  }, [auth.user?.id, getEditorContentHtml, getEditorPlainText, handleSync, promoteSavedNote, selectedNote]);

  const clearSavedSelectionHighlight = useCallback(() => {
    const cssWithHighlights = CSS as unknown as { highlights?: { delete: (name: string) => void } };
    cssWithHighlights.highlights?.delete('cloudpad-saved-selection');
  }, []);

  const getActiveFormatTarget = useCallback((): 'title' | 'body' => {
    const activeElement = document.activeElement;
    if (activeElement instanceof Element) {
      if (activeElement.closest('.title-editor-shell')) return 'title';
      if (activeElement.closest('.codemirror-editor-shell')) return 'body';
    }
    if (titleCodeEditorRef.current?.hasFocus()) return 'title';
    if (codeEditorRef.current?.hasFocus()) return 'body';
    return activeFormatTargetRef.current;
  }, []);

  const preserveActiveCodeMirrorSelection = useCallback(() => {
    if (getActiveFormatTarget() === 'title') {
      titleCodeEditorRef.current?.preserveSelection();
      return;
    }
    codeEditorRef.current?.preserveSelection();
  }, [getActiveFormatTarget]);

  const closeFormatContextMenu = useCallback(() => {
    setFormatContextMenu((current) => (current.open ? { ...current, open: false } : current));
  }, []);

  const openFormatContextMenu = useCallback((
    event: ReactMouseEvent<HTMLElement>,
    target: 'title' | 'body'
  ) => {
    if (!selectedNote) return;

    event.preventDefault();
    event.stopPropagation();

    activeFormatTargetRef.current = target;
    setActiveFormatTarget(target);

    if (target === 'title') {
      titleCodeEditorRef.current?.preserveSelection();
    } else {
      codeEditorRef.current?.preserveSelection();
    }

    setFormatContextMenu({
      open: true,
      x: event.clientX,
      y: event.clientY
    });
  }, [selectedNote]);

  const showSavedSelectionHighlight = useCallback(() => {
    const range = savedRangeRef.current;
    if (!range || range.collapsed) {
      clearSavedSelectionHighlight();
      return;
    }

    const cssWithHighlights = CSS as unknown as { highlights?: { set: (name: string, highlight: unknown) => void } };
    const highlightConstructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!cssWithHighlights.highlights || !highlightConstructor) return;

    cssWithHighlights.highlights.set('cloudpad-saved-selection', new highlightConstructor(range.cloneRange()));
  }, [clearSavedSelectionHighlight]);

  const saveEditorSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !editorRef.current) return;
    const range = selection.getRangeAt(0);
    if (editorRef.current.contains(range.commonAncestorContainer)) {
      clearSavedSelectionHighlight();
      setIsBoldButtonActive(document.queryCommandState('bold'));
      if (range.collapsed) {
        savedRangeRef.current = null;
        return;
      }
      savedRangeRef.current = range.cloneRange();
      setFontSizeInput(String(selectionFontSize(editorRef.current, selectedNote?.fontSize ?? 16)));
    }
  }, [clearSavedSelectionHighlight, selectedNote?.fontSize]);

  const restoreEditorSelection = useCallback(() => {
    const selection = window.getSelection();
    const range = savedRangeRef.current;
    if (!selection || !range || !editorRef.current) return;
    selection.removeAllRanges();
    selection.addRange(range);
    editorRef.current.focus();
  }, []);

  const syncRichEditorContent = useCallback(() => {
    if (!selectedNote) return;
    lastEditActivityAtRef.current = Date.now();
    const text = getEditorPlainText();
    const html = getEditorContentHtml();
    editorDraftRef.current = {
      noteId: selectedNote.id,
      userId: selectedNote.userId ?? auth.user?.id ?? null,
      content: text,
      contentHtml: html
    };

    if (editorSaveTimeoutRef.current) {
      window.clearTimeout(editorSaveTimeoutRef.current);
    }
    editorSaveTimeoutRef.current = window.setTimeout(() => {
      void flushEditorDraft();
    }, 420);
  }, [auth.user?.id, flushEditorDraft, getEditorContentHtml, getEditorPlainText, selectedNote]);

  const recordEditorUndoSnapshot = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const html = editor.innerHTML;
    const stack = editorUndoStackRef.current;
    if (stack[stack.length - 1] !== html) {
      stack.push(html);
      if (stack.length > 80) stack.shift();
    }
    editorRedoStackRef.current = [];
  }, []);

  const restoreEditorHistorySnapshot = useCallback((html: string) => {
    const editor = editorRef.current;
    if (!editor) return;

    editor.innerHTML = html;
    selectedLinesRef.current = [];
    lineSelectionAnchorRef.current = null;
    multiLineSelectionRef.current = [];
    multiCursorOffsetsRef.current = [];
    cursorsRef.current = [];
    columnSelectionsRef.current = [];
    columnSelectionAnchorOffsetRef.current = null;
    columnSelectionAnchorCursorRef.current = null;
    columnSelectionFocusCursorRef.current = null;
    isColumnSelectingRef.current = false;
    setSelectedLines([]);
    setMultiCursorOffsets([]);
    setCursors([]);
    setColumnSelections([]);

    const cssWithHighlights = CSS as unknown as { highlights?: { delete: (name: string) => void } };
    cssWithHighlights.highlights?.delete('cloudpad-saved-selection');
    cssWithHighlights.highlights?.delete('cloudpad-multi-line-selection');
    cssWithHighlights.highlights?.delete('cloudpad-multi-cursor');
    cssWithHighlights.highlights?.delete('cloudpad-primary-multi-cursor');

    editor.focus();
    syncRichEditorContent();
  }, [syncRichEditorContent]);

  const handleEditorUndo = useCallback(() => {
    const editor = editorRef.current;
    const previousHtml = editorUndoStackRef.current.pop();
    if (!editor || previousHtml === undefined) return false;

    editorRedoStackRef.current.push(editor.innerHTML);
    restoreEditorHistorySnapshot(previousHtml);
    return true;
  }, [restoreEditorHistorySnapshot]);

  const handleEditorRedo = useCallback(() => {
    const editor = editorRef.current;
    const nextHtml = editorRedoStackRef.current.pop();
    if (!editor || nextHtml === undefined) return false;

    editorUndoStackRef.current.push(editor.innerHTML);
    restoreEditorHistorySnapshot(nextHtml);
    return true;
  }, [restoreEditorHistorySnapshot]);

  const applyRichCommand = useCallback((command: string, value?: string) => {
    if (!selectedNote) return;
    restoreEditorSelection();
    document.execCommand(command, false, value);
    saveEditorSelection();
    syncRichEditorContent();
  }, [restoreEditorSelection, saveEditorSelection, selectedNote, syncRichEditorContent]);

  const applyFontFamilyToSelection = useCallback((fontFamily: string) => {
    if (!selectedNote) return;
    setFontFamilyInput(fontFamily);

    if (getActiveFormatTarget() === 'title') {
      const appliedToSelection = titleCodeEditorRef.current?.setSelectionFontFamily(fontFamily);
      if (appliedToSelection) return;
      void patchSelectedNote({ fontFamily });
      return;
    }

    if (codeEditorRef.current) {
      const appliedToSelection = codeEditorRef.current.setSelectionFontFamily(fontFamily);
      if (appliedToSelection) return;
      void patchSelectedNote({ fontFamily });
      return;
    }

    restoreEditorSelection();
    document.execCommand('fontName', false, fontCommandValue(fontFamily));
    saveEditorSelection();

    if (editorRef.current) {
      void patchSelectedNote({
        content: editorRef.current.innerText.replace(/\n$/, ''),
        contentHtml: editorRef.current.innerHTML,
        fontFamily
      });
    } else {
      void patchSelectedNote({ fontFamily });
    }
  }, [getActiveFormatTarget, patchSelectedNote, restoreEditorSelection, saveEditorSelection, selectedNote]);

  const applyFontSizeToSelection = useCallback((fontSize: number) => {
    if (!selectedNote) return;
    const nextSize = clamp(Math.round(fontSize), 10, 100);
    setFontSizeInput(String(nextSize));

    if (getActiveFormatTarget() === 'title') {
      const appliedToSelection = titleCodeEditorRef.current?.setSelectionFontSize(nextSize);
      if (appliedToSelection) return;
      void patchSelectedNote({ fontSize: nextSize });
      return;
    }

    if (codeEditorRef.current) {
      const appliedToSelection = codeEditorRef.current.setSelectionFontSize(nextSize);
      if (appliedToSelection) return;
      void patchSelectedNote({ fontSize: nextSize });
      return;
    }

    restoreEditorSelection();
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const editor = editorRef.current;

    if (
      !selection ||
      !range ||
      selection.isCollapsed ||
      !editor ||
      !editor.contains(range.commonAncestorContainer)
    ) {
      void patchSelectedNote({ fontSize: nextSize });
      return;
    }

    const span = wrapRangeWithStyle(range, { fontSize: `${nextSize}px` });

    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(span);
    selection.addRange(nextRange);
    saveEditorSelection();
    syncRichEditorContent();
  }, [getActiveFormatTarget, patchSelectedNote, restoreEditorSelection, saveEditorSelection, selectedNote, syncRichEditorContent]);

  const commitFontSizeInput = useCallback(() => {
    const parsedSize = Number(fontSizeInput);
    if (!Number.isFinite(parsedSize)) {
      setFontSizeInput(String(selectedNote?.fontSize ?? 16));
      return;
    }
    applyFontSizeToSelection(parsedSize);
  }, [applyFontSizeToSelection, fontSizeInput, selectedNote?.fontSize]);

  const applyWeightToSelection = useCallback((weight: FontWeight) => {
    setFontWeightInput(weight);

    if (getActiveFormatTarget() === 'title') {
      const appliedToSelection = titleCodeEditorRef.current?.setSelectionWeight(weight);
      if (appliedToSelection) {
        setIsBoldButtonActive(weight === '600' || weight === '700' || weight === '800');
        return;
      }
      void patchSelectedNote({ fontWeight: weight });
      return;
    }

    if (codeEditorRef.current) {
      const hasSelection = Boolean(codeEditorRef.current.getSelectionRange());
      if (hasSelection) {
        isApplyingWeightFromToolbarRef.current = true;
        const applied = codeEditorRef.current.setSelectionWeight(weight);
        window.setTimeout(() => {
          isApplyingWeightFromToolbarRef.current = false;
        }, 0);
        if (applied) {
          setIsBoldButtonActive(weight === '600' || weight === '700' || weight === '800');
          return;
        }
        isApplyingWeightFromToolbarRef.current = false;
      }

      void patchSelectedNote({ fontWeight: weight });
      setIsBoldButtonActive(weight === '600' || weight === '700' || weight === '800');
      return;
    }

    if (weight === '700' || weight === '800') {
      applyRichCommand('bold');
      return;
    }

    restoreEditorSelection();
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      document.execCommand('bold', false);
      saveEditorSelection();
      syncRichEditorContent();
      return;
    }

    const range = selection.getRangeAt(0);
    const span = wrapRangeWithStyle(range, { fontWeight: weight });

    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(span);
    selection.addRange(nextRange);
    saveEditorSelection();
    syncRichEditorContent();
  }, [applyRichCommand, getActiveFormatTarget, patchSelectedNote, restoreEditorSelection, saveEditorSelection, syncRichEditorContent]);

  const applyTextColor = useCallback((color: string) => {
    if (!selectedNote) return;
    const nextColor = normalizeColorInputValue(color, selectedNote.textColor);
    setTextColorInput(nextColor);

    if (getActiveFormatTarget() === 'title') {
      const appliedToSelection = titleCodeEditorRef.current?.setSelectionColor(nextColor);
      if (appliedToSelection) return;
      void patchSelectedNote({ textColor: nextColor });
      return;
    }

    if (codeEditorRef.current) {
      const appliedToSelection = codeEditorRef.current.setSelectionColor(nextColor);
      if (appliedToSelection) return;
      void patchSelectedNote({ textColor: nextColor });
      return;
    }

    applyRichCommand('foreColor', nextColor);
  }, [applyRichCommand, getActiveFormatTarget, patchSelectedNote, selectedNote]);

  const toggleBoldFormatting = useCallback(() => {
    if (!selectedNote) return;

    if (getActiveFormatTarget() === 'title') {
      if (titleCodeEditorRef.current?.toggleBold()) return;
      void patchSelectedNote({ fontWeight: noteIsBoldActive ? '400' : '700' });
      setIsBoldButtonActive(!noteIsBoldActive);
      return;
    }

    if (codeEditorRef.current) {
      codeEditorRef.current.toggleBold();
      return;
    }

    restoreEditorSelection();
    document.execCommand('bold');
    setIsBoldButtonActive(document.queryCommandState('bold'));
    saveEditorSelection();
    syncRichEditorContent();
  }, [getActiveFormatTarget, noteIsBoldActive, patchSelectedNote, restoreEditorSelection, saveEditorSelection, selectedNote, syncRichEditorContent]);

  const insertPlainTextAtSelection = useCallback((text: string) => {
    if (!editorRef.current) return;

    restoreEditorSelection();
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const normalizedText = normalizePastedText(text);

    if (!selection || !range || !editorRef.current.contains(range.commonAncestorContainer)) {
      editorRef.current.focus();
      editorRef.current.appendChild(document.createTextNode(normalizedText));
    } else {
      range.deleteContents();
      const textNode = document.createTextNode(normalizedText);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    saveEditorSelection();
    syncRichEditorContent();
  }, [restoreEditorSelection, saveEditorSelection, syncRichEditorContent]);

  const isEditorKeyboardTarget = useCallback((target: EventTarget | null): boolean => {
    if (!editorRef.current) return false;
    if (target instanceof Node && editorRef.current.contains(target)) return true;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    return editorRef.current.contains(selection.getRangeAt(0).commonAncestorContainer);
  }, []);

  const focusLineInEditor = useCallback((lineNumber: number) => {
    if (codeEditorRef.current) {
      codeEditorRef.current.goToLine(lineNumber);
      return;
    }

    const editor = editorRef.current;
    if (!editor) return;

    const nextLine = Math.max(1, Math.floor(lineNumber));
    const text = editor.innerText.replace(/\n$/, '');
    const lines = text.split('\n');
    const targetLine = Math.min(nextLine, Math.max(lines.length, 1));
    const targetOffset = lines.slice(0, targetLine - 1).reduce((total, line) => total + line.length + 1, 0);

    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    let node = walker.nextNode();
    const selection = window.getSelection();
    const range = document.createRange();

    while (node) {
      const nodeLength = node.textContent?.length ?? 0;
      if (consumed + nodeLength >= targetOffset) {
        range.setStart(node, Math.max(0, Math.min(targetOffset - consumed, nodeLength)));
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
        editor.focus();
        saveEditorSelection();
        return;
      }
      consumed += nodeLength;
      node = walker.nextNode();
    }

    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    editor.focus();
    saveEditorSelection();
  }, [saveEditorSelection]);

  const openGoToLine = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    let currentLine = 1;

    if (editor && selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      const range = selection.getRangeAt(0);
      const beforeRange = document.createRange();
      beforeRange.selectNodeContents(editor);
      beforeRange.setEnd(range.startContainer, range.startOffset);
      currentLine = beforeRange.toString().split('\n').length;
    }

    setGoToLineInput(String(Math.max(1, currentLine)));
    setIsGoToLineOpen(true);
  }, []);

  const confirmGoToLine = useCallback(() => {
    const parsedLine = Number(goToLineInput);
    if (!Number.isFinite(parsedLine)) return;
    setIsGoToLineOpen(false);
    focusLineInEditor(parsedLine);
  }, [focusLineInEditor, goToLineInput]);

  const collectEditorTextSnapshot = useCallback((): EditorTextSnapshot | null => {
    const editor = editorRef.current;
    if (!editor) return null;

    const nodes: Text[] = [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      nodes.push(node as Text);
      node = walker.nextNode();
    }

    return {
      nodes,
      text: nodes.map((textNode) => textNode.data).join('')
    };
  }, []);

  const locateTextOffset = useCallback((nodes: Text[], offset: number): TextPoint | null => {
    if (nodes.length === 0) return null;
    let consumed = 0;

    for (const textNode of nodes) {
      const nodeLength = textNode.data.length;
      const nextConsumed = consumed + nodeLength;
      if (offset <= nextConsumed) {
        return { node: textNode, offset: Math.max(0, Math.min(nodeLength, offset - consumed)) };
      }
      consumed = nextConsumed;
    }

    const lastNode = nodes[nodes.length - 1];
    return { node: lastNode, offset: lastNode.data.length };
  }, []);

  const createEditorRangeFromOffsets = useCallback((nodes: Text[], start: number, end: number): Range | null => {
    const startPoint = locateTextOffset(nodes, start);
    const endPoint = locateTextOffset(nodes, end);
    if (!startPoint || !endPoint) return null;

    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    return range;
  }, [locateTextOffset]);

  const renderMultiLineSelectionHighlight = useCallback((ranges: EditorMultiLineRange[]) => {
    const cssWithHighlights = CSS as unknown as {
      highlights?: {
        set: (name: string, highlight: unknown) => void;
        delete: (name: string) => void;
      };
    };
    const highlightConstructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!cssWithHighlights.highlights || !highlightConstructor) return;

    const snapshot = collectEditorTextSnapshot();
    if (!snapshot || ranges.length === 0) {
      cssWithHighlights.highlights.delete('cloudpad-multi-line-selection');
      return;
    }

    const domRanges = ranges
      .map((range) => createEditorRangeFromOffsets(snapshot.nodes, range.start, range.end))
      .filter((range): range is Range => range !== null && !range.collapsed);

    if (domRanges.length === 0) {
      cssWithHighlights.highlights.delete('cloudpad-multi-line-selection');
      return;
    }

    cssWithHighlights.highlights.set('cloudpad-multi-line-selection', new highlightConstructor(...domRanges));
  }, [collectEditorTextSnapshot, createEditorRangeFromOffsets]);

  const renderMultiCursorHighlight = useCallback((offsets: number[]) => {
    const snapshot = collectEditorTextSnapshot();
    renderMultiCursorHighlightFromModule({
      cursors: snapshot ? offsets.map((offset) => offsetToCursor(snapshot.text, offset)) : undefined,
      offsets,
      snapshot,
      createEditorRangeFromOffsets
    });
  }, [collectEditorTextSnapshot, createEditorRangeFromOffsets]);

  const applyMultiCursorOffsets = useCallback((offsets: number[]) => {
    const snapshot = collectEditorTextSnapshot();
    const maxOffset = snapshot?.text.length ?? 0;
    const nextOffsets = normalizeMultiCursorOffsets(offsets, maxOffset);
    const nextCursors = snapshot ? nextOffsets.map((offset) => offsetToCursor(snapshot.text, offset)) : [];

    multiCursorOffsetsRef.current = nextOffsets;
    cursorsRef.current = nextCursors;
    setMultiCursorOffsets(nextOffsets);
    setCursors(nextCursors);
    savedRangeRef.current = null;
    renderMultiCursorHighlightFromModule({
      cursors: nextCursors,
      offsets: nextOffsets,
      snapshot,
      createEditorRangeFromOffsets
    });
  }, [collectEditorTextSnapshot, renderMultiCursorHighlight]);

  const clearMultiCursorSelection = useCallback(() => {
    multiCursorOffsetsRef.current = [];
    cursorsRef.current = [];
    setMultiCursorOffsets([]);
    setCursors([]);
    const cssWithHighlights = CSS as unknown as { highlights?: { delete: (name: string) => void } };
    cssWithHighlights.highlights?.delete('cloudpad-multi-cursor');
    cssWithHighlights.highlights?.delete('cloudpad-primary-multi-cursor');
  }, []);

  const getNodeTextLength = useCallback((node: Node): number => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
    let length = 0;
    node.childNodes.forEach((childNode) => {
      length += getNodeTextLength(childNode);
    });
    return length;
  }, []);

  const getTextOffsetFromDomPoint = useCallback((root: Node, container: Node, offset: number): number | null => {
    let totalOffset = 0;
    let foundPoint = false;

    const walk = (node: Node): boolean => {
      if (node === container) {
        if (node.nodeType === Node.TEXT_NODE) {
          totalOffset += clamp(offset, 0, node.textContent?.length ?? 0);
        } else {
          const children = Array.from(node.childNodes).slice(0, clamp(offset, 0, node.childNodes.length));
          totalOffset += children.reduce((sum, childNode) => sum + getNodeTextLength(childNode), 0);
        }
        foundPoint = true;
        return true;
      }

      if (node.nodeType === Node.TEXT_NODE) {
        totalOffset += node.textContent?.length ?? 0;
        return false;
      }

      for (const childNode of Array.from(node.childNodes)) {
        if (walk(childNode)) return true;
      }
      return false;
    };

    walk(root);
    return foundPoint ? totalOffset : null;
  }, [getNodeTextLength]);

  const getEditorOffsetFromPoint = useCallback((clientX: number, clientY: number): number | null => {
    const editor = editorRef.current;
    if (!editor) return null;

    const documentWithCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const caretRange = documentWithCaret.caretRangeFromPoint?.(clientX, clientY) ?? null;
    const caretPosition = !caretRange ? documentWithCaret.caretPositionFromPoint?.(clientX, clientY) ?? null : null;

    const range = caretRange ?? document.createRange();
    if (caretPosition) {
      range.setStart(caretPosition.offsetNode, caretPosition.offset);
      range.collapse(true);
    }

    if (!editor.contains(range.startContainer)) return null;
    return getTextOffsetFromDomPoint(editor, range.startContainer, range.startOffset);
  }, [getTextOffsetFromDomPoint]);

  const getLineRangeAtOffset = useCallback((text: string, offset: number): EditorMultiLineRange | null => {
    if (text.length === 0) return null;
    const safeOffset = clamp(offset, 0, text.length);
    const lineStart = text.lastIndexOf('\n', Math.max(0, safeOffset - 1)) + 1;
    const lineBreakIndex = text.indexOf('\n', safeOffset);
    const lineEnd = lineBreakIndex >= 0 ? lineBreakIndex + 1 : text.length;
    if (lineEnd <= lineStart) return null;
    return { start: lineStart, end: lineEnd };
  }, []);

  const getLineIndexAtOffset = useCallback((text: string, offset: number): number => {
    const safeOffset = clamp(offset, 0, text.length);
    return text.slice(0, safeOffset).split('\n').length - 1;
  }, []);

  const getLineRangesFromSelectedLines = useCallback((text: string, lines: number[]): EditorMultiLineRange[] => {
    const lineStarts = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === '\n') lineStarts.push(index + 1);
    }

    return normalizeSelectedLines(lines)
      .map((lineIndex) => {
        const start = lineStarts[lineIndex];
        if (start === undefined) return null;
        const nextLineStart = lineStarts[lineIndex + 1];
        const end = nextLineStart ?? text.length;
        if (end <= start) return null;
        return { start, end };
      })
      .filter((range): range is EditorMultiLineRange => range !== null);
  }, []);

  const applySelectedLines = useCallback((lines: number[]) => {
    const snapshot = collectEditorTextSnapshot();
    const maxLineIndex = Math.max(0, (snapshot?.text.split('\n').length ?? 1) - 1);
    const nextLines = normalizeSelectedLines(lines).filter((lineIndex) => lineIndex <= maxLineIndex);
    const nextRanges = snapshot ? getLineRangesFromSelectedLines(snapshot.text, nextLines) : [];

    selectedLinesRef.current = nextLines;
    multiLineSelectionRef.current = nextRanges;
    setSelectedLines(nextLines);
    savedRangeRef.current = null;
    renderMultiLineSelectionHighlight(nextRanges);
  }, [collectEditorTextSnapshot, getLineRangesFromSelectedLines, renderMultiLineSelectionHighlight]);

  const clearLineSelection = useCallback(() => {
    selectedLinesRef.current = [];
    lineSelectionAnchorRef.current = null;
    multiLineSelectionRef.current = [];
    columnSelectionsRef.current = [];
    setSelectedLines([]);
    setColumnSelections([]);
    const cssWithHighlights = CSS as unknown as { highlights?: { delete: (name: string) => void } };
    cssWithHighlights.highlights?.delete('cloudpad-multi-line-selection');
  }, []);

  const clearMultiLineSelection = clearLineSelection;

  const clearEditorSmartSelection = useCallback(() => {
    clearLineSelection();
    clearMultiCursorSelection();
    columnSelectionAnchorOffsetRef.current = null;
    columnSelectionAnchorCursorRef.current = null;
    columnSelectionFocusCursorRef.current = null;
    isColumnSelectingRef.current = false;
  }, [clearLineSelection, clearMultiCursorSelection]);

  const toggleLineSelection = useCallback((lineIndex: number) => {
    const currentLines = selectedLinesRef.current;
    const nextLines = currentLines.includes(lineIndex)
      ? currentLines.filter((line) => line !== lineIndex)
      : [...currentLines, lineIndex];

    lineSelectionAnchorRef.current = lineIndex;
    applySelectedLines(nextLines);
  }, [applySelectedLines]);

  const selectLineRange = useCallback((fromLine: number, toLine: number) => {
    const snapshot = collectEditorTextSnapshot();
    if (!snapshot) return;

    const maxLineIndex = Math.max(0, snapshot.text.split('\n').length - 1);
    const startLine = clamp(Math.min(fromLine, toLine), 0, maxLineIndex);
    const endLine = clamp(Math.max(fromLine, toLine), 0, maxLineIndex);
    const nextLines = Array.from({ length: endLine - startLine + 1 }, (_, index) => startLine + index);

    lineSelectionAnchorRef.current = fromLine;
    applySelectedLines(nextLines);
  }, [applySelectedLines, collectEditorTextSnapshot]);

  const toggleMultiLineSelectionAtPoint = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return;
    const snapshot = collectEditorTextSnapshot();
    if (!snapshot) return;
    const offset = getEditorOffsetFromPoint(event.clientX, event.clientY);
    if (offset === null) return;
    const lineIndex = getLineIndexAtOffset(snapshot.text, offset);

    event.preventDefault();
    event.stopPropagation();
    editorRef.current?.focus({ preventScroll: true });
    window.getSelection()?.removeAllRanges();
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
      clearMultiCursorSelection();
      const anchorLine = lineSelectionAnchorRef.current ?? selectedLinesRef.current[selectedLinesRef.current.length - 1] ?? lineIndex;
      selectLineRange(anchorLine, lineIndex);
      return;
    }

    clearLineSelection();
    const currentOffsets = multiCursorOffsetsRef.current;
    const nextOffsets = currentOffsets.includes(offset)
      ? currentOffsets.filter((currentOffset) => currentOffset !== offset)
      : [...currentOffsets, offset];
    applyMultiCursorOffsets(nextOffsets);
  }, [
    applyMultiCursorOffsets,
    clearLineSelection,
    clearMultiCursorSelection,
    collectEditorTextSnapshot,
    getEditorOffsetFromPoint,
    getLineIndexAtOffset,
    selectLineRange
  ]);

  const updateColumnSelectionAtPoint = useCallback((clientX: number, clientY: number) => {
    const snapshot = collectEditorTextSnapshot();
    const anchorOffset = columnSelectionAnchorOffsetRef.current;
    if (!snapshot || anchorOffset === null) return;
    const focusOffset = getEditorOffsetFromPoint(clientX, clientY);
    if (focusOffset === null) return;
    columnSelectionFocusCursorRef.current = offsetToCursor(snapshot.text, focusOffset);

    const selections = getColumnSelectionsFromOffsets(snapshot.text, anchorOffset, focusOffset);
    const ranges = columnSelectionsToRanges(snapshot.text, selections);
    const nextCursors = ranges.length === 0
      ? getColumnCursorsFromOffsets(snapshot.text, anchorOffset, focusOffset)
      : [];
    const cursorOffsets = nextCursors.length > 0 ? cursorsToOffsets(snapshot.text, nextCursors) : [];

    if (ranges.length > 0) {
      clearMultiCursorSelection();
      multiLineSelectionRef.current = ranges;
      columnSelectionsRef.current = selections;
      setColumnSelections(selections);
      const nextLines = normalizeSelectedLines(ranges.map((range) => getLineIndexAtOffset(snapshot.text, range.start)));
      selectedLinesRef.current = nextLines;
      setSelectedLines(nextLines);
      savedRangeRef.current = null;
      renderMultiLineSelectionHighlight(ranges);
      return;
    }

    selectedLinesRef.current = [];
    setSelectedLines([]);
    columnSelectionsRef.current = [];
    setColumnSelections([]);
    multiLineSelectionRef.current = [];
    renderMultiLineSelectionHighlight([]);
    applyMultiCursorOffsets(cursorOffsets);
  }, [
    applyMultiCursorOffsets,
    clearMultiCursorSelection,
    collectEditorTextSnapshot,
    getEditorOffsetFromPoint,
    getLineIndexAtOffset,
    renderMultiLineSelectionHighlight
  ]);

  const handleEditorMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.altKey) {
      const offset = getEditorOffsetFromPoint(event.clientX, event.clientY);
      if (offset === null) return;
      event.preventDefault();
      event.stopPropagation();
      editorRef.current?.focus({ preventScroll: true });
      columnSelectionAnchorOffsetRef.current = offset;
      const snapshot = collectEditorTextSnapshot();
      const anchorCursor = snapshot ? offsetToCursor(snapshot.text, offset) : null;
      columnSelectionAnchorCursorRef.current = anchorCursor;
      columnSelectionFocusCursorRef.current = anchorCursor;
      isColumnSelectingRef.current = true;
      clearEditorSmartSelection();
      window.getSelection()?.removeAllRanges();
      return;
    }

    toggleMultiLineSelectionAtPoint(event);
  }, [clearEditorSmartSelection, getEditorOffsetFromPoint, toggleMultiLineSelectionAtPoint]);

  const handleEditorMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!isColumnSelectingRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    updateColumnSelectionAtPoint(event.clientX, event.clientY);
  }, [updateColumnSelectionAtPoint]);

  const handleEditorMouseUp = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (isColumnSelectingRef.current) {
      event.preventDefault();
      event.stopPropagation();
      updateColumnSelectionAtPoint(event.clientX, event.clientY);
      isColumnSelectingRef.current = false;
      return;
    }

    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    saveEditorSelection();
  }, [saveEditorSelection, updateColumnSelectionAtPoint]);

  const getMultiLineSelectedText = useCallback(() => {
    const snapshot = collectEditorTextSnapshot();
    if (!snapshot) return '';
    return normalizeEditorRanges(multiLineSelectionRef.current)
      .map((range) => snapshot.text.slice(range.start, range.end).replace(/\n$/, ''))
      .join('\n');
  }, [collectEditorTextSnapshot]);

  const deleteMultiLineSelection = useCallback(() => {
    const snapshot = collectEditorTextSnapshot();
    const ranges = normalizeEditorRanges(multiLineSelectionRef.current);
    if (!snapshot || ranges.length === 0) return false;

    recordEditorUndoSnapshot();
    for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
      const domRange = createEditorRangeFromOffsets(snapshot.nodes, range.start, range.end);
      domRange?.deleteContents();
    }

    clearMultiLineSelection();
    window.getSelection()?.removeAllRanges();
    syncRichEditorContent();
    return true;
  }, [clearMultiLineSelection, collectEditorTextSnapshot, createEditorRangeFromOffsets, recordEditorUndoSnapshot, syncRichEditorContent]);

  const applyMultiCursorEdit = useCallback((edit: { insertText?: string; deleteBackward?: boolean; deleteForward?: boolean }) => {
    const snapshot = collectEditorTextSnapshot();
    if (cursorsRef.current.length === 0) return false;
    recordEditorUndoSnapshot();
    const result = applyMultiCursorEditFromModule({
      snapshot,
      cursors: cursorsRef.current,
      edit,
      createEditorRangeFromOffsets
    });
    if (!result.changed) return false;

    editorRef.current?.normalize();
    window.getSelection()?.removeAllRanges();
    syncRichEditorContent();
    window.setTimeout(() => {
      cursorsRef.current = result.nextCursors;
      setCursors(result.nextCursors);
      applyMultiCursorOffsets(result.nextOffsets);
    }, 0);
    return true;
  }, [applyMultiCursorOffsets, collectEditorTextSnapshot, createEditorRangeFromOffsets, recordEditorUndoSnapshot, syncRichEditorContent]);

  const applySelectionRangeEdit = useCallback((edit: { insertText?: string; deleteBackward?: boolean; deleteForward?: boolean }) => {
    const snapshot = collectEditorTextSnapshot();
    const ranges = normalizeEditorRanges(multiLineSelectionRef.current);
    if (ranges.length === 0) return false;
    recordEditorUndoSnapshot();
    const result = applyRangeSelectionEdit({
      snapshot,
      ranges,
      edit,
      createEditorRangeFromOffsets
    });
    if (!result.changed) return false;

    editorRef.current?.normalize();
    window.getSelection()?.removeAllRanges();
    clearLineSelection();
    syncRichEditorContent();
    window.setTimeout(() => {
      cursorsRef.current = result.nextCursors;
      setCursors(result.nextCursors);
      applyMultiCursorOffsets(result.nextOffsets);
    }, 0);
    return true;
  }, [applyMultiCursorOffsets, clearLineSelection, collectEditorTextSnapshot, createEditorRangeFromOffsets, recordEditorUndoSnapshot, syncRichEditorContent]);

  const getCurrentEditorSelectionRange = useCallback((): SearchRange | null => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return null;

    const selectedRange = selection.getRangeAt(0);
    if (!editor.contains(selectedRange.commonAncestorContainer)) return null;

    const beforeStart = document.createRange();
    beforeStart.selectNodeContents(editor);
    beforeStart.setEnd(selectedRange.startContainer, selectedRange.startOffset);
    const beforeEnd = document.createRange();
    beforeEnd.selectNodeContents(editor);
    beforeEnd.setEnd(selectedRange.endContainer, selectedRange.endOffset);

    const start = beforeStart.toString().length;
    const end = beforeEnd.toString().length;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }, []);

  const selectEditorMatch = useCallback((nodes: Text[], match: SearchMatch) => {
    const startPoint = locateTextOffset(nodes, match.start);
    const endPoint = locateTextOffset(nodes, match.end);
    const selection = window.getSelection();
    if (!startPoint || !endPoint || !selection) return false;

    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    selection.removeAllRanges();
    selection.addRange(range);
    saveEditorSelection();
    const targetElement = range.startContainer.parentElement;
    targetElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  }, [locateTextOffset, saveEditorSelection]);

  const replaceEditorMatch = useCallback((nodes: Text[], match: SearchMatch, replacementText: string) => {
    const startPoint = locateTextOffset(nodes, match.start);
    const endPoint = locateTextOffset(nodes, match.end);
    const selection = window.getSelection();
    if (!startPoint || !endPoint || !selection) return false;

    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    range.deleteContents();

    const insertedNode = document.createTextNode(replacementText);
    range.insertNode(insertedNode);

    const insertedRange = document.createRange();
    insertedRange.setStart(insertedNode, 0);
    insertedRange.setEnd(insertedNode, insertedNode.data.length);
    selection.removeAllRanges();
    selection.addRange(insertedRange);
    saveEditorSelection();
    syncRichEditorContent();
    return true;
  }, [locateTextOffset, saveEditorSelection, syncRichEditorContent]);

  const getSearchRangeForRequest = useCallback((request: FindReplaceRequest): SearchRange | null | 'missing' => {
    if (!request.inSelection) return null;
    const selectedRange = activeFindSelectionRef.current ?? getCurrentEditorSelectionRange();
    if (!selectedRange || selectedRange.start === selectedRange.end) return 'missing';
    return selectedRange;
  }, [getCurrentEditorSelectionRange]);

  const openFindReplacePanel = useCallback(() => {
    const codeEditorSelectionRange = codeEditorRef.current?.getSelectionRange() ?? null;
    const selectionRange = codeEditorSelectionRange ?? getCurrentEditorSelectionRange();
    const selectedText = codeEditorRef.current?.getSelectedText() || window.getSelection()?.toString() || '';
    const compactSelectedText = selectedText.replace(/\r?\n/g, ' ').trim();
    const initialQuery = compactSelectedText && compactSelectedText.length <= 200 ? compactSelectedText : '';

    activeFindSelectionRef.current = selectionRange && selectionRange.start !== selectionRange.end
      ? selectionRange
      : null;
    setFindInitialQuery(initialQuery);
    setFindResultMessage('');

    if (!isTauriRuntime()) {
      setIsFindOpen(true);
      return;
    }

    setIsFindOpen(false);

    void (async () => {
      try {
        const existingWindow = await WebviewWindow.getByLabel('find-replace');
        if (existingWindow) {
          setIsFindOpen(false);
          await existingWindow.show();
          await existingWindow.setFocus();
          await emitTo('find-replace', 'cloudpad-find-open', { initialQuery });
          return;
        }

        const search = new URLSearchParams({
          window: 'find-replace',
          q: initialQuery
        });
        const placement = await getFindWindowInitialPlacement();
        const findWindow = new WebviewWindow('find-replace', {
          url: `index.html?${search.toString()}`,
          title: 'ค้นหา / แทนที่',
          x: placement.x,
          y: placement.y,
          width: FIND_WINDOW_WIDTH,
          height: FIND_WINDOW_HEIGHT,
          minWidth: FIND_WINDOW_MIN_WIDTH,
          minHeight: FIND_WINDOW_MIN_HEIGHT,
          resizable: true,
          // The Find / Replace window already has its own compact header. Hiding
          // the native title bar prevents the duplicate dark strip on Windows.
          decorations: false,
          alwaysOnTop: true,
          focus: true,
          center: false
        });

        findWindow.once('tauri://created', async () => {
          await findWindow.setFocus();
          await emitTo('find-replace', 'cloudpad-find-open', { initialQuery });
        });
        findWindow.once('tauri://error', () => {
          setIsFindOpen(true);
        });
      } catch {
        setIsFindOpen(true);
      }
    })();
  }, [getCurrentEditorSelectionRange]);

  const handleFindReplaceFind = useCallback((direction: SearchDirection, request: FindReplaceRequest) => {
    const codeEditor = codeEditorRef.current;
    if (codeEditor) {
      const result = codeEditor.findReplaceFind(direction, request);
      setFindResultMessage(result.message);
      return null;
    }

    const snapshot = collectEditorTextSnapshot();
    if (!snapshot) {
      setFindResultMessage('ยังไม่มีแผ่นงานให้ค้นหา');
      return null;
    }

    const searchRange = getSearchRangeForRequest(request);
    if (searchRange === 'missing') {
      setFindResultMessage('เลือกข้อความก่อนใช้ In selection');
      return null;
    }

    const result = findMatchesInText(snapshot.text, request.query, request, searchRange);
    if (result.error) {
      setFindResultMessage(result.error);
      return null;
    }
    if (result.matches.length === 0) {
      setFindResultMessage('ไม่พบข้อความที่ค้นหา');
      return null;
    }

    const currentSelection = getCurrentEditorSelectionRange();
    const cursorStart = currentSelection?.start ?? (direction === 'next' ? -1 : Number.POSITIVE_INFINITY);
    const cursorEnd = currentSelection?.end ?? cursorStart;
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
      setFindResultMessage(direction === 'next' ? 'ถึงท้ายเอกสารแล้ว' : 'ถึงต้นเอกสารแล้ว');
      return null;
    }

    const match = result.matches[matchIndex];
    selectEditorMatch(snapshot.nodes, match);
    setFindResultMessage(`พบ ${matchIndex + 1} จาก ${result.matches.length} รายการ`);
    return { snapshot, matches: result.matches, match, matchIndex };
  }, [
    collectEditorTextSnapshot,
    getCurrentEditorSelectionRange,
    getSearchRangeForRequest,
    selectEditorMatch
  ]);

  const handleFindReplaceReplace = useCallback((request: FindReplaceRequest) => {
    const codeEditor = codeEditorRef.current;
    if (codeEditor) {
      const result = codeEditor.findReplaceReplace(request);
      setFindResultMessage(result.message);
      return;
    }

    const snapshot = collectEditorTextSnapshot();
    if (!snapshot) {
      setFindResultMessage('ยังไม่มีแผ่นงานให้แทนที่');
      return;
    }

    const searchRange = getSearchRangeForRequest(request);
    if (searchRange === 'missing') {
      setFindResultMessage('เลือกข้อความก่อนใช้ In selection');
      return;
    }

    const result = findMatchesInText(snapshot.text, request.query, request, searchRange);
    if (result.error) {
      setFindResultMessage(result.error);
      return;
    }
    if (result.matches.length === 0) {
      setFindResultMessage('ไม่พบข้อความที่ต้องการแทนที่');
      return;
    }

    const currentSelection = getCurrentEditorSelectionRange();
    const selectedMatch = currentSelection
      ? result.matches.find((match) => match.start === currentSelection.start && match.end === currentSelection.end)
      : undefined;
    const fallback = selectedMatch ? null : handleFindReplaceFind(request.backward ? 'previous' : 'next', request);
    const match = selectedMatch ?? fallback?.match;
    const freshSnapshot = selectedMatch ? snapshot : collectEditorTextSnapshot();

    if (!match || !freshSnapshot) return;

    const replacement = buildReplacementText(match, request.query, request.replacement, request);
    if (replacement.error) {
      setFindResultMessage(replacement.error);
      return;
    }

    if (replaceEditorMatch(freshSnapshot.nodes, match, replacement.value)) {
      setFindResultMessage('แทนที่แล้ว 1 รายการ');
    }
  }, [
    collectEditorTextSnapshot,
    getCurrentEditorSelectionRange,
    getSearchRangeForRequest,
    handleFindReplaceFind,
    replaceEditorMatch
  ]);

  const handleFindReplaceReplaceAll = useCallback((request: FindReplaceRequest) => {
    const codeEditor = codeEditorRef.current;
    if (codeEditor) {
      const result = codeEditor.findReplaceReplaceAll(request);
      setFindResultMessage(result.message);
      return;
    }

    const snapshot = collectEditorTextSnapshot();
    if (!snapshot) {
      setFindResultMessage('ยังไม่มีแผ่นงานให้แทนที่');
      return;
    }

    const searchRange = getSearchRangeForRequest(request);
    if (searchRange === 'missing') {
      setFindResultMessage('เลือกข้อความก่อนใช้ In selection');
      return;
    }

    const result = findMatchesInText(snapshot.text, request.query, request, searchRange);
    if (result.error) {
      setFindResultMessage(result.error);
      return;
    }
    if (result.matches.length === 0) {
      setFindResultMessage('ไม่พบข้อความที่ต้องการแทนที่');
      return;
    }

    const replacements = result.matches.map((match) => buildReplacementText(match, request.query, request.replacement, request));
    const replacementError = replacements.find((replacement) => replacement.error);
    if (replacementError?.error) {
      setFindResultMessage(replacementError.error);
      return;
    }

    for (let index = result.matches.length - 1; index >= 0; index -= 1) {
      replaceEditorMatch(snapshot.nodes, result.matches[index], replacements[index].value);
    }

    setFindResultMessage(`แทนที่ทั้งหมด ${result.matches.length} รายการ`);
  }, [
    collectEditorTextSnapshot,
    getSearchRangeForRequest,
    replaceEditorMatch
  ]);

  const handleFindReplaceFormatMatches = useCallback((request: FindReplaceRequest) => {
    const codeEditor = codeEditorRef.current;
    if (codeEditor) {
      const result = codeEditor.findReplaceFormatMatches(request);
      setFindResultMessage(result.message);
      return;
    }

    const snapshot = collectEditorTextSnapshot();
    if (!snapshot) {
      setFindResultMessage('ยังไม่มีแผ่นงานให้ปรับแต่ง');
      return;
    }

    const searchRange = getSearchRangeForRequest(request);
    if (searchRange === 'missing') {
      setFindResultMessage('เลือกข้อความก่อนใช้เฉพาะส่วนที่เลือก');
      return;
    }

    const result = findMatchesInText(snapshot.text, request.query, request, searchRange);
    if (result.error) {
      setFindResultMessage(result.error);
      return;
    }
    if (result.matches.length === 0) {
      setFindResultMessage('ไม่พบคำที่ต้องการปรับแต่ง');
      return;
    }

    const matchRanges = result.matches.map((match) => {
      const startPoint = locateTextOffset(snapshot.nodes, match.start);
      const endPoint = locateTextOffset(snapshot.nodes, match.end);
      if (!startPoint || !endPoint) return null;
      const range = document.createRange();
      range.setStart(startPoint.node, startPoint.offset);
      range.setEnd(endPoint.node, endPoint.offset);
      return range;
    }).filter((range): range is Range => Boolean(range));

    if (matchRanges.length === 0) {
      setFindResultMessage('ไม่สามารถปรับแต่งคำที่ค้นหาได้');
      return;
    }

    recordEditorUndoSnapshot();
    const style: Partial<CSSStyleDeclaration> = {
      fontFamily: request.textStyle.fontFamily,
      fontSize: `${clamp(Math.round(request.textStyle.fontSize), 10, 100)}px`,
      fontWeight: request.textStyle.fontWeight,
      color: normalizeColorInputValue(request.textStyle.color)
    };
    const styledSpans = [...matchRanges].reverse().map((range) => wrapRangeWithStyle(range, style)).reverse();
    const firstSpan = styledSpans[0];
    if (firstSpan) {
      const selection = window.getSelection();
      const firstRange = document.createRange();
      firstRange.selectNodeContents(firstSpan);
      selection?.removeAllRanges();
      selection?.addRange(firstRange);
      firstSpan.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    syncRichEditorContent();
    setFindResultMessage(`ปรับแต่งคำที่พบแล้ว ${matchRanges.length} รายการ`);
  }, [
    collectEditorTextSnapshot,
    getSearchRangeForRequest,
    locateTextOffset,
    recordEditorUndoSnapshot,
    syncRichEditorContent
  ]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlisten: (() => void) | null = null;

    void listen<FindWindowActionPayload>('cloudpad-find-action', (event) => {
      const payload = event.payload;
      if (payload.action === 'find') {
        handleFindReplaceFind(payload.direction, payload.request);
        return;
      }
      if (payload.action === 'replace') {
        handleFindReplaceReplace(payload.request);
        return;
      }
      if (payload.action === 'replaceAll') {
        handleFindReplaceReplaceAll(payload.request);
        return;
      }
      if (payload.action === 'formatMatches') {
        handleFindReplaceFormatMatches(payload.request);
        return;
      }
      if (payload.action === 'close') {
        setIsFindOpen(false);
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, [handleFindReplaceFind, handleFindReplaceFormatMatches, handleFindReplaceReplace, handleFindReplaceReplaceAll]);

  useEffect(() => {
    if (!findResultMessage) return;
    if (!isTauriRuntime()) return;
    void emitTo('find-replace', 'cloudpad-find-result', { message: findResultMessage });
  }, [findResultMessage]);

  useEffect(() => {
    function handleKeyboardShortcuts(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && isFindOpen) {
        event.preventDefault();
        setIsFindOpen(false);
        editorRef.current?.focus();
        return;
      }
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      const keyCode = event.code;
      const isEditorTarget = isEditorKeyboardTarget(event.target);
      const isCodeMirrorTarget = event.target instanceof Element && Boolean(event.target.closest('.codemirror-note-editor'));
      const isTitleCodeMirrorTarget = event.target instanceof Element && Boolean(event.target.closest('.title-editor-shell'));
      const isBodyCodeMirrorTarget = isCodeMirrorTarget && !isTitleCodeMirrorTarget;
      const isFormControlTarget = event.target instanceof HTMLElement && (
        event.target.closest('.find-dialog-layer, .format-context-menu') !== null ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLButtonElement
      );
      const getActiveCodeMirrorEditor = () => {
        if (isTitleCodeMirrorTarget) return titleCodeEditorRef.current;
        if (isBodyCodeMirrorTarget) return codeEditorRef.current;
        if (titleCodeEditorRef.current?.hasFocus()) return titleCodeEditorRef.current;
        if (codeEditorRef.current?.hasFocus()) return codeEditorRef.current;
        return activeFormatTargetRef.current === 'title'
          ? titleCodeEditorRef.current
          : codeEditorRef.current;
      };

      if (key === 's' || keyCode === 'KeyS') {
        event.preventDefault();
        void handleManualSave();
        return;
      }

      if (key === 'b' || keyCode === 'KeyB') {
        // Do NOT bail out on a CodeMirror target: the editor has no bold binding of
        // its own, and toggleBoldFormatting() already routes to the focused
        // CodeMirror editor (codeEditorRef/titleCodeEditorRef.toggleBold). Returning
        // here left Ctrl+B dead inside the note — bold only worked from the menu.
        if (isFormControlTarget) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        toggleBoldFormatting();
        return;
      }

      if (key === 'f' || keyCode === 'KeyF') {
        if (isCodeMirrorTarget) return;
        if (isFormControlTarget) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        clearSavedSelectionHighlight();
        openFindReplacePanel();
        return;
      }

      if (key === 'g' || keyCode === 'KeyG') {
        if (!selectedNote) return;
        event.preventDefault();
        event.stopPropagation();
        clearSavedSelectionHighlight();
        openGoToLine();
        return;
      }

      if (key === 'z' || keyCode === 'KeyZ') {
        if (isCodeMirrorTarget) return;
        if (isFormControlTarget) return;
        if (!isEditorTarget && !isCodeMirrorTarget) return;
        if (handleEditorUndo()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        clearSavedSelectionHighlight();
        savedRangeRef.current = null;
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            saveEditorSelection();
            syncRichEditorContent();
          });
        });
        return;
      }

      if (key === 'y' || keyCode === 'KeyY') {
        if (isCodeMirrorTarget) return;
        if (isFormControlTarget) return;
        if (!isEditorTarget && !isCodeMirrorTarget) return;
        if (handleEditorRedo()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        clearSavedSelectionHighlight();
        savedRangeRef.current = null;
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            saveEditorSelection();
            syncRichEditorContent();
          });
        });
        return;
      }

      // Zoom keys need a keyCode fallback like the letter shortcuts above: with a
      // Thai keyboard layout active, event.key for these keys is a Thai character,
      // so matching on `key` alone left Ctrl+= / Ctrl+- / Ctrl+0 dead while typing
      // Thai. keyCode is layout-independent (physical key), and Numpad variants are
      // covered too.
      if (key === '=' || key === '+' || keyCode === 'Equal' || keyCode === 'NumpadAdd') {
        event.preventDefault();
        setNoteZoom((current) => clamp(Number((current + ZOOM_STEP).toFixed(2)), ZOOM_MIN, ZOOM_MAX));
        return;
      }

      if (key === '-' || key === '_' || keyCode === 'Minus' || keyCode === 'NumpadSubtract') {
        event.preventDefault();
        setNoteZoom((current) => clamp(Number((current - ZOOM_STEP).toFixed(2)), ZOOM_MIN, ZOOM_MAX));
        return;
      }

      if (key === '0' || keyCode === 'Digit0' || keyCode === 'Numpad0') {
        event.preventDefault();
        setNoteZoom(1);
      }
    }

    window.addEventListener('keydown', handleKeyboardShortcuts, true);
    return () => window.removeEventListener('keydown', handleKeyboardShortcuts, true);
  }, [
    clearSavedSelectionHighlight,
    activeFormatTarget,
    handleEditorRedo,
    handleEditorUndo,
    handleManualSave,
    isEditorKeyboardTarget,
    isFindOpen,
    openFindReplacePanel,
    openGoToLine,
    saveEditorSelection,
    selectedNote,
    syncRichEditorContent,
    toggleBoldFormatting
  ]);

  async function handleLogin() {
    setAccountMessage(null);
    try {
      await auth.login(email.trim(), password);
      setPassword('');
      setAccountMessage('เข้าสู่ระบบสำเร็จ กำลังซิงก์ข้อมูล');
    } catch {
      // Error is displayed from the auth store.
    }
  }

  async function handleRegister() {
    setAccountMessage(null);
    try {
      const result = await auth.register(email.trim(), password);
      setPassword('');
      setAccountMessage(
        result.needsEmailConfirmation
          ? 'สมัครสำเร็จ กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ'
          : 'สมัครและเข้าสู่ระบบสำเร็จ'
      );
    } catch {
      // Error is displayed from the auth store.
    }
  }

  async function handleRequestPasswordReset() {
    setAccountMessage(null);
    try {
      await auth.requestPasswordReset(email.trim());
      setAccountMessage('ส่งรหัสยืนยันไปที่อีเมลแล้ว กรุณาตรวจสอบกล่องจดหมาย');
      setAuthView('reset-confirm');
    } catch {
      // Error is displayed from the auth store.
    }
  }

  async function handleConfirmPasswordReset() {
    setAccountMessage(null);
    try {
      await auth.confirmPasswordReset(email.trim(), resetOtp.trim(), newPassword);
      setPassword('');
      setResetOtp('');
      setNewPassword('');
      setAuthView('login');
      setAccountMessage('ตั้งรหัสผ่านใหม่สำเร็จ เข้าสู่ระบบเรียบร้อยแล้ว');
    } catch {
      // Error is displayed from the auth store.
    }
  }

  async function handleLogout() {
    setAccountMessage(null);
    try {
      await auth.logout();
      setNotes([]);
      setDeletedNotes([]);
      setSelectedId(null);
      setSyncState('ready');
      setSyncMessage('ออกจากระบบแล้ว · ซ่อนโน้ตบนเครื่องจนกว่าจะเข้าสู่ระบบ');
    } catch {
      // Error is displayed from the auth store.
    }
  }

  const canSubmitAccount = email.trim().length > 0 && password.length >= 6 && !auth.loading;
  const canSubmitResetRequest = email.trim().length > 0 && !auth.loading;
  const canSubmitResetConfirm = resetOtp.trim().length > 0 && newPassword.length >= 6 && !auth.loading;
  const findPanelPortal = isFindOpen && typeof document !== 'undefined'
    ? createPortal(
        <FindReplacePanel
          initialQuery={findInitialQuery}
          resultMessage={findResultMessage}
          onFind={handleFindReplaceFind}
          onReplace={handleFindReplaceReplace}
          onReplaceAll={handleFindReplaceReplaceAll}
          onFormatMatches={handleFindReplaceFormatMatches}
          onClose={() => {
            setIsFindOpen(false);
            codeEditorRef.current?.focus();
          }}
        />,
        document.body
      )
    : null;

  const formatContextMenuPortal = formatContextMenu.open && selectedNote && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={formatMenuRef}
          className="format-context-menu"
          style={{ left: formatContextMenu.x, top: formatContextMenu.y }}
          role="dialog"
          aria-label="เมนูปรับแต่งตัวอักษร"
        >
          <div className="format-context-menu__header">
            <strong>ปรับแต่งตัวอักษร</strong>
            <small>{activeFormatTargetRef.current === 'title' ? 'หัวข้อโน้ต' : 'แผ่นงานโน้ต'}</small>
          </div>

          <label className="font-control">
            ฟอนต์
            <select
              value={fontFamilyInput}
              onChange={(event) => applyFontFamilyToSelection(event.target.value)}
            >
              {FONT_OPTIONS.map((font) => (
                <option key={font.value} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>

          <div className="format-context-menu__row">
            <label className="size-control">
              ขนาด 10–100
              <input
                type="number"
                min="10"
                max="100"
                step="1"
                value={fontSizeInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setFontSizeInput(value);
                  const parsedSize = Number(value);
                  if (value !== '' && Number.isFinite(parsedSize) && parsedSize >= 10 && parsedSize <= 100) {
                    applyFontSizeToSelection(parsedSize);
                  }
                }}
                onBlur={commitFontSizeInput}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitFontSizeInput();
                  }
                }}
              />
            </label>

            <label className="weight-control">
              น้ำหนัก
              <select
                value={fontWeightInput}
                onChange={(event) => applyWeightToSelection(event.target.value as FontWeight)}
              >
                {WEIGHT_OPTIONS.map((weight) => (
                  <option key={weight.value} value={weight.value}>
                    {weight.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="format-context-menu__row format-context-menu__row--compact">
            <button
              type="button"
              className={`secondary-button bold-toggle-button ${isBoldActive ? 'active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                toggleBoldFormatting();
                closeFormatContextMenu();
              }}
              aria-pressed={isBoldActive}
              title="ตัวหนา Ctrl+B"
            >
              หนา Ctrl+B
            </button>

            <label className="color-control">
              สี
              <input
                className="color-picker"
                type="color"
                value={textColorInput}
                onChange={(event) => applyTextColor(event.target.value)}
              />
            </label>
          </div>

          <div className="color-swatches format-context-menu__swatches" aria-label="สีตัวอักษรแบบเร็ว">
            {COLOR_PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                className={textColorInput.toLowerCase() === color ? 'active' : ''}
                style={{ backgroundColor: color }}
                aria-label={`ใช้สี ${color}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  applyTextColor(color);
                  closeFormatContextMenu();
                }}
              />
            ))}
          </div>

          <div className="format-context-menu__footer">
            <span>คลิกขวาอีกครั้งเพื่อย้ายเมนู</span>
          </div>
        </div>,
        document.body
      )
    : null;

  const topbarStatusState: SyncState | 'saved' = isSaving
    ? 'syncing'
    : lastSavedMessage
      ? 'saved'
      : syncState;

  const topbarStatusMessage = isSaving
    ? 'กำลังบันทึกในเครื่อง...'
    : lastSavedMessage
      ? lastSavedMessage
      : syncMessage;

  return (
    <>
      <main
        className="app-shell"
        style={appStyle}
        onWheel={(event) => {
          if (!event.ctrlKey) return;
          event.preventDefault();
          const direction = event.deltaY < 0 ? 1 : -1;
          setAppZoom((current) => clamp(Number((current + direction * ZOOM_STEP).toFixed(2)), ZOOM_MIN, ZOOM_MAX));
        }}
      >
      <aside className="sidebar">
        <div className="account-hover-zone">
          <button className="account-float-button" type="button">
            <span>{auth.user ? 'บัญชีพร้อมซิงก์' : 'ล็อกอินเข้าใช้งาน'}</span>
            <span className={`account-dot ${auth.user ? 'online' : ''}`} />
            <span className="account-round-arrow" aria-hidden="true" />
          </button>

          <section className="account-card">
            <div className="account-heading">
              <strong>บัญชี CloudPad <span className="account-cloud-inline" aria-hidden="true">☁</span></strong>
              <span className={`account-dot ${auth.user ? 'online' : ''}`} />
            </div>

            {!auth.cloudEnabled ? (
              <p className="account-help">เพิ่มค่า Supabase ในไฟล์ .env เพื่อเปิดระบบบัญชีและ Cloud Sync</p>
            ) : auth.user ? (
              <>
                <p className="account-email">{auth.user.email}</p>
                <div className="sync-interval-setting">
                  <label className="sync-interval-label" htmlFor="syncIntervalSelect">
                    ซิงก์อัตโนมัติทุก
                  </label>
                  <div className="sync-interval-row">
                    <select
                      id="syncIntervalSelect"
                      className="sync-interval-select"
                      value={syncIntervalDraft}
                      onChange={(event) => setSyncIntervalDraft(Number(event.target.value))}
                    >
                      {SYNC_INTERVAL_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="primary-button sync-interval-save"
                      onClick={handleSaveSyncInterval}
                      disabled={syncIntervalDraft === syncIntervalSec}
                    >
                      บันทึก
                    </button>
                  </div>
                  <p className="account-help sync-interval-current">
                    ปัจจุบัน: ทุก {formatSyncInterval(syncIntervalSec)}
                  </p>
                </div>
                <button className="secondary-button full-width" onClick={handleLogout} disabled={auth.loading}>
                  ออกจากระบบ
                </button>
              </>
            ) : authView === 'reset-request' ? (
              <>
                <input
                  className="account-input"
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    auth.clearError();
                  }}
                  placeholder="อีเมลที่ใช้สมัคร"
                  autoComplete="email"
                />
                <p className="account-help">กรอกอีเมลที่ใช้สมัคร ระบบจะส่งรหัสยืนยันไปให้ทางอีเมล</p>
                <div className="account-actions">
                  <button
                    className="primary-button"
                    onClick={handleRequestPasswordReset}
                    disabled={!canSubmitResetRequest}
                  >
                    ส่งรหัสยืนยัน
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setAuthView('login');
                      auth.clearError();
                      setAccountMessage(null);
                    }}
                  >
                    ย้อนกลับ
                  </button>
                </div>
              </>
            ) : authView === 'reset-confirm' ? (
              <>
                <p className="account-email">{email}</p>
                <input
                  className="account-input"
                  type="text"
                  inputMode="numeric"
                  value={resetOtp}
                  onChange={(event) => {
                    setResetOtp(event.target.value);
                    auth.clearError();
                  }}
                  placeholder="รหัสยืนยันจากอีเมล"
                  autoComplete="one-time-code"
                />
                <input
                  className="account-input"
                  type="password"
                  value={newPassword}
                  onChange={(event) => {
                    setNewPassword(event.target.value);
                    auth.clearError();
                  }}
                  placeholder="รหัสผ่านใหม่อย่างน้อย 6 ตัว"
                  autoComplete="new-password"
                />
                <div className="account-actions">
                  <button
                    className="primary-button"
                    onClick={handleConfirmPasswordReset}
                    disabled={!canSubmitResetConfirm}
                  >
                    ตั้งรหัสผ่านใหม่
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setAuthView('login');
                      auth.clearError();
                      setAccountMessage(null);
                    }}
                  >
                    ย้อนกลับ
                  </button>
                </div>
              </>
            ) : (
              <>
                <input
                  className="account-input"
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    auth.clearError();
                  }}
                  placeholder="อีเมล"
                  autoComplete="email"
                />
                <input
                  className="account-input"
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    auth.clearError();
                  }}
                  placeholder="รหัสผ่านอย่างน้อย 6 ตัว"
                  autoComplete="current-password"
                />
                <div className="account-actions">
                  <button className="primary-button" onClick={handleLogin} disabled={!canSubmitAccount}>
                    เข้าสู่ระบบ
                  </button>
                  <button className="secondary-button" onClick={handleRegister} disabled={!canSubmitAccount}>
                    สมัคร
                  </button>
                </div>
                <button
                  type="button"
                  className="link-button forgot-password-link"
                  onClick={() => {
                    setAuthView('reset-request');
                    auth.clearError();
                    setAccountMessage(null);
                  }}
                >
                  ลืมรหัสผ่าน?
                </button>
              </>
            )}

            <label className="emoji-bridge-setting" title="เปิดเพื่อใช้ Win+. แทรกอีโมจิ">
              <input
                type="checkbox"
                checked={emojiBridgeEnabled}
                onChange={(event) => {
                  const next = event.target.checked;
                  setEmojiBridgeEnabled(next);
                  try {
                    localStorage.setItem(EMOJI_BRIDGE_STORAGE_KEY, next ? 'true' : 'false');
                  } catch {
                    // ignore storage errors (private mode); the checkbox still reflects intent
                  }
                }}
              />
              <span className="emoji-bridge-setting__text">
                <strong>รองรับอิโมจิ Windows (Win+.)</strong>
                <small>ปิดไว้ = พิมพ์ลื่นสุด · เปิด = ใช้ Win+. ได้ และ Win+Space จะคืนโฟกัสทันที</small>
              </span>
            </label>

            {(auth.error || accountMessage) && (
              <p className={auth.error ? 'account-error' : 'account-success'}>
                {auth.error ?? accountMessage}
              </p>
            )}
          </section>
        </div>

        <div className="brand-row">
          <div className="brand">
            <span className="brand-logo" aria-hidden="true">☁</span>
            <div>
              <div className="brand-title-row">
                <h1>CloudPad</h1>
                <button
                  type="button"
                  className="whats-new-trigger brand-version-trigger"
                  title={`เวอร์ชัน ${APP_VERSION} · มีอะไรใหม่`}
                  onClick={() => setIsWhatsNewOpen(true)}
                >
                  v{APP_VERSION}
                </button>
              </div>
              <p>Offline-first Notepad</p>
            </div>
          </div>
          <div className="brand-header-actions">
            <button className="primary-button new-note-button brand-new-note-button" onClick={handleCreateNote} disabled={!canUseNotes}>
              <span aria-hidden="true">＋</span> ใหม่
            </button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          className="hidden-file-input"
          type="file"
          multiple
          onChange={handleImportTextFile}
        />

        <div className="file-primary-actions-row">
          <section className={`file-actions-panel ${isFileActionsOpen ? 'open' : 'collapsed'}`}>
            <button
              className="file-actions-toggle"
              type="button"
              aria-expanded={isFileActionsOpen}
              onClick={() => setIsFileActionsOpen((open) => !open)}
            >
              <DownloadIcon className="file-actions-icon" />
              <span>นำเข้า / ส่งออก</span>
              <span className="file-actions-arrow" aria-hidden="true" />
            </button>

            <div className="file-actions-body" aria-hidden={!isFileActionsOpen}>
              <div className="file-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!canUseNotes}
                >
                  <DownloadIcon className="file-action-button-icon" /> นำเข้าไฟล์
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={openExportPicker}
                  disabled={!selectedNote}
                >
                  <UploadIcon className="file-action-button-icon" /> ส่งออก
                </button>
              </div>
            </div>
          </section>
        </div>

        <div className="note-primary-actions-row">
          <button
            type="button"
            className={`note-select-mode-toggle secondary-button ${isNoteSelectMode ? 'active' : ''}`}
            onClick={toggleNoteSelectMode}
            disabled={notes.length === 0}
            aria-label={isNoteSelectMode ? 'ออกจากโหมดเลือกหลายรายการ' : 'เลือกหลายรายการ'}
            aria-pressed={isNoteSelectMode}
          >
            <span className="note-select-mode-label">
              {isNoteSelectMode ? 'เสร็จสิ้น' : 'เลือก'}
            </span>
          </button>
        </div>

        <div className="search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            ref={searchInputRef}
            className="search-input"
            placeholder="ค้นหาโน้ต..."
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setInitialFilter(null);
            }}
          />
          {(query || initialFilter) && (
            <button
              type="button"
              className="search-clear-button"
              aria-label="ล้างการค้นหา"
              title="ล้างการค้นหา"
              onClick={() => {
                setQuery('');
                setInitialFilter(null);
                searchInputRef.current?.focus();
              }}
            >
              ×
            </button>
          )}
        </div>

        <div
          className={`note-select-toolbar-shell ${isNoteSelectMode ? 'open' : ''}`}
          aria-hidden={!isNoteSelectMode}
        >
          <div className="note-select-toolbar">
            <div className="note-select-toolbar-row">
              <span>{bulkSelectedNoteIds.length} ที่เลือก</span>
              <div className="note-select-toolbar-links">
                <button
                  type="button"
                  className="note-select-link-button"
                  onClick={() => setBulkSelectedNoteIds(filteredNotes.map((note) => note.id))}
                >
                  เลือกทั้งหมด
                </button>
                <button
                  type="button"
                  className="note-select-link-button"
                  onClick={toggleNoteSelectMode}
                >
                  ยกเลิก
                </button>
              </div>
            </div>
            <button
              type="button"
              className="danger-button note-select-delete-button"
              disabled={bulkSelectedNoteIds.length === 0}
              onClick={() => setIsBulkDeleteConfirmOpen(true)}
            >
              🗑 ลบที่เลือก{bulkSelectedNoteIds.length > 0 ? ` (${bulkSelectedNoteIds.length})` : ''}
            </button>
          </div>
        </div>

        <div className="note-browser">
          <nav className="note-alphabet-index" aria-label="ค้นหาโน้ตตามตัวอักษร">
            <button
              type="button"
              className={!initialFilter ? 'active' : ''}
              aria-pressed={!initialFilter}
              title={`แสดงทั้งหมด ${notes.length} โน้ต`}
              onClick={() => {
                setInitialFilter(null);
                setQuery('');
                noteListRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            >
              ทั้งหมด
            </button>
            {alphabetEntries.map(({ initial, count }) => (
              <button
                type="button"
                key={initial}
                className={initialFilter === initial ? 'active' : ''}
                aria-pressed={initialFilter === initial}
                title={`${initial} · ${count} โน้ต`}
                onClick={() => {
                  setInitialFilter(initial);
                  setQuery('');
                  window.requestAnimationFrame(() => {
                    noteListRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                  });
                }}
              >
                {initial}
              </button>
            ))}
          </nav>

          <div className="note-list" ref={noteListRef}>
            {filteredNotes.length === 0 && (
              <div className="note-list-empty">
                ไม่พบโน้ตที่ตรงกับการค้นหา
              </div>
            )}
            {filteredNotes.map((note) => (
            <div
              key={note.id}
              data-note-id={note.id}
              role="button"
              tabIndex={0}
              className={`note-card ${selectedNote?.id === note.id ? 'active' : ''} ${note.isPinned ? 'pinned' : ''} ${draggingNoteId === note.id ? 'dragging' : ''} ${dragOverNoteId === note.id && draggingNoteId !== note.id ? 'drag-over' : ''} ${isNoteSelectMode ? 'select-mode' : ''} ${bulkSelectedNoteIds.includes(note.id) ? 'selected' : ''}`}
              draggable={false}
              data-tooltip={isNoteSelectMode ? 'คลิกเพื่อเลือก/ยกเลิกเลือก' : 'คลิกขวาเพื่อปักหมุด / ลากเพื่อจัดลำดับ'}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.currentTarget.click();
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (isNoteSelectMode) return;
                void handleToggleNotePin(note);
              }}
              onDragStart={(event) => {
                if (isNoteSelectMode) return;
                setDraggingNoteId(note.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', note.id);
              }}
              onDragEnter={(event) => {
                if (isNoteSelectMode) return;
                event.preventDefault();
                setDragOverNoteId(note.id);
              }}
              onDragOver={(event) => {
                if (isNoteSelectMode) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDragOverNoteId(note.id);
              }}
              onDragLeave={() => {
                if (isNoteSelectMode) return;
                setDragOverNoteId((currentId) => (currentId === note.id ? null : currentId));
              }}
              onDrop={(event) => {
                if (isNoteSelectMode) return;
                event.preventDefault();
                void handleDropNote(note);
              }}
              onDragEnd={() => {
                if (isNoteSelectMode) return;
                setDraggingNoteId(null);
                setDragOverNoteId(null);
              }}
              onPointerDown={(event) => {
                if (isNoteSelectMode) return;
                beginPointerNoteDrag(event, note);
              }}
              onPointerMove={(event) => {
                if (isNoteSelectMode) return;
                updatePointerNoteDrag(event);
              }}
              onPointerUp={(event) => {
                if (isNoteSelectMode) return;
                finishPointerNoteDrag(event);
              }}
              onPointerCancel={() => {
                if (isNoteSelectMode) return;
                pointerDragRef.current = null;
                setDraggingNoteId(null);
                setDragOverNoteId(null);
                window.requestAnimationFrame(() => {
                  skipNoteClickRef.current = false;
                });
              }}
              onClick={() => {
                if (isNoteSelectMode) {
                  toggleBulkNoteSelection(note.id);
                  return;
                }
                if (skipNoteClickRef.current) {
                  skipNoteClickRef.current = false;
                  return;
                }
                flushTitlePromote();
                void flushEditorDraft();
                setSelectedId(note.id);
              }}
            >
              {isNoteSelectMode && (
                <input
                  type="checkbox"
                  className="note-select-checkbox"
                  checked={bulkSelectedNoteIds.includes(note.id)}
                  tabIndex={-1}
                  readOnly
                  aria-hidden="true"
                />
              )}
              {note.isPinned && <span className="note-pin-indicator" aria-label="ปักหมุด">📌</span>}
              <strong data-tooltip={note.title || 'ไม่มีชื่อ'}>
                {renderSearchHighlight(note.title || 'ไม่มีชื่อ', query)}
              </strong>
              <span data-tooltip={note.content || 'ยังไม่มีเนื้อหา'}>
                {renderSearchHighlight(note.content || 'ยังไม่มีเนื้อหา', query)}
              </span>
              <small
                className={`note-sync-row is-${noteBadgeStatus(note, syncState)}`}
                data-tooltip={`${NOTE_BADGE_TITLE[noteBadgeStatus(note, syncState)]} · แก้ไขล่าสุด ${formatDate(note.updatedAt)}`}
              >
                <SyncStatusIcon status={noteBadgeStatus(note, syncState)} />
                <span className="sync-label">
                  {NOTE_BADGE_LABEL[noteBadgeStatus(note, syncState)]}
                </span>
                <span className="sync-separator" aria-hidden="true">·</span>
                <time dateTime={note.updatedAt}>
                  {formatDate(note.updatedAt)}
                </time>
              </small>
            </div>
            ))}
          </div>

          {query.trim() && queryMatchedNotes.length > 0 && (
            <div className="note-search-markers" aria-label={`พบ ${queryMatchedNotes.length} โน้ต`}>
              {queryMatchedNotes.map((note) => {
                const originalIndex = notes.findIndex((item) => item.id === note.id);
                const markerPosition = notes.length > 1
                  ? (originalIndex / (notes.length - 1)) * 100
                  : 0;
                return (
                  <button
                    type="button"
                    key={note.id}
                    className={selectedNote?.id === note.id ? 'active' : ''}
                    style={{ top: `${markerPosition}%` }}
                    title={note.title || 'ไม่มีชื่อ'}
                    aria-label={`ไปยัง ${note.title || 'ไม่มีชื่อ'}`}
                    onClick={() => {
                      setSelectedId(note.id);
                      scrollNoteIntoView(note.id);
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="trash-slot">
          <section className={`trash-panel ${isTrashOpen ? 'open' : 'collapsed'}`}>
          <button
            type="button"
            className="trash-toggle"
            aria-expanded={isTrashOpen}
            onClick={toggleTrashPanel}
          >
            <span aria-hidden="true">🗑</span>
            <span>ถังขยะ</span>
            <small>{deletedNotes.length} รายการ</small>
          </button>
          <div className="trash-body" aria-hidden={!isTrashOpen}>
            {deletedNotes.length === 0 ? (
              <p className="trash-empty">ยังไม่มีโน้ตที่ถูกลบ</p>
            ) : (
              <div className="trash-list">
                <div className="trash-list-toolbar">
                  <div className="trash-list-toolbar-row">
                    {isTrashSelectMode ? (
                      <>
                        <span>{bulkSelectedTrashIds.length} ที่เลือก</span>
                        <div className="trash-list-toolbar-links">
                          <button
                            type="button"
                            className="trash-select-link"
                            onClick={() => setBulkSelectedTrashIds(deletedNotes.map((note) => note.id))}
                          >
                            เลือกทั้งหมด
                          </button>
                          <button type="button" className="trash-select-link" onClick={toggleTrashSelectMode}>
                            ยกเลิก
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span>รายการในถังขยะ</span>
                        <button type="button" className="trash-select-link" onClick={toggleTrashSelectMode}>
                          เลือกหลายรายการ
                        </button>
                      </>
                    )}
                  </div>
                  {!isTrashSelectMode && (
                    <div className="trash-list-toolbar-actions">
                      <button
                        type="button"
                        className="trash-restore-all"
                        onClick={() => void handleRestoreAllNotes()}
                      >
                        กู้คืนทั้งหมด
                      </button>
                      <button
                        type="button"
                        className="trash-delete-all"
                        onClick={() => setIsClearTrashConfirmOpen(true)}
                      >
                        ลบทั้งหมด
                      </button>
                    </div>
                  )}
                </div>

                {isTrashSelectMode && (
                  <div className="trash-bulk-actions">
                    <button
                      type="button"
                      className="trash-restore-all"
                      disabled={bulkSelectedTrashIds.length === 0}
                      onClick={() => void handleRestoreSelectedTrash()}
                    >
                      กู้คืนที่เลือก{bulkSelectedTrashIds.length > 0 ? ` (${bulkSelectedTrashIds.length})` : ''}
                    </button>
                    <button
                      type="button"
                      className="trash-delete-all"
                      disabled={bulkSelectedTrashIds.length === 0}
                      onClick={() => setIsBulkPermanentDeleteConfirmOpen(true)}
                    >
                      ลบที่เลือก{bulkSelectedTrashIds.length > 0 ? ` (${bulkSelectedTrashIds.length})` : ''}
                    </button>
                  </div>
                )}

                {deletedNotes.map((note) => (
                  <div
                    className={`trash-item ${isTrashSelectMode ? 'select-mode' : ''} ${bulkSelectedTrashIds.includes(note.id) ? 'selected' : ''}`}
                    key={note.id}
                    role={isTrashSelectMode ? 'button' : undefined}
                    tabIndex={isTrashSelectMode ? 0 : undefined}
                    onClick={() => {
                      if (isTrashSelectMode) toggleBulkTrashSelection(note.id);
                    }}
                    onKeyDown={(event) => {
                      if (!isTrashSelectMode) return;
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      toggleBulkTrashSelection(note.id);
                    }}
                  >
                    {isTrashSelectMode && (
                      <input
                        type="checkbox"
                        className="trash-select-checkbox"
                        checked={bulkSelectedTrashIds.includes(note.id)}
                        readOnly
                        tabIndex={-1}
                        aria-hidden="true"
                      />
                    )}
                    <div>
                      <strong>{note.title || 'ไม่มีชื่อ'}</strong>
                      <small>{note.deletedAt ? `ลบเมื่อ ${formatDate(note.deletedAt)}` : 'อยู่ในถังขยะ'}</small>
                    </div>
                    {!isTrashSelectMode && (
                      <div className="trash-actions">
                        <button type="button" onClick={() => void handleRestoreNote(note.id)}>
                          กู้คืน
                        </button>
                        <button
                          type="button"
                          className="trash-delete"
                          onClick={() => setPendingPermanentDeleteNote(note)}
                        >
                          ลบถาวร
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          </section>
        </div>

      </aside>

      <section className="editor-panel">
        <header className="topbar">
          <div className="topbar-content">
            <div className="status-group">
              <SmoothSyncStatus
                state={topbarStatusState}
                message={topbarStatusMessage}
                transient={isSaving || Boolean(lastSavedMessage)}
              />
            </div>
            <div className="actions">
              <div className="zoom-controls" aria-label="ปรับขนาดหน้าต่างโปรแกรม">
                <button
                  type="button"
                  onClick={() => setAppZoom((current) => clamp(Number((current - ZOOM_STEP).toFixed(2)), ZOOM_MIN, ZOOM_MAX))}
                >
                  −
                </button>
                <span>{Math.round(appZoom * 100)}%</span>
                <button
                  type="button"
                  onClick={() => setAppZoom((current) => clamp(Number((current + ZOOM_STEP).toFixed(2)), ZOOM_MIN, ZOOM_MAX))}
                >
                  +
                </button>
                <button type="button" className="reset-button" onClick={() => setAppZoom(1)}>⟳ รีเซ็ต</button>
              </div>
              <div className="note-zoom-controls topbar-note-zoom" aria-label="ย่อขยายแผ่นเขียนโน้ต">
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setNoteZoom((current) => clamp(Number((current - ZOOM_STEP).toFixed(2)), ZOOM_MIN, ZOOM_MAX))}
                >
                  −
                </button>
                <span>แผ่น {Math.round(noteZoom * 100)}%</span>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setNoteZoom((current) => clamp(Number((current + ZOOM_STEP).toFixed(2)), ZOOM_MIN, ZOOM_MAX))}
                >
                  +
                </button>
              </div>
              <button className="sync-button" onClick={handleSync} disabled={syncState === 'syncing'}>
                {syncState === 'syncing' ? 'กำลังซิงก์...' : '☁ Sync Now'}
              </button>
            </div>
          </div>
        </header>

        {selectedNote ? (
          <div className="editor">
            <div className="title-row">
            <div
              className="title-input title-editor-shell"
              style={titleInputStyle}
              onPointerDownCapture={() => {
                activeFormatTargetRef.current = 'title';
                setActiveFormatTarget('title');
              }}
              onContextMenu={(event) => openFormatContextMenu(event, 'title')}
            >
              <CodeMirrorNoteEditor
                key={`title-${selectedNote.id}`}
                ref={titleCodeEditorRef}
                value={selectedNote.title}
                contentHtml={getTitleContentHtml(selectedNote.contentHtml, selectedNote.title)}
                style={titleInputStyle}
                placeholder="หัวข้อโน้ต"
                singleLine
                onChange={(value) => {
                  const normalizedTitle = value.replace(/[\r\n]+/g, ' ');
                  if (normalizedTitle !== value) {
                    titleCodeEditorRef.current?.setValue(normalizedTitle);
                    return;
                  }
                  const titleHtml = titleCodeEditorRef.current?.getHtml() ?? escapePlainTextForEditor(normalizedTitle);
                  titleHtmlRef.current = titleHtml;
                  const bodyHtml = codeEditorRef.current?.getHtml() ?? getBodyContentHtml(selectedNote.contentHtml);
                  patchSelectedNoteTitleThrottled({
                    title: normalizedTitle,
                    contentHtml: combineTitleAndBodyHtml(titleHtml, bodyHtml)
                  });
                }}
                onFormatChange={(title, titleHtml) => {
                  const normalizedTitle = title.replace(/[\r\n]+/g, ' ');
                  titleHtmlRef.current = titleHtml;
                  const bodyHtml = codeEditorRef.current?.getHtml() ?? getBodyContentHtml(selectedNote.contentHtml);
                  void patchSelectedNote({
                    title: normalizedTitle,
                    contentHtml: combineTitleAndBodyHtml(titleHtml, bodyHtml)
                  });
                }}
                onBoldStateChange={(active) => {
                  if (activeFormatTargetRef.current === 'title') setIsBoldButtonActive(active);
                }}
                onWeightStateChange={(weight) => {
                  if (activeFormatTargetRef.current === 'title' && !isApplyingWeightFromToolbarRef.current) {
                    setFontWeightInput(weight);
                  }
                }}
                onColorStateChange={(color) => {
                  if (activeFormatTargetRef.current === 'title') {
                    setTextColorInput(normalizeColorInputValue(color, selectedNote.textColor));
                  }
                }}
                onFontSizeStateChange={(fontSize) => {
                  if (activeFormatTargetRef.current === 'title') setFontSizeInput(String(fontSize));
                }}
                onFontFamilyStateChange={(fontFamily) => {
                  if (activeFormatTargetRef.current === 'title') setFontFamilyInput(fontFamily);
                }}
                onFocus={() => {
                  activeFormatTargetRef.current = 'title';
                  setActiveFormatTarget('title');
                  clearSavedSelectionHighlight();
                  clearMultiLineSelection();
                }}
                onOpenFind={openFindReplacePanel}
              />
            </div>
            <button
              type="button"
              className="title-delete-button"
              onClick={handleDeleteNote}
              disabled={!selectedNote}
              title="ลบโน้ต"
              aria-label="ลบโน้ต"
            >
              🗑
            </button>
            </div>
            <div
              ref={noteCanvasRef}
              className="note-canvas-viewport"
              onWheel={(event) => {
                if (!event.ctrlKey) return;
                event.preventDefault();
                event.stopPropagation();
                const direction = event.deltaY < 0 ? 1 : -1;
                setNoteZoom((current) => clamp(Number((current + direction * ZOOM_STEP).toFixed(2)), ZOOM_MIN, ZOOM_MAX));
              }}
            >
              <div
                ref={editorRef}
                className="content-input rich-content-input codemirror-editor-shell"
                data-selected-lines-count={columnSelections.length}
                data-multi-cursor-count={cursors.length}
                style={selectedNoteStyle}
                onPointerDownCapture={() => {
                  activeFormatTargetRef.current = 'body';
                  setActiveFormatTarget('body');
                }}
                onContextMenu={(event) => openFormatContextMenu(event, 'body')}
              >
                <CodeMirrorNoteEditor
                  key={`body-${selectedNote.id}`}
                  ref={codeEditorRef}
                  value={selectedNote.content}
                  contentHtml={getBodyContentHtml(selectedNote.contentHtml)}
                  style={selectedNoteStyle}
                  placeholder="เขียนโน้ตของคุณที่นี่..."
                  onChange={(value) => {
                    codeEditorValueRef.current = value;
                    syncRichEditorContent();
                  }}
                  onFormatChange={(content, contentHtml) => {
                    if (!selectedNote) return;
                    codeEditorValueRef.current = content;
                    promoteSavedNote(selectedNote.id, {
                      content,
                      contentHtml: combineTitleAndBodyHtml(
                        titleCodeEditorRef.current?.getHtml() ?? titleHtmlRef.current,
                        contentHtml
                      )
                    }, new Date().toISOString());
                  }}
                  onBoldStateChange={(active) => {
                    if (activeFormatTargetRef.current === 'body') setIsBoldButtonActive(active);
                  }}
                  onWeightStateChange={(weight) => {
                    if (activeFormatTargetRef.current === 'body' && !isApplyingWeightFromToolbarRef.current) {
                      setFontWeightInput(weight);
                    }
                  }}
                  onColorStateChange={(color) => {
                    if (activeFormatTargetRef.current === 'body') {
                      setTextColorInput(normalizeColorInputValue(color, selectedNote.textColor));
                    }
                  }}
                  onFontSizeStateChange={(fontSize) => {
                    if (activeFormatTargetRef.current === 'body') setFontSizeInput(String(fontSize));
                  }}
                  onFontFamilyStateChange={(fontFamily) => {
                    if (activeFormatTargetRef.current === 'body') setFontFamilyInput(fontFamily);
                  }}
                  onFocus={() => {
                    activeFormatTargetRef.current = 'body';
                    setActiveFormatTarget('body');
                    clearSavedSelectionHighlight();
                  }}
                  onBlur={() => {
                    // Windows Emoji/Clipboard History temporarily removes
                    // focus from the browser. Flushing here re-synchronizes
                    // CodeMirror while Windows is still inserting text and
                    // causes the target selection to be lost.
                    window.setTimeout(() => {
                      if (!document.hasFocus() || codeEditorRef.current?.hasFocus()) return;
                      void flushEditorDraft();
                    }, 0);
                  }}
                  onOpenFind={openFindReplacePanel}
                  onEscapeSmartSelection={clearEditorSmartSelection}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <h2>{auth.cloudEnabled && !auth.user ? 'เข้าสู่ระบบเพื่อดูโน้ต' : 'ยังไม่มีโน้ต'}</h2>
            <p>
              {auth.cloudEnabled && !auth.user
                ? 'เมื่อเข้าสู่ระบบแล้ว โน้ตที่เคยซิงก์ไว้จะกลับมาแสดงที่นี่'
                : 'กด + ใหม่ เพื่อสร้างโน้ตแรก'}
            </p>
          </div>
        )}
      </section>


      {isExportPickerOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="export-notes-title">
          <div className="modal-card export-notes-modal">
            <div className="export-notes-header">
              <div>
                <h2 id="export-notes-title">ส่งออกโน้ตหลายรายการ</h2>
                <p>เลือกโน้ตที่ต้องการบันทึกเป็นไฟล์ .txt</p>
              </div>
              <span>{exportSelectedIds.length} รายการ</span>
            </div>

            <div className="export-notes-toolbar">
              <button
                type="button"
                onClick={() => setExportSelectedIds(notes.map((note) => note.id))}
              >
                เลือกทั้งหมด
              </button>
              <button type="button" onClick={() => setExportSelectedIds([])}>
                ล้างที่เลือก
              </button>
            </div>

            <div className="export-notes-list">
              {notes.map((note) => {
                const isChecked = exportSelectedIds.includes(note.id);
                return (
                  <label className={`export-note-option ${isChecked ? 'selected' : ''}`} key={note.id}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleExportSelection(note.id)}
                    />
                    <span>
                      <strong>{note.title || 'ไม่มีชื่อ'}</strong>
                      <small>{note.content || 'ยังไม่มีเนื้อหา'}</small>
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setIsExportPickerOpen(false);
                  setExportSelectedIds([]);
                }}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={exportSelectedIds.length === 0}
                onClick={() => void handleExportTextFiles()}
              >
                ส่งออก {exportSelectedIds.length} ไฟล์
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDeleteNote && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-note-title">
          <div className="modal-card danger-modal">
            <h2 id="delete-note-title">ต้องการลบแผ่นงานนี้หรือไม่ ?</h2>
            <p>โน้ต “{pendingDeleteNote.title || 'ไม่มีชื่อ'}” จะถูกย้ายไปถังขยะ และสามารถกู้คืนกลับมาได้ภายหลัง</p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setPendingDeleteNote(null)}>
                ยกเลิก
              </button>
              <button type="button" className="danger-button" onClick={() => void confirmDeleteNote()}>
                ยืนยัน
              </button>
            </div>
          </div>
        </div>
      )}

      {isBulkDeleteConfirmOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-note-title">
          <div className="modal-card danger-modal">
            <h2 id="bulk-delete-note-title">ต้องการลบโน้ต {bulkSelectedNoteIds.length} รายการหรือไม่ ?</h2>
            <p>โน้ตที่เลือกไว้จะถูกย้ายไปถังขยะ และสามารถกู้คืนกลับมาได้ภายหลัง</p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setIsBulkDeleteConfirmOpen(false)}>
                ยกเลิก
              </button>
              <button type="button" className="danger-button" onClick={() => void confirmBulkDeleteNotes()}>
                ยืนยัน
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingPermanentDeleteNote && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="permanent-delete-note-title">
          <div className="modal-card danger-modal">
            <h2 id="permanent-delete-note-title">ลบถาวรจากถังขยะหรือไม่ ?</h2>
            <p>โน้ต “{pendingPermanentDeleteNote.title || 'ไม่มีชื่อ'}” จะถูกลบถาวร และไม่สามารถกู้คืนกลับมาได้</p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setPendingPermanentDeleteNote(null)}>
                ยกเลิก
              </button>
              <button type="button" className="danger-button" onClick={() => void confirmPermanentDeleteNote()}>
                ลบถาวร
              </button>
            </div>
          </div>
        </div>
      )}

      {isClearTrashConfirmOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="clear-trash-title">
          <div className="modal-card danger-modal">
            <h2 id="clear-trash-title">ลบโน้ตในถังขยะทั้งหมดหรือไม่ ?</h2>
            <p>โน้ตในถังขยะทั้งหมด {deletedNotes.length} รายการ จะถูกลบถาวร และไม่สามารถกู้คืนกลับมาได้</p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setIsClearTrashConfirmOpen(false)}>
                ยกเลิก
              </button>
              <button type="button" className="danger-button" onClick={() => void confirmClearTrash()}>
                ลบทั้งหมด
              </button>
            </div>
          </div>
        </div>
      )}

      {isBulkPermanentDeleteConfirmOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="bulk-permanent-delete-title">
          <div className="modal-card danger-modal">
            <h2 id="bulk-permanent-delete-title">ลบโน้ต {bulkSelectedTrashIds.length} รายการถาวรหรือไม่ ?</h2>
            <p>โน้ตที่เลือกไว้จะถูกลบถาวร และไม่สามารถกู้คืนกลับมาได้</p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setIsBulkPermanentDeleteConfirmOpen(false)}>
                ยกเลิก
              </button>
              <button type="button" className="danger-button" onClick={() => void confirmBulkPermanentDeleteTrash()}>
                ลบถาวร
              </button>
            </div>
          </div>
        </div>
      )}

      {isWhatsNewOpen && (
        <WhatsNewModal entries={CHANGELOG.slice(0, WHATS_NEW_VISIBLE_COUNT)} onClose={() => setIsWhatsNewOpen(false)} />
      )}

      {isGoToLineOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="go-to-line-title">
          <form
            className="modal-card"
            onSubmit={(event) => {
              event.preventDefault();
              confirmGoToLine();
            }}
          >
            <h2 id="go-to-line-title">ไปยังบรรทัด</h2>
            <p>พิมพ์หมายเลขบรรทัดที่ต้องการ แล้วกด Enter</p>
            <input
              className="modal-input"
              type="number"
              min="1"
              value={goToLineInput}
              onChange={(event) => setGoToLineInput(event.target.value)}
              autoFocus
            />
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setIsGoToLineOpen(false)}>
                ยกเลิก
              </button>
              <button type="submit" className="primary-button">
                ไปยังบรรทัด
              </button>
            </div>
          </form>
        </div>
      )}
      </main>
      {formatContextMenuPortal}
      {findPanelPortal}
      <CustomTooltip />
    </>
  );
}
