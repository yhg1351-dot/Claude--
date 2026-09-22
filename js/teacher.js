// 교사 확인 화면: 로그인 후 제출 현황, 답변과 사진, 접속 해제, CSV 내려받기, 전체 삭제.
import { backend, isConfigured } from "./backend.js";
import { setupPwa, installButton, inAppNotice } from "./pwa.js";
import { loadTripData, orderedPlaceIds } from "./data.js";
import { createEditor } from "./editor.js";

const CFG = window.APP_CONFIG || {};
const $ = (s, r = document) => r.querySelector(s);
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
  data: null,
  loggedIn: false,
  tab: "overview",
  classFilter: "all",
  placeFilter: null,
  submissions: [],
  sessions: [],
  stamps: [],
  stampsUnavailable: false,
  onlyUnstamped: false,
  urls: {},
  urlAt: {}, // 사진 임시 주소를 받은 시각
  urlMissing: {}, // 서버에 없는 미리보기 경로 (다시 묻지 않음)
  loadedAt: null,
  error: null,
};

// ------------------------------------------------------------ 데이터 헬퍼
function allGroupCodes() {
  const t = state.data.trip;
  const out = [];
  for (const c of t.classes) for (let g = 1; g <= c.groups; g++) out.push(`${t.grade}${c.class}${String(g).padStart(2, "0")}`);
  return out;
}
function codeLabel(code) { return `${code[1]}반 ${parseInt(code.slice(2), 10)}모둠`; }
function missionPlaces() { return orderedPlaceIds(state.data).map((id) => [id, state.data.places[id]]).filter(([, p]) => p.type === "mission"); }
function missionById(id) {
  for (const [pid, p] of missionPlaces()) for (const m of p.missions || []) if (m.id === id) return { ...m, placeId: pid, placeName: p.name };
  return null;
}
function subsFor(code) { return state.submissions.filter((s) => s.group_code === code); }
function subMap() {
  const m = new Map();
  for (const s of state.submissions) m.set(`${s.group_code}:${s.mission_id}`, s);
  return m;
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// 모둠의 '대표 폰' 상태 (보기만 하는 폰은 서버에 기록하지 않음)
function sessionStatus(s) {
  if (!s) return { label: "대표 없음", cls: "gray" };
  const age = Date.now() - new Date(s.last_seen).getTime();
  const timeout = (CFG.lockTimeoutMinutes || 5) * 60 * 1000;
  if (age < timeout) return { label: "대표 접속 중", cls: "ok" };
  if (age > 12 * 3600 * 1000) return { label: "해제됨", cls: "gray" };
  return { label: "대표 신호 끊김", cls: "warn" };
}
function answerText(sub, m) {
  const a = sub.answer || {};
  if (m && m.type === "choice") {
    const ok = a.choice === m.answer;
    return { text: `${a.text ?? "(없음)"}`, correct: ok };
  }
  return { text: a.text || "(내용 없음)", correct: null };
}
function filteredCodes() {
  return allGroupCodes().filter((c) => state.classFilter === "all" || c[1] === state.classFilter);
}

// ------------------------------------------------------------ 데이터 불러오기
function sessionExpired() {
  if (!state.loggedIn) return;
  state.loggedIn = false;
  state.sessionMessage = "로그인이 만료되었어요. 교사 코드로 다시 로그인해 주세요. 데이터는 그대로 있어요.";
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  render();
}
async function load() {
  // 세션이 사라진 상태로 조회하면 오류 없이 빈 목록이 돌아오므로 먼저 확인한다
  if (!(await backend.teacherSession())) { sessionExpired(); return; }
  const r = await backend.fetchAll();
  if (!r.ok) { state.error = r.message || "불러오기 실패"; render(); return; }
  state.submissions = r.submissions || [];
  state.sessions = r.sessions || [];
  state.stamps = r.stamps || [];
  state.stampsUnavailable = !!r.stampsUnavailable;
  state.error = null;
  state.loadedAt = new Date();
  await refreshPhotoUrls();
  await refreshConfig();
  // 편집 중이거나 ZIP 을 받는 중에는 화면을 다시 그리지 않는다 (입력·진행 표시가 끊기지 않게)
  if (state.tab === "edit" || zipJob.running) { updateLoadedAtLabel(); return; }
  render();
}
// 다른 교사가 저장한 설정을 받아온다. 편집 중(저장 안 된 변경)이면 덮어쓰지 않고 알린다.
async function refreshConfig() {
  try {
    const r = await backend.loadConfig();
    if (!r.ok || !r.data || !r.data.trip || !r.data.places) return;
    if (r.updatedAt === state.dataUpdatedAt) return;
    if (editorApi && editorApi.isDirty()) { editorApi.notifyServerChange(r.updatedAt); return; }
    state.data = r.data; state.dataUpdatedAt = r.updatedAt; state.dataSource = "server";
    editorBox = null; editorApi = null; // 편집 탭은 새 설정으로 다시 만든다
  } catch (e) {}
}
function updateLoadedAtLabel() {
  const elx = document.querySelector(".loaded-at");
  if (elx && state.loadedAt) elx.textContent = `${fmtTime(state.loadedAt.toISOString())} 갱신`;
}
// 사진 임시 주소는 15분만 유효하다. 받은 지 10분이 지났거나 아직 없는 사진만 새로 받는다.
const URL_TTL_MS = 10 * 60 * 1000;
async function refreshPhotoUrls() {
  const now = Date.now();
  const paths = [];
  for (const s of state.submissions) for (const p of s.photo_paths || []) {
    // 원본과 목록용 작은 미리보기(_t) 주소를 함께 받는다. 미리보기가 없는 옛 사진은 원본으로 대신한다.
    for (const q of [p, thumbPath(p)]) {
      if (state.urlMissing[q]) continue;
      if (!state.urls[q] || !state.urlAt[q] || now - state.urlAt[q] > URL_TTL_MS) paths.push(q);
    }
  }
  if (!paths.length) return;
  const { urls: fresh, missing } = await backend.signedUrlsDetailed(paths);
  for (const q of paths) if (fresh[q]) { state.urls[q] = fresh[q]; state.urlAt[q] = now; }
  // 서버에 파일이 정말 없는 경로만 기억한다 (요청 실패는 다음 갱신 때 다시 시도)
  for (const q of missing) state.urlMissing[q] = true;
}
function thumbPath(p) { return p.replace(/\.jpg$/, "_t.jpg"); }
// 목록에 보여 줄 주소: 작은 미리보기가 있으면 그것, 없으면 원본
function listUrl(p) { return state.urls[thumbPath(p)] || state.urls[p]; }
// 도장 도우미
function stampKey(code, mid) { return `${code}:${mid}`; }
function stampMap() { const m = new Map(); for (const s of state.stamps) m.set(stampKey(s.group_code, s.mission_id), s); return m; }
function allMissions() { return missionPlaces().flatMap(([, p]) => p.missions || []); }
function stampCount(code) { const sm = stampMap(); return allMissions().filter((m) => sm.has(stampKey(code, m.id))).length; }
// 퀴즈 정답의 자동 도장은 서버(submit_answer)가 찍는다. 교사가 지운 도장을 화면이 되살리지 않도록 클라이언트 보완은 두지 않는다.
async function toggleStamp(s, btn) {
  const sm = stampMap();
  const has = sm.has(stampKey(s.group_code, s.mission_id));
  if (btn) btn.disabled = true;
  const r = await backend.setStamp(s.group_code, s.mission_id, !has);
  if (!r.ok) { alert(`도장 저장 실패: ${r.message || ""}`); if (btn) btn.disabled = false; return; }
  if (has) state.stamps = state.stamps.filter((x) => stampKey(x.group_code, x.mission_id) !== stampKey(s.group_code, s.mission_id));
  else state.stamps.push({ group_code: s.group_code, mission_id: s.mission_id, auto: false, created_at: new Date().toISOString() });
  render();
}
function stampControls(s) {
  const st = stampMap().get(stampKey(s.group_code, s.mission_id));
  const row = el("div", { class: "stamp-row" });
  if (st) {
    row.append(el("span", { class: "chip ok" }, st.auto ? "✓ 도장 (정답 자동)" : "✓ 도장 찍힘"));
    row.append(el("button", { class: "btn small ghost danger", onclick: (e) => toggleStamp(s, e.currentTarget) }, "지우기"));
  } else {
    row.append(el("button", { class: "btn small stamp-btn", onclick: (e) => toggleStamp(s, e.currentTarget) }, "도장 찍기"));
  }
  return row;
}
function unstampedFilter() {
  return el("button", { class: `btn small ${state.onlyUnstamped ? "gold" : ""}`, onclick: () => { state.onlyUnstamped = !state.onlyUnstamped; render(); } }, state.onlyUnstamped ? "도장 안 찍힌 것만 보는 중" : "도장 안 찍힌 것만 보기");
}
function isStamped(s) { return stampMap().has(stampKey(s.group_code, s.mission_id)); }

let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => { if (document.visibilityState === "visible" && state.loggedIn) load(); }, 30000);
}

// ------------------------------------------------------------ 화면
function render() {
  const app = $("#app");
  app.innerHTML = "";
  if (!state.loggedIn) { app.append(viewLogin()); return; }
  app.append(viewHeader());
  if (state.error) app.append(el("div", { class: "notice error" }, `불러오기 오류: ${state.error} (30초마다 자동으로 다시 시도)`));
  if (state.tab === "overview") app.append(viewOverview());
  else if (state.tab === "byPlace") app.append(viewByPlace());
  else if (state.tab === "byGroup") app.append(viewByGroup());
  else if (state.tab === "tools") app.append(viewTools());
  else if (state.tab === "edit") app.append(viewEdit());
  // 편집 화면의 고정 바가 상단 바 바로 아래에 붙도록 상단 바 높이를 알려 준다
  const top = app.querySelector(".teacher-top");
  if (top) document.documentElement.style.setProperty("--tt-h", `${top.offsetHeight}px`);
}

// 편집 탭: 화면을 다시 그려도 편집 중인 내용이 남도록 컨테이너를 재사용
let editorBox = null;
let editorApi = null;
function viewEdit() {
  if (!editorBox) {
    editorBox = el("div");
    editorApi = createEditor(editorBox, {
      data: state.data, updatedAt: state.dataUpdatedAt, source: state.dataSource,
      onSaved: (data, updatedAt) => { state.data = data; state.dataUpdatedAt = updatedAt; state.dataSource = "server"; },
      // 미션을 지우거나 바꿀 때 경고에 쓸 제출·도장 수
      usage: (missionId) => ({
        subs: state.submissions.filter((x) => x.mission_id === missionId).length,
        stamps: state.stamps.filter((x) => x.mission_id === missionId).length,
      }),
    });
  }
  return editorBox;
}

function viewLogin() {
  const fixedEmail = (CFG.teacherEmail || "").trim();
  const simple = isConfigured && !!fixedEmail && !state.useEmailLogin;
  const email = el("input", { class: "input", type: "email", placeholder: "교사 이메일", autocomplete: "username" });
  const pw = el("input", { class: "input", type: "password", placeholder: simple ? "교사 코드" : "비밀번호", autocomplete: "current-password", inputmode: simple ? "text" : null });
  const err = el("div", { class: "notice error hidden" });
  const btn = el("button", { class: "btn primary" }, "들어가기");
  const doLogin = async () => {
    btn.disabled = true;
    const r = await backend.teacherLogin(simple ? fixedEmail : email.value.trim(), pw.value);
    btn.disabled = false;
    if (r.ok) { state.loggedIn = true; state.sessionMessage = null; render(); load(); startAutoRefresh(); }
    else {
      err.textContent = r.reason === "auth" ? (simple ? "교사 코드가 맞지 않습니다." : "이메일 또는 비밀번호가 맞지 않습니다.") : `로그인 실패: ${r.message || ""}`;
      err.classList.remove("hidden");
    }
  };
  btn.addEventListener("click", doLogin);
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  const ib = installButton({ label: "📲 이 폰에 교사 화면 설치", title: "교사 화면을 홈 화면에 추가하기" });
  return el("div", { style: "max-width:420px;margin:40px auto" }, el("div", { class: "card teacher-login" }, [
    el("h2", {}, "교사 확인 화면"),
    el("p", { class: "muted" }, state.data.trip.title),
    state.sessionMessage ? el("div", { class: "notice warn" }, state.sessionMessage) : null,
    inAppNotice("사진 저장과 홈 화면 설치가 잘 안 될 수 있으니 크롬이나 사파리로 열어 주세요."),
    !isConfigured ? el("div", { class: "notice info small" }, "데모 모드: 이 기기에서 제출한 내용만 보입니다. 비밀번호는 config.js의 localTeacherPassword 값입니다.") : null,
    isConfigured && !simple ? el("div", { class: "field" }, email) : null,
    el("div", { class: "field" }, [simple ? el("label", {}, "교사 코드를 입력하세요") : null, pw]),
    err, btn,
    isConfigured && fixedEmail
      ? el("p", { class: "muted small", style: "margin-top:12px;text-align:center" }, el("a", { href: "#", onclick: (e) => { e.preventDefault(); state.useEmailLogin = !state.useEmailLogin; render(); } }, simple ? "다른 계정으로 로그인" : "교사 코드로 로그인"))
      : null,
    el("p", { class: "muted small", style: "text-align:center" }, "한 번 로그인하면 이 기기에서는 계속 유지됩니다."),
    ib ? el("div", { class: "install-row", style: "text-align:center" }, [ib, el("p", { class: "muted small", style: "margin:6px 0 0" }, "여행 중에는 홈 화면 아이콘으로 바로 여는 게 편해요.")]) : null,
  ]));
}

function viewHeader() {
  // 1단계 주 메뉴: 분할 막대 (좁은 화면에서는 짧은 이름)
  const tabs = [["overview", "현황", "현황"], ["byPlace", "장소별 제출", "장소별"], ["byGroup", "모둠별 제출", "모둠별"], ["edit", "편집", "편집"], ["tools", "도구", "도구"]];
  return el("div", { class: "teacher-head" }, [
    el("div", { class: "teacher-top" }, [
      el("h1", {}, "교사 확인 화면"),
      el("span", { class: "stamp loaded-at" }, state.loadedAt ? `${fmtTime(state.loadedAt.toISOString())} 갱신` : ""),
      el("button", { class: "btn small icon", onclick: load, "aria-label": "새로고침", title: "새로고침" }, "↻"),
      el("button", { class: "btn small", onclick: async () => { await backend.teacherLogout(); state.loggedIn = false; render(); } }, "나가기"),
    ]),
    el("div", { class: "tabs seg" }, tabs.map(([k, l, sh]) => el("button", { class: k === state.tab ? "active" : "", onclick: () => { state.tab = k; render(); } }, [el("span", { class: "full" }, l), el("span", { class: "short" }, sh)]))),
    state.tab === "edit" ? null : el("div", { class: "toolbar class-picker" }, [
      el("span", { class: "muted small" }, "반"),
      el("div", { class: "filter-chips" }, [
        el("button", { class: state.classFilter === "all" ? "active" : "", onclick: () => { state.classFilter = "all"; render(); } }, "전체"),
        ...state.data.trip.classes.map((c) => el("button", { class: state.classFilter === String(c.class) ? "active" : "", onclick: () => { state.classFilter = String(c.class); render(); } }, `${c.class}반`)),
      ]),
    ]),
  ]);
}

function viewOverview() {
  const codes = filteredCodes();
  const places = missionPlaces();
  const sm = subMap();
  const sessByCode = new Map(state.sessions.map((s) => [s.code, s]));
  const totalMissions = places.reduce((n, [, p]) => n + (p.missions || []).length, 0);
  const active = codes.filter((c) => sessionStatus(sessByCode.get(c)).cls === "ok").length;
  const unstamped = state.submissions.filter((s) => codes.includes(s.group_code) && !isStamped(s)).length;
  const photoCount = state.submissions.filter((s) => codes.includes(s.group_code)).reduce((n, s) => n + (s.photo_paths || []).length, 0);

  const wrap = el("div");
  wrap.append(el("div", { class: "kpis" }, [
    kpi(`${active}/${codes.length}`, "대표 폰 접속 중 / 모둠"), kpi(`${unstamped}`, "도장 안 찍힌 제출"),
    kpi(state.submissions.filter((s) => codes.includes(s.group_code)).length, `제출 건수 (최대 ${totalMissions * codes.length})`), kpi(photoCount, "사진 수"),
  ]));

  const thead = el("tr", {}, [el("th", {}, "모둠"), el("th", {}, "접속"), ...places.map(([, p]) => el("th", { class: "num" }, p.name)), el("th", { class: "num" }, "도장"), el("th", {}, "최근 제출")]);
  const rows = codes.map((code) => {
    const s = sessByCode.get(code);
    const st = sessionStatus(s);
    const subs = subsFor(code);
    const last = subs.map((x) => x.updated_at || x.created_at).sort().pop();
    const releaseBtn = s && st.cls !== "gray"
      ? el("button", { class: "btn small ghost", onclick: async () => {
          if (!confirm(`${codeLabel(code)}의 대표 폰을 해제할까요? 다른 휴대폰이 바로 대표 폰이 될 수 있게 됩니다.`)) return;
          const r = await backend.releaseGroup(code);
          if (!r.ok) alert(`실패: ${r.message || ""}`); else load();
        } }, "해제")
      : null;
    return el("tr", {}, [
      el("td", {}, el("strong", {}, codeLabel(code))),
      el("td", { class: "conn" }, el("span", { class: "cell-conn" }, [el("span", { class: `chip ${st.cls}` }, st.label), releaseBtn])),
      ...places.map(([pid, p]) => {
        const total = (p.missions || []).length;
        const done = (p.missions || []).filter((m) => sm.has(`${code}:${m.id}`)).length;
        const cls = done === 0 ? "cell-none" : done === total ? "cell-ok" : "cell-partial";
        return el("td", { class: `num ${cls}` }, `${done}/${total}`);
      }),
      el("td", { class: `num ${stampCount(code) === totalMissions && totalMissions > 0 ? "cell-ok" : stampCount(code) ? "cell-partial" : "cell-none"}` }, `${stampCount(code)}/${totalMissions}${stampCount(code) === totalMissions && totalMissions > 0 ? " 🏆" : ""}`),
      el("td", { class: "muted" }, last ? fmtTime(last) : "-"),
    ]);
  });
  wrap.append(el("div", { class: "table-wrap overview" }, el("table", { class: "grid" }, [el("thead", {}, thead), el("tbody", {}, rows)])));
  // 모바일용 카드
  const cards = el("div", { class: "group-cards" });
  for (const code of codes) {
    const s = sessByCode.get(code);
    const st = sessionStatus(s);
    const hd = el("div", { class: "hd" }, [el("strong", {}, codeLabel(code)), el("span", { class: `chip ${st.cls}` }, st.label)]);
    if (s && st.cls !== "gray") hd.append(el("button", { class: "btn small ghost", onclick: async () => {
      if (!confirm(`${codeLabel(code)}의 대표 폰을 해제할까요?`)) return;
      const r = await backend.releaseGroup(code);
      if (!r.ok) alert(`실패: ${r.message || ""}`); else load();
    } }, "해제"));
    const pls = el("div", { class: "places" }, places.map(([, p]) => {
      const total = (p.missions || []).length;
      const done = (p.missions || []).filter((m) => sm.has(`${code}:${m.id}`)).length;
      return el("div", { class: "pl" }, [el("div", { class: "n" }, p.name), el("div", { class: "v" }, `${done}/${total}`), el("div", { class: "mini" }, el("i", { style: `width:${total ? (done / total) * 100 : 0}%` }))]);
    }));
    const sc = stampCount(code);
    cards.append(el("div", { class: "group-card" }, [hd, pls, el("div", { class: "muted small", style: "margin-top:8px" }, `도장 ${sc}/${totalMissions}${sc === totalMissions && totalMissions > 0 ? " 🏆 완주" : ""}`)]));
  }
  wrap.append(cards);
  wrap.append(el("p", { class: "muted small" }, `모둠원은 누구나 앱을 볼 수 있고, 제출은 모둠이 정한 '대표 폰' 한 대만 합니다. "대표 접속 중"은 최근 ${CFG.lockTimeoutMinutes || 5}분 안에 대표 폰 신호가 있음, "대표 신호 끊김"은 다른 폰이 대표를 이어받을 수 있는 상태. '해제'를 누르면 바로 다른 폰이 대표가 될 수 있습니다. 30초마다 자동 갱신.`));
  return wrap;
}
function kpi(v, l) { return el("div", { class: "kpi" }, [el("div", { class: "v" }, String(v)), el("div", { class: "l" }, l)]); }

function viewByPlace() {
  const places = missionPlaces();
  const wrap = el("div");
  if (!places.length) { wrap.append(el("p", { class: "muted", style: "padding:20px" }, "미션이 있는 장소가 없습니다. 편집 탭에서 미션을 추가하세요.")); wrap.append(orphanSection(null)); return wrap; }
  if (!state.placeFilter || !places.some(([id]) => id === state.placeFilter)) state.placeFilter = places[0][0];
  wrap.append(el("div", { class: "tabs sub" }, places.map(([pid, p]) => el("button", { class: pid === state.placeFilter ? "active" : "", onclick: () => { state.placeFilter = pid; render(); } }, p.name))));
  wrap.append(el("div", { class: "tool-row", style: "margin:4px 0 8px" }, unstampedFilter()));
  const p = state.data.places[state.placeFilter];
  const codes = filteredCodes();
  const sm = subMap();
  for (const m of p.missions || []) {
    const card = el("div", { class: "card" });
    const submittedAll = codes.filter((c) => sm.has(`${c}:${m.id}`));
    const submitted = state.onlyUnstamped ? submittedAll.filter((c) => !isStamped(sm.get(`${c}:${m.id}`))) : submittedAll;
    const missing = codes.filter((c) => !sm.has(`${c}:${m.id}`));
    card.append(el("h2", {}, [m.title, " ", el("span", { class: "chip gray" }, `${submittedAll.length}/${codes.length} 제출`), state.onlyUnstamped ? el("span", { class: "chip warn" }, `도장 대기 ${submitted.length}`) : null]));
    card.append(el("p", { class: "muted small q-text" }, m.question));
    if (m.type === "choice") card.append(el("p", { class: "muted small" }, `정답: ${m.options[m.answer]}`));
    if (missing.length) {
      const list = missing.map(codeLabel).join(", ");
      card.append(missing.length > 12
        ? el("details", { class: "small" }, [el("summary", {}, el("strong", {}, `미제출 ${missing.length}모둠 보기`)), el("p", {}, list)])
        : el("p", { class: "small" }, [el("strong", {}, "미제출: "), list]));
    }
    for (const c of submitted) card.append(subCard(sm.get(`${c}:${m.id}`), m, true));
    wrap.append(card);
  }
  wrap.append(orphanSection(null));
  return wrap;
}

function viewByGroup() {
  const codes = filteredCodes();
  const sm = subMap();
  const wrap = el("div");
  const sel = el("select", { onchange: (e) => { state.groupSel = e.target.value; render(); } }, codes.map((c) => el("option", { value: c, selected: state.groupSel === c ? "" : null }, `${codeLabel(c)} (${subsFor(c).length}건)`)));
  if (!state.groupSel || !codes.includes(state.groupSel)) state.groupSel = codes[0];
  const resetBtn = el("button", { class: "btn small ghost danger", style: "margin-left:auto", onclick: async () => {
    const code = state.groupSel;
    const n = subsFor(code).length;
    const typed = prompt(`${codeLabel(code)}의 제출 ${n}건, 사진, 도장, 접속 정보를 모두 지웁니다. 다른 모둠은 그대로입니다. 되돌릴 수 없습니다.\n계속하려면 모둠 코드 ${code} 를 입력하세요.`);
    if (typed === null) return;
    if (typed.trim() !== code) { alert("모둠 코드가 일치하지 않아 취소했습니다."); return; }
    const r = await backend.resetGroup(code);
    if (!r.ok) { alert(`초기화 실패: ${r.message || ""}`); return; }
    for (const p of Object.keys(state.urls)) if (p.startsWith(`${code}/`)) { delete state.urls[p]; delete state.urlAt[p]; delete state.urlMissing[p]; }
    alert(`${codeLabel(code)}을 초기화했습니다. (사진 ${r.photos || 0}장 삭제)`);
    load();
  } }, "이 모둠 초기화");
  wrap.append(el("div", { class: "toolbar" }, [el("label", { class: "muted small" }, "모둠: "), sel, unstampedFilter(), resetBtn]));
  for (const [pid, p] of missionPlaces()) {
    const card = el("div", { class: "card" });
    card.append(el("h2", {}, [p.emoji ? `${p.emoji} ` : "", p.name]));
    for (const m of p.missions || []) {
      const s = sm.get(`${state.groupSel}:${m.id}`);
      if (!s) { if (!state.onlyUnstamped) card.append(el("div", { class: "sub-card", style: "opacity:.6" }, [el("div", { class: "hdr" }, [el("strong", {}, m.title), el("span", { class: "chip gray" }, "미제출")])])); continue; }
      if (state.onlyUnstamped && isStamped(s)) continue;
      card.append(subCard(s, m, false));
    }
    wrap.append(card);
  }
  wrap.append(orphanSection(state.groupSel));
  return wrap;
}
// 설정(편집)에서 사라진 미션에 남은 제출. 도장 처리와 사진 확인은 그대로 할 수 있다.
function orphanSection(groupCode) {
  const codes = filteredCodes();
  const known = new Set(missionPlaces().flatMap(([, p]) => (p.missions || []).map((m) => m.id)));
  const subs = state.submissions.filter((s) => !known.has(s.mission_id) && codes.includes(s.group_code) && (!groupCode || s.group_code === groupCode));
  if (!subs.length) return el("div");
  const card = el("div", { class: "card", style: "border:1px solid #f3d9a4" });
  card.append(el("h2", {}, `설정에 없는 미션의 제출 ${subs.length}건`));
  card.append(el("p", { class: "muted small" }, "편집에서 미션을 지우거나 '기본 파일에서 가져오기'로 바꾼 뒤 남은 제출입니다. 학생 도장판에는 보이지 않습니다."));
  for (const s of subs) card.append(subCard(s, { id: s.mission_id, title: `(삭제된 미션) ${s.mission_id}`, type: "text", placeId: s.place_id, placeName: s.place_id }, !groupCode));
  return card;
}

function subCard(s, m, showGroup) {
  const a = answerText(s, m);
  const hdr = el("div", { class: "hdr" }, [
    showGroup ? el("strong", {}, codeLabel(s.group_code)) : el("strong", {}, m.title),
    a.correct === true ? el("span", { class: "chip ok" }, "정답") : a.correct === false ? el("span", { class: "chip danger" }, "오답") : null,
    el("span", { class: "muted small" }, fmtTime(s.updated_at || s.created_at)),
  ]);
  const card = el("div", { class: "sub-card" }, [hdr, el("div", { class: "ans" }, a.text)]);
  const paths = s.photo_paths || [];
  if (paths.length) {
    card.append(el("div", { class: "thumbs" }, paths.map((p) => {
      const url = listUrl(p);
      const full = state.urls[p] || url; // 크게 보기와 저장은 원본
      const img = el("img", { src: url || "", alt: "제출 사진", loading: "lazy", onclick: () => full && lightbox(full, photoFileName(s, m, paths.indexOf(p))) });
      if (!url) img.style.opacity = ".3";
      return img;
    })));
  }
  if (!state.stampsUnavailable) card.append(stampControls(s));
  return card;
}
function lightbox(url, filename) {
  const lb = el("div", { class: "lightbox", onclick: () => lb.remove() }, el("img", { src: url }));
  const bar = el("div", { class: "lb-bar", onclick: (e) => e.stopPropagation() }, [
    el("button", { class: "btn small", onclick: () => savePhoto(url, filename) }, "⬇ 이 사진 저장"),
    el("button", { class: "btn small ghost", style: "color:#fff", onclick: () => lb.remove() }, "닫기"),
  ]);
  lb.append(bar);
  document.body.append(lb);
}
async function savePhoto(url, filename) {
  try {
    const r = await fetch(url);
    const blob = await r.blob();
    const a = el("a", { href: URL.createObjectURL(blob), download: filename || "photo.jpg" });
    document.body.append(a); a.click(); a.remove();
  } catch (e) {
    alert("저장에 실패했어요. 다시 시도해 주세요.");
  }
}
// 파일 이름에 쓸 수 없는 문자 정리
function safeName(t) { return String(t || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40); }
function photoFileName(s, m, i) {
  const g = `${s.group_code[1]}반${parseInt(s.group_code.slice(2), 10)}모둠`;
  return `${g}_${safeName(m ? m.placeName : s.place_id)}_${safeName(m ? m.title : s.mission_id)}_${i + 1}.jpg`;
}

function viewTools() {
  const wrap = el("div");
  wrap.append(el("div", { class: "card" }, [
    el("h2", {}, "CSV 내려받기"),
    el("p", { class: "muted" }, `선택한 범위(${state.classFilter === "all" ? "전체" : state.classFilter + "반"})의 제출 내용을 엑셀에서 열 수 있는 파일로 저장합니다. 사진은 파일 이름만 포함되고, 시각은 한국 시각입니다.`),
    el("button", { class: "btn wide-auto", onclick: downloadCsv }, "CSV 내려받기"),
  ]));
  const codes = filteredCodes();
  const withPhotos = state.submissions.filter((s) => codes.includes(s.group_code) && (s.photo_paths || []).length);
  const photoTotal = withPhotos.reduce((n, s) => n + s.photo_paths.length, 0);
  const prog = el("div", { class: "muted small zip-prog", style: "margin-top:8px" }, zipJob.text);
  const scopeLabel = state.classFilter === "all" ? "전체" : `${state.classFilter}반`;
  const estMb = Math.round(photoTotal * 0.5);
  const zipBtn = el("button", { class: "btn wide-auto", onclick: () => downloadZip(withPhotos, prog, zipBtn) }, `${scopeLabel} 사진 ${photoTotal}장 ZIP으로 내려받기`);
  if (!photoTotal || zipJob.running) zipBtn.disabled = true;
  const scopeChips = el("div", { class: "filter-chips zip-scope", style: "margin:8px 0" }, [
    el("button", { class: state.classFilter === "all" ? "active" : "", onclick: () => { state.classFilter = "all"; render(); } }, "전체"),
    ...state.data.trip.classes.map((c) => el("button", { class: state.classFilter === String(c.class) ? "active" : "", onclick: () => { state.classFilter = String(c.class); render(); } }, `${c.class}반`)),
  ]);
  wrap.append(el("div", { class: "card" }, [
    el("h2", {}, "사진 내려받기"),
    el("p", { class: "muted" }, "제출된 사진(원본 화질)을 반·모둠 폴더로 정리한 ZIP 파일로 저장합니다. 범위를 고르세요."),
    scopeChips,
    el("p", { class: "muted small" }, `${scopeLabel}: ${withPhotos.length}건, ${photoTotal}장, 약 ${estMb}MB`),
    photoTotal > 200 ? el("div", { class: "notice warn small" }, "사진이 많습니다. 폰에서는 메모리가 부족해 실패할 수 있으니 PC에서 받거나 반별로 나눠 받으세요.") : null,
    zipBtn, prog,
    el("p", { class: "muted small" }, "사진 한 장만 저장하려면 장소별·모둠별 제출에서 사진을 눌러 크게 본 뒤 '이 사진 저장'을 누르세요."),
  ]));
  wrap.append(el("div", { class: "card" }, [
    el("h2", {}, "전체 삭제"),
    el("p", { class: "muted" }, "수학여행이 끝난 뒤 학생 답변, 사진, 접속 정보를 모두 지웁니다. 되돌릴 수 없습니다."),
    el("button", { class: "btn danger wide-auto", onclick: async () => {
      const typed = prompt('정말 삭제하려면 "삭제"라고 입력하세요.');
      if (typed !== "삭제") return;
      const r = await backend.deleteAll();
      if (!r.ok) alert(`삭제 실패: ${r.message || ""}`);
      else { alert("모두 삭제했습니다."); state.urls = {}; state.urlAt = {}; state.urlMissing = {}; load(); }
    } }, "학생 데이터 전체 삭제"),
  ]));
  { const n = inAppNotice("사진 저장과 홈 화면 설치가 잘 안 될 수 있으니 크롬이나 사파리로 열어 주세요."); const ib = installButton({ label: "📲 이 폰에 교사 화면 설치", title: "교사 화면을 홈 화면에 추가하기" });
    if (n || ib) wrap.append(el("div", { class: "card" }, [
      el("h2", {}, "이 폰에 설치"),
      el("p", { class: "muted" }, "홈 화면에 교사 화면 아이콘을 추가하면 여행 중에 주소를 찾지 않아도 바로 열 수 있습니다. 로그인은 그대로 유지됩니다."),
      n, ib ? el("div", { class: "install-row" }, ib) : null,
    ])); }
  wrap.append(el("div", { class: "card" }, [
    el("h2", {}, "운영 안내"),
    el("ul", { class: "muted small" }, [
      el("li", {}, "도장: 제출 카드의 '도장 찍기'를 누르면 학생 도장판에 바로 표시됩니다. 퀴즈 정답은 자동으로 찍히고, 모든 미션에 도장이 찍히면 학생 앱에 완주 인증서가 열립니다."),
      el("li", {}, "모둠의 대표 폰을 바꿔야 할 때: 현황 탭에서 해당 모둠의 '해제' 버튼을 누르면 새 폰에서 바로 '대표 폰으로 정하기'를 누를 수 있습니다."),
      el("li", {}, "사진이 안 보일 때: 학생 폰이 아직 전송 중일 수 있습니다. 신호가 잡히면 자동으로 올라옵니다."),
      el("li", {}, "미션 내용 수정: 저장소의 data/missions.json 파일을 고치면 1~2분 뒤 반영됩니다."),
    ]),
  ]));
  return wrap;
}

// 사진을 모두 받아 ZIP 하나로 묶는다 (브라우저 안에서 처리, 서버 부담 없음)
const zipJob = { running: false, text: "" };
function setZipText(prog, text) { zipJob.text = text; prog.textContent = text; const live = document.querySelector(".zip-prog"); if (live && live !== prog) live.textContent = text; }
async function downloadZip(subs, prog, btn) {
  if (!window.fflate) { alert("압축 기능을 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요."); return; }
  if (zipJob.running) return;
  zipJob.running = true;
  btn.disabled = true;
  const files = {};
  let done = 0, failed = 0;
  const total = subs.reduce((n, s) => n + s.photo_paths.length, 0);
  const paths = subs.flatMap((s) => s.photo_paths);
  setZipText(prog, "사진 주소를 준비하는 중…");
  const urls = await backend.signedUrls(paths);
  for (const s of subs) {
    const m = missionById(s.mission_id);
    const folder = `${s.group_code[0]}학년${s.group_code[1]}반/${parseInt(s.group_code.slice(2), 10)}모둠`;
    for (let i = 0; i < s.photo_paths.length; i++) {
      const url = urls[s.photo_paths[i]];
      let name = `${folder}/${photoFileName(s, m, i)}`;
      for (let k = 2; files[name]; k++) name = `${folder}/${photoFileName(s, m, i).replace(/\.jpg$/, `_${k}.jpg`)}`; // 같은 이름이면 번호를 붙인다
      try {
        if (!url) throw new Error("no url");
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        files[name] = [new Uint8Array(await r.arrayBuffer()), { level: 0 }];
      } catch (e) {
        failed++;
      }
      done++;
      setZipText(prog, `받는 중 ${done}/${total}${failed ? ` (실패 ${failed})` : ""}`);
    }
  }
  try {
    const zipped = window.fflate.zipSync(files);
    const blob = new Blob([zipped], { type: "application/zip" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `수학여행_사진_${state.classFilter === "all" ? "전체" : state.classFilter + "반"}_${new Date().toISOString().slice(0, 10)}.zip` });
    document.body.append(a); a.click(); a.remove();
    setZipText(prog, `완료: ${done - failed}장 저장${failed ? `, ${failed}장 실패(다시 시도해 보세요)` : ""}`);
  } catch (e) {
    setZipText(prog, "ZIP 생성에 실패했어요. 반을 나눠서 다시 시도해 주세요.");
  }
  zipJob.running = false;
  btn.disabled = false;
  if (state.tab === "tools") render();
}

function localTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
function downloadCsv() {
  const codes = filteredCodes();
  const rows = [["모둠코드", "반", "모둠", "장소", "미션", "유형", "답변", "정답여부", "도장", "사진수", "사진파일", "제출시각"]];
  for (const s of state.submissions.filter((x) => codes.includes(x.group_code)).sort((a, b) => a.group_code.localeCompare(b.group_code) || a.mission_id.localeCompare(b.mission_id))) {
    const m = missionById(s.mission_id);
    const a = answerText(s, m);
    rows.push([
      s.group_code, s.group_code[1], String(parseInt(s.group_code.slice(2), 10)),
      m ? m.placeName : s.place_id, m ? m.title : s.mission_id, m ? m.type : "",
      a.text, a.correct === null ? "" : a.correct ? "O" : "X", isStamped(s) ? "O" : "",
      String((s.photo_paths || []).length), (s.photo_paths || []).join(" "), localTime(s.updated_at || s.created_at),
    ]);
  }
  const csv = "﻿" + rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const scope = state.classFilter === "all" ? "전체" : `${state.classFilter}반`;
  const a = el("a", { href: URL.createObjectURL(blob), download: `수학여행_제출내역_${scope}_${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
}

// ------------------------------------------------------------ 시작
setupPwa({ onChange: () => { if (state.data) render(); } });
async function init() {
  const loaded = await loadTripData();
  state.data = loaded.data; state.dataUpdatedAt = loaded.updatedAt; state.dataSource = loaded.source;
  state.loggedIn = await backend.teacherSession();
  backend.onTeacherSignedOut(sessionExpired);
  render();
  if (state.loggedIn) { load(); startAutoRefresh(); }
}
init();
