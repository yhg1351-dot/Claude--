// 교사 확인 화면: 로그인 후 제출 현황, 답변과 사진, 접속 해제, CSV 내려받기, 전체 삭제.
import { backend, isConfigured } from "./backend.js";
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
  urls: {},
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
async function load() {
  const r = await backend.fetchAll();
  if (!r.ok) { state.error = r.message || "불러오기 실패"; render(); return; }
  state.submissions = r.submissions || [];
  state.sessions = r.sessions || [];
  state.error = null;
  state.loadedAt = new Date();
  const paths = [];
  for (const s of state.submissions) for (const p of s.photo_paths || []) if (!state.urls[p]) paths.push(p);
  if (paths.length) Object.assign(state.urls, await backend.signedUrls(paths));
  render();
}
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
function viewEdit() {
  if (!editorBox) {
    editorBox = el("div");
    createEditor(editorBox, {
      data: state.data, updatedAt: state.dataUpdatedAt, source: state.dataSource,
      onSaved: (data, updatedAt) => { state.data = data; state.dataUpdatedAt = updatedAt; state.dataSource = "server"; },
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
    if (r.ok) { state.loggedIn = true; render(); load(); startAutoRefresh(); }
    else {
      err.textContent = r.reason === "auth" ? (simple ? "교사 코드가 맞지 않습니다." : "이메일 또는 비밀번호가 맞지 않습니다.") : `로그인 실패: ${r.message || ""}`;
      err.classList.remove("hidden");
    }
  };
  btn.addEventListener("click", doLogin);
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  return el("div", { style: "max-width:420px;margin:40px auto" }, el("div", { class: "card" }, [
    el("h2", {}, "교사 확인 화면"),
    el("p", { class: "muted" }, state.data.trip.title),
    !isConfigured ? el("div", { class: "notice info small" }, "데모 모드: 이 기기에서 제출한 내용만 보입니다. 비밀번호는 config.js의 localTeacherPassword 값입니다.") : null,
    isConfigured && !simple ? el("div", { class: "field" }, email) : null,
    el("div", { class: "field" }, [simple ? el("label", {}, "교사 코드를 입력하세요") : null, pw]),
    err, btn,
    isConfigured && fixedEmail
      ? el("p", { class: "muted small", style: "margin-top:12px;text-align:center" }, el("a", { href: "#", onclick: (e) => { e.preventDefault(); state.useEmailLogin = !state.useEmailLogin; render(); } }, simple ? "다른 계정으로 로그인" : "교사 코드로 로그인"))
      : null,
    el("p", { class: "muted small", style: "text-align:center" }, "한 번 로그인하면 이 기기에서는 계속 유지됩니다."),
  ]));
}

function viewHeader() {
  // 1단계 주 메뉴: 분할 막대 (좁은 화면에서는 짧은 이름)
  const tabs = [["overview", "현황", "현황"], ["byPlace", "장소별 제출", "장소별"], ["byGroup", "모둠별 제출", "모둠별"], ["edit", "편집", "편집"], ["tools", "도구", "도구"]];
  return el("div", { class: "teacher-head" }, [
    el("div", { class: "teacher-top" }, [
      el("h1", {}, "교사 확인 화면"),
      el("span", { class: "stamp" }, state.loadedAt ? `${fmtTime(state.loadedAt.toISOString())} 갱신` : ""),
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
  const submittedGroups = codes.filter((c) => subsFor(c).length > 0).length;
  const photoCount = state.submissions.filter((s) => codes.includes(s.group_code)).reduce((n, s) => n + (s.photo_paths || []).length, 0);

  const wrap = el("div");
  wrap.append(el("div", { class: "kpis" }, [
    kpi(`${active}/${codes.length}`, "대표 폰 접속 중 / 모둠"), kpi(`${submittedGroups}`, "제출 시작한 모둠"),
    kpi(state.submissions.filter((s) => codes.includes(s.group_code)).length, `제출 건수 (최대 ${totalMissions * codes.length})`), kpi(photoCount, "사진 수"),
  ]));

  const thead = el("tr", {}, [el("th", {}, "모둠"), el("th", {}, "접속"), ...places.map(([, p]) => el("th", { class: "num" }, p.name)), el("th", {}, "최근 제출")]);
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
    cards.append(el("div", { class: "group-card" }, [hd, pls]));
  }
  wrap.append(cards);
  wrap.append(el("p", { class: "muted small" }, `모둠원은 누구나 앱을 볼 수 있고, 제출은 모둠이 정한 '대표 폰' 한 대만 합니다. "대표 접속 중"은 최근 ${CFG.lockTimeoutMinutes || 5}분 안에 대표 폰 신호가 있음, "대표 신호 끊김"은 다른 폰이 대표를 이어받을 수 있는 상태. '해제'를 누르면 바로 다른 폰이 대표가 될 수 있습니다. 30초마다 자동 갱신.`));
  return wrap;
}
function kpi(v, l) { return el("div", { class: "kpi" }, [el("div", { class: "v" }, String(v)), el("div", { class: "l" }, l)]); }

function viewByPlace() {
  const places = missionPlaces();
  if (!state.placeFilter) state.placeFilter = places[0][0];
  const wrap = el("div");
  wrap.append(el("div", { class: "tabs sub" }, places.map(([pid, p]) => el("button", { class: pid === state.placeFilter ? "active" : "", onclick: () => { state.placeFilter = pid; render(); } }, p.name))));
  const p = state.data.places[state.placeFilter];
  const codes = filteredCodes();
  const sm = subMap();
  for (const m of p.missions || []) {
    const card = el("div", { class: "card" });
    const submitted = codes.filter((c) => sm.has(`${c}:${m.id}`));
    const missing = codes.filter((c) => !sm.has(`${c}:${m.id}`));
    card.append(el("h2", {}, [m.title, " ", el("span", { class: "chip gray" }, `${submitted.length}/${codes.length} 제출`)]));
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
  return wrap;
}

function viewByGroup() {
  const codes = filteredCodes();
  const sm = subMap();
  const wrap = el("div");
  const sel = el("select", { onchange: (e) => { state.groupSel = e.target.value; render(); } }, codes.map((c) => el("option", { value: c, selected: state.groupSel === c ? "" : null }, `${codeLabel(c)} (${subsFor(c).length}건)`)));
  if (!state.groupSel || !codes.includes(state.groupSel)) state.groupSel = codes[0];
  wrap.append(el("div", { class: "toolbar" }, [el("label", { class: "muted small" }, "모둠: "), sel]));
  for (const [pid, p] of missionPlaces()) {
    const card = el("div", { class: "card" });
    card.append(el("h2", {}, [p.emoji ? `${p.emoji} ` : "", p.name]));
    for (const m of p.missions || []) {
      const s = sm.get(`${state.groupSel}:${m.id}`);
      if (!s) { card.append(el("div", { class: "sub-card", style: "opacity:.6" }, [el("div", { class: "hdr" }, [el("strong", {}, m.title), el("span", { class: "chip gray" }, "미제출")])])); continue; }
      card.append(subCard(s, m, false));
    }
    wrap.append(card);
  }
  return wrap;
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
      const url = state.urls[p];
      const img = el("img", { src: url || "", alt: "제출 사진", loading: "lazy", onclick: () => url && lightbox(url, photoFileName(s, m, paths.indexOf(p))) });
      if (!url) img.style.opacity = ".3";
      return img;
    })));
  }
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
    el("p", { class: "muted" }, "모든 제출 내용을 엑셀에서 열 수 있는 파일로 저장합니다. 사진은 파일 이름만 포함됩니다."),
    el("button", { class: "btn wide-auto", onclick: downloadCsv }, "CSV 내려받기"),
  ]));
  const codes = filteredCodes();
  const withPhotos = state.submissions.filter((s) => codes.includes(s.group_code) && (s.photo_paths || []).length);
  const photoTotal = withPhotos.reduce((n, s) => n + s.photo_paths.length, 0);
  const prog = el("div", { class: "muted small", style: "margin-top:8px" });
  const zipBtn = el("button", { class: "btn wide-auto", onclick: () => downloadZip(withPhotos, prog, zipBtn) }, `사진 ${photoTotal}장 ZIP으로 내려받기`);
  if (!photoTotal) zipBtn.disabled = true;
  wrap.append(el("div", { class: "card" }, [
    el("h2", {}, "사진 내려받기"),
    el("p", { class: "muted" }, `제출된 사진을 반·모둠 폴더로 정리한 ZIP 파일로 저장합니다. 위의 "반" 선택으로 범위를 좁힐 수 있습니다. (현재 ${state.classFilter === "all" ? "전체" : state.classFilter + "반"}: ${withPhotos.length}건, ${photoTotal}장)`),
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
      else { alert("모두 삭제했습니다."); state.urls = {}; load(); }
    } }, "학생 데이터 전체 삭제"),
  ]));
  wrap.append(el("div", { class: "card" }, [
    el("h2", {}, "운영 안내"),
    el("ul", { class: "muted small" }, [
      el("li", {}, "모둠의 대표 폰을 바꿔야 할 때: 현황 탭에서 해당 모둠의 '해제' 버튼을 누르면 새 폰에서 바로 '대표 폰으로 정하기'를 누를 수 있습니다."),
      el("li", {}, "사진이 안 보일 때: 학생 폰이 아직 전송 중일 수 있습니다. 신호가 잡히면 자동으로 올라옵니다."),
      el("li", {}, "미션 내용 수정: 저장소의 data/missions.json 파일을 고치면 1~2분 뒤 반영됩니다."),
    ]),
  ]));
  return wrap;
}

// 사진을 모두 받아 ZIP 하나로 묶는다 (브라우저 안에서 처리, 서버 부담 없음)
async function downloadZip(subs, prog, btn) {
  if (!window.fflate) { alert("압축 기능을 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요."); return; }
  btn.disabled = true;
  const files = {};
  let done = 0, failed = 0;
  const total = subs.reduce((n, s) => n + s.photo_paths.length, 0);
  const paths = subs.flatMap((s) => s.photo_paths);
  prog.textContent = "사진 주소를 준비하는 중…";
  const urls = await backend.signedUrls(paths);
  for (const s of subs) {
    const m = missionById(s.mission_id);
    const folder = `${s.group_code[0]}학년${s.group_code[1]}반/${parseInt(s.group_code.slice(2), 10)}모둠`;
    for (let i = 0; i < s.photo_paths.length; i++) {
      const url = urls[s.photo_paths[i]];
      const name = `${folder}/${photoFileName(s, m, i)}`;
      try {
        if (!url) throw new Error("no url");
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        files[name] = [new Uint8Array(await r.arrayBuffer()), { level: 0 }];
      } catch (e) {
        failed++;
      }
      done++;
      prog.textContent = `받는 중 ${done}/${total}${failed ? ` (실패 ${failed})` : ""}`;
    }
  }
  try {
    const zipped = window.fflate.zipSync(files);
    const blob = new Blob([zipped], { type: "application/zip" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `수학여행_사진_${state.classFilter === "all" ? "전체" : state.classFilter + "반"}_${new Date().toISOString().slice(0, 10)}.zip` });
    document.body.append(a); a.click(); a.remove();
    prog.textContent = `완료: ${done - failed}장 저장${failed ? `, ${failed}장 실패(다시 시도해 보세요)` : ""}`;
  } catch (e) {
    prog.textContent = "ZIP 생성에 실패했어요. 반을 나눠서 다시 시도해 주세요.";
  }
  btn.disabled = false;
}

function downloadCsv() {
  const rows = [["모둠코드", "반", "모둠", "장소", "미션", "유형", "답변", "정답여부", "사진수", "사진파일", "제출시각"]];
  for (const s of state.submissions.slice().sort((a, b) => a.group_code.localeCompare(b.group_code) || a.mission_id.localeCompare(b.mission_id))) {
    const m = missionById(s.mission_id);
    const a = answerText(s, m);
    rows.push([
      s.group_code, s.group_code[1], String(parseInt(s.group_code.slice(2), 10)),
      m ? m.placeName : s.place_id, m ? m.title : s.mission_id, m ? m.type : "",
      a.text, a.correct === null ? "" : a.correct ? "O" : "X",
      String((s.photo_paths || []).length), (s.photo_paths || []).join(" "), s.updated_at || s.created_at || "",
    ]);
  }
  const csv = "﻿" + rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `수학여행_제출내역_${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
}

// ------------------------------------------------------------ 시작
async function init() {
  const loaded = await loadTripData();
  state.data = loaded.data; state.dataUpdatedAt = loaded.updatedAt; state.dataSource = loaded.source;
  state.loggedIn = await backend.teacherSession();
  render();
  if (state.loggedIn) { load(); startAutoRefresh(); }
}
init();
