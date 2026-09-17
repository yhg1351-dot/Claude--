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
    getProgress: (token) => rpc("get_progress", { p_token: token }),
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
    async fetchAll() {
      try {
        const [subs, sess] = await Promise.all([
          client.from("submissions").select("*").order("updated_at", { ascending: false }).limit(5000),
          client.from("group_sessions").select("*"),
        ]);
        if (subs.error) return { ok: false, reason: "network", message: subs.error.message };
        if (sess.error) return { ok: false, reason: "network", message: sess.error.message };
        return { ok: true, submissions: subs.data, sessions: sess.data };
      } catch (e) {
        return netErr(e);
      }
    },
    async signedUrls(paths) {
      if (!paths.length) return {};
      const out = {};
      for (let i = 0; i < paths.length; i += 100) {
        const chunk = paths.slice(i, i + 100);
        const { data, error } = await client.storage.from("photos").createSignedUrls(chunk, 60 * 15);
        if (error) continue;
        for (const d of data) if (d.signedUrl) out[d.path] = d.signedUrl;
      }
      return out;
    },
    async releaseGroup(code) {
      const { error } = await client
        .from("group_sessions")
        .update({ last_seen: new Date(Date.now() - 24 * 3600 * 1000).toISOString() })
        .eq("code", code);
      return error ? { ok: false, message: error.message } : { ok: true };
    },
    async deleteAll() {
      try {
        // 1) 저장소의 모든 사진 삭제 (모둠 폴더 → 파일)
        const bucket = client.storage.from("photos");
        const top = await bucket.list("", { limit: 1000 });
        if (top.error) return { ok: false, message: top.error.message };
        for (const folder of top.data || []) {
          if (folder.id) continue; // 파일이면 건너뜀 (폴더는 id가 null)
          const files = await bucket.list(folder.name, { limit: 1000 });
          const paths = (files.data || []).filter((f) => f.id).map((f) => `${folder.name}/${f.name}`);
          for (let i = 0; i < paths.length; i += 100) {
            await bucket.remove(paths.slice(i, i + 100));
          }
        }
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
  const timeoutMs = (CFG.lockTimeoutMinutes || 5) * 60 * 1000;
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
      return { ok: true, submissions: rows };
    },
    async uploadPhoto(code, path, blob) {
      await store.put("photos", { key: path, blob, code });
      return { ok: true };
    },
    async submit(token, sub) {
      const all = sessions();
      const s = Object.values(all).find((x) => x.token === token || x.prev_token === token);
      if (!s) return { ok: false, reason: "invalid" };
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
      return { ok: true };
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
    async fetchAll() {
      const submissions = await store.all("localSubmissions");
      const sess = Object.values(sessions()).map((s) => ({
        ...s,
        last_seen: new Date(s.last_seen).toISOString(),
        claimed_at: new Date(s.claimed_at).toISOString(),
      }));
      return { ok: true, submissions, sessions: sess };
    },
    async signedUrls(paths) {
      const out = {};
      for (const p of paths) {
        const row = await store.get("photos", p);
        if (row && row.blob) out[p] = URL.createObjectURL(row.blob);
      }
      return out;
    },
    async releaseGroup(code) {
      const all = sessions();
      if (all[code]) all[code].last_seen = Date.now() - 24 * 3600 * 1000;
      save(all);
      return { ok: true };
    },
    async deleteAll() {
      await store.clear("localSubmissions");
      await store.clear("photos");
      ls.remove(KEY);
      return { ok: true };
    },
  };
}

export const backend = isConfigured && window.supabase ? makeSupabase() : makeLocal();
