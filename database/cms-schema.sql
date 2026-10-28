create extension if not exists pgcrypto;

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  password_hash text not null,
  role text not null default 'admin' check (role = 'admin'),
  failed_login_count integer not null default 0 check (failed_login_count >= 0),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_sessions (
  token_hash text primary key check (length(token_hash) = 64),
  csrf_hash text not null check (length(csrf_hash) = 64),
  user_id uuid not null references public.admin_users(id) on delete cascade,
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  check (expires_at <= absolute_expires_at)
);

create index if not exists admin_sessions_user_id_idx
  on public.admin_sessions(user_id);
create index if not exists admin_sessions_expiry_idx
  on public.admin_sessions(expires_at);

create table if not exists public.admin_password_resets (
  token_hash text primary key check (length(token_hash) = 64),
  user_id uuid not null references public.admin_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists admin_password_resets_user_id_idx
  on public.admin_password_resets(user_id);
create index if not exists admin_password_resets_expiry_idx
  on public.admin_password_resets(expires_at);

create or replace function public.consume_admin_password_reset(
  p_token_hash text,
  p_password_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reset_user_id uuid;
begin
  select user_id into reset_user_id
  from public.admin_password_resets
  where token_hash = p_token_hash and expires_at > now()
  for update;

  if reset_user_id is null then
    return false;
  end if;

  update public.admin_users
  set
    password_hash = p_password_hash,
    failed_login_count = 0,
    locked_until = null,
    updated_at = now()
  where id = reset_user_id and role = 'admin';

  if not found then
    return false;
  end if;

  delete from public.admin_sessions where user_id = reset_user_id;
  delete from public.admin_password_resets where user_id = reset_user_id;
  return true;
end;
$$;

revoke all on function public.consume_admin_password_reset(text, text)
  from public, anon, authenticated;
grant execute on function public.consume_admin_password_reset(text, text)
  to service_role;

create or replace function public.create_first_admin(
  p_email text,
  p_password_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('the-shrub-lodge-first-admin'));

  if exists (select 1 from public.admin_users) then
    return false;
  end if;

  insert into public.admin_users (email, password_hash, role)
  values (lower(trim(p_email)), p_password_hash, 'admin');

  return true;
end;
$$;

revoke all on function public.create_first_admin(text, text)
  from public, anon, authenticated;
grant execute on function public.create_first_admin(text, text)
  to service_role;

create or replace function public.record_admin_login_failure(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.admin_users
  set
    failed_login_count = case
      when locked_until > now() then failed_login_count
      when locked_until is not null then 1
      else failed_login_count + 1
    end,
    locked_until = case
      when locked_until > now() then locked_until
      when (
        case
          when locked_until is not null then 1
          else failed_login_count + 1
        end
      ) >= 5 then now() + interval '15 minutes'
      else null
    end,
    updated_at = now()
  where id = p_user_id and role = 'admin';
$$;

revoke all on function public.record_admin_login_failure(uuid)
  from public, anon, authenticated;
grant execute on function public.record_admin_login_failure(uuid)
  to service_role;

create table if not exists public.site_content (
  key text primary key,
  value jsonb not null,
  updated_by uuid references public.admin_users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.works (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null check (length(trim(title)) between 1 and 200),
  description text not null default '',
  images text[] not null default '{}',
  category text not null check (length(trim(category)) between 1 and 100),
  link text,
  work_date date,
  position integer not null default 0,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists works_public_order_idx
  on public.works(published, position, work_date desc);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null check (length(trim(title)) between 1 and 200),
  excerpt text not null default '',
  content text not null default '',
  cover_image text,
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'published')),
  scheduled_for timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'scheduled' or scheduled_for is not null)
);

create index if not exists posts_publication_idx
  on public.posts(status, published_at desc, scheduled_for);

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  public_url text not null,
  file_name text not null,
  mime_type text not null
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 10485760),
  alt_text text not null default '',
  uploaded_by uuid references public.admin_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  email text not null,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists contact_messages_created_idx
  on public.contact_messages(created_at desc);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.admin_users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_logs_created_idx
  on public.activity_logs(created_at desc);

alter table public.admin_users enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.admin_password_resets enable row level security;
alter table public.site_content enable row level security;
alter table public.works enable row level security;
alter table public.posts enable row level security;
alter table public.media_assets enable row level security;
alter table public.contact_messages enable row level security;
alter table public.activity_logs enable row level security;

revoke all on public.admin_users, public.admin_sessions, public.admin_password_resets,
  public.site_content,
  public.works, public.posts, public.media_assets, public.contact_messages,
  public.activity_logs from anon, authenticated;

grant all on public.admin_users, public.admin_sessions, public.admin_password_resets,
  public.site_content,
  public.works, public.posts, public.media_assets, public.contact_messages,
  public.activity_logs to service_role;

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
values (
  'site-media',
  'site-media',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can view site media" on storage.objects;
create policy "Public can view site media"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'site-media');
