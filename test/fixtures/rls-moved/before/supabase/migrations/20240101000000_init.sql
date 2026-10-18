create table public.profiles (id uuid primary key, name text);
alter table public.profiles enable row level security;
create policy "own profile" on public.profiles for select to authenticated using (auth.uid() = id);

create table public.posts (id bigint primary key, owner uuid);
alter table public.posts enable row level security;
create policy "owner write" on public.posts for all to authenticated using (auth.uid() = owner);

create table public.comments (id bigint);
alter table public.comments enable row level security;
create policy c_read on public.comments for select using (auth.uid() is not null);
