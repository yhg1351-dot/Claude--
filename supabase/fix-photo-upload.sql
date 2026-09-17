-- 사진 업로드 403 오류 수정
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요. (경고가 떠도 Run query 를 누르면 됩니다)
create or replace function public.is_group_active(p_code text)
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (select 1 from public.group_sessions gs where gs.code = p_code)
$$;
