// 서버 연동 계층. Supabase가 설정되어 있으면 Supabase, 아니면 데모(로컬) 모드로 동작한다.
// 두 모드 모두 같은 함수 이름과 결과 형태({ ok, reason, ... })를 돌려준다.
import { store, ls, uuid } from "./store.js";

const CFG = window.APP_CONFIG || {};
export const isConfigured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);

// 네트워크 오류를 한 가지 형태로 정리
function netErr(e) {
  const msg = (e && (e.message || e.error_description || e.error)) || String(e);
  return { ok: false, reason: "network", message: msg };
}

// ---------------------------------------------------------------- Supabase
function makeSupabase() {
  // 교사 화면만 로그인 세션을 저장한다. 학생 앱은 같은 브라우저에 교사 로그인이 남아 있어도
  // 항상 '로그인 없음(anon)' 자격으로 요청해야 사진 업로드 규칙에 맞는다.
  const isTeacher = window.APP_ROLE === "teacher";
  const client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: isTeacher
      ? { persistSession: true, autoRefreshToken: true, storageKey: "mq-teacher-auth" }
      : { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  async function rpc(name, args) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const { data, error } = await client.rpc(name, args).abortSignal(ctrl.signal);
      if (error) return { ok: false, reason: "network", message: `${name} 실패 ${error.code || ""}: ${error.message}` };
      return data && typeof data === "object" ? data : { ok: true, data };
    } catch (e) {
      return netErr(e);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mode: "supabase",
    client,
    claimGroup: (code, deviceId) => rpc("claim_group", { p_code: code, p_device_id: deviceId }),
    heartbeat: (token) => rpc("heartbeat", { p_token: token }),
    // 모둠 상태: 해제됨/지워짐 구분. 서버 함수가 아직 없으면(업데이트 SQL 미실행) ok:false
    groupState: (code) => rpc("group_state", { p_code: code }),
    getProgress: (token) => rpc("get_progress", { p_token: token }),
    getGroupProgress: (code) => rpc("get_group_progress", { p_code: code }),
    async uploadPhoto(code, path, blob) {
      try {
        const { error } = await client.storage.from("photos").upload(path, blob, {
          contentType: "image/jpeg",
          upsert: false,
        });
        if (error) {
          // 같은 파일이 이미 있으면 성공으로 간주 (재시도 중복)
          if (/exists|duplicate/i.test(error.message) || error.statusCode === "409" || error.status === 409) return { ok: true };
          const code = error.statusCode || error.status || "";
          return { ok: false, reason: "network", message: `사진 업로드 실패 ${code}: ${error.message}` };
        }
        return { ok: true };
      } catch (e) {
        return netErr(e);
      }
    },
    submit: (token, s) =>
      rpc("submit_answer", {
        p_token: token,
        p_submission_id: s.id,
        p_place_id: s.placeId,
        p_mission_id: s.missionId,
        p_answer: s.answer,
        p_photo_paths: s.photoPaths || [],
      }),

    // ----- 일정·미션 설정 (교사가 편집, 학생은 읽기만)
    async loadConfig() {
      // 신호가 약해 응답이 없으면 10초 뒤 포기하고 캐시·기본 파일을 쓰게 한다
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        if (!isTeacher) {
          // 학생 앱: 정답을 뺀 설정을 주는 서버 함수. (업데이트 SQL 을 아직 안 돌렸으면 표에서 직접 읽는다)
          const { data: r, error: e1 } = await client.rpc("get_trip_config").abortSignal(ctrl.signal);
          if (!e1 && r && typeof r === "object") return { ok: true, data: r.data || null, updatedAt: r.updated_at || null };
          if (e1 && !/function|schema cache|PGRST202|42883/i.test(e1.message || "")) return { ok: false, reason: "network", message: e1.message };
        }
        const { data, error } = await client.from("app_config").select("data, updated_at").eq("id", "trip").abortSignal(ctrl.signal).maybeSingle();
        if (error) return { ok: false, reason: "network", message: error.message };
        if (!data) return { ok: true, data: null, updatedAt: null };
        return { ok: true, data: data.data, updatedAt: data.updated_at };
      } catch (e) {
        return netErr(e);
      } finally {
        clearTimeout(timer);
      }
    },
    async saveConfig(data, expectedUpdatedAt) {
      try {
        // 다른 교사가 먼저 저장했는지 확인 (마지막 저장 시각 비교)
        const cur = await client.from("app_config").select("updated_at").eq("id", "trip").maybeSingle();
        if (cur.error) return { ok: false, reason: "network", message: cur.error.message };
        if (cur.data && expectedUpdatedAt && cur.data.updated_at !== expectedUpdatedAt) return { ok: false, reason: "conflict" };
        const now = new Date().toISOString();
        const { error } = await client.from("app_config").upsert({ id: "trip", data, updated_at: now });
        if (error) return { ok: false, reason: "network", message: error.message };
        const after = await client.from("app_config").select("updated_at").eq("id", "trip").maybeSingle();
        return { ok: true, updatedAt: after.data ? after.data.updated_at : now };
      } catch (e) {
        return netErr(e);
      }
    },
    async uploadAsset(path, blob) {
      try {
        const { error } = await client.storage.from("assets").upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: true });
        if (error) return { ok: false, reason: "network", message: error.message };
        const { data } = client.storage.from("assets").getPublicUrl(path);
        return { ok: true, url: data.publicUrl };
      } catch (e) {
        return netErr(e);
      }
    },

    // ----- 교사용
    async teacherLogin(email, password) {
      try {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) return { ok: false, reason: "auth", message: error.message };
        return { ok: true };
      } catch (e) {
        return netErr(e);
      }
    },
    async teacherSession() {
      const { data } = await client.auth.getSession();
      return !!(data && data.session);
    },
    // 이 기기만 로그아웃 (기본값 global 은 같은 계정의 다른 교사 기기까지 모두 로그아웃시킴)
    teacherLogout: () => client.auth.signOut({ scope: "local" }),
    // 세션이 만료·폐기되어 로그아웃되면 알려 준다 (교사 화면이 빈 대시보드 대신 로그인 화면을 보이게)
    onTeacherSignedOut(fn) {
      try { client.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") fn(); }); } catch (e) {}
    },
    async fetchAll() {
      try {
        const [subs, sess, st] = await Promise.all([
          client.from("submissions").select("*").order("updated_at", { ascending: false }).limit(5000),
          client.from("group_sessions").select("*"),
          client.from("stamps").select("*").limit(10000),
        ]);
        if (subs.error) return { ok: false, reason: "network", message: subs.error.message };
        if (sess.error) return { ok: false, reason: "network", message: sess.error.message };
        // 도장 표가 아직 없으면(SQL 미실행) 빈 목록으로 진행
        return { ok: true, submissions: subs.data, sessions: sess.data, stamps: st.error ? [] : st.data, stampsUnavailable: !!st.error };
      } catch (e) {
        return netErr(e);
      }
    },
    async signedUrls(paths) {
      return (await this.signedUrlsDetailed(paths)).urls;
    },
    // urls: 경로→임시 주소, missing: 서버에 파일이 없는 경로(요청은 성공). 요청 자체가 실패한 경로는 둘 다에 없다.
    async signedUrlsDetailed(paths) {
      const urls = {}, missing = [];
      for (let i = 0; i < paths.length; i += 100) {
        const chunk = paths.slice(i, i + 100);
        try {
          const { data, error } = await client.storage.from("photos").createSignedUrls(chunk, 60 * 15);
          if (error || !Array.isArray(data)) continue;
          for (const d of data) { if (d.signedUrl) urls[d.path] = d.signedUrl; else if (d.path) missing.push(d.path); }
        } catch (e) { /* 네트워크 실패: 다음 갱신 때 다시 */ }
      }
      return { urls, missing };
    },
    // 도장 찍기/지우기 (교사)
    async setStamp(code, missionId, on, opts = {}) {
      try {
        if (on) {
          const { error } = await client.from("stamps").upsert({ group_code: code, mission_id: missionId, auto: !!opts.auto }, { onConflict: "group_code,mission_id", ignoreDuplicates: true });
          if (error) return { ok: false, message: error.message };
        } else {
          const { error } = await client.from("stamps").delete().eq("group_code", code).eq("mission_id", missionId);
          if (error) return { ok: false, message: error.message };
        }
        return { ok: true };
      } catch (e) {
        return netErr(e);
      }
    },
    async releaseGroup(code) {
      // 서버 함수가 토큰을 새로 발급해 옛 대표 폰을 끊는다. 함수가 아직 없으면(업데이트 SQL 미실행) 예전 방식으로.
      const r = await rpc("release_group", { p_code: code });
      if (r.ok) return r;
      if (!/function|schema cache|PGRST202|42883/i.test(r.message || "")) return r;
      const { error } = await client
        .from("group_sessions")
        .update({ last_seen: new Date(Date.now() - 24 * 3600 * 1000).toISOString() })
        .eq("code", code);
      return error ? { ok: false, message: error.message } : { ok: true };
    },
    // 저장소의 한 폴더(비우면 전체) 아래 사진을 깊이에 상관없이 모두 지운다
    async removePhotosUnder(prefix) {
      const bucket = client.storage.from("photos");
      const paths = [];
      const walk = async (pre) => {
        const r = await bucket.list(pre, { limit: 1000 });
        if (r.error) throw new Error(r.error.message);
        for (const f of r.data || []) {
          const full = pre ? `${pre}/${f.name}` : f.name;
          if (f.id) paths.push(full); // 파일 (폴더는 id가 null)
          else await walk(full);
        }
      };
      await walk(prefix || "");
      for (let i = 0; i < paths.length; i += 100) {
        const r = await bucket.remove(paths.slice(i, i + 100));
        if (r.error) throw new Error(r.error.message);
      }
      return paths.length;
    },
    // 한 모둠만 초기화: 그 모둠의 사진·제출·도장·접속 정보. 다른 모둠은 건드리지 않는다.
    async resetGroup(code) {
      if (!/^[0-9]{4,5}$/.test(code)) return { ok: false, message: "모둠 코드가 올바르지 않습니다." };
      try {
        const photos = await this.removePhotosUnder(code);
        const a = await client.from("stamps").delete().eq("group_code", code);
        if (a.error && !/relation .* does not exist/i.test(a.error.message)) return { ok: false, message: a.error.message };
        const b = await client.from("submissions").delete().eq("group_code", code);
        if (b.error) return { ok: false, message: b.error.message };
        const c = await client.from("group_sessions").delete().eq("code", code);
        if (c.error) return { ok: false, message: c.error.message };
        return { ok: true, photos };
      } catch (e) {
        return netErr(e);
      }
    },
    async deleteAll() {
      try {
        // 1) 저장소의 모든 사진 삭제 (모둠 폴더 → 미션 폴더 → 파일, 깊이에 상관없이 모두)
        await this.removePhotosUnder("");
        // 2) 제출 내용과 접속 정보 삭제
        const r = await client.rpc("teacher_delete_all");
        if (r.error) return { ok: false, message: r.error.message };
        return { ok: true };
      } catch (e) {
        return netErr(e);
      }
    },
  };
}

// ---------------------------------------------------------------- 데모(로컬) 모드
// 이 기기 브라우저 안에서만 동작. 실제 서버 없이 앱 흐름을 확인하기 위한 용도.
function makeLocal() {
  const KEY = "mq-local-sessions";
  const STAMP_KEY = "mq-local-stamps";
  const timeoutMs = (CFG.lockTimeoutMinutes || 5) * 60 * 1000;
  const stampsAll = () => ls.get(STAMP_KEY, {});
  const stampsFor = (code) => Object.entries(stampsAll()).filter(([k]) => k.startsWith(`${code}:`)).map(([k, v]) => ({ group_code: code, mission_id: k.slice(code.length + 1), auto: !!v.auto, created_at: v.created_at }));
  const sessions = () => ls.get(KEY, {});
  const save = (s) => ls.set(KEY, s);

  return {
    mode: "local",
    async claimGroup(code, deviceId) {
      const all = sessions();
      const s = all[code];
      const now = Date.now();
      if (!s) {
        all[code] = { code, device_id: deviceId, token: uuid(), prev_token: null, last_seen: now, claimed_at: now };
      } else if (s.device_id === deviceId) {
        s.last_seen = now;
      } else if (now - s.last_seen > timeoutMs) {
        all[code] = { code, device_id: deviceId, token: uuid(), prev_token: s.token, last_seen: now, claimed_at: now };
      } else {
        return { ok: false, reason: "in_use", last_seen: s.last_seen };
      }
      save(all);
      return { ok: true, token: all[code].token, code };
    },
    async heartbeat(token) {
      const all = sessions();
      const s = Object.values(all).find((x) => x.token === token);
      if (!s) return { ok: false, reason: "invalid" };
      s.last_seen = Date.now();
      save(all);
      return { ok: true };
    },
    async getProgress(token) {
      const all = sessions();
      const s = Object.values(all).find((x) => x.token === token);
      if (!s) return { ok: false, reason: "invalid" };
      const rows = (await store.all("localSubmissions")).filter((r) => r.group_code === s.code);
      return { ok: true, submissions: rows, stamps: stampsFor(s.code) };
    },
    async getGroupProgress(code) {
      const s = sessions()[code];
      const rows = (await store.all("localSubmissions")).filter((r) => r.group_code === code)
        .map((r) => ({ mission_id: r.mission_id, place_id: r.place_id, photo_count: (r.photo_paths || []).length, updated_at: r.updated_at }));
      return { ok: true, submissions: rows, stamps: stampsFor(code), rep: { exists: !!s, active: !!s && Date.now() - s.last_seen < timeoutMs, last_seen: s ? s.last_seen : null } };
    },
    async uploadPhoto(code, path, blob) {
      await store.put("photos", { key: path, blob, code });
      return { ok: true };
    },
    async submit(token, sub) {
      const all = sessions();
      const s = Object.values(all).find((x) => x.token === token || x.prev_token === token);
      if (!s) return { ok: false, reason: "invalid" };
      // 서버 함수와 같은 검사: 사진은 6장까지, 경로는 자기 모둠 폴더 안이어야 한다
      const paths = sub.photoPaths || [];
      if (paths.length > 6 || paths.some((x) => !new RegExp(`^${s.code}/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\\.jpg$`).test(x))) {
        return { ok: false, reason: "bad_data" };
      }
      const key = `${s.code}:${sub.missionId}`;
      const prev = await store.get("localSubmissions", key);
      await store.put("localSubmissions", {
        key,
        id: sub.id,
        group_code: s.code,
        place_id: sub.placeId,
        mission_id: sub.missionId,
        answer: sub.answer,
        photo_paths: sub.photoPaths || [],
        created_at: prev ? prev.created_at : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      // 서버와 같은 자동 도장: 객관식 정답이면 자동 도장, 오답으로 다시 내면 자동 도장만 회수
      try {
        const row = ls.get("mq-local-config");
        const data = row && row.data ? row.data : await (await fetch("./data/missions.json")).json();
        const m = Object.values(data.places || {}).flatMap((pl) => pl.missions || []).find((x) => x.id === sub.missionId);
        if (m && m.type === "choice" && sub.answer && sub.answer.choice !== undefined) {
          const all = stampsAll(); const k = `${s.code}:${sub.missionId}`;
          if (sub.answer.choice === m.answer) { if (!all[k]) all[k] = { auto: true, created_at: new Date().toISOString() }; }
          else if (all[k] && all[k].auto) delete all[k];
          ls.set(STAMP_KEY, all);
        }
      } catch (e) { /* 데모 모드 보조 기능 */ }
      return { ok: true };
    },

    // ----- 설정 (데모: 이 브라우저에만 저장)
    async loadConfig() {
      const row = ls.get("mq-local-config");
      return { ok: true, data: row ? row.data : null, updatedAt: row ? row.updatedAt : null };
    },
    async saveConfig(data) {
      const updatedAt = new Date().toISOString();
      ls.set("mq-local-config", { data, updatedAt });
      return { ok: true, updatedAt };
    },
    async uploadAsset(_path, blob) {
      // 데모 모드: 이미지를 글자(data URL)로 바꿔 설정 안에 넣는다
      const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
      return { ok: true, url };
    },

    // ----- 교사용
    async teacherLogin(_email, password) {
      if (password === (CFG.localTeacherPassword || "1234")) {
        ls.set("mq-local-teacher", true);
        return { ok: true };
      }
      return { ok: false, reason: "auth", message: "비밀번호가 다릅니다" };
    },
    async teacherSession() {
      return !!ls.get("mq-local-teacher", false);
    },
    async teacherLogout() {
      ls.remove("mq-local-teacher");
    },
    onTeacherSignedOut() {},
    async fetchAll() {
      const submissions = await store.all("localSubmissions");
      const sess = Object.values(sessions()).map((s) => ({
        ...s,
        last_seen: new Date(s.last_seen).toISOString(),
        claimed_at: new Date(s.claimed_at).toISOString(),
      }));
      const stamps = Object.entries(stampsAll()).map(([k, v]) => { const [code, ...rest] = k.split(":"); return { group_code: code, mission_id: rest.join(":"), auto: !!v.auto, created_at: v.created_at }; });
      return { ok: true, submissions, sessions: sess, stamps };
    },
    async setStamp(code, missionId, on, opts = {}) {
      const all = stampsAll();
      const k = `${code}:${missionId}`;
      if (on) { if (!all[k]) all[k] = { auto: !!opts.auto, created_at: new Date().toISOString() }; }
      else delete all[k];
      ls.set(STAMP_KEY, all);
      return { ok: true };
    },
    async signedUrls(paths) {
      return (await this.signedUrlsDetailed(paths)).urls;
    },
    async signedUrlsDetailed(paths) {
      const urls = {}, missing = [];
      for (const p of paths) {
        const row = await store.get("photos", p);
        if (row && row.blob) urls[p] = URL.createObjectURL(row.blob); else missing.push(p);
      }
      return { urls, missing };
    },
    async releaseGroup(code) {
      const all = sessions();
      if (all[code]) { all[code].last_seen = Date.now() - 24 * 3600 * 1000; all[code].token = uuid(); all[code].prev_token = null; all[code].device_id = ""; }
      save(all);
      return { ok: true };
    },
    async groupState(code) {
      const s = sessions()[code];
      return { ok: true, exists: !!s, released: !!s && s.device_id === "" };
    },
    async resetGroup(code) {
      for (const r of await store.all("localSubmissions")) if (r.group_code === code) await store.del("localSubmissions", r.key);
      let photos = 0;
      for (const r of await store.all("photos")) if (r.key.startsWith(`${code}/`)) { await store.del("photos", r.key); photos += 1; }
      const all = sessions(); delete all[code]; save(all);
      const st = stampsAll(); for (const k of Object.keys(st)) if (k.startsWith(`${code}:`)) delete st[k]; ls.set(STAMP_KEY, st);
      return { ok: true, photos };
    },
    async deleteAll() {
      await store.clear("localSubmissions");
      await store.clear("photos");
      ls.remove(KEY);
      ls.remove(STAMP_KEY);
      return { ok: true };
    },
  };
}

// 서버가 설정되어 있는데 연결 라이브러리(vendor/supabase.js)를 못 받은 경우: 데모 모드로 조용히 넘어가면
// 제출이 폰에만 저장되면서 '전송 완료'로 보이므로, 앱이 이를 알고 진행을 막게 한다.
export const backendUnavailable = !!(isConfigured && !window.supabase);
export const backend = isConfigured && window.supabase ? makeSupabase() : makeLocal();
