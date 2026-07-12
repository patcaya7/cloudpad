import { getSqliteDb, initLocalDb, loadNotesFromStorage, saveNotesToStorage } from '../../db/local-db';
import type { Note, NoteRow, NoteTypography, SyncStatus } from '../../types/note';
import { DEFAULT_NOTE_TYPOGRAPHY, normalizeTypography, rowToNote } from '../../types/note';

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function noteToRow(note: Note): NoteRow {
  return {
    id: note.id,
    cloud_id: note.cloudId ?? null,
    user_id: note.userId ?? null,
    title: note.title,
    content: note.content,
    content_html: note.contentHtml,
    font_size: note.fontSize,
    text_color: note.textColor,
    font_weight: note.fontWeight,
    font_family: note.fontFamily,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
    deleted_at: note.deletedAt ?? null,
    is_pinned: note.isPinned ? 1 : 0,
    note_order: note.noteOrder,
    sync_status: note.syncStatus,
    version: note.version
  };
}

let setupPromise: Promise<void> | null = null;

async function runSetupNotes(): Promise<void> {
  await initLocalDb();
}

export function setupNotes(): Promise<void> {
  if (!setupPromise) setupPromise = runSetupNotes();
  return setupPromise;
}

export type ListNotesOptions = {
  userId?: string | null;
  includeUnassigned?: boolean;
};

function matchesUser(row: NoteRow, options: ListNotesOptions = {}): boolean {
  if (options.userId) return row.user_id === options.userId;
  if (options.includeUnassigned) return !row.user_id;
  return true;
}

function userWhereClause(options: ListNotesOptions = {}): {
  clause: string;
  params: unknown[];
} {
  if (options.userId) {
    return {
      clause: ' AND user_id = ?',
      params: [options.userId]
    };
  }

  if (options.includeUnassigned) {
    return {
      clause: ' AND user_id IS NULL',
      params: []
    };
  }

  return {
    clause: '',
    params: []
  };
}

export async function listNotes(options: ListNotesOptions = {}): Promise<Note[]> {
  const db = await getSqliteDb();
  if (db) {
    const userFilter = userWhereClause(options);
    const rows = await db.select<NoteRow>(
      `SELECT * FROM notes
       WHERE deleted_at IS NULL${userFilter.clause}
       ORDER BY is_pinned DESC, note_order ASC, updated_at DESC`,
      userFilter.params
    );
    return rows.map(rowToNote);
  }

  return loadNotesFromStorage()
    .filter((row) => !row.deleted_at && matchesUser(row, options))
    .sort((a, b) => {
      const pinnedDiff = Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned));
      if (pinnedDiff !== 0) return pinnedDiff;
      const orderDiff = Number(a.note_order ?? 0) - Number(b.note_order ?? 0);
      if (orderDiff !== 0) return orderDiff;
      return b.updated_at.localeCompare(a.updated_at);
    })
    .map(rowToNote);
}

export async function listDeletedNotes(options: ListNotesOptions = {}): Promise<Note[]> {
  const db = await getSqliteDb();
  if (db) {
    const userFilter = userWhereClause(options);
    const rows = await db.select<NoteRow>(
      `SELECT * FROM notes WHERE deleted_at IS NOT NULL${userFilter.clause} ORDER BY deleted_at DESC`,
      userFilter.params
    );
    return rows.map(rowToNote);
  }

  return loadNotesFromStorage()
    .filter((row) => Boolean(row.deleted_at) && matchesUser(row, options))
    .sort((a, b) => String(b.deleted_at ?? '').localeCompare(String(a.deleted_at ?? '')))
    .map(rowToNote);
}

export async function listAllNotes(): Promise<Note[]> {
  const db = await getSqliteDb();
  if (db) {
    const rows = await db.select<NoteRow>('SELECT * FROM notes ORDER BY updated_at DESC');
    return rows.map(rowToNote);
  }

  return loadNotesFromStorage()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map(rowToNote);
}

export async function getPendingNotes(userId?: string): Promise<Note[]> {
  const db = await getSqliteDb();
  if (db) {
    const userFilter = userId ? ' AND user_id = ?' : '';
    const rows = await db.select<NoteRow>(
      `SELECT * FROM notes
       WHERE sync_status IN ('pending', 'deleted', 'conflict')${userFilter}
       ORDER BY updated_at ASC`,
      userId ? [userId] : []
    );
    return rows.map(rowToNote);
  }

  return loadNotesFromStorage()
    .filter(
      (row) =>
        ['pending', 'deleted', 'conflict'].includes(row.sync_status) &&
        (!userId || row.user_id === userId)
    )
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
    .map(rowToNote);
}

export async function createNote(
  input?: Partial<Pick<Note, 'title' | 'content' | 'contentHtml' | 'userId'> & NoteTypography>
): Promise<Note> {
  const timestamp = nowIso();
  const typography = normalizeTypography(input);
  const note: Note = {
    id: newId(),
    cloudId: null,
    userId: input?.userId ?? null,
    title: input?.title ?? 'Untitled',
    content: input?.content ?? '',
    contentHtml: input?.contentHtml ?? input?.content ?? '',
    fontSize: typography.fontSize,
    textColor: typography.textColor,
    fontWeight: typography.fontWeight,
    fontFamily: typography.fontFamily,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    isPinned: false,
    noteOrder: Date.now(),
    syncStatus: 'pending',
    version: 1
  };

  const db = await getSqliteDb();
  if (db) {
    await db.execute(
      `INSERT INTO notes
       (id, cloud_id, user_id, title, content, content_html, font_size, text_color, font_weight, font_family, created_at, updated_at, deleted_at, is_pinned, note_order, sync_status, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        note.id,
        note.cloudId,
        note.userId,
        note.title,
        note.content,
        note.contentHtml,
        note.fontSize,
        note.textColor,
        note.fontWeight,
        note.fontFamily,
        note.createdAt,
        note.updatedAt,
        note.deletedAt,
        note.isPinned ? 1 : 0,
        note.noteOrder,
        note.syncStatus,
        note.version
      ]
    );
    return note;
  }

  const notes = loadNotesFromStorage();
  notes.push(noteToRow(note));
  saveNotesToStorage(notes);
  return note;
}

export async function updateNote(
  id: string,
  patch: Partial<Pick<Note, 'title' | 'content' | 'contentHtml' | 'cloudId' | 'userId'> & NoteTypography> & {
    syncStatus?: SyncStatus;
  }
): Promise<Note | null> {
  const existing = (await listAllNotes()).find((note) => note.id === id);
  if (!existing) return null;

  const updated: Note = {
    ...existing,
    ...patch,
    updatedAt: nowIso(),
    syncStatus: patch.syncStatus ?? 'pending',
    version: existing.version + 1
  };

  const db = await getSqliteDb();
  if (db) {
    await db.execute(
      `UPDATE notes
       SET cloud_id = ?, user_id = ?, title = ?, content = ?, content_html = ?, font_size = ?, text_color = ?, font_weight = ?, font_family = ?, updated_at = ?, sync_status = ?, version = ?
       WHERE id = ?`,
      [
        updated.cloudId ?? null,
        updated.userId ?? null,
        updated.title,
        updated.content,
        updated.contentHtml,
        updated.fontSize,
        updated.textColor,
        updated.fontWeight,
        updated.fontFamily,
        updated.updatedAt,
        updated.syncStatus,
        updated.version,
        id
      ]
    );
    return updated;
  }

  saveNotesToStorage(
    loadNotesFromStorage().map((row) => (row.id === id ? noteToRow(updated) : row))
  );
  return updated;
}

export async function updateNotePin(id: string, isPinned: boolean): Promise<void> {
  const db = await getSqliteDb();
  if (db) {
    await db.execute('UPDATE notes SET is_pinned = ? WHERE id = ?', [isPinned ? 1 : 0, id]);
    return;
  }

  saveNotesToStorage(
    loadNotesFromStorage().map((row) =>
      row.id === id ? { ...row, is_pinned: isPinned ? 1 : 0 } : row
    )
  );
}

export async function updateNoteListOrder(orderedIds: string[]): Promise<void> {
  const orderById = new Map(orderedIds.map((id, index) => [id, (index + 1) * 1000]));
  const db = await getSqliteDb();
  if (db) {
    for (const [id, order] of orderById) {
      await db.execute('UPDATE notes SET note_order = ? WHERE id = ?', [order, id]);
    }
    return;
  }

  saveNotesToStorage(
    loadNotesFromStorage().map((row) =>
      orderById.has(row.id) ? { ...row, note_order: orderById.get(row.id) ?? 0 } : row
    )
  );
}

export async function softDeleteNote(id: string): Promise<void> {
  const existing = (await listAllNotes()).find((note) => note.id === id);
  if (!existing) return;
  const deletedAt = nowIso();

  const db = await getSqliteDb();
  if (db) {
    await db.execute(
      `UPDATE notes
       SET deleted_at = ?, updated_at = ?, sync_status = 'deleted', version = version + 1
       WHERE id = ?`,
      [deletedAt, deletedAt, id]
    );
    return;
  }

  saveNotesToStorage(
    loadNotesFromStorage().map((row) =>
      row.id === id
        ? {
            ...row,
            deleted_at: deletedAt,
            updated_at: deletedAt,
            sync_status: 'deleted' as SyncStatus,
            version: row.version + 1
          }
        : row
    )
  );
}

export async function restoreDeletedNote(id: string): Promise<void> {
  const existing = (await listAllNotes()).find((note) => note.id === id);
  if (!existing) return;
  const updatedAt = nowIso();

  const db = await getSqliteDb();
  if (db) {
    await db.execute(
      `UPDATE notes
       SET deleted_at = NULL, updated_at = ?, sync_status = 'pending', version = version + 1
       WHERE id = ?`,
      [updatedAt, id]
    );
    return;
  }

  saveNotesToStorage(
    loadNotesFromStorage().map((row) =>
      row.id === id
        ? {
            ...row,
            deleted_at: null,
            updated_at: updatedAt,
            sync_status: 'pending' as SyncStatus,
            version: row.version + 1
          }
        : row
    )
  );
}

export async function permanentlyDeleteNote(id: string): Promise<void> {
  const db = await getSqliteDb();
  if (db) {
    await db.execute('DELETE FROM notes WHERE id = ?', [id]);
    return;
  }

  saveNotesToStorage(loadNotesFromStorage().filter((row) => row.id !== id));
}

export type CloudNote = {
  id: string;
  user_id: string;
  title: string;
  content: string;
  content_html?: string | null;
  font_size?: number | null;
  text_color?: string | null;
  font_weight?: string | null;
  font_family?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
};

export async function applyCloudNote(cloudNote: CloudNote): Promise<Note> {
  const existing = (await listAllNotes()).find((note) => note.cloudId === cloudNote.id);
  const typography = normalizeTypography({
    fontSize: cloudNote.font_size ?? DEFAULT_NOTE_TYPOGRAPHY.fontSize,
    textColor: cloudNote.text_color ?? DEFAULT_NOTE_TYPOGRAPHY.textColor,
    fontWeight: (cloudNote.font_weight ?? DEFAULT_NOTE_TYPOGRAPHY.fontWeight) as NoteTypography['fontWeight'],
    fontFamily: cloudNote.font_family ?? DEFAULT_NOTE_TYPOGRAPHY.fontFamily
  });
  const note: Note = {
    id: existing?.id ?? newId(),
    cloudId: cloudNote.id,
    userId: cloudNote.user_id,
    title: cloudNote.title,
    content: cloudNote.content,
    contentHtml: cloudNote.content_html ?? cloudNote.content,
    fontSize: typography.fontSize,
    textColor: typography.textColor,
    fontWeight: typography.fontWeight,
    fontFamily: typography.fontFamily,
    createdAt: cloudNote.created_at,
    updatedAt: cloudNote.updated_at,
    deletedAt: cloudNote.deleted_at,
    isPinned: existing?.isPinned ?? false,
    noteOrder: existing?.noteOrder ?? Date.now(),
    syncStatus: 'synced',
    version: cloudNote.version
  };

  const db = await getSqliteDb();
  if (db) {
    await db.execute(
      `INSERT INTO notes
       (id, cloud_id, user_id, title, content, content_html, font_size, text_color, font_weight, font_family, created_at, updated_at, deleted_at, is_pinned, note_order, sync_status, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)
       ON CONFLICT(id) DO UPDATE SET
         cloud_id = excluded.cloud_id,
         user_id = excluded.user_id,
         title = excluded.title,
         content = excluded.content,
         content_html = excluded.content_html,
         font_size = excluded.font_size,
         text_color = excluded.text_color,
         font_weight = excluded.font_weight,
         font_family = excluded.font_family,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at,
         sync_status = 'synced',
         version = excluded.version`,
      [
        note.id,
        note.cloudId,
        note.userId,
        note.title,
        note.content,
        note.contentHtml,
        note.fontSize,
        note.textColor,
        note.fontWeight,
        note.fontFamily,
        note.createdAt,
        note.updatedAt,
        note.deletedAt,
        note.isPinned ? 1 : 0,
        note.noteOrder,
        note.version
      ]
    );
    return note;
  }

  const rows = loadNotesFromStorage();
  const index = rows.findIndex((row) => row.id === note.id || row.cloud_id === note.cloudId);
  if (index >= 0) rows[index] = noteToRow(note);
  else rows.push(noteToRow(note));
  saveNotesToStorage(rows);
  return note;
}

export async function setNoteSyncMetadata(
  id: string,
  values: {
    cloudId?: string | null;
    userId?: string | null;
    syncStatus?: SyncStatus;
    updatedAt?: string;
    deletedAt?: string | null;
    version?: number;
  }
): Promise<void> {
  const existing = (await listAllNotes()).find((note) => note.id === id);
  if (!existing) return;

  const updated: Note = {
    ...existing,
    cloudId: values.cloudId !== undefined ? values.cloudId : existing.cloudId,
    userId: values.userId !== undefined ? values.userId : existing.userId,
    syncStatus: values.syncStatus ?? existing.syncStatus,
    updatedAt: values.updatedAt ?? existing.updatedAt,
    deletedAt: values.deletedAt !== undefined ? values.deletedAt : existing.deletedAt,
    version: values.version ?? existing.version
  };

  const db = await getSqliteDb();
  if (db) {
    await db.execute(
      `UPDATE notes
       SET cloud_id = ?, user_id = ?, sync_status = ?, updated_at = ?, deleted_at = ?, version = ?
       WHERE id = ?`,
      [
        updated.cloudId ?? null,
        updated.userId ?? null,
        updated.syncStatus,
        updated.updatedAt,
        updated.deletedAt ?? null,
        updated.version,
        id
      ]
    );
    return;
  }

  saveNotesToStorage(
    loadNotesFromStorage().map((row) => (row.id === id ? noteToRow(updated) : row))
  );
}
