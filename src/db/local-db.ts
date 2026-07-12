import type { NoteRow } from '../types/note';

type SqlDatabase = {
  execute: (sql: string, bindValues?: unknown[]) => Promise<unknown>;
  select: <T = unknown>(sql: string, bindValues?: unknown[]) => Promise<T[]>;
};

let dbPromise: Promise<SqlDatabase | null> | null = null;

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function getSqliteDb(): Promise<SqlDatabase | null> {
  if (!isTauriRuntime()) return null;
  if (!dbPromise) {
    dbPromise = import('@tauri-apps/plugin-sql')
      .then(async (module) => module.default.load('sqlite:cloudpad.db') as Promise<SqlDatabase>)
      .catch((error) => {
        console.warn('SQLite plugin unavailable; falling back to localStorage.', error);
        return null;
      });
  }
  return dbPromise;
}

export async function initLocalDb(): Promise<void> {
  const db = await getSqliteDb();
  if (!db) return;

  await db.execute(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      cloud_id TEXT,
      user_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_html TEXT,
      font_size INTEGER NOT NULL DEFAULT 16,
      text_color TEXT NOT NULL DEFAULT '#172033',
      font_weight TEXT NOT NULL DEFAULT '400',
      font_family TEXT NOT NULL DEFAULT '"Google Sans Text", "Google Sans", Inter, ui-sans-serif, system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      note_order INTEGER NOT NULL DEFAULT 0,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      version INTEGER NOT NULL DEFAULT 1
    )
  `);

  await ensureColumn(db, 'font_size', 'INTEGER NOT NULL DEFAULT 16');
  await ensureColumn(db, 'content_html', 'TEXT');
  await ensureColumn(db, 'text_color', "TEXT NOT NULL DEFAULT '#172033'");
  await ensureColumn(db, 'font_weight', "TEXT NOT NULL DEFAULT '400'");
  await ensureColumn(db, 'font_family', 'TEXT NOT NULL DEFAULT \'"Google Sans Text", "Google Sans", Inter, ui-sans-serif, system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji\'');
  await ensureColumn(db, 'is_pinned', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'note_order', 'INTEGER NOT NULL DEFAULT 0');

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_notes_updated_at
    ON notes(updated_at)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_notes_list_order
    ON notes(is_pinned, note_order, updated_at)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_notes_sync_status
    ON notes(sync_status)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_notes_cloud_id
    ON notes(cloud_id)
  `);

}

async function ensureColumn(db: SqlDatabase, columnName: string, definition: string): Promise<void> {
  try {
    await db.execute(`ALTER TABLE notes ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('duplicate column')) {
      throw error;
    }
  }
}

const STORAGE_KEY = 'cloudpad.notes.v1';

export function loadNotesFromStorage(): NoteRow[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as NoteRow[];
  } catch {
    return [];
  }
}

export function saveNotesToStorage(notes: NoteRow[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}
