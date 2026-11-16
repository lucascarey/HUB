-- HUB: everything is an item; items are linked to each other.
create table public.items (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  type       text not null check (type in ('proyecto','tarea','evento','idea','dinero','habito')),
  title      text not null default '',
  parent_id  text references public.items (id) on delete cascade,
  date       date,
  x          integer not null default 0,
  y          integer not null default 0,
  done       boolean not null default false,
  area       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index items_user_idx on public.items (user_id);
create index items_parent_idx on public.items (parent_id);

create table public.links (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  a          text not null references public.items (id) on delete cascade,
  b          text not null references public.items (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index links_user_idx on public.links (user_id);

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger items_touch before update on public.items
  for each row execute function public.touch_updated_at();

-- Each person only ever sees and edits their own HUB.
alter table public.items enable row level security;
alter table public.links enable row level security;

create policy "own items" on public.items for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own links" on public.links for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
