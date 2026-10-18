create table public.profiles (id uuid primary key references auth.users, name text);
alter table public.profiles enable row level security;
create policy "own profile" on public.profiles for select to authenticated using (auth.uid() = id);
create policy "update own" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create table public.posts (id bigint primary key, owner uuid, body text);
alter table public.posts enable row level security;
create policy "public read" on public.posts for select using (true);
create policy "owner write" on public.posts for all to authenticated using (auth.uid() = owner) with check (auth.uid() = owner);

create table public.audit (id bigint primary key);

create table public.secrets (id bigint primary key);
alter table public.secrets enable row level security;
create policy "service only" on public.secrets for all to service_role using (true) with check (true);
create policy "block anon" on public.secrets as restrictive for all using (true);

create table private.internal (id int);
create temp table scratch (id int);
