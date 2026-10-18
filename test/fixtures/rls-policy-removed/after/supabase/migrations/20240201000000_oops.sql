alter table public.profiles disable row level security;
drop policy "owner write" on public.posts;
alter policy c_read on public.comments using (true);
create table public.invoices (id bigint primary key, amount numeric);
