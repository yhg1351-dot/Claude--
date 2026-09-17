// 학생용 앱 화면. 해시 주소(#/place/…, #/mission/…)로 화면을 바꾸어 뒤로가기 버튼이 동작한다.
import { store, ls, uuid } from "./store.js";
import { backend, isConfigured } from "./backend.js";
import { compressImage } from "./image.js";
import { enqueue, pending, onSync, startSyncLoop, resumeAfterLogin, kick, retryNow } from "./sync.js";

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
function loadProgress() { state.progress = state.session ? ls.get(progressKey(), {}) : {}; }
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
  const t = el("div", { class: `notice ${kind}`, style: "position:fixed;left:16px;right:16px;top:12px;z-index:50;box-shadow:var(--shadow)" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
function modal({ title, body, buttons }) {
  return new Promise((resolve) => {
    const box = el("div", { class: "box" }, [el("h3", {}, title), el("div", { class: "muted", style: "font-size:15px" }, body)]);
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
async function login(code) {
  const r = await backend.claimGroup(code, deviceId());
  if (r.ok) {
    state.session = { code, token: r.token, deviceId: deviceId(), at: Date.now() };
    state.loginMessage = null;
    ls.set("mq-session", state.session);
    loadProgress();
    resumeAfterLogin();
    await pullProgress();
    return { ok: true };
  }
  return r;
}
function logoutLocal(message) {
  state.session = null;
  ls.remove("mq-session");
  if (message) state.loginMessage = message;
  location.hash = "#/";
  render();
}
let hbTimer = null;
async function heartbeat() {
  if (!state.session || !navigator.onLine) return;
  const r = await backend.heartbeat(state.session.token);
  if (!r.ok && r.reason === "invalid") {
    logoutLocal("다른 기기에서 이 모둠 코드로 접속했거나, 선생님이 접속을 해제했어요. 코드를 다시 입력해 주세요.");
  }
}
function startHeartbeat() {
  if (hbTimer) return;
  hbTimer = setInterval(() => { if (document.visibilityState === "visible") heartbeat(); }, (CFG.heartbeatSeconds || 60) * 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") heartbeat(); });
}
// 서버에 저장된 제출 내역을 받아 로컬 진행 상태와 합친다 (기기가 바뀌어도 진행 상태 유지)
async function pullProgress() {
  if (!state.session || !navigator.onLine) return;
  const r = await backend.getProgress(state.session.token);
  if (!r.ok || !Array.isArray(r.submissions)) return;
  const queued = new Set((await pending()).map((i) => i.missionId));
  for (const s of r.submissions) {
    if (queued.has(s.mission_id)) continue; // 아직 보내지 않은 새 제출이 우선
    state.progress[s.mission_id] = {
      status: "sent", answer: s.answer, photoCount: (s.photo_paths || []).length, at: s.updated_at || s.created_at,
    };
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
  return { name: "home" };
}
function go(hash) { location.hash = hash; }

// ------------------------------------------------------------ 렌더링
const root = () => $("#app");

function render() {
  const r = route();
  const app = root();
  app.innerHTML = "";
  if (r.name === "login") app.append(viewLogin());
  else if (r.name === "home") app.append(viewHome());
  else if (r.name === "place") app.append(viewPlace(r.placeId));
  else if (r.name === "mission") app.append(viewMission(r.placeId, r.missionId));
  renderStatus();
  window.scrollTo(0, 0);
}

function viewLogin() {
  const wrap = el("div");
  wrap.append(el("div", { class: "topbar" }, el("h1", {}, state.data.trip.title)));
  const msg = state.loginMessage;
  const input = el("input", { class: "input code-input", inputmode: "numeric", pattern: "[0-9]*", maxlength: "4", placeholder: "6101", autocomplete: "off" });
  const err = el("div", { class: "notice error hidden" });
  const btn = el("button", { class: "btn primary" }, "시작하기");
  const card = el("div", { class: "card" }, [
    el("h2", {}, "모둠 코드를 입력하세요"),
    el("p", { class: "muted" }, "예: 6학년 1반 1모둠 → 6101, 6학년 1반 10모둠 → 6110"),
    msg ? el("div", { class: "notice warn" }, msg) : null,
    el("div", { class: "field" }, input),
    err,
    btn,
    el("p", { class: "muted small", style: "margin-top:12px" }, "모둠에서 한 대의 휴대폰으로만 접속할 수 있어요. 다른 폰으로 바꾸려면 선생님께 말씀하세요."),
    !isConfigured ? el("div", { class: "notice info small" }, "데모 모드: 제출 내용이 이 기기 안에만 저장됩니다.") : null,
  ]);
  const submit = async () => {
    const code = input.value.trim();
    err.classList.add("hidden");
    if (!validCode(code)) { err.textContent = "없는 모둠 코드예요. 다시 확인해 주세요."; err.classList.remove("hidden"); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 확인 중';
    const r = await login(code);
    btn.disabled = false; btn.textContent = "시작하기";
    if (r.ok) { go("#/"); render(); return; }
    if (r.reason === "in_use") {
      err.textContent = `이 모둠 코드는 지금 다른 휴대폰에서 사용 중이에요. 그 폰에서 ${CFG.lockTimeoutMinutes || 5}분 동안 앱을 쓰지 않으면 자동으로 풀리고, 선생님이 바로 풀어 줄 수도 있어요.`;
    } else if (r.reason === "network") {
      err.textContent = "인터넷 연결이 불안정해요. 신호가 잡히는 곳에서 다시 눌러 주세요.";
    } else {
      err.textContent = "접속에 실패했어요. 잠시 후 다시 시도해 주세요.";
    }
    err.classList.remove("hidden");
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  wrap.append(card);
  return wrap;
}

function placeProgress(placeId) {
  const ms = missionsOf(placeId);
  const done = ms.filter((m) => state.progress[m.id]).length;
  return { done, total: ms.length };
}

function viewHome() {
  const wrap = el("div");
  const bar = el("div", { class: "topbar" }, [
    el("h1", {}, state.data.trip.title),
    el("span", { class: "chip" }, codeLabel(state.session.code)),
  ]);
  wrap.append(bar);
  if (state.pendingItems && state.pendingItems.length) wrap.append(viewPendingCard());
  for (const day of state.data.trip.days) {
    wrap.append(el("div", { class: "day-title" }, day.label || `${day.day}일차`));
    for (const stop of day.stops) {
      const p = place(stop.placeId);
      if (!p) continue;
      const isMission = p.type === "mission";
      const pr = isMission ? placeProgress(stop.placeId) : null;
      const btn = el("button", { class: `stop ${isMission ? "" : "info"}`, onclick: () => go(`#/place/${stop.placeId}`) }, [
        el("div", { class: "emoji" }, p.emoji || "📍"),
        el("div", {}, [
          el("div", { class: "name" }, p.name),
          el("div", { class: "meta" }, [stop.time ? `${stop.time} · ` : "", isMission ? `미션 ${pr.total}개` : "안내"]),
        ]),
        isMission
          ? el("div", { class: "prog" }, [
              el("span", { class: `chip ${pr.done === pr.total && pr.total > 0 ? "ok" : "gray"}` }, `${pr.done}/${pr.total}`),
            ])
          : el("div", { class: "prog muted" }, "›"),
      ]);
      wrap.append(btn);
    }
  }
  wrap.append(el("p", { class: "muted small", style: "margin-top:20px;text-align:center" }, [
    "다른 모둠 코드로 바꾸려면 ",
    el("a", { href: "#", onclick: async (e) => {
      e.preventDefault();
      const n = (await pending()).length;
      const ok = await modal({
        title: "접속을 끊을까요?",
        body: n > 0 ? `아직 서버로 보내지 못한 제출이 ${n}개 있어요. 지금 끊으면 나중에 같은 코드로 다시 접속했을 때 마저 보내요.` : "제출한 내용은 서버에 남아 있어요.",
        buttons: [{ label: "취소", value: false }, { label: "접속 끊기", value: true, kind: "danger" }],
      });
      if (ok) logoutLocal();
    } }, "여기를 누르세요"),
  ]));
  return wrap;
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

function viewPlace(placeId) {
  const p = place(placeId);
  const wrap = el("div");
  wrap.append(el("div", { class: "topbar" }, [
    el("button", { class: "back", onclick: () => go("#/") }, "‹"),
    el("h1", {}, `${p.emoji || ""} ${p.name}`),
    el("span", { class: "chip" }, codeLabel(state.session.code)),
  ]));
  if (p.intro) wrap.append(el("div", { class: "card" }, el("p", {}, p.intro)));
  const ms = missionsOf(placeId);
  if (!ms.length) return wrap;
  const pr = placeProgress(placeId);
  wrap.append(el("div", { class: "card", style: "padding:12px 16px" }, [
    el("div", { class: "row" }, [el("strong", {}, "진행 상황"), el("span", { style: "text-align:right" }, `${pr.done} / ${pr.total} 완료`)]),
    el("div", { class: "progress-bar" }, el("i", { style: `width:${pr.total ? (pr.done / pr.total) * 100 : 0}%` })),
  ]));
  ms.forEach((m, i) => {
    const st = state.progress[m.id];
    const cls = st ? (st.status === "sent" ? "done" : "queued") : "";
    const label = !st ? "" : st.status === "sent" ? "완료" : "전송 대기";
    wrap.append(el("button", { class: `mission-item ${cls}`, onclick: () => go(`#/mission/${placeId}/${m.id}`) }, [
      el("div", { class: "idx" }, st ? "✓" : String(i + 1)),
      el("div", {}, [el("div", { class: "t" }, m.title), el("div", { class: "w" }, [typeIcon(m.type), " ", m.where || ""])]),
      label ? el("span", { class: `chip st ${st.status === "sent" ? "ok" : "warn"}` }, label) : el("span", { class: "st muted" }, "›"),
    ]));
  });
  return wrap;
}
function typeIcon(t) { return t === "photo" ? "📷" : t === "choice" ? "🔘" : "✏️"; }

function viewMission(placeId, missionId) {
  const m = findMission(placeId, missionId);
  const p = place(placeId);
  const prev = state.progress[m.id];
  const draftKey = `${placeId}/${missionId}`;
  const draft = state.draft[draftKey] || (state.draft[draftKey] = { choice: prev?.answer?.choice ?? null, text: prev?.answer?.text || "", photos: [] });

  const wrap = el("div");
  wrap.append(el("div", { class: "topbar" }, [
    el("button", { class: "back", onclick: () => go(`#/place/${placeId}`) }, "‹"),
    el("h1", {}, p.name),
    el("span", { class: "chip" }, codeLabel(state.session.code)),
  ]));
  const card = el("div", { class: "card" });
  card.append(el("h2", {}, [typeIcon(m.type), " ", m.title]));
  if (m.where) card.append(el("div", { class: "where" }, [el("span", {}, "📍"), el("span", {}, [el("strong", {}, "어디서: "), m.where])]));
  if (prev) card.append(el("div", { class: `notice ${prev.status === "sent" ? "ok" : "warn"}` }, prev.status === "sent" ? "✓ 제출 완료! 다시 제출하면 새 내용으로 바뀌어요." : "⏳ 저장됨. 인터넷이 연결되면 자동으로 보내요. 다시 제출하면 새 내용으로 바뀌어요."));
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
      });
      body.append(b);
    });
  }
  let textarea = null;
  if (m.type === "text" || (m.type === "photo" && m.caption)) {
    textarea = el("textarea", { class: "input", placeholder: m.type === "text" ? "모둠의 답을 적어 주세요" : m.caption, maxlength: "500" });
    textarea.value = draft.text;
    textarea.addEventListener("input", () => { draft.text = textarea.value; });
    body.append(el("div", { class: "field" }, [m.type === "photo" ? el("label", {}, m.caption) : null, textarea]));
  }
  let photoGrid = null;
  if (m.type === "photo") {
    const max = m.maxPhotos || 1;
    photoGrid = el("div", { class: "photos" });
    const fileInput = el("input", { type: "file", accept: "image/*", capture: "environment", class: "sr-only" });
    fileInput.addEventListener("change", async () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!f) return;
      if (draft.photos.length >= max) return;
      const busy = el("div", { class: "ph" }, el("div", { style: "display:grid;place-items:center;height:100%" }, el("span", { class: "spinner" })));
      photoGrid.prepend(busy);
      try {
        const blob = await compressImage(f, CFG.photo || {});
        draft.photos.push(blob);
      } catch (e) {
        toast("사진을 읽지 못했어요. 다시 찍어 주세요.", "error");
      }
      renderPhotos();
    });
    body.append(fileInput);
    const renderPhotos = () => {
      photoGrid.innerHTML = "";
      draft.photos.forEach((blob, i) => {
        const url = URL.createObjectURL(blob);
        const img = el("img", { src: url, alt: `사진 ${i + 1}` });
        img.onload = () => URL.revokeObjectURL(url);
        photoGrid.append(el("div", { class: "ph" }, [img, el("button", { class: "rm", "aria-label": "삭제", onclick: () => { draft.photos.splice(i, 1); renderPhotos(); } }, "✕")]));
      });
      if (draft.photos.length < max) {
        photoGrid.append(el("button", { class: "add", onclick: () => fileInput.click() }, [el("span", {}, "📷"), draft.photos.length ? "추가" : "사진 찍기"]));
      }
    };
    renderPhotos();
    body.append(el("div", { class: "field" }, [el("label", {}, `사진 (최대 ${max}장)`), photoGrid]));
    // 이미 제출한 사진 미리보기
    if (prev && prev.photoCount) {
      const prevGrid = el("div", { class: "photos" });
      store.all("photos").then((rows) => {
        rows.filter((r) => r.key.startsWith(`${state.session.code}/${m.id}/`)).forEach((r) => {
          const url = URL.createObjectURL(r.blob);
          prevGrid.append(el("div", { class: "ph" }, el("img", { src: url })));
        });
        if (prevGrid.children.length) body.append(el("div", { class: "field" }, [el("label", { class: "muted" }, "이전에 제출한 사진"), prevGrid]));
      });
    }
  }
  card.append(body, err);

  const submitBtn = el("button", { class: "btn primary", style: "margin-top:8px" }, prev ? "다시 제출하기" : "제출하기");
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
      if (!draft.photos.length) return showErr("사진을 한 장 이상 찍어 주세요.");
      if (m.caption && !draft.text.trim()) return showErr("사진 설명을 적어 주세요.");
      answer = { text: draft.text.trim() };
    }
    submitBtn.disabled = true; submitBtn.innerHTML = '<span class="spinner"></span> 저장 중';
    try {
      await enqueue({ code: state.session.code, placeId, missionId: m.id, answer, photos: draft.photos });
      state.progress[m.id] = { status: "queued", answer, photoCount: draft.photos.length, at: new Date().toISOString() };
      saveProgress();
      delete state.draft[draftKey];
      toast(navigator.onLine ? "제출했어요! 전송 중…" : "저장했어요! 인터넷이 연결되면 자동으로 보내요.", "ok");
      go(`#/place/${placeId}`);
    } catch (e) {
      console.error(e);
      submitBtn.disabled = false; submitBtn.textContent = "제출하기";
      showErr("저장에 실패했어요. 휴대폰 저장 공간을 확인하고 다시 시도해 주세요.");
    }
    function showErr(t) { err.textContent = t; err.classList.remove("hidden"); submitBtn.disabled = false; submitBtn.textContent = prev ? "다시 제출하기" : "제출하기"; }
  });
  card.append(submitBtn);
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
  try {
    const res = await fetch(`./data/missions.json?v=${encodeURIComponent(CFG.version || "1")}`, { cache: "no-cache" });
    state.data = await res.json();
  } catch (e) {
    // 캐시된 파일이 없고 오프라인이면 안내
    root().innerHTML = '<div class="card"><h2>미션 정보를 불러오지 못했어요</h2><p class="muted">인터넷이 연결된 곳에서 다시 열어 주세요.</p></div>';
    return;
  }
  state.session = ls.get("mq-session");
  if (state.session) loadProgress();

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
      logoutLocal("접속이 만료되어 남은 제출을 보내지 못했어요. 모둠 코드를 다시 입력하면 이어서 보내요.");
    } else if (ev.type === "idle" || ev.type === "error") syncMsg = null;
    await refreshPending();
  });
  window.addEventListener("online", () => { state.online = true; renderStatus(); });
  window.addEventListener("offline", () => { state.online = false; renderStatus(); });
  window.addEventListener("hashchange", render);

  render();
  await refreshPending();
  startSyncLoop();
  startHeartbeat();
  if (state.session) { heartbeat(); pullProgress(); }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}
init();
