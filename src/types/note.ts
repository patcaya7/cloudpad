export type SyncStatus = 'synced' | 'pending' | 'conflict' | 'deleted';

export type FontWeight = '300' | '400' | '600' | '700' | '800';

export const EMOJI_FONT_FALLBACK = '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji';

export interface NoteTypography {
  fontSize: number;
  textColor: string;
  fontWeight: FontWeight;
  fontFamily: string;
}

export function withEmojiFontFallback(fontFamily: string): string {
  const normalized = fontFamily.trim();
  if (!normalized) return EMOJI_FONT_FALLBACK;
  return normalized.includes('Segoe UI Emoji')
    || normalized.includes('Apple Color Emoji')
    || normalized.includes('Noto Color Emoji')
    || normalized.includes('emoji')
    ? normalized
    : `${normalized}, ${EMOJI_FONT_FALLBACK}`;
}

export const DEFAULT_FONT_FAMILY = withEmojiFontFallback('"Google Sans Text", "Google Sans", Inter, ui-sans-serif, system-ui');

export const DEFAULT_NOTE_TYPOGRAPHY: NoteTypography = {
  fontSize: 20,
  textColor: '#172033',
  fontWeight: '400',
  fontFamily: DEFAULT_FONT_FAMILY
};

export interface Note {
  id: string;
  cloudId?: string | null;
  userId?: string | null;
  title: string;
  content: string;
  contentHtml: string;
  fontSize: number;
  textColor: string;
  fontWeight: FontWeight;
  fontFamily: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  isPinned: boolean;
  noteOrder: number;
  syncStatus: SyncStatus;
  version: number;
}

export interface NoteRow {
  id: string;
  cloud_id?: string | null;
  user_id?: string | null;
  title: string;
  content: string;
  content_html?: string | null;
  font_size?: number | null;
  text_color?: string | null;
  font_weight?: FontWeight | string | null;
  font_family?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  is_pinned?: number | boolean | null;
  note_order?: number | null;
  sync_status: SyncStatus;
  version: number;
}

export function normalizeTypography(input: Partial<NoteTypography> = {}): NoteTypography {
  const parsedFontSize = Number(input.fontSize);
  const fontSize = Number.isFinite(parsedFontSize)
    ? Math.min(100, Math.max(10, Math.round(parsedFontSize)))
    : DEFAULT_NOTE_TYPOGRAPHY.fontSize;

  const fontWeight = ['300', '400', '600', '700', '800'].includes(String(input.fontWeight))
    ? (String(input.fontWeight) as FontWeight)
    : DEFAULT_NOTE_TYPOGRAPHY.fontWeight;

  return {
    fontSize,
    textColor: input.textColor || DEFAULT_NOTE_TYPOGRAPHY.textColor,
    fontWeight,
    fontFamily: withEmojiFontFallback(input.fontFamily || DEFAULT_NOTE_TYPOGRAPHY.fontFamily)
  };
}

export function rowToNote(row: NoteRow): Note {
  const typography = normalizeTypography({
    fontSize: row.font_size ?? undefined,
    textColor: row.text_color ?? undefined,
    fontWeight: row.font_weight as FontWeight | undefined,
    fontFamily: row.font_family ?? undefined
  });

  return {
    id: row.id,
    cloudId: row.cloud_id ?? null,
    userId: row.user_id ?? null,
    title: row.title,
    content: row.content,
    contentHtml: row.content_html ?? row.content,
    fontSize: typography.fontSize,
    textColor: typography.textColor,
    fontWeight: typography.fontWeight,
    fontFamily: typography.fontFamily,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
    isPinned: Boolean(row.is_pinned),
    noteOrder: Number(row.note_order ?? 0),
    syncStatus: row.sync_status,
    version: row.version
  };
}
