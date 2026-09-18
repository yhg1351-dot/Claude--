-- 교사 화면 "편집" 기능용 설정. Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요.
create table if not exists public.app_config (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
alter table public.app_config enable row level security;
drop policy if exists anyone_read_config on public.app_config;
create policy anyone_read_config on public.app_config for select to anon, authenticated using (true);
drop policy if exists teacher_insert_config on public.app_config;
create policy teacher_insert_config on public.app_config for insert to authenticated with check (true);
drop policy if exists teacher_update_config on public.app_config;
create policy teacher_update_config on public.app_config for update to authenticated using (true) with check (true);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assets', 'assets', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];
drop policy if exists anyone_read_assets on storage.objects;
create policy anyone_read_assets on storage.objects for select to anon, authenticated using (bucket_id = 'assets');
drop policy if exists teacher_write_assets on storage.objects;
create policy teacher_write_assets on storage.objects for insert to authenticated with check (bucket_id = 'assets');
drop policy if exists teacher_update_assets on storage.objects;
create policy teacher_update_assets on storage.objects for update to authenticated using (bucket_id = 'assets') with check (bucket_id = 'assets');
drop policy if exists teacher_delete_assets on storage.objects;
create policy teacher_delete_assets on storage.objects for delete to authenticated using (bucket_id = 'assets');
