-- 도장(골드·실버·브론즈) 기능. Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.

-- ---------------------------------------------------------------- 도장 표
create table if not exists public.stamps (
  group_code  text not null,
  mission_id  text not null,
  stamp       text not null check (stamp in ('gold', 'silver', 'bronze')),
  note        text,
  by_name     text,
  auto        boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
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

-- ---------------------------------------------------------------- 답변 저장 + 퀴즈 정답이면 자동 실버 도장
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
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if coalesce(array_length(p_photo_paths, 1), 0) > 5 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
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

  -- 교사 편집본(app_config)에서 이 미션을 찾아 객관식 정답이면 자동 실버 도장
  select m into v_m
  from public.app_config c,
       jsonb_each(c.data->'places') pl,
       jsonb_array_elements(coalesce(pl.value->'missions', '[]'::jsonb)) m
  where c.id = 'trip' and m->>'id' = p_mission_id
  limit 1;
  if v_m is not null and v_m->>'type' = 'choice' and (p_answer ? 'choice') then
    v_correct := (v_m->>'answer')::int = (p_answer->>'choice')::int;
    if v_correct then
      insert into public.stamps (group_code, mission_id, stamp, auto)
      values (v_code, p_mission_id, 'silver', true)
      on conflict (group_code, mission_id) do update
        set stamp = 'silver', updated_at = now()
        where public.stamps.auto;               -- 교사가 직접 찍은 도장은 건드리지 않음
    else
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
  select coalesce(jsonb_agg(jsonb_build_object('mission_id', mission_id, 'stamp', stamp, 'note', note, 'updated_at', updated_at)), '[]'::jsonb) into st
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
  select coalesce(jsonb_agg(jsonb_build_object('mission_id', mission_id, 'stamp', stamp, 'note', note, 'updated_at', updated_at)), '[]'::jsonb) into st
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
