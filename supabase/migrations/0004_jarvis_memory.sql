-- Jarvis's memory: things it learns about Lucas (people, preferences, facts, plans) and brings up later.
create table public.memories (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text not null default 'dato' check (kind in ('dato','persona','preferencia','plan','recuerdo','idea')),
  content     text not null,
  importance  smallint not null default 2 check (importance between 1 and 3),
  -- Optional link to something in the HUB this memory is about.
  item_id     text references public.items (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index memories_user_idx on public.memories (user_id, created_at desc);

create trigger memories_touch before update on public.memories
  for each row execute function public.touch_updated_at();

alter table public.memories enable row level security;
create policy "own memories" on public.memories for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
