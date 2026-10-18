create table if not exists public.comments (id bigint);
alter table comments enable row level security;
create policy c_read on comments for select using (true);
alter policy c_read on comments using (auth.uid() is not null);

do $$ begin execute 'alter table public.audit enable row level security'; end $$;
do $$ begin perform 1; end $$;
