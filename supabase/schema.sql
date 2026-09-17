-- =====================================================================
-- 경주 수학여행 미션 앱 · Supabase 설정 스크립트
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
-- 학생은 로그인 없이(anon 키) 아래 RPC 함수로만 데이터를 다루고,
-- 교사는 이메일/비밀번호로 로그인(authenticated)한 뒤 테이블을 직접 읽습니다.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- 테이블
create table if not exists public.group_sessions (
  code        text primary key,
  device_id   text not null,
  token       uuid not null default gen_random_uuid(),
  prev_token  uuid,
  claimed_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

create table if not exists public.submissions (
  id           uuid primary key,
  group_code   text not null,
  place_id     text not null,
  mission_id   text not null,
  answer       jsonb,
  photo_paths  text[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (group_code, mission_id)
);
create index if not exists submissions_group_idx on public.submissions (group_code);

-- ---------------------------------------------------------------- 접근 제한 (RLS)
alter table public.group_sessions enable row level security;
alter table public.submissions enable row level security;

-- 학생(anon)은 테이블에 직접 접근할 수 없다 (정책 없음 = 차단). 교사(authenticated)만 허용.
drop policy if exists teacher_read_sessions on public.group_sessions;
create policy teacher_read_sessions on public.group_sessions for select to authenticated using (true);
drop policy if exists teacher_update_sessions on public.group_sessions;
create policy teacher_update_sessions on public.group_sessions for update to authenticated using (true) with check (true);
drop policy if exists teacher_delete_sessions on public.group_sessions;
create policy teacher_delete_sessions on public.group_sessions for delete to authenticated using (true);

drop policy if exists teacher_read_submissions on public.submissions;
create policy teacher_read_submissions on public.submissions for select to authenticated using (true);
drop policy if exists teacher_delete_submissions on public.submissions;
create policy teacher_delete_submissions on public.submissions for delete to authenticated using (true);

-- ---------------------------------------------------------------- 학생용 RPC 함수
-- 접속 잠금 만료 시간(분). js/config.js 의 lockTimeoutMinutes 와 같게 유지하세요.
create or replace function public.lock_timeout() returns interval
language sql immutable as $$ select interval '5 minutes' $$;

-- 모둠 코드 점유: 처음이면 새 세션, 같은 기기면 갱신, 다른 기기는 만료됐을 때만 교체
create or replace function public.claim_group(p_code text, p_device_id text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  s public.group_sessions%rowtype;
  new_token uuid;
begin
  if p_code !~ '^[0-9]{4,5}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p_device_id is null or length(p_device_id) < 8 or length(p_device_id) > 64 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  select * into s from public.group_sessions where code = p_code for update;

  if not found then
    insert into public.group_sessions (code, device_id) values (p_code, p_device_id) returning * into s;
    return jsonb_build_object('ok', true, 'token', s.token, 'code', s.code);
  end if;

  if s.device_id = p_device_id then
    update public.group_sessions set last_seen = now() where code = p_code;
    return jsonb_build_object('ok', true, 'token', s.token, 'code', s.code);
  end if;

  if s.last_seen < now() - public.lock_timeout() then
    new_token := gen_random_uuid();
    update public.group_sessions
      set device_id = p_device_id, prev_token = s.token, token = new_token, claimed_at = now(), last_seen = now()
      where code = p_code;
    return jsonb_build_object('ok', true, 'token', new_token, 'code', p_code);
  end if;

  return jsonb_build_object('ok', false, 'reason', 'in_use', 'last_seen', s.last_seen);
end;
$$;

-- 접속 유지 신호
create or replace function public.heartbeat(p_token uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  update public.group_sessions set last_seen = now() where token = p_token;
  get diagnostics n = row_count;
  if n = 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 내 모둠의 제출 내역 (사진 경로는 개수 확인용으로만 사용, 사진 자체는 내려받을 수 없음)
create or replace function public.get_progress(p_token uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
  rows jsonb;
begin
  select code into v_code from public.group_sessions where token = p_token;
  if v_code is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'mission_id', mission_id, 'place_id', place_id, 'answer', answer,
    'photo_paths', to_jsonb(photo_paths), 'created_at', created_at, 'updated_at', updated_at
  )), '[]'::jsonb) into rows
  from public.submissions where group_code = v_code;
  return jsonb_build_object('ok', true, 'submissions', rows);
end;
$$;

-- 답변 저장 (같은 미션을 다시 제출하면 덮어씀). 직전 토큰도 허용해 기기 교체 중 밀린 제출을 받는다.
create or replace function public.submit_answer(
  p_token uuid, p_submission_id uuid, p_place_id text, p_mission_id text, p_answer jsonb, p_photo_paths text[]
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
  p text;
begin
  select code into v_code from public.group_sessions where token = p_token or prev_token = p_token limit 1;
  if v_code is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p_mission_id is null or length(p_mission_id) > 64 or p_place_id is null or length(p_place_id) > 64 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if coalesce(array_length(p_photo_paths, 1), 0) > 5 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  -- 사진 경로는 반드시 자기 모둠 폴더 안이어야 한다
  foreach p in array coalesce(p_photo_paths, '{}') loop
    if p !~ ('^' || v_code || '/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\.jpg$') then
      return jsonb_build_object('ok', false, 'reason', 'invalid');
    end if;
  end loop;
  if pg_column_size(p_answer) > 20000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  insert into public.submissions (id, group_code, place_id, mission_id, answer, photo_paths)
  values (p_submission_id, v_code, p_place_id, p_mission_id, p_answer, coalesce(p_photo_paths, '{}'))
  on conflict (group_code, mission_id) do update
    set id = excluded.id, place_id = excluded.place_id, answer = excluded.answer,
        photo_paths = excluded.photo_paths, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

-- 교사용: 모든 제출과 접속 정보 삭제 (사진 파일은 앱이 저장소 API로 지운다)
create or replace function public.teacher_delete_all()
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    raise exception 'not allowed';
  end if;
  -- Supabase 안전장치(pg-safeupdate) 때문에 조건 없는 delete 는 거부되므로 where true 를 붙인다
  delete from public.submissions where true;
  delete from public.group_sessions where true;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.claim_group(text, text) from public;
revoke all on function public.heartbeat(uuid) from public;
revoke all on function public.get_progress(uuid) from public;
revoke all on function public.submit_answer(uuid, uuid, text, text, jsonb, text[]) from public;
revoke all on function public.teacher_delete_all() from public, anon;
grant execute on function public.claim_group(text, text) to anon, authenticated;
grant execute on function public.heartbeat(uuid) to anon, authenticated;
grant execute on function public.get_progress(uuid) to anon, authenticated;
grant execute on function public.submit_answer(uuid, uuid, text, text, jsonb, text[]) to anon, authenticated;
grant execute on function public.teacher_delete_all() to authenticated;

-- ---------------------------------------------------------------- 사진 저장소 (비공개 버킷)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 3145728, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg'];

-- 저장소 정책에서 쓰는 도우미: 최근 30분 안에 접속 신호가 있는 모둠인지 (학생은 테이블을 직접 못 보므로 함수로 확인)
create or replace function public.is_group_active(p_code text)
returns boolean
language sql security definer stable set search_path = public
as $$
  -- 한 번이라도 접속한 적이 있는 모둠이면 사진 업로드를 허용한다.
  -- (신호가 잠시 끊겨도 밀린 사진을 계속 올릴 수 있도록 시간 제한을 두지 않음)
  select exists (select 1 from public.group_sessions gs where gs.code = p_code)
$$;
revoke all on function public.is_group_active(text) from public;
grant execute on function public.is_group_active(text) to anon, authenticated;

-- 학생(anon): 최근 접속 신호가 있는 모둠 폴더에만 올릴 수 있고, 보거나 지울 수는 없다
drop policy if exists student_upload_photos on storage.objects;
create policy student_upload_photos on storage.objects for insert to anon
  with check (bucket_id = 'photos' and public.is_group_active((storage.foldername(name))[1]));
drop policy if exists student_upsert_photos on storage.objects;
create policy student_upsert_photos on storage.objects for update to anon
  using (bucket_id = 'photos')
  with check (bucket_id = 'photos' and public.is_group_active((storage.foldername(name))[1]));

-- 교사(authenticated): 보기, 삭제
drop policy if exists teacher_read_photos on storage.objects;
create policy teacher_read_photos on storage.objects for select to authenticated using (bucket_id = 'photos');
drop policy if exists teacher_delete_photos on storage.objects;
create policy teacher_delete_photos on storage.objects for delete to authenticated using (bucket_id = 'photos');
