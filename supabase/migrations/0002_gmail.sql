-- Gmail connection for the "important unread mail" box.
-- Tokens are never readable through the API directly: only through the functions below.

create table public.gmail_tokens (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  refresh_token text not null,
  email         text not null default '',
  updated_at    timestamptz not null default now()
);
alter table public.gmail_tokens enable row level security; -- no policies: no direct access

-- Hash of the server secret the Vercel callback uses to save a token.
create table public.app_secrets (
  name  text primary key,
  hash  bytea not null
);
alter table public.app_secrets enable row level security; -- no policies

-- Called by the OAuth callback on the server, which proves itself with HUB_DB_SECRET.
create or replace function public.hub_save_gmail_token(p_user uuid, p_token text, p_email text, p_secret text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.app_secrets
    where name = 'gmail_store' and hash = extensions.digest(p_secret, 'sha256')
  ) then
    raise exception 'forbidden';
  end if;
  insert into public.gmail_tokens (user_id, refresh_token, email, updated_at)
  values (p_user, p_token, coalesce(p_email, ''), now())
  on conflict (user_id) do update
    set refresh_token = excluded.refresh_token, email = excluded.email, updated_at = now();
end $$;

-- The signed-in person's own token, for the mail route.
create or replace function public.hub_gmail_token()
returns text language sql security definer set search_path = '' stable as $$
  select refresh_token from public.gmail_tokens where user_id = (select auth.uid());
$$;

create or replace function public.hub_gmail_disconnect()
returns void language sql security definer set search_path = '' as $$
  delete from public.gmail_tokens where user_id = (select auth.uid());
$$;

revoke all on function public.hub_save_gmail_token(uuid, text, text, text) from public;
revoke all on function public.hub_gmail_token() from public;
revoke all on function public.hub_gmail_disconnect() from public;
grant execute on function public.hub_save_gmail_token(uuid, text, text, text) to anon, authenticated;
grant execute on function public.hub_gmail_token() to authenticated;
grant execute on function public.hub_gmail_disconnect() to authenticated;
-- Supabase grants new functions to anon by default; these two only make sense signed in.
revoke execute on function public.hub_gmail_token() from anon;
revoke execute on function public.hub_gmail_disconnect() from anon;

-- After applying, register the secret once (not stored in the repo):
--   insert into public.app_secrets (name, hash) values ('gmail_store', extensions.digest('<HUB_DB_SECRET>', 'sha256'));
