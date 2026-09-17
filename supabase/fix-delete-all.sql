-- "삭제 실패: DELETE requires a WHERE clause" 오류 수정
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요.
create or replace function public.teacher_delete_all()
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    raise exception 'not allowed';
  end if;
  delete from public.submissions where true;
  delete from public.group_sessions where true;
  return jsonb_build_object('ok', true);
end;
$$;
