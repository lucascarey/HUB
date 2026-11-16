-- Gym: every set you log (exercise, weight, reps) is one row.
create table public.gym_logs (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  exercise   text not null,
  kg         numeric(6,2) not null default 0,
  reps       integer not null default 0,
  sets       integer not null default 1,
  date       date not null default current_date,
  created_at timestamptz not null default now()
);
create index gym_logs_user_idx on public.gym_logs (user_id, date);

alter table public.gym_logs enable row level security;
create policy "own gym logs" on public.gym_logs for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
