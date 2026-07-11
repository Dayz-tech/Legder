-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run

create table if not exists journal_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  trades jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Added for multi-account support — safe to run even if you already ran the block above.
alter table journal_data add column if not exists accounts jsonb not null default '{}'::jsonb;
alter table journal_data add column if not exists active_account_id text;

alter table journal_data enable row level security;

-- Each user can only ever read or write their own single row
drop policy if exists "Users can view own journal data" on journal_data;
create policy "Users can view own journal data"
  on journal_data for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own journal data" on journal_data;
create policy "Users can insert own journal data"
  on journal_data for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own journal data" on journal_data;
create policy "Users can update own journal data"
  on journal_data for update
  using (auth.uid() = user_id);