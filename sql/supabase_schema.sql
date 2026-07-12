-- Run this file in the Supabase SQL Editor.

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  content text not null,
  content_html text,
  font_size integer not null default 16,
  text_color text not null default '#172033',
  font_weight text not null default '400',
  font_family text not null default 'Inter, ui-sans-serif, system-ui',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

alter table public.notes
add column if not exists content_html text;

alter table public.notes
add column if not exists font_size integer not null default 16;

alter table public.notes
add column if not exists text_color text not null default '#172033';

alter table public.notes
add column if not exists font_weight text not null default '400';

alter table public.notes
add column if not exists font_family text not null default 'Inter, ui-sans-serif, system-ui';

create index if not exists notes_user_updated_idx
on public.notes(user_id, updated_at desc);

alter table public.notes enable row level security;

grant select, insert, update, delete
on table public.notes
to authenticated;

drop policy if exists "Users can read own notes" on public.notes;
create policy "Users can read own notes"
on public.notes
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can insert own notes" on public.notes;
create policy "Users can insert own notes"
on public.notes
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can update own notes" on public.notes;
create policy "Users can update own notes"
on public.notes
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete own notes" on public.notes;
create policy "Users can delete own notes"
on public.notes
for delete
to authenticated
using (auth.uid() = user_id);
