-- 학생 앱 '보기 모드'(모둠원 모두 접속, 제출은 대표 폰만) 지원 함수
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요.

-- 보기 모드용: 모둠 코드만으로 진행 상황(어떤 미션을 제출했는지)과 대표 폰 유무를 조회 (답 내용은 제외)
create or replace function public.get_group_progress(p_code text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  rows jsonb;
  s public.group_sessions%rowtype;
begin
  if p_code !~ '^[0-9]{4,5}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'mission_id', mission_id, 'place_id', place_id,
    'photo_count', coalesce(array_length(photo_paths, 1), 0),
    'updated_at', updated_at
  )), '[]'::jsonb) into rows
  from public.submissions where group_code = p_code;
  select * into s from public.group_sessions where code = p_code;
  return jsonb_build_object(
    'ok', true, 'submissions', rows,
    'rep', jsonb_build_object(
      'exists', found,
      'active', found and s.last_seen > now() - public.lock_timeout(),
      'last_seen', case when found then s.last_seen else null end
    )
  );
end;
$$;
revoke all on function public.get_group_progress(text) from public;
grant execute on function public.get_group_progress(text) to anon, authenticated;
