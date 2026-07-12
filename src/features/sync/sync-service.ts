import { supabase } from '../../cloud/supabase';
import type { Note } from '../../types/note';
import {
  applyCloudNote,
  getPendingNotes,
  listAllNotes,
  setNoteSyncMetadata,
  type CloudNote
} from '../notes/note-repository';

export type SyncResult = {
  ok: boolean;
  message: string;
  uploadedCount: number;
  downloadedCount: number;
};

const BASE_NOTE_COLUMNS = 'id,user_id,title,content,created_at,updated_at,deleted_at,version';
const NOTE_COLUMNS_WITH_TYPOGRAPHY =
  'id,user_id,title,content,content_html,font_size,text_color,font_weight,font_family,created_at,updated_at,deleted_at,version';

let remoteSupportsTypography: boolean | null = null;

function getNoteColumns(): string {
  return remoteSupportsTypography === false ? BASE_NOTE_COLUMNS : NOTE_COLUMNS_WITH_TYPOGRAPHY;
}

function isTypographyColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return ['content_html', 'font_size', 'text_color', 'font_weight', 'font_family'].some((column) =>
    message.toLowerCase().includes(column)
  );
}

function notePayload(note: Note, userId: string, includeTypography = remoteSupportsTypography !== false) {
  const payload = {
    user_id: userId,
    title: note.title,
    content: note.content,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
    deleted_at: note.deletedAt ?? null,
    version: note.version
  };

  if (!includeTypography) return payload;

  return {
    ...payload,
    content_html: note.contentHtml,
    font_size: note.fontSize,
    text_color: note.textColor,
    font_weight: note.fontWeight,
    font_family: note.fontFamily
  };
}

function isRemoteNewer(remote: CloudNote, local: Note): boolean {
  return new Date(remote.updated_at).getTime() > new Date(local.updatedAt).getTime();
}

async function fetchRemoteNote(cloudId: string, userId: string): Promise<CloudNote | null> {
  if (!supabase) return null;
  let { data, error } = await supabase
    .from('notes')
    .select(getNoteColumns() as '*')
    .eq('id', cloudId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error && remoteSupportsTypography !== false && isTypographyColumnError(error)) {
    remoteSupportsTypography = false;
    const retry = await supabase
      .from('notes')
      .select(BASE_NOTE_COLUMNS as '*')
      .eq('id', cloudId)
      .eq('user_id', userId)
      .maybeSingle();
    data = retry.data;
    error = retry.error;
  } else if (!error && remoteSupportsTypography !== false) {
    remoteSupportsTypography = true;
  }

  if (error) throw error;
  return data as CloudNote | null;
}

async function uploadPendingNote(note: Note, userId: string): Promise<'uploaded' | 'downloaded'> {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');

  if (note.cloudId) {
    const remote = await fetchRemoteNote(note.cloudId, userId);
    if (remote && isRemoteNewer(remote, note)) {
      await applyCloudNote(remote);
      return 'downloaded';
    }
  }

  if (note.cloudId) {
    let { error } = await supabase
      .from('notes')
      .update(notePayload(note, userId))
      .eq('id', note.cloudId)
      .eq('user_id', userId);

    if (error && remoteSupportsTypography !== false && isTypographyColumnError(error)) {
      remoteSupportsTypography = false;
      const retry = await supabase
        .from('notes')
        .update(notePayload(note, userId, false))
        .eq('id', note.cloudId)
        .eq('user_id', userId);
      error = retry.error;
    } else if (!error && remoteSupportsTypography !== false) {
      remoteSupportsTypography = true;
    }

    if (error) throw error;

    await setNoteSyncMetadata(note.id, {
      cloudId: note.cloudId,
      userId,
      syncStatus: 'synced'
    });
    return 'uploaded';
  }

  let { data, error } = await supabase
    .from('notes')
    .insert(notePayload(note, userId))
    .select(getNoteColumns() as '*')
    .single();

  if (error && remoteSupportsTypography !== false && isTypographyColumnError(error)) {
    remoteSupportsTypography = false;
    const retry = await supabase
      .from('notes')
      .insert(notePayload(note, userId, false))
      .select(BASE_NOTE_COLUMNS as '*')
      .single();
    data = retry.data;
    error = retry.error;
  } else if (!error && remoteSupportsTypography !== false) {
    remoteSupportsTypography = true;
  }

  if (error) throw error;

  await setNoteSyncMetadata(note.id, {
    cloudId: data.id as string,
    userId,
    syncStatus: 'synced',
    updatedAt: data.updated_at as string,
    deletedAt: (data.deleted_at as string | null) ?? null,
    version: data.version as number
  });
  return 'uploaded';
}

async function runSyncNotes(): Promise<SyncResult> {
  if (!supabase) {
    return {
      ok: false,
      message: 'Local-only · ยังไม่ได้ตั้งค่า Supabase',
      uploadedCount: 0,
      downloadedCount: 0
    };
  }

  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser();

  if (userError) throw userError;
  if (!user) {
    return {
      ok: false,
      message: 'Local-only · เข้าสู่ระบบเพื่อซิงก์ Cloud',
      uploadedCount: 0,
      downloadedCount: 0
    };
  }

  let uploadedCount = 0;
  let downloadedCount = 0;
  const pending = await getPendingNotes(user.id);

  for (const note of pending) {
    const action = await uploadPendingNote(note, user.id);
    if (action === 'uploaded') uploadedCount += 1;
    else downloadedCount += 1;
  }

  let { data, error } = await supabase
    .from('notes')
    .select(getNoteColumns() as '*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: true });

  if (error && remoteSupportsTypography !== false && isTypographyColumnError(error)) {
    remoteSupportsTypography = false;
    const retry = await supabase
      .from('notes')
      .select(BASE_NOTE_COLUMNS as '*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: true });
    data = retry.data;
    error = retry.error;
  } else if (!error && remoteSupportsTypography !== false) {
    remoteSupportsTypography = true;
  }

  if (error) throw error;

  const localNotes = await listAllNotes();
  for (const remote of (data ?? []) as CloudNote[]) {
    const local = localNotes.find((note) => note.cloudId === remote.id);
    if (!local || isRemoteNewer(remote, local)) {
      await applyCloudNote(remote);
      downloadedCount += 1;
    }
  }

  const total = uploadedCount + downloadedCount;
  return {
    ok: true,
    message: total === 0
      ? 'ข้อมูลตรงกับ Cloud แล้ว'
      : `ซิงก์สำเร็จ: อัปโหลด ${uploadedCount} ดาวน์โหลด ${downloadedCount}`,
    uploadedCount,
    downloadedCount
  };
}

let activeSync: Promise<SyncResult> | null = null;

export function syncNotes(): Promise<SyncResult> {
  if (!activeSync) {
    activeSync = runSyncNotes().finally(() => {
      activeSync = null;
    });
  }
  return activeSync;
}

export const syncPendingNotes = syncNotes;
