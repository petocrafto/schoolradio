alter table public.schedules
  add column if not exists program_name text not null default 'Untitled program';

alter table public.schedule_overrides
  add column if not exists program_name text not null default 'Untitled program';
