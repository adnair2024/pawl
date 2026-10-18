create table public.profiles (id uuid primary key, name text);
create policy "own profile" on public.profiles for select to authenticated using (auth.uid() = id);

create table public.posts (id bigint primary key, owner uuid);
create policy "owner write" on public.posts for all to authenticated using (auth.uid() = owner);

create table public.comments (id bigint);
create policy c_read on public.comments for select using (auth.uid() is not null);
