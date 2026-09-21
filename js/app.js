// 학생용 앱 화면. 해시 주소(#/place/…, #/mission/…)로 화면을 바꾸어 뒤로가기 버튼이 동작한다.
import { store, ls, uuid } from "./store.js";
import { backend, isConfigured } from "./backend.js";
import { compressImage } from "./image.js";
import { enqueue, pending, onSync, startSyncLoop, resumeAfterLogin, kick, retryNow, purgeStale } from "./sync.js";
import { loadTripData } from "./data.js";
import { setupPwa, installButton, inAppNotice } from "./pwa.js";

const CFG = window.APP_CONFIG || {};
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
};

const state = {
  data: null,         // missions.json
  session: null,      // { code, token, deviceId }
  progress: {},       // missionId -> { status, answer, photoCount, at }
  stamps: {},         // missionId -> created_at (선생님 도장)
  pendingCount: 0,
  online: navigator.onLine,
  draft: {},          // 미션 화면 입력 중인 내용
};

// ------------------------------------------------------------ 유틸
function deviceId() {
  let id = ls.get("mq-device-id");
  if (!id) { id = uuid(); ls.set("mq-device-id", id); }
  return id;
}
function progressKey() { return `mq-progress-${state.session.code}`; }
function draftKeyOf(placeId, missionId) { return `${placeId}/${missionId}`; }
async function loadDrafts() {
  state.draft = {};
  if (!state.session) return;
  try {
    for (const d of await store.all("drafts")) {
      if (d.code !== state.session.code) continue;
      state.draft[draftKeyOf(d.placeId, d.missionId)] = { choice: d.choice ?? null, text: d.text || "", photos: d.photos || [], keptPaths: d.keptPaths };
    }
  } catch (e) { console.error(e); }
}
let draftTimer = null;
function saveDraft(placeId, missionId) {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const d = state.draft[draftKeyOf(placeId, missionId)];
    if (!d || !state.session) return;
    store.put("drafts", { key: `${state.session.code}:${missionId}`, code: state.session.code, placeId, missionId, choice: d.choice, text: d.text, photos: d.photos, keptPaths: d.keptPaths, at: Date.now() }).catch(() => {});
  }, 250);
}
function clearDraft(placeId, missionId) {
  delete state.draft[draftKeyOf(placeId, missionId)];
  if (state.session) store.del("drafts", `${state.session.code}:${missionId}`).catch(() => {});
}
function loadProgress() {
  state.progress = state.session ? ls.get(progressKey(), {}) : {};
  state.stamps = state.session ? ls.get(`mq-stamps-${state.session.code}`, {}) : {};
}
function saveStamps() { if (state.session) ls.set(`mq-stamps-${state.session.code}`, state.stamps); }
function allMissionList() {
  const out = [];
  for (const day of (state.data.trip.days || [])) for (const st of day.stops || []) {
    const p = place(st.placeId);
    if (p && p.type === "mission") for (const m of p.missions || []) if (!out.find((x) => x.id === m.id)) out.push({ ...m, placeId: st.placeId, placeName: p.name });
  }
  for (const [pid, p] of Object.entries(state.data.places)) if (p.type === "mission") for (const m of p.missions || []) if (!out.find((x) => x.id === m.id)) out.push({ ...m, placeId: pid, placeName: p.name });
  return out;
}
function stampStats() {
  const ms = allMissionList();
  const stamped = ms.filter((m) => state.stamps[m.id]).length;
  return { stamped, total: ms.length, complete: ms.length > 0 && stamped === ms.length };
}
function saveProgress() { if (state.session) ls.set(progressKey(), state.progress); }
function place(id) { return state.data.places[id]; }
function missionsOf(placeId) { return (place(placeId) && place(placeId).missions) || []; }
function findMission(placeId, mid) { return missionsOf(placeId).find((m) => m.id === mid); }
function codeLabel(code) {
  if (!code || code.length < 4) return code;
  return `${code[0]}학년 ${code[1]}반 ${parseInt(code.slice(2), 10)}모둠`;
}
function validCode(code) {
  const t = state.data.trip;
  if (!/^\d{4}$/.test(code)) return false;
  if (parseInt(code[0], 10) !== t.grade) return false;
  const cls = t.classes.find((c) => c.class === parseInt(code[1], 10));
  if (!cls) return false;
  const g = parseInt(code.slice(2), 10);
  return g >= 1 && g <= cls.groups;
}
function toast(msg, kind = "info", ms = 2500) {
  const t = el("div", { class: `notice toast ${kind}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
function modal({ title, body, buttons }) {
  return new Promise((resolve) => {
    const box = el("div", { class: "box" }, [el("h3", {}, title), el("div", { class: "muted", style: "font-size:15px;color:var(--ink-2)" }, body)]);
    const ov = el("div", { class: "overlay" }, box);
    const row = el("div", { class: "row", style: "margin-top:14px" });
    for (const b of buttons) {
      row.append(el("button", { class: `btn ${b.kind || ""}`, onclick: () => { ov.remove(); resolve(b.value); } }, b.label));
    }
    box.append(row);
    document.body.append(ov);
  });
}

// ------------------------------------------------------------ 세션 / 접속 잠금
// 모둠 코드로 들어가면 누구나 일정·미션을 볼 수 있다(보기 모드). 제출은 '대표 폰'으로 정한 한 대만 가능.
async function login(code) {
  state.session = { code, token: null, rep: false, deviceId: deviceId(), at: Date.now() };
  state.loginMessage = null;
  ls.set("mq-session", state.session);
  loadProgress();
  await loadDrafts();
  await pullProgress();
  return { ok: true };
}
function isRep() { return !!(state.session && state.session.rep && state.session.token); }
// 이 폰을 모둠 대표 폰으로 정한다 (서버 잠금 획득)
async function claimRep() {
  if (!state.session) return { ok: false };
  if (!navigator.onLine) return { ok: false, reason: "network" };
  const r = await backend.claimGroup(state.session.code, state.session.deviceId || deviceId());
  if (r.ok) {
    state.session = { ...state.session, token: r.token, rep: true, at: Date.now() };
    ls.set("mq-session", state.session);
    resumeAfterLogin();
    await pullProgress();
    return { ok: true };
  }
  return r;
}
function dropRep(message) {
  if (!state.session) return;
  // 토큰은 남겨 두어 대기 중인 제출이 '직전 토큰'으로 접수될 수 있게 한다
  state.session = { ...state.session, rep: false };
  ls.set("mq-session", state.session);
  if (message) toast(message, "warn", 4000);
  render();
}
function logoutLocal(message) {
  state.session = null;
  ls.remove("mq-session");
  if (message) state.loginMessage = message;
  location.hash = "#/";
  render();
}
// 서버가 접속 정보를 모를 때(삭제·해제 등) 같은 기기로 조용히 다시 접속한다.
// 다른 기기가 실제로 쓰고 있을 때만 로그아웃한다.
let recovering = null;
async function recoverSession() {
  if (!isRep()) return false;
  if (recovering) return recovering;
  recovering = (async () => {
    const r = await backend.claimGroup(state.session.code, state.session.deviceId || deviceId());
    if (r.ok) {
      state.session = { ...state.session, token: r.token, at: Date.now() };
      ls.set("mq-session", state.session);
      resumeAfterLogin();
      return true;
    }
    if (r.reason === "in_use") {
      dropRep("다른 폰이 우리 모둠 대표 폰이 되었어요. 이 폰은 보기 모드로 바뀌었어요.");
    }
    // 네트워크 오류면 그대로 두고 다음에 다시 시도
    return false;
  })();
  try { return await recovering; } finally { recovering = null; }
}
let hbTimer = null;
async function heartbeat() {
  if (!isRep() || !navigator.onLine) return;
  const r = await backend.heartbeat(state.session.token);
  if (!r.ok && r.reason === "invalid") await recoverSession();
}
function startHeartbeat() {
  if (hbTimer) return;
  hbTimer = setInterval(() => { if (document.visibilityState === "visible") heartbeat(); }, (CFG.heartbeatSeconds || 60) * 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") heartbeat(); });
}
// 서버에 저장된 제출 내역을 받아 로컬 진행 상태와 합친다 (기기가 바뀌어도 진행 상태 유지)
async function pullProgress() {
  if (!state.session || !navigator.onLine) return;
  const r = isRep() ? await backend.getProgress(state.session.token) : await backend.getGroupProgress(state.session.code);
  if (!r.ok || !Array.isArray(r.submissions)) return;
  if (r.rep) state.repInfo = r.rep;
  if (Array.isArray(r.stamps)) {
    const before = Object.keys(state.stamps).length;
    state.stamps = {};
    for (const st of r.stamps) state.stamps[st.mission_id] = st.created_at || true;
    saveStamps();
    const added = Object.keys(state.stamps).length - before;
    if (added > 0 && before >= 0 && state.stampsLoadedOnce) toast(`🎉 선생님 도장 ${added}개를 새로 받았어요!`, "ok", 3500);
    state.stampsLoadedOnce = true;
  }
  const queued = new Set((await pending()).map((i) => i.missionId));
  const onServer = new Set(r.submissions.map((s) => s.mission_id));
  for (const s of r.submissions) {
    if (queued.has(s.mission_id)) continue; // 아직 보내지 않은 새 제출이 우선
    const prevAnswer = state.progress[s.mission_id] ? state.progress[s.mission_id].answer : undefined;
    state.progress[s.mission_id] = {
      status: "sent", answer: s.answer !== undefined ? s.answer : prevAnswer,
      photoCount: s.photo_count !== undefined ? s.photo_count : (s.photo_paths || []).length, at: s.updated_at || s.created_at,
    };
  }
  // 서버에서 지워진 제출(교사 전체 삭제 등)은 폰 화면에서도 '완료' 표시를 내린다
  for (const mid of Object.keys(state.progress)) {
    if (state.progress[mid].status === "sent" && !onServer.has(mid) && !queued.has(mid)) delete state.progress[mid];
  }
  saveProgress();
  render();
}

// ------------------------------------------------------------ 라우팅
function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean);
  if (!state.session) return { name: "login" };
  if (parts[0] === "place" && parts[1] && place(parts[1])) return { name: "place", placeId: parts[1] };
  if (parts[0] === "mission" && parts[1] && findMission(parts[1], parts[2])) return { name: "mission", placeId: parts[1], missionId: parts[2] };
  if (parts[0] === "certificate" && stampStats().complete) return { name: "certificate" };
  return { name: "home" };
}
function go(hash) { location.hash = hash; }
function rememberRoute() {
  const h = location.hash;
  if (/^#\/(place|mission)\//.test(h)) ls.set("mq-last-route", { hash: h, at: Date.now() });
  else if (h === "#/" || h === "") ls.remove("mq-last-route");
}
// 카메라 앱 등에서 돌아오며 페이지가 주소만 남기고 새로 열렸을 때, 30분 안에 보던 화면으로 되돌린다
function restoreRoute() {
  if (location.hash && location.hash !== "#/") return;
  const last = ls.get("mq-last-route");
  if (last && last.hash && Date.now() - last.at < 30 * 60 * 1000) history.replaceState(null, "", last.hash);
}

// ------------------------------------------------------------ 홈 화면에 추가 (PWA 설치) · 앱 안 브라우저 안내 → js/pwa.js
setupPwa({
  onChange: () => { if (state.data) render(); },
  onInstalled: () => toast("홈 화면에 추가했어요! 이제 아이콘으로 바로 열 수 있어요.", "ok", 3500),
});

// ------------------------------------------------------------ 렌더링
const root = () => $("#app");

function render() {
  rememberRoute();
  const app = root();
  try {
    const r = route();
    app.innerHTML = "";
    if (r.name === "login") app.append(viewLogin());
    else if (r.name === "home") app.append(viewHome());
    else if (r.name === "place") app.append(viewPlace(r.placeId));
    else if (r.name === "mission") app.append(viewMission(r.placeId, r.missionId));
    else if (r.name === "certificate") app.append(viewCertificate());
    else app.append(viewHome());
  } catch (e) {
    // 화면을 그리다 오류가 나면 빈 화면 대신 복구 카드를 보여 준다
    app.innerHTML = "";
    app.append(errorCard(e));
    return;
  }
  renderStatus();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------ 오류 복구
function errorCard(e) {
  const msg = (e && (e.message || String(e))) || "알 수 없는 오류";
  return el("div", { class: "card", style: "margin-top:24px" }, [
    el("h2", {}, "화면을 여는 데 문제가 생겼어요"),
    el("p", { class: "muted" }, "아래 버튼을 누르면 이 폰에 저장된 앱 정보를 지우고 처음부터 다시 엽니다. 제출한 내용은 서버에 남아 있어요."),
    el("div", { class: "row", style: "margin-top:12px" }, [
      el("button", { class: "btn primary", onclick: () => location.reload() }, "다시 열기"),
      el("button", { class: "btn", onclick: resetApp }, "처음부터 다시 열기"),
    ]),
    el("p", { class: "muted small", style: "margin-top:12px;word-break:break-all" }, `오류 내용: ${msg}`),
  ]);
}
// 저장된 앱 정보(세션·캐시·서비스 워커)를 모두 지우고 새로 연다. 서버의 제출 기록은 그대로다.
async function resetApp() {
  try { Object.keys(localStorage).filter((k) => k.startsWith("mq-")).forEach((k) => localStorage.removeItem(k)); } catch (e) {}
  try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch (e) {}
  try { if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch (e) {}
  location.replace(location.pathname);
}
// 화면이 비어 있는 채로 스크립트 오류가 나면 복구 카드를 띄운다
let booted = false;
window.addEventListener("error", (ev) => { if (!booted || !root().firstChild) { root().innerHTML = ""; root().append(errorCard(ev.error || ev.message)); } });
window.addEventListener("unhandledrejection", (ev) => { if (!booted || !root().firstChild) { root().innerHTML = ""; root().append(errorCard(ev.reason)); } });

function heroSkyline() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 400 60"); svg.setAttribute("class", "skyline"); svg.setAttribute("preserveAspectRatio", "none");
  svg.innerHTML = '<path d="M0 60 L0 44 L30 44 L36 30 L42 44 L70 44 L70 36 L84 26 L98 36 L98 44 L130 44 L134 22 L138 12 L142 22 L146 44 L180 44 L188 34 L196 44 L230 44 L232 30 L240 18 L248 30 L250 44 L290 44 L296 38 L302 44 L330 44 L338 26 L346 44 L400 44 L400 60 Z" fill="rgba(255,255,255,.12)"/><path d="M0 60 L0 50 L60 50 L66 42 L72 50 L120 50 L126 44 L132 50 L200 50 L206 40 L212 50 L280 50 L286 45 L292 50 L400 50 L400 60 Z" fill="rgba(255,255,255,.18)"/>';
  return svg;
}

function viewLogin() {
  const wrap = el("div");
  const hero = el("div", { class: "hero" }, [
    el("div", { class: "eyebrow" }, "Gyeongju Field Trip"),
    el("h1", {}, state.data.trip.title),
    el("p", {}, "천 년의 도시에서 모둠 미션에 도전해요"),
  ]);
  hero.append(heroSkyline());
  wrap.append(hero);
  { const n = inAppNotice(); if (n) wrap.append(n); }
  const msg = state.loginMessage;
  const input = el("input", { class: "input code-input", inputmode: "numeric", pattern: "[0-9]*", maxlength: "4", placeholder: "6101", autocomplete: "off" });
  const err = el("div", { class: "notice error hidden" });
  const btn = el("button", { class: "btn primary" }, "시작하기");
  const card = el("div", { class: "card login-card" }, [
    el("h2", {}, "모둠 코드를 입력하세요"),
    el("p", { class: "muted" }, "학년·반·모둠 순서예요. 예: 6학년 1반 1모둠 → 6101"),
    msg ? el("div", { class: "notice warn" }, msg) : null,
    el("div", { class: "field" }, input),
    err,
    btn,
    el("p", { class: "muted small", style: "margin-top:12px" }, "모둠원 모두 들어와서 일정과 미션을 볼 수 있어요. 미션 제출은 모둠에서 정한 '대표 폰' 한 대에서만 해요."),
    !isConfigured ? el("div", { class: "notice info small" }, "데모 모드: 제출 내용이 이 기기 안에만 저장됩니다.") : null,
  ]);
  { const ib = installButton(); if (ib) card.append(el("div", { class: "install-row" }, [ib, el("p", { class: "muted small", style: "margin:6px 0 0" }, "아이콘으로 바로 열면 매번 주소를 찾지 않아도 돼요.")])); }
  const submit = async () => {
    const code = input.value.trim();
    err.classList.add("hidden");
    if (!validCode(code)) { err.textContent = "없는 모둠 코드예요. 다시 확인해 주세요."; err.classList.remove("hidden"); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 확인 중';
    await login(code);
    btn.disabled = false; btn.textContent = "시작하기";
    go("#/"); render();
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  wrap.append(card);
  return wrap;
}

function totalProgress() {
  let done = 0, total = 0;
  for (const p of Object.values(state.data.places)) for (const m of p.missions || []) { total++; if (state.progress[m.id]) done++; }
  return { done, total };
}
function ringEl(done, total) {
  const r = 30, c = 2 * Math.PI * r;
  const pct = total ? done / total : 0;
  const box = el("div", { class: "ring" });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 76 76");
  svg.innerHTML = `<circle class="track" cx="38" cy="38" r="${r}"/><circle class="bar" cx="38" cy="38" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"/>`;
  box.append(svg, el("div", { class: "txt" }, [`${Math.round(pct * 100)}%`, el("small", {}, `${done}/${total}`)]));
  return box;
}

function placeProgress(placeId) {
  const ms = missionsOf(placeId);
  const done = ms.filter((m) => state.progress[m.id]).length;
  return { done, total: ms.length };
}

function viewHome() {
  const wrap = el("div");
  const tp = totalProgress();
  wrap.append(el("div", { class: "topbar" }, el("h1", {}, state.data.trip.title)));
  { const n = inAppNotice(); if (n) wrap.append(n); }
  wrap.append(el("div", { class: "home-head" }, [
    el("div", { class: "who" }, [
      el("div", { class: "g" }, `${state.session.code[0]}학년 ${state.session.code[1]}반`),
      el("div", { class: "n" }, `${parseInt(state.session.code.slice(2), 10)}모둠`),
      el("div", { class: "s" }, tp.done === tp.total && tp.total > 0 ? "🎉 모든 미션을 마쳤어요!" : tp.done === 0 ? "첫 미션을 시작해 보세요" : `미션 ${tp.total - tp.done}개가 남았어요`),
    ]),
    ringEl(tp.done, tp.total),
  ]));
  wrap.append(viewRepCard());
  wrap.append(viewStampBoard());
  if (state.pendingItems && state.pendingItems.length) wrap.append(viewPendingCard());
  for (const day of state.data.trip.days) {
    wrap.append(el("div", { class: "day-title" }, day.label || `${day.day}일차`));
    const tl = el("div", { class: "timeline" });
    for (const stop of day.stops) {
      const p = place(stop.placeId);
      if (!p) {
        // 장소 없이 글자만 있는 일정 항목 (예: 🚌 버스 이동)
        if (!stop.label) continue;
        tl.append(el("div", { class: "stop info custom" }, [
          el("div", { class: "emoji" }, stop.emoji || "📍"),
          el("div", { class: "body" }, [el("div", { class: "name" }, stop.label), el("div", { class: "meta" }, stop.time || "")]),
        ]));
        continue;
      }
      const isMission = p.type === "mission";
      const pr = isMission ? placeProgress(stop.placeId) : null;
      const complete = isMission && pr.total > 0 && pr.done === pr.total;
      const btn = el("button", { class: `stop ${isMission ? "" : "info"} ${complete ? "complete" : ""}`, onclick: () => go(`#/place/${stop.placeId}`) }, [
        el("div", { class: "emoji" }, p.emoji || "📍"),
        el("div", { class: "body" }, [
          el("div", { class: "name" }, p.name),
          el("div", { class: "meta" }, [stop.time ? `${stop.time} · ` : "", isMission ? `미션 ${pr.total}개` : "안내"]),
          isMission ? el("div", { class: "progress-bar" }, el("i", { style: `width:${pr.total ? (pr.done / pr.total) * 100 : 0}%` })) : null,
        ]),
        isMission
          ? el("div", { class: "prog" }, el("span", { class: `pill-count ${complete ? "done" : pr.done > 0 ? "partial" : ""}` }, `${pr.done}/${pr.total}`))
          : el("div", { class: "arrow" }, "›"),
      ]);
      tl.append(btn);
    }
    wrap.append(tl);
  }
  { const ib = installButton({ compact: true }); if (ib) wrap.append(el("div", { class: "install-row", style: "text-align:center;margin-top:18px" }, ib)); }
  wrap.append(el("p", { class: "muted small", style: "margin-top:20px;text-align:center" }, [
    "다른 모둠 코드로 바꾸려면 ",
    el("a", { href: "#", onclick: async (e) => {
      e.preventDefault();
      const n = (await pending()).length;
      const ok = await modal({
        title: "접속을 끊을까요?",
        body: n > 0 ? `아직 서버로 보내지 못한 제출이 ${n}개 있어요. 지금 끊으면 나중에 같은 코드로 다시 접속했을 때 마저 보내요.` : (isRep() ? "이 폰은 대표 폰이에요. 접속을 끊어도 제출한 내용은 서버에 남아 있어요." : "제출한 내용은 서버에 남아 있어요."),
        buttons: [{ label: "취소", value: false }, { label: "접속 끊기", value: true, kind: "danger" }],
      });
      if (ok) logoutLocal();
    } }, "여기를 누르세요"),
  ]));
  return wrap;
}

// 미션 스탬프: 미션마다 칸 하나. 선생님 도장을 받으면 빨간 도장이 찍힌다.
function viewStampBoard() {
  const ms = allMissionList();
  if (!ms.length) return el("div");
  const ss = stampStats();
  const card = el("div", { class: "card stamp-card" });
  card.append(el("div", { class: "row" }, [
    el("h2", { style: "margin:0" }, "미션 스탬프"),
    el("div", { class: "stamp-count" }, [el("strong", {}, String(ss.stamped)), el("span", { class: "muted" }, ` / ${ss.total}`)]),
  ]));
  // 칸 수가 늘어도 두 줄 안팎이 되도록 열 수를 정한다. 칸 아래 미션 이름이 읽히도록 한 줄 최대 6칸.
  const maxCols = window.innerWidth < 380 ? 5 : 6; // 좁은 폰은 5칸
  const cols = Math.max(4, Math.min(maxCols, Math.ceil(ms.length / 2)));
  const grid = el("div", { class: "stamp-grid", style: `grid-template-columns: repeat(${cols}, 1fr)` });
  ms.forEach((m, i) => {
    const st = state.stamps[m.id] ? "stamped" : state.progress[m.id] ? "pending" : "";
    grid.append(el("div", { class: `stamp-slot ${st}`, title: `${m.placeName} · ${m.title}` }, [
      el("div", { class: "circle" }, [
        st === "stamped" ? el("span", { class: "seal" }, "도장") : st === "pending" ? el("span", { class: "wait" }, "검토 중") : el("span", { class: "no" }, String(i + 1)),
      ]),
      el("span", { class: "lbl" }, m.title),
    ]));
  });
  card.append(grid);
  if (ss.complete) {
    card.append(el("div", { class: "notice ok", style: "margin-top:12px" }, "🏆 모든 미션에 도장을 받았어요! 수학여행 완주!"));
    card.append(el("button", { class: "btn gold", onclick: () => go("#/certificate") }, "완주 인증서 보기"));
  } else {
    card.append(el("p", { class: "muted small", style: "margin:10px 0 0" }, "제출한 미션을 선생님이 확인하면 도장이 찍혀요. 모든 칸을 채우면 완주 인증서를 받아요!"));
  }
  return card;
}

// 완주 인증서
function certificateSvg() {
  const t = state.data.trip;
  const code = state.session.code;
  const group = `${code[0]}학년 ${code[1]}반 ${parseInt(code.slice(2), 10)}모둠`;
  const ss = stampStats();
  const d = new Date();
  const date = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 500" width="720" height="500" font-family="-apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif">
  <rect width="720" height="500" fill="#fbf7ec"/>
  <rect x="18" y="18" width="684" height="464" fill="none" stroke="#d4a72c" stroke-width="6"/>
  <rect x="30" y="30" width="660" height="440" fill="none" stroke="#d4a72c" stroke-width="1.5"/>
  <circle cx="360" cy="96" r="34" fill="#e0b34a"/><circle cx="360" cy="96" r="26" fill="#fbf1d6"/>
  <text x="360" y="105" text-anchor="middle" font-size="26" font-weight="800" fill="#b98a1e">★</text>
  <text x="360" y="170" text-anchor="middle" font-size="34" font-weight="900" fill="#1d2440" letter-spacing="6">완주 인증서</text>
  <text x="360" y="204" text-anchor="middle" font-size="16" fill="#6b7280">${esc(t.title)}</text>
  <text x="360" y="268" text-anchor="middle" font-size="30" font-weight="900" fill="#1d2440">${esc(group)}</text>
  <text x="360" y="316" text-anchor="middle" font-size="16" fill="#1c2033">위 모둠은 수학여행 미션 ${ss.total}개를 모두 해내고</text>
  <text x="360" y="342" text-anchor="middle" font-size="16" fill="#1c2033">선생님 도장 ${ss.stamped}개를 받았기에 이 인증서를 드립니다.</text>
  <text x="360" y="410" text-anchor="middle" font-size="15" fill="#4b5068">${esc(date)}</text>
  <text x="360" y="444" text-anchor="middle" font-size="17" font-weight="800" fill="#1d2440">${esc(t.title)} 선생님 일동</text>
  <circle cx="600" cy="420" r="34" fill="none" stroke="#d9483b" stroke-width="3" opacity=".85"/>
  <text x="600" y="427" text-anchor="middle" font-size="16" font-weight="900" fill="#d9483b" opacity=".85">완주</text>
</svg>`;
}
function viewCertificate() {
  const wrap = el("div");
  wrap.append(el("div", { class: "topbar" }, [el("button", { class: "back", onclick: () => go("#/") }, "‹"), el("h1", {}, "완주 인증서")]));
  const holder = el("div", { class: "cert-holder", html: certificateSvg() });
  wrap.append(el("div", { class: "card", style: "padding:10px" }, holder));
  wrap.append(el("button", { class: "btn gold", onclick: async () => {
    try {
      const svg = new Blob([certificateSvg()], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(svg);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement("canvas"); c.width = 1440; c.height = 1000;
      c.getContext("2d").drawImage(img, 0, 0, 1440, 1000);
      URL.revokeObjectURL(url);
      const a = el("a", { href: c.toDataURL("image/png"), download: `완주인증서_${state.session.code}.png` });
      document.body.append(a); a.click(); a.remove();
    } catch (e) { toast("이미지 저장에 실패했어요. 화면을 캡처해 주세요.", "error", 3500); }
  } }, "이미지로 저장"));
  wrap.append(el("p", { class: "muted small", style: "text-align:center" }, "저장이 안 되면 화면을 캡처해도 돼요."));
  return wrap;
}

// 대표 폰 상태 카드: 보기 모드면 '대표 폰으로 정하기' 버튼, 대표 폰이면 표시만
function viewRepCard() {
  if (isRep()) {
    return el("div", { class: "rep-bar rep" }, [el("span", {}, "📱 이 폰이 우리 모둠 대표 폰이에요"), el("span", { class: "muted small" }, "미션 제출은 이 폰에서")]);
  }
  const info = state.repInfo || {};
  const btn = el("button", { class: "btn small gold", onclick: () => becomeRep(btn) }, info.exists && info.active ? "대표 폰 이어받기" : "우리 모둠 대표 폰으로 정하기");
  return el("div", { class: "rep-bar" }, [
    el("div", {}, [
      el("div", { style: "font-weight:800" }, "지금은 보기 모드예요"),
      el("div", { class: "muted small" }, info.exists && info.active ? "우리 모둠에는 이미 대표 폰이 있어요. 미션 제출은 그 폰에서 해요." : "미션을 제출하려면 모둠에서 폰 한 대를 대표로 정하세요."),
    ]),
    btn,
  ]);
}
async function becomeRep(btn) {
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  const r = await claimRep();
  if (r.ok) { toast("이 폰이 우리 모둠 대표 폰이 되었어요!", "ok"); render(); return; }
  if (btn) { btn.disabled = false; btn.textContent = label; }
  if (r.reason === "in_use") {
    await modal({
      title: "이미 대표 폰이 있어요",
      body: `우리 모둠은 다른 폰이 대표예요. 그 폰에서 ${CFG.lockTimeoutMinutes || 5}분 동안 앱을 쓰지 않으면 이 버튼으로 이어받을 수 있고, 선생님이 바로 풀어 줄 수도 있어요.`,
      buttons: [{ label: "알겠어요", value: true, kind: "primary" }],
    });
  } else if (r.reason === "network") {
    toast("인터넷 연결이 불안정해요. 신호가 잡히는 곳에서 다시 눌러 주세요.", "error", 3500);
  } else {
    toast("잠시 후 다시 시도해 주세요.", "error");
  }
}

// 전송 대기 중인 제출과 마지막 오류를 보여 주는 카드 (문제 파악용)
function viewPendingCard() {
  const items = state.pendingItems;
  const card = el("div", { class: "card", style: "border:1px solid #f3d9a4" });
  card.append(el("h2", {}, `⏳ 전송 대기 ${items.length}개`));
  card.append(el("p", { class: "muted small" }, state.online ? "자동으로 다시 보내는 중이에요. 계속 안 되면 아래 오류 내용을 선생님께 보여 주세요." : "인터넷이 연결되면 자동으로 보내요."));
  for (const it of items) {
    const m = findMission(it.placeId, it.missionId);
    card.append(el("div", { class: "notice warn small", style: "word-break:break-all" }, [
      el("strong", {}, m ? m.title : it.missionId),
      ` · 사진 ${it.photoPaths.length}장 · 시도 ${it.attempts}회`,
      it.lastError ? el("div", { style: "margin-top:4px" }, `오류: ${it.lastError}`) : null,
    ]));
  }
  card.append(el("button", { class: "btn", onclick: async () => { syncMsg = "📤 다시 보내는 중…"; renderStatus(); await retryNow(); } }, "지금 다시 보내기"));
  return card;
}

// 안내·미션 이미지: 잘리지 않게 전체를 보여 주고, 누르면 화면 가득 크게 본다 (두 손가락으로 확대 가능)
function imageCard(src, alt, cls, style) {
  const img = el("img", { src, alt, loading: "lazy" });
  const card = el("div", { class: cls, style: style || "" }, [img, el("span", { class: "zoom-hint" }, "🔍 누르면 크게")]);
  card.addEventListener("click", () => openImage(src, alt));
  return card;
}
function openImage(src, alt) {
  const big = el("img", { src, alt });
  const bar = el("div", { class: "lb-bar" }, [
    el("button", { class: "btn small", onclick: (e) => { e.stopPropagation(); window.open(src, "_blank", "noopener"); } }, "원본 크기로 열기"),
    el("button", { class: "btn small primary", onclick: (e) => { e.stopPropagation(); lb.remove(); } }, "닫기"),
  ]);
  const lb = el("div", { class: "lightbox scroll" }, [big, bar]);
  lb.addEventListener("click", (e) => { if (e.target === lb) lb.remove(); });
  document.body.append(lb);
}

function viewPlace(placeId) {
  const p = place(placeId);
  const wrap = el("div");
  const ms = missionsOf(placeId);
  wrap.append(el("div", { class: "topbar" }, [
    el("button", { class: "back", onclick: () => go("#/") }, "‹"),
    el("h1", {}, p.name),
    el("span", { class: "chip" }, codeLabel(state.session.code)),
  ]));
  wrap.append(el("div", { class: "place-head" }, [
    el("div", { class: "emoji" }, p.emoji || "📍"),
    el("div", {}, [el("div", { class: "t" }, p.name), el("div", { class: "d" }, ms.length ? `미션 ${ms.length}개` : "안내")]),
  ]));
  if (p.image) wrap.append(imageCard(p.image, p.name, "card img-card"));
  if (p.intro) wrap.append(el("div", { class: "card" }, el("p", { class: "intro" }, p.intro)));
  if (!ms.length) return wrap;
  const pr = placeProgress(placeId);
  wrap.append(el("div", { class: "card prog-card" }, [
    el("div", { style: "flex:1" }, [
      el("div", { class: "muted small", style: "font-weight:700" }, "진행 상황"),
      el("div", { class: "progress-bar" }, el("i", { style: `width:${pr.total ? (pr.done / pr.total) * 100 : 0}%` })),
    ]),
    el("div", { class: "num" }, [String(pr.done), el("small", {}, ` / ${pr.total}`)]),
  ]));
  ms.forEach((m, i) => {
    const st = state.progress[m.id];
    const cls = st ? (st.status === "sent" ? "done" : "queued") : "";
    const label = !st ? "" : st.status === "sent" ? "완료" : "전송 대기";
    wrap.append(el("button", { class: `mission-item ${cls}`, onclick: () => go(`#/mission/${placeId}/${m.id}`) }, [
      el("div", { class: "idx" }, st ? "✓" : String(i + 1)),
      el("div", { class: "body" }, [el("div", { class: "t" }, m.title), el("div", { class: "w" }, [typeIcon(m.type), " ", m.where || ""])]),
      state.stamps[m.id] ? el("span", { class: "st seal-mini" }, "도장") : label ? el("span", { class: `chip st ${st.status === "sent" ? "ok" : "warn"}` }, label) : el("span", { class: "st arrow" }, "›"),
    ]));
  });
  return wrap;
}
function typeIcon(t) { return t === "photo" ? "📷" : t === "choice" ? "🔘" : "✏️"; }

function viewMission(placeId, missionId) {
  const m = findMission(placeId, missionId);
  const p = place(placeId);
  const prev = state.progress[m.id];
  const draftKey = draftKeyOf(placeId, missionId);
  const draft = state.draft[draftKey] || (state.draft[draftKey] = { choice: prev?.answer?.choice ?? null, text: prev?.answer?.text || "", photos: [] });

  const wrap = el("div");
  wrap.append(el("div", { class: "topbar" }, [
    el("button", { class: "back", onclick: () => go(`#/place/${placeId}`) }, "‹"),
    el("h1", {}, p.name),
    el("span", { class: "chip" }, codeLabel(state.session.code)),
  ]));
  const card = el("div", { class: "card mission-card" });
  card.append(el("div", { class: "kind" }, [typeIcon(m.type), " ", m.type === "photo" ? "사진 미션" : m.type === "choice" ? "퀴즈" : "생각 쓰기"]));
  card.append(el("h2", {}, m.title));
  if (m.where) card.append(el("div", { class: "where" }, [el("span", {}, "📍"), el("span", {}, [el("strong", {}, "어디서 "), m.where])]));
  if (state.stamps[m.id]) card.append(el("div", { class: "notice ok stamped-notice" }, [el("span", { class: "seal-mini" }, "도장"), " 선생님 도장을 받았어요!"]));
  else if (prev) card.append(el("div", { class: `notice ${prev.status === "sent" ? "ok" : "warn"}` }, prev.status === "sent" ? "✓ 제출 완료! 선생님이 확인하면 도장이 찍혀요. 다시 제출하면 새 내용으로 바뀌어요." : "⏳ 저장됨. 인터넷이 연결되면 자동으로 보내요. 다시 제출하면 새 내용으로 바뀌어요."));
  if (m.image) card.append(imageCard(m.image, "미션 사진", "img-card", "margin:10px 0"));
  card.append(el("div", { class: "question" }, m.question || ""));
  if (m.hint) card.append(el("details", { class: "hint" }, [el("summary", {}, "힌트 보기"), el("p", {}, m.hint)]));

  const err = el("div", { class: "notice error hidden" });
  const body = el("div");

  // ----- 유형별 입력
  if (m.type === "choice") {
    const letters = "①②③④⑤⑥⑦⑧";
    m.options.forEach((opt, i) => {
      const b = el("button", { class: `option ${draft.choice === i ? "selected" : ""}` }, [el("span", { class: "letter" }, letters[i] || i + 1), el("span", {}, opt)]);
      b.addEventListener("click", () => {
        draft.choice = i;
        body.querySelectorAll(".option").forEach((o, j) => o.classList.toggle("selected", j === i));
        saveDraft(placeId, missionId);
      });
      body.append(b);
    });
  }
  let textarea = null;
  if (m.type === "text" || (m.type === "photo" && m.caption)) {
    textarea = el("textarea", { class: "input", placeholder: m.type === "text" ? "모둠의 답을 적어 주세요" : m.caption, maxlength: "500" });
    textarea.value = draft.text;
    textarea.addEventListener("input", () => { draft.text = textarea.value; saveDraft(placeId, missionId); });
    body.append(el("div", { class: "field" }, [m.type === "photo" ? el("label", {}, m.caption) : null, textarea]));
  }
  let photoGrid = null;
  let photoState = null; // 사진 미션의 이전 사진 유지 상태
  if (m.type === "photo") {
    const max = m.maxPhotos || 1;
    photoGrid = el("div", { class: "photos" });
    // 카메라로 바로 찍기 / 앨범에서 고르기 두 가지 입력
    const fileInput = el("input", { type: "file", accept: "image/*", capture: "environment", class: "sr-only" });
    const galleryInput = el("input", { type: "file", accept: "image/*", class: "sr-only", multiple: max > 1 ? "multiple" : undefined });
    const onPick = (input) => async () => {
      const files = Array.from(input.files || []);
      input.value = "";
      if (!files.length) return;
      const room = photoState ? photoState.roomLeft() : max - draft.photos.length;
      if (room <= 0) return;
      if (files.length > room) toast(`사진은 최대 ${max}장까지예요. 앞의 ${room}장만 넣었어요.`, "warn", 3000);
      for (const f of files.slice(0, room)) {
        const busy = el("div", { class: "ph" }, el("div", { style: "display:grid;place-items:center;height:100%" }, el("span", { class: "spinner" })));
        photoGrid.prepend(busy);
        try {
          const blob = await compressImage(f, CFG.photo || {});
          draft.photos.push(blob);
          saveDraft(placeId, missionId);
        } catch (e) {
          console.error(e);
          toast("사진을 읽지 못했어요. 다른 사진으로 다시 시도해 주세요.", "error");
        }
        renderPhotos();
      }
    };
    fileInput.addEventListener("change", onPick(fileInput));
    galleryInput.addEventListener("change", onPick(galleryInput));
    body.append(fileInput, galleryInput);
    // 이전에 제출한 사진: 이 폰에 남아 있는 파일을 같은 격자에 보여 주고, ✕로 빼거나 새 사진을 더할 수 있다
    const kept = []; // { path, blob }
    let keptLoaded = false;
    let keptMissing = 0; // 다른 폰에서 제출해 이 폰에 없는 이전 사진 수
    const total = () => kept.length + draft.photos.length;
    const loadKept = async () => {
      try {
        const rows = (await store.all("photos"))
          .filter((r) => r.key.startsWith(`${state.session.code}/${m.id}/`) && !r.key.endsWith("_t.jpg") && r.blob)
          .sort((a, b) => a.key.localeCompare(b.key));
        // 초안에 '남길 사진' 목록이 있으면(이전에 ✕로 뺀 것 반영) 그것만, 없으면 전부
        const want = Array.isArray(draft.keptPaths) ? new Set(draft.keptPaths) : null;
        for (const r of rows) if (!want || want.has(r.key)) kept.push({ path: r.key, blob: r.blob });
        if (prev && prev.photoCount && !rows.length) keptMissing = prev.photoCount;
      } catch (e) { /* 저장소를 못 읽으면 새 사진만 */ }
      keptLoaded = true;
      renderPhotos();
    };
    const renderPhotos = () => {
      photoGrid.innerHTML = "";
      kept.forEach((k, i) => {
        const url = URL.createObjectURL(k.blob);
        const img = el("img", { src: url, alt: `이전 사진 ${i + 1}` });
        img.onload = () => URL.revokeObjectURL(url);
        photoGrid.append(el("div", { class: "ph kept" }, [
          img,
          el("span", { class: "tag" }, prev && prev.status === "sent" ? "제출됨" : "저장됨"),
          el("button", { class: "rm", "aria-label": "이 사진 빼기", onclick: () => { kept.splice(i, 1); draft.keptPaths = kept.map((x) => x.path); saveDraft(placeId, missionId); renderPhotos(); } }, "✕"),
        ]));
      });
      draft.photos.forEach((blob, i) => {
        const url = URL.createObjectURL(blob);
        const img = el("img", { src: url, alt: `사진 ${kept.length + i + 1}` });
        img.onload = () => URL.revokeObjectURL(url);
        photoGrid.append(el("div", { class: "ph" }, [img, el("button", { class: "rm", "aria-label": "삭제", onclick: () => { draft.photos.splice(i, 1); saveDraft(placeId, missionId); renderPhotos(); } }, "✕")]));
      });
      if (total() < max) {
        photoGrid.append(el("button", { class: "add", onclick: () => fileInput.click() }, [el("span", {}, "📷"), total() ? "추가" : "사진 찍기"]));
      }
    };
    // onPick 의 남은 칸 계산이 이전 사진까지 포함하도록
    const roomLeft = () => max - total();
    renderPhotos();
    const keptNote = el("p", { class: "muted small", style: "margin:6px 0 0" });
    body.append(el("div", { class: "field" }, [
      el("label", {}, `사진 (최대 ${max}장)`),
      photoGrid,
      keptNote,
      el("p", { class: "photo-alt" }, el("a", { href: "#", onclick: (e) => { e.preventDefault(); if (total() < max) galleryInput.click(); } }, "이미 찍은 사진을 앨범에서 고르기")),
    ]));
    loadKept().then(() => {
      if (kept.length) keptNote.textContent = "이전에 낸 사진은 그대로 남아요. ✕를 누르면 빼고, 빈 칸에 새 사진을 더할 수 있어요.";
      else if (keptMissing) keptNote.textContent = `이전에 낸 사진 ${keptMissing}장은 다른 폰에서 제출해 여기에는 없어요. 다시 제출하면 새 사진으로 바뀌어요.`;
      else keptNote.remove();
    });
    photoState = { kept: () => kept, total, roomLeft, ready: () => keptLoaded };
  }
  card.append(body, err);

  const submitBtn = el("button", { class: "btn gold" }, prev ? "다시 제출하기" : "제출하기");
  submitBtn.addEventListener("click", async () => {
    err.classList.add("hidden");
    let answer;
    if (m.type === "choice") {
      if (draft.choice === null || draft.choice === undefined) return showErr("답을 하나 골라 주세요.");
      answer = { choice: draft.choice, text: m.options[draft.choice] };
    } else if (m.type === "text") {
      if (!draft.text.trim()) return showErr("답을 적어 주세요.");
      answer = { text: draft.text.trim() };
    } else {
      if (!(photoState ? photoState.total() : draft.photos.length)) return showErr("사진을 한 장 이상 찍어 주세요.");
      if (m.caption && !draft.text.trim()) return showErr("사진 설명을 적어 주세요.");
      answer = { text: draft.text.trim() };
    }
    submitBtn.disabled = true; submitBtn.innerHTML = '<span class="spinner"></span> 저장 중';
    try {
      // 교사 화면 목록용 작은 미리보기(약 30KB)를 함께 만든다. 실패해도 제출은 진행한다.
      let thumbs = [];
      try { thumbs = await Promise.all(draft.photos.map((b) => compressImage(b, { maxSide: 360, quality: 0.7, maxBytes: 40 * 1024 }))); } catch (e) { thumbs = []; }
      // 이전 제출에서 남긴 사진은 경로를 그대로 쓰고(서버에 이미 있으면 다시 올리지 않음), 새 사진만 새로 올린다
      const keptEntries = photoState ? photoState.kept().map((k) => ({ blob: k.blob, path: k.path, uploaded: !!(prev && prev.status === "sent") })) : [];
      const newEntries = draft.photos.map((b, i) => ({ blob: b, thumb: thumbs[i] }));
      const photos = [...keptEntries, ...newEntries];
      await enqueue({ code: state.session.code, placeId, missionId: m.id, answer, photos });
      state.progress[m.id] = { status: "queued", answer, photoCount: photos.length, at: new Date().toISOString() };
      saveProgress();
      clearDraft(placeId, missionId);
      toast(navigator.onLine ? "제출했어요! 전송 중…" : "저장했어요! 인터넷이 연결되면 자동으로 보내요.", "ok");
      go(`#/place/${placeId}`);
    } catch (e) {
      console.error(e);
      submitBtn.disabled = false; submitBtn.textContent = "제출하기";
      showErr("저장에 실패했어요. 휴대폰 저장 공간을 확인하고 다시 시도해 주세요.");
    }
    function showErr(t) { err.textContent = t; err.classList.remove("hidden"); submitBtn.disabled = false; submitBtn.textContent = prev ? "다시 제출하기" : "제출하기"; }
  });
  if (isRep()) {
    card.append(el("div", { class: "submit-wrap" }, submitBtn));
  } else {
    const info = state.repInfo || {};
    const repBtn = el("button", { class: "btn gold", onclick: () => becomeRep(repBtn) }, info.exists && info.active ? "대표 폰 이어받기" : "우리 모둠 대표 폰으로 정하기");
    card.append(el("div", { class: "submit-wrap" }, [
      el("div", { class: "notice info" }, "제출은 우리 모둠 대표 폰에서만 할 수 있어요. 여기서 적은 내용은 이 폰에만 저장돼요."),
      repBtn,
    ]));
  }
  wrap.append(card);
  return wrap;
}

// ------------------------------------------------------------ 하단 상태 표시줄
let statusEl = null;
let syncMsg = null;
function renderStatus() {
  if (!statusEl) { statusEl = el("div", { class: "statusbar hidden" }); document.body.append(statusEl); }
  if (!state.session) { statusEl.classList.add("hidden"); document.body.classList.remove("has-status"); return; }
  let text = "", cls = "";
  if (!state.online) { text = `📴 오프라인 · 저장된 제출 ${state.pendingCount}개는 연결되면 자동 전송`; cls = "warn"; }
  else if (syncMsg) { text = syncMsg; cls = ""; }
  else if (state.pendingCount > 0) {
    const err = (state.pendingItems || []).find((i) => i.lastError);
    text = `⏳ 전송 대기 ${state.pendingCount}개 · 자동으로 다시 시도 중${err ? " · " + String(err.lastError).slice(0, 60) : ""}`;
    cls = "warn";
  }
  else { statusEl.classList.add("hidden"); document.body.classList.remove("has-status"); return; }
  statusEl.className = `statusbar ${cls}`;
  statusEl.textContent = text;
  document.body.classList.add("has-status");
}

let pendingSig = "";
async function refreshPending() {
  const items = await pending();
  state.pendingItems = items;
  state.pendingCount = items.length;
  renderStatus();
  // 대기 목록이 실제로 바뀌었을 때만 홈 화면을 다시 그린다
  const sig = items.map((i) => `${i.id}:${i.attempts}:${i.lastError || ""}`).join("|");
  if (sig !== pendingSig) { pendingSig = sig; if (route().name === "home") render(); }
}

// ------------------------------------------------------------ 시작
async function init() {
  // 8초가 지나도 첫 화면이 안 열리면 안내와 초기화 버튼을 보여 준다
  const slow = setTimeout(() => {
    if (booted) return;
    root().append(el("div", { class: "card", style: "text-align:center" }, [
      el("p", { class: "muted", style: "margin:0 0 10px" }, "신호가 약해 오래 걸리고 있어요. 조금 더 기다리거나 다시 열어 주세요."),
      el("div", { class: "row", style: "justify-content:center" }, [
        el("button", { class: "btn small", onclick: () => location.reload() }, "다시 열기"),
        el("button", { class: "btn small ghost", onclick: resetApp }, "처음부터 다시 열기"),
      ]),
    ]));
  }, 8000);
  try {
    state.data = (await loadTripData()).data;
  } catch (e) {
    // 캐시된 파일이 없고 오프라인이면 안내
    clearTimeout(slow);
    root().innerHTML = "";
    root().append(el("div", { class: "card" }, [
      el("h2", {}, "미션 정보를 불러오지 못했어요"),
      el("p", { class: "muted" }, "인터넷이 연결된 곳에서 다시 열어 주세요."),
      el("div", { class: "row", style: "margin-top:12px" }, [
        el("button", { class: "btn primary", onclick: () => location.reload() }, "다시 열기"),
        el("button", { class: "btn", onclick: resetApp }, "처음부터 다시 열기"),
      ]),
    ]));
    return;
  }
  state.session = ls.get("mq-session");
  if (state.session && state.session.token && state.session.rep === undefined) { state.session.rep = true; ls.set("mq-session", state.session); }
  if (state.session) { loadProgress(); await loadDrafts(); restoreRoute(); }
  // 설정의 purgeOutboxBefore 이전에 만들어진 대기 항목은 보내지 않고 지운다 (예외 상황 정리용)
  for (const missionId of await purgeStale(CFG.purgeOutboxBefore)) {
    const pr = state.progress[missionId];
    if (pr && pr.status !== "sent") { delete state.progress[missionId]; saveProgress(); }
  }

  onSync(async (ev) => {
    if (ev.type === "uploading") syncMsg = `📤 사진 전송 중 (${ev.index + 1}/${ev.total})`;
    else if (ev.type === "sent") {
      syncMsg = null;
      const pr = state.progress[ev.missionId];
      if (pr) { pr.status = "sent"; saveProgress(); }
      toast("서버에 전송 완료 ✓", "ok", 1500);
      if (route().name !== "mission") render();
    } else if (ev.type === "invalid_token") {
      syncMsg = null;
      await recoverSession();
    } else if (ev.type === "idle" || ev.type === "error") syncMsg = null;
    await refreshPending();
  });
  window.addEventListener("online", () => { state.online = true; renderStatus(); });
  window.addEventListener("offline", () => { state.online = false; renderStatus(); });
  window.addEventListener("hashchange", render);
  // 교사가 일정·미션을 고치면 앱이 다시 보일 때 새로 받아온다
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !navigator.onLine) return;
    try {
      const r = await loadTripData();
      if (JSON.stringify(r.data) !== JSON.stringify(state.data)) { state.data = r.data; render(); }
    } catch (e) {}
  });

  clearTimeout(slow);
  booted = true;
  render();
  await refreshPending();
  startSyncLoop();
  startHeartbeat();
  if (state.session) { heartbeat(); pullProgress(); }
}
init().catch((e) => { root().innerHTML = ""; root().append(errorCard(e)); });
