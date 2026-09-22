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
    return jsonb_build_object('ok', false, 'reason', 'bad_data');
  end if;
  if coalesce(array_length(p_photo_paths, 1), 0) > 6 then
    return jsonb_build_object('ok', false, 'reason', 'bad_data');
  end if;
  -- 사진 경로는 반드시 자기 모둠 폴더 안이어야 한다
  foreach p in array coalesce(p_photo_paths, '{}') loop
    if p !~ ('^' || v_code || '/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\.jpg$') then
      return jsonb_build_object('ok', false, 'reason', 'bad_data');
    end if;
  end loop;
  if pg_column_size(p_answer) > 20000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_data');
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

-- 학생: 접속한 적 있는 모둠 폴더에만 올릴 수 있고, 보거나 지울 수는 없다.
-- (같은 브라우저에 교사 로그인이 남아 있어도 올릴 수 있도록 authenticated 도 허용)
drop policy if exists student_upload_photos on storage.objects;
create policy student_upload_photos on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'photos' and public.is_group_active((storage.foldername(name))[1]));
drop policy if exists student_upsert_photos on storage.objects;
create policy student_upsert_photos on storage.objects for update to anon, authenticated
  using (bucket_id = 'photos')
  with check (bucket_id = 'photos' and public.is_group_active((storage.foldername(name))[1]));

-- 교사(authenticated): 보기, 삭제
drop policy if exists teacher_read_photos on storage.objects;
create policy teacher_read_photos on storage.objects for select to authenticated using (bucket_id = 'photos');
drop policy if exists teacher_delete_photos on storage.objects;
create policy teacher_delete_photos on storage.objects for delete to authenticated using (bucket_id = 'photos');

-- ---------------------------------------------------------------- 교사 편집용 설정 저장 (일정·장소·미션)
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

-- 안내 이미지용 공개 사진함 (학생이 로그인 없이 볼 수 있어야 하므로 public). 올리기·지우기는 교사만.
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
-- ---------------------------------------------------------------- 도장 표
create table if not exists public.stamps (
  group_code  text not null,
  mission_id  text not null,
  auto        boolean not null default false,   -- 퀴즈 정답으로 자동 부여된 도장
  created_at  timestamptz not null default now(),
  primary key (group_code, mission_id)
);
alter table public.stamps enable row level security;
drop policy if exists teacher_read_stamps on public.stamps;
create policy teacher_read_stamps on public.stamps for select to authenticated using (true);
drop policy if exists teacher_write_stamps on public.stamps;
create policy teacher_write_stamps on public.stamps for insert to authenticated with check (true);
drop policy if exists teacher_update_stamps on public.stamps;
create policy teacher_update_stamps on public.stamps for update to authenticated using (true) with check (true);
drop policy if exists teacher_delete_stamps on public.stamps;
create policy teacher_delete_stamps on public.stamps for delete to authenticated using (true);

-- ---------------------------------------------------------------- 답변 저장 + 퀴즈 정답이면 자동 도장
create or replace function public.submit_answer(
  p_token uuid, p_submission_id uuid, p_place_id text, p_mission_id text, p_answer jsonb, p_photo_paths text[]
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
  p text;
  v_m jsonb;
  v_correct boolean := null;
begin
  select code into v_code from public.group_sessions where token = p_token or prev_token = p_token limit 1;
  if v_code is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p_mission_id is null or length(p_mission_id) > 64 or p_place_id is null or length(p_place_id) > 64 then
    return jsonb_build_object('ok', false, 'reason', 'bad_data');
  end if;
  if coalesce(array_length(p_photo_paths, 1), 0) > 6 then
    return jsonb_build_object('ok', false, 'reason', 'bad_data');
  end if;
  foreach p in array coalesce(p_photo_paths, '{}') loop
    if p !~ ('^' || v_code || '/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\.jpg$') then
      return jsonb_build_object('ok', false, 'reason', 'bad_data');
    end if;
  end loop;
  if pg_column_size(p_answer) > 20000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_data');
  end if;

  insert into public.submissions (id, group_code, place_id, mission_id, answer, photo_paths)
  values (p_submission_id, v_code, p_place_id, p_mission_id, p_answer, coalesce(p_photo_paths, '{}'))
  on conflict (group_code, mission_id) do update
    set id = excluded.id, place_id = excluded.place_id, answer = excluded.answer,
        photo_paths = excluded.photo_paths, updated_at = now();

  -- 교사 편집본(app_config)에서 이 미션을 찾아 객관식 정답이면 자동 도장
  select m into v_m
  from public.app_config c,
       jsonb_each(c.data->'places') pl,
       jsonb_array_elements(coalesce(pl.value->'missions', '[]'::jsonb)) m
  where c.id = 'trip' and m->>'id' = p_mission_id
  limit 1;
  if v_m is not null and v_m->>'type' = 'choice' and (p_answer ? 'choice') then
    v_correct := (v_m->>'answer')::int = (p_answer->>'choice')::int;
    if v_correct then
      insert into public.stamps (group_code, mission_id, auto) values (v_code, p_mission_id, true)
      on conflict (group_code, mission_id) do nothing;
    else
      -- 오답으로 다시 제출하면 자동 도장만 거둔다 (교사가 찍은 도장은 유지)
      delete from public.stamps where group_code = v_code and mission_id = p_mission_id and auto;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'correct', v_correct);
end;
$$;

-- ---------------------------------------------------------------- 진행 상황 조회에 도장 포함
create or replace function public.get_progress(p_token uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
  rows jsonb;
  st jsonb;
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
  select coalesce(jsonb_agg(jsonb_build_object('mission_id', mission_id, 'created_at', created_at)), '[]'::jsonb) into st
  from public.stamps where group_code = v_code;
  return jsonb_build_object('ok', true, 'submissions', rows, 'stamps', st);
end;
$$;

create or replace function public.get_group_progress(p_code text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  rows jsonb;
  st jsonb;
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
  select coalesce(jsonb_agg(jsonb_build_object('mission_id', mission_id, 'created_at', created_at)), '[]'::jsonb) into st
  from public.stamps where group_code = p_code;
  select * into s from public.group_sessions where code = p_code;
  return jsonb_build_object(
    'ok', true, 'submissions', rows, 'stamps', st,
    'rep', jsonb_build_object(
      'exists', found,
      'active', found and s.last_seen > now() - public.lock_timeout(),
      'last_seen', case when found then s.last_seen else null end
    )
  );
end;
$$;

-- 전체 삭제에 도장도 포함
create or replace function public.teacher_delete_all()
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    raise exception 'not allowed';
  end if;
  delete from public.stamps where true;
  delete from public.submissions where true;
  delete from public.group_sessions where true;
  return jsonb_build_object('ok', true);
end;
$$;

-- =====================================================================
-- 업데이트 2 (여행 전 안정성 보완). Supabase SQL 편집기에서 전체를 붙여 넣고 실행하세요.
-- 데이터는 바뀌지 않으며 여러 번 실행해도 안전합니다. 앱 코드가 먼저 배포된 뒤(푸시 후 2~3분) 실행하세요.
-- 내용: 교사 '해제'가 대표 폰을 실제로 끊음, 사진 업로드 규칙 강화(덮어쓰기 금지·최근 활동 모둠만),
--       이전 토큰 2시간 뒤 만료, 동시 첫 접속 충돌 방지, 학생 앱용 설정(정답 제외) 함수.
-- =====================================================================

-- 1) 모둠 코드 점유: 동시 접속 잠금 + (설정이 있으면) 실제 존재하는 모둠 코드만 허용
create or replace function public.claim_group(p_code text, p_device_id text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  s public.group_sessions%rowtype;
  new_token uuid;
  cfg jsonb;
  v_ok boolean;
begin
  if p_code !~ '^[0-9]{4,5}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p_device_id is null or length(p_device_id) < 8 or length(p_device_id) > 64 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  -- 두 폰이 정확히 같은 순간 처음 접속해도 한 줄씩 처리한다
  perform pg_advisory_xact_lock(hashtext('claim:' || p_code));

  -- 교사 편집본이 있으면 학년·반·모둠 수에 맞는 코드만 받는다 (없는 모둠 폴더가 만들어지지 않게)
  select c.data into cfg from public.app_config c where c.id = 'trip';
  if cfg is not null and cfg->'trip'->'classes' is not null then
    select exists (
      select 1 from jsonb_array_elements(cfg->'trip'->'classes') cl
      where (cfg->'trip'->>'grade')::int = substr(p_code, 1, 1)::int
        and (cl->>'class')::int = substr(p_code, 2, 1)::int
        and substr(p_code, 3)::int between 1 and (cl->>'groups')::int
    ) into v_ok;
    if not v_ok then
      return jsonb_build_object('ok', false, 'reason', 'invalid');
    end if;
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
grant execute on function public.claim_group(text, text) to anon, authenticated;

-- 2) 모둠 상태 조회 (학생 앱이 '해제됨'과 '지워짐'을 구분해 처리)
create or replace function public.group_state(p_code text)
returns jsonb
language sql security definer stable set search_path = public
as $$
  select jsonb_build_object(
    'ok', true,
    'exists', exists (select 1 from public.group_sessions where code = p_code),
    'released', coalesce((select device_id = '' from public.group_sessions where code = p_code), false)
  )
$$;
revoke all on function public.group_state(text) from public;
grant execute on function public.group_state(text) to anon, authenticated;

-- 3) 교사 '해제': 토큰을 새로 발급해 옛 대표 폰의 신호가 더 이상 통하지 않게 한다
create or replace function public.release_group(p_code text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    raise exception 'not allowed';
  end if;
  update public.group_sessions
    set token = gen_random_uuid(), prev_token = null, device_id = '', last_seen = now() - interval '1 day'
    where code = p_code;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.release_group(text) from public, anon;
grant execute on function public.release_group(text) to authenticated;

-- 4) 사진 업로드 규칙: 최근 3일 안에 활동한 모둠 폴더에만, 덮어쓰기는 금지
create or replace function public.is_group_active(p_code text)
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from public.group_sessions gs
    where gs.code = p_code and gs.last_seen > now() - interval '3 days'
  )
$$;
drop policy if exists student_upsert_photos on storage.objects;

-- 5) 제출: 이전 토큰은 대표가 바뀐 뒤 2시간까지만 인정, 객관식 값 형식 검사
create or replace function public.submit_answer(
  p_token uuid, p_submission_id uuid, p_place_id text, p_mission_id text, p_answer jsonb, p_photo_paths text[]
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
  p text;
  v_m jsonb;
  v_correct boolean := null;
begin
  select code into v_code from public.group_sessions
    where token = p_token or (prev_token = p_token and claimed_at > now() - interval '2 hours') limit 1;
  if v_code is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p_mission_id is null or length(p_mission_id) > 64 or p_place_id is null or length(p_place_id) > 64 then
    return jsonb_build_object('ok', false, 'reason', 'bad_data');
  end if;
  if coalesce(array_length(p_photo_paths, 1), 0) > 6 then
    return jsonb_build_object('ok', false, 'reason', 'bad_data');
  end if;
  foreach p in array coalesce(p_photo_paths, '{}') loop
    if p !~ ('^' || v_code || '/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\.jpg$') then
      return jsonb_build_object('ok', false, 'reason', 'bad_data');
    end if;
  end loop;
  if pg_column_size(p_answer) > 20000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_data');
  end if;

  insert into public.submissions (id, group_code, place_id, mission_id, answer, photo_paths)
  values (p_submission_id, v_code, p_place_id, p_mission_id, p_answer, coalesce(p_photo_paths, '{}'))
  on conflict (group_code, mission_id) do update
    set id = excluded.id, place_id = excluded.place_id, answer = excluded.answer,
        photo_paths = excluded.photo_paths, updated_at = now();

  -- 교사 편집본(app_config)에서 이 미션을 찾아 객관식 정답이면 자동 도장
  select m into v_m
  from public.app_config c,
       jsonb_each(c.data->'places') pl,
       jsonb_array_elements(coalesce(pl.value->'missions', '[]'::jsonb)) m
  where c.id = 'trip' and m->>'id' = p_mission_id
  limit 1;
  if v_m is not null and v_m->>'type' = 'choice' and jsonb_typeof(p_answer->'choice') = 'number' and jsonb_typeof(v_m->'answer') = 'number' then
    v_correct := (v_m->>'answer')::int = (p_answer->>'choice')::int;
    if v_correct then
      insert into public.stamps (group_code, mission_id, auto) values (v_code, p_mission_id, true)
      on conflict (group_code, mission_id) do nothing;
    else
      -- 오답으로 다시 제출하면 자동 도장만 거둔다 (교사가 찍은 도장은 유지)
      delete from public.stamps where group_code = v_code and mission_id = p_mission_id and auto;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'correct', v_correct);
end;
$$;
grant execute on function public.submit_answer(uuid, uuid, text, text, jsonb, text[]) to anon, authenticated;

-- 6) 학생 앱용 설정: 객관식 정답을 뺀 편집본 (채점은 서버가 하므로 학생 폰에는 정답이 없어도 된다)
create or replace function public.get_trip_config()
returns jsonb
language plpgsql security definer stable set search_path = public
as $$
declare
  c record;
  places jsonb := '{}'::jsonb;
  pk text; pv jsonb; ms jsonb;
begin
  select data, updated_at into c from public.app_config where id = 'trip';
  if not found then
    return jsonb_build_object('ok', true, 'data', null, 'updated_at', null);
  end if;
  for pk, pv in select key, value from jsonb_each(coalesce(c.data->'places', '{}'::jsonb)) loop
    if pv ? 'missions' then
      select coalesce(jsonb_agg(m - 'answer'), '[]'::jsonb) into ms from jsonb_array_elements(pv->'missions') m;
      pv := jsonb_set(pv, '{missions}', ms);
    end if;
    places := places || jsonb_build_object(pk, pv);
  end loop;
  return jsonb_build_object('ok', true, 'data', jsonb_set(c.data, '{places}', places), 'updated_at', c.updated_at);
end;
$$;
revoke all on function public.get_trip_config() from public;
grant execute on function public.get_trip_config() to anon, authenticated;
-- 설정 표는 이제 교사만 직접 읽는다 (학생 앱은 위 함수를 쓴다)
drop policy if exists anyone_read_config on public.app_config;
drop policy if exists teacher_read_config on public.app_config;
create policy teacher_read_config on public.app_config for select to authenticated using (true);
