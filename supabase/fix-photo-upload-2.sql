-- 교사 로그인이 남아 있는 브라우저에서도 사진 업로드가 되도록 규칙 확장
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요.
drop policy if exists student_upload_photos on storage.objects;
create policy student_upload_photos on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'photos' and public.is_group_active((storage.foldername(name))[1]));
drop policy if exists student_upsert_photos on storage.objects;
create policy student_upsert_photos on storage.objects for update to anon, authenticated
  using (bucket_id = 'photos')
  with check (bucket_id = 'photos' and public.is_group_active((storage.foldername(name))[1]));
