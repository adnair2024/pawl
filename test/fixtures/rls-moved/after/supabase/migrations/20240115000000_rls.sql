alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.comments enable row level security;
-- recreate a policy with the same name and rule, and add a stricter one
drop policy "owner write" on public.posts;
create policy "owner write" on public.posts for all to authenticated using (auth.uid() = owner);
create policy "no anon" on public.posts as restrictive for all to anon using (false);
create table public.tags (id bigint primary key);
alter table public.tags enable row level security;
