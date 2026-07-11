-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run

create table if not exists journal_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  trades jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table journal_data enable row level security;

-- Each user can only ever read or write their own single row
create policy "Users can view own journal data"
  on journal_data for select
  using (auth.uid() = user_id);

create policy "Users can insert own journal data"
  on journal_data for insert
  with check (auth.uid() = user_id);

create policy "Users can update own journal data"
  on journal_data for update
  using (auth.uid() = user_id);
