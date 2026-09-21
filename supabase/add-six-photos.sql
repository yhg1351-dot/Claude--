-- 미션당 사진을 최대 6장까지 받도록 서버 함수의 제한을 올립니다.
-- Supabase SQL 편집기에서 이 파일 전체를 붙여 넣고 실행하세요. (add-stamps.sql 실행 후)
-- 여러 번 실행해도 안전합니다.

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
  if coalesce(array_length(p_photo_paths, 1), 0) > 6 then
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

grant execute on function public.submit_answer(uuid, uuid, text, text, jsonb, text[]) to anon, authenticated;
