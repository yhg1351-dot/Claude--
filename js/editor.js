// 교사용 편집 화면: 일정 · 장소 · 미션 · 반/모둠 수를 고치고 서버에 저장한다.
import { backend } from "./backend.js";
import { compressImage } from "./image.js";
import { loadDefaultData, orderedPlaceIds } from "./data.js";

const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const rid = () => Math.random().toString(36).slice(2, 6);
const EMOJIS = ["🏯", "🏛️", "🎢", "🏨", "🍚", "🍱", "🏫", "🚌", "🚶", "🌊", "⛰️", "🌳", "🎭", "🛏️", "📸", "🎁", "📍"];

export function createEditor(container, ctx) {
  // ctx: { data, updatedAt, source, onSaved(data, updatedAt) }
  let draft = clone(ctx.data);
  let updatedAt = ctx.updatedAt;
  let source = ctx.source;
  let dirty = false;
  let saving = false;
  let statusText = "";
  let tab = "basics"; // basics | schedule | places
  let focusPlaceId = null; // 장소 탭으로 이동할 때 강조할 장소

  const markDirty = () => { dirty = true; renderToolbarStatus(); };
  const placeList = () => orderedPlaceIds(draft).map((id) => [id, draft.places[id]]);
  const missionCount = () => placeList().reduce((n, [, p]) => n + (p.missions || []).length, 0);
  const uniqueId = (prefix) => {
    let id;
    do { id = `${prefix}-${rid()}`; } while (draft.places[id] || placeList().some(([, p]) => (p.missions || []).some((m) => m.id === id)));
    return id;
  };

  // ------------------------------------------------ 입력 도우미
  function field(label, value, onInput, opts = {}) {
    const input = opts.multiline
      ? el("textarea", { class: "input", placeholder: opts.placeholder || "" })
      : el("input", { class: "input", type: opts.type || "text", placeholder: opts.placeholder || "", inputmode: opts.inputmode || null, min: opts.min ?? null, max: opts.max ?? null });
    input.value = value ?? "";
    input.addEventListener("input", () => { onInput(opts.type === "number" ? Number(input.value) : input.value); markDirty(); });
    return el("div", {}, [label ? el("label", {}, label) : null, input]);
  }
  function select(label, value, options, onChange) {
    const sel = el("select", { class: "input" }, options.map(([v, t]) => el("option", { value: v, selected: String(v) === String(value) }, t)));
    sel.addEventListener("change", () => { onChange(sel.value); markDirty(); });
    return el("div", {}, [label ? el("label", {}, label) : null, sel]);
  }
  function moveItem(arr, i, dir) {
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  function imageField(labelText, current, onChange, pathPrefix) {
    const box = el("div", {});
    const fileInput = el("input", { type: "file", accept: "image/*", class: "sr-only" });
    const status = el("span", { class: "muted small" });
    fileInput.addEventListener("change", async () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!f) return;
      status.textContent = " 올리는 중…";
      try {
        const blob = await compressImage(f, { maxSide: 2400, quality: 0.88, maxBytes: 900 * 1024 });
        const r = await backend.uploadAsset(`${pathPrefix}-${Date.now()}.jpg`, blob);
        if (!r.ok) throw new Error(r.message || "업로드 실패");
        onChange(r.url);
        markDirty();
        render();
      } catch (e) {
        status.textContent = ` 실패: ${e.message}`;
      }
    });
    box.append(el("label", {}, labelText));
    if (current) box.append(el("img", { class: "ed-thumb", src: current, alt: "" }));
    box.append(
      el("div", { class: "ed-actions" }, [
        el("button", { class: "btn small", onclick: () => fileInput.click() }, current ? "이미지 바꾸기" : "이미지 추가"),
        current ? el("button", { class: "btn small ghost", onclick: () => { onChange(null); markDirty(); render(); } }, "이미지 삭제") : null,
        status,
      ]),
      fileInput,
    );
    return box;
  }

  // ------------------------------------------------ 섹션: 기본 정보
  function sectionBasics() {
    const t = draft.trip;
    const card = el("div", { class: "card" });
    card.append(el("h2", {}, "기본 정보"));
    card.append(el("div", { class: "ed-row two" }, [
      field("여행 이름", t.title, (v) => { t.title = v; }),
      field("학년", t.grade, (v) => { t.grade = v; }, { type: "number", min: 1, max: 9 }),
    ]));
    card.append(el("label", { class: "muted small", style: "display:block;margin-top:8px;font-weight:700" }, "반과 모둠 수 (모둠 코드는 학년+반+모둠 두 자리, 예: 6101)"));
    const list = el("div", {});
    (t.classes || []).forEach((c, i) => {
      list.append(el("div", { class: "ed-item stop-item" }, [
        el("span", { class: "muted small" }, "반"),
        el("input", { class: "input", type: "number", min: 1, max: 9, value: c.class, style: "width:80px", oninput: (e) => { c.class = Number(e.target.value); markDirty(); } }),
        el("span", { class: "muted small" }, "모둠 수"),
        el("input", { class: "input", type: "number", min: 1, max: 99, value: c.groups, style: "width:80px", oninput: (e) => { c.groups = Number(e.target.value); markDirty(); } }),
        el("button", { class: "btn small ghost danger", onclick: () => { t.classes.splice(i, 1); markDirty(); render(); } }, "삭제"),
      ]));
    });
    card.append(list);
    card.append(el("div", { class: "ed-actions" }, el("button", { class: "btn small", onclick: () => {
      const last = t.classes[t.classes.length - 1];
      t.classes.push({ class: last ? last.class + 1 : 1, groups: last ? last.groups : 6 });
      markDirty(); render();
    } }, "+ 반 추가")));
    return card;
  }

  // ------------------------------------------------ 섹션: 일정
  function sectionSchedule() {
    const t = draft.trip;
    const wrap = el("div", {});
    wrap.append(el("h2", { class: "mission-section" }, "일정"));
    const placeOptions = placeList().map(([id, p]) => [id, `${p.emoji || ""} ${p.name}`]);
    (t.days || []).forEach((day, di) => {
      const card = el("div", { class: "card", "data-jump-id": `day-${di}` });
      card.append(el("h2", {}, [el("span", { class: "ttl" }, day.label || `${day.day}일차`), el("span", { class: "sp" }),
        el("div", { class: "card-actions" }, [
          el("button", { class: "btn small ghost icon", "aria-label": "위로", disabled: di === 0, onclick: () => { moveItem(t.days, di, -1); markDirty(); render(); } }, "↑"),
          el("button", { class: "btn small ghost icon", "aria-label": "아래로", disabled: di === t.days.length - 1, onclick: () => { moveItem(t.days, di, 1); markDirty(); render(); } }, "↓"),
          el("button", { class: "btn small ghost danger", onclick: () => {
            if (!confirm(`${day.label || day.day + "일차"} 전체를 삭제할까요?`)) return;
            t.days.splice(di, 1); markDirty(); render();
          } }, "날짜 삭제"),
        ]),
      ]));
      card.append(el("div", { class: "ed-row two" }, [
        field("표시 이름", day.label, (v) => { day.label = v; }, { placeholder: "예: 1일차" }),
        field("날짜", day.date, (v) => { day.date = v; }, { type: "date" }),
      ]));
      card.append(el("label", { class: "muted small", style: "display:block;margin-top:6px;font-weight:700" }, "이 날의 순서"));
      (day.stops || []).forEach((stop, si) => {
        const isCustom = !stop.placeId;
        const row = el("div", { class: "ed-item stop-item" });
        const timeInput = el("input", { class: "input", type: "time", value: stop.time || "", style: "width:140px", oninput: (e) => { stop.time = e.target.value; markDirty(); } });
        // 장소 목록에서 고르거나, "직접 입력"으로 아이콘+글자만 적는 항목(예: 🚌 버스 이동, 🍱 점심)
        const sel = el("select", { class: "input", style: "flex:1;min-width:150px" }, [
          ...placeOptions.map(([v, txt]) => el("option", { value: v, selected: v === stop.placeId }, txt)),
          el("option", { value: "__custom", selected: isCustom }, "✏️ 직접 입력…"),
        ]);
        sel.addEventListener("change", () => {
          if (sel.value === "__custom") { stop.placeId = null; stop.emoji = stop.emoji || "🚌"; stop.label = stop.label || ""; }
          else { stop.placeId = sel.value; }
          markDirty(); render();
        });
        row.append(timeInput, sel);
        if (isCustom) {
          const emojiSel = el("select", { class: "input", style: "width:80px" }, EMOJIS.map((e) => el("option", { value: e, selected: e === (stop.emoji || "🚌") }, e)));
          emojiSel.addEventListener("change", () => { stop.emoji = emojiSel.value; markDirty(); });
          const labelInput = el("input", { class: "input", placeholder: "예: 버스 이동, 점심 식사", value: stop.label || "", style: "flex:1;min-width:140px", oninput: (e) => { stop.label = e.target.value; markDirty(); } });
          row.append(emojiSel, labelInput);
          // 안내문·이미지·미션을 붙이려면 장소로 바꾼다
          row.append(el("button", { class: "btn small", title: "이 항목을 장소로 바꾸고 안내문·이미지·미션을 붙입니다", onclick: () => {
            const name = (stop.label || "").trim();
            if (!name) { alert("먼저 항목 이름을 적어 주세요."); return; }
            const id = uniqueId("place");
            draft.places[id] = { name, emoji: stop.emoji || "📍", type: "info", intro: "" };
            stop.placeId = id; delete stop.label; delete stop.emoji;
            markDirty(); goToPlace(id);
          } }, "안내·미션 추가"));
        } else {
          row.append(el("button", { class: "btn small ghost", title: "이 장소의 안내문·이미지·미션 편집으로 이동", onclick: () => goToPlace(stop.placeId) }, "내용 편집 →"));
        }
        row.append(el("div", { class: "stop-actions" }, [
          el("button", { class: "btn small ghost icon", "aria-label": "위로", onclick: () => { moveItem(day.stops, si, -1); markDirty(); render(); } }, "↑"),
          el("button", { class: "btn small ghost icon", "aria-label": "아래로", onclick: () => { moveItem(day.stops, si, 1); markDirty(); render(); } }, "↓"),
          el("button", { class: "btn small ghost danger", onclick: () => { day.stops.splice(si, 1); markDirty(); render(); } }, "삭제"),
        ]));
        card.append(row);
      });
      card.append(el("div", { class: "ed-actions" }, [
        el("button", { class: "btn small", onclick: () => {
          const first = placeOptions[0];
          day.stops = day.stops || [];
          // 장소가 있으면 첫 장소로, 없으면 직접 입력 항목으로 시작 (드롭다운에서 언제든 바꿀 수 있음)
          day.stops.push(first ? { placeId: first[0], time: "" } : { placeId: null, emoji: "🚌", label: "", time: "" });
          markDirty(); render();
        } }, "+ 일정 항목 추가"),
        el("span", { class: "muted small" }, "추가한 뒤 목록에서 장소를 고르거나 '직접 입력'을 선택하세요."),
      ]));
      wrap.append(card);
    });
    wrap.append(el("div", { class: "ed-actions" }, el("button", { class: "btn small", onclick: () => {
      const n = (t.days || []).length + 1;
      t.days = t.days || [];
      t.days.push({ day: n, label: `${n}일차`, date: "", stops: [] });
      markDirty(); render();
    } }, "+ 날짜 추가")));
    return wrap;
  }

  // ------------------------------------------------ 섹션: 장소와 미션
  function missionEditor(p, m, mi) {
    const card = el("div", { class: "ed-item" });
    const typeLabel = { choice: "🔘 퀴즈(객관식)", text: "✏️ 생각 쓰기", photo: "📷 사진 미션" };
    card.append(el("div", { class: "row", style: "align-items:center" }, [
      el("strong", {}, `${mi + 1}. ${typeLabel[m.type] || m.type}`),
      el("div", { class: "card-actions", style: "margin-left:auto;flex:none" }, [
        el("button", { class: "btn small ghost icon", "aria-label": "위로", onclick: () => { moveItem(p.missions, mi, -1); markDirty(); render(); } }, "↑"),
        el("button", { class: "btn small ghost icon", "aria-label": "아래로", onclick: () => { moveItem(p.missions, mi, 1); markDirty(); render(); } }, "↓"),
        el("button", { class: "btn small ghost danger", onclick: () => { if (confirm(`"${m.title}" 미션을 삭제할까요?`)) { p.missions.splice(mi, 1); markDirty(); render(); } } }, "삭제"),
      ]),
    ]));
    card.append(el("div", { class: "ed-row two" }, [
      select("유형", m.type, [["choice", "퀴즈(객관식)"], ["text", "생각 쓰기"], ["photo", "사진 미션"]], (v) => {
        m.type = v;
        if (v === "choice" && !m.options) { m.options = ["", "", "", ""]; m.answer = 0; }
        if (v === "photo" && !m.maxPhotos) m.maxPhotos = 1;
        render();
      }),
      field("제목", m.title, (v) => { m.title = v; }, { placeholder: "예: 다보탑과 석가탑 찾기" }),
    ]));
    card.append(el("div", { class: "ed-row" }, [
      field("어디서 (위치 안내)", m.where, (v) => { m.where = v; }, { placeholder: "예: 대웅전 앞마당" }),
      field("문제 / 미션 설명", m.question, (v) => { m.question = v; }, { multiline: true }),
      field("힌트 (선택)", m.hint, (v) => { m.hint = v; }),
    ]));
    if (m.type === "choice") {
      const box = el("div", {});
      box.append(el("label", {}, "보기 (정답에 표시)"));
      (m.options || []).forEach((opt, oi) => {
        box.append(el("div", { class: "opt-row" }, [
          el("input", { type: "radio", name: `ans-${m.id}`, checked: m.answer === oi, onchange: () => { m.answer = oi; markDirty(); } }),
          el("input", { class: "input", value: opt, placeholder: `보기 ${oi + 1}`, oninput: (e) => { m.options[oi] = e.target.value; markDirty(); } }),
          el("button", { class: "btn small ghost danger icon", "aria-label": "보기 삭제", onclick: () => { m.options.splice(oi, 1); if (m.answer >= m.options.length) m.answer = 0; markDirty(); render(); } }, "✕"),
        ]));
      });
      box.append(el("div", { class: "ed-actions" }, el("button", { class: "btn small", onclick: () => { m.options.push(""); markDirty(); render(); } }, "+ 보기 추가")));
      card.append(box);
    }
    if (m.type === "photo") {
      card.append(el("div", { class: "ed-row two" }, [
        field("최대 사진 수", m.maxPhotos || 1, (v) => { m.maxPhotos = Math.max(1, Math.min(3, v || 1)); }, { type: "number", min: 1, max: 3 }),
        field("사진과 함께 적을 내용 (비우면 사진만)", m.caption, (v) => { m.caption = v; }, { placeholder: "예: 고른 탑의 이름을 적어 주세요." }),
      ]));
    }
    card.append(el("div", { class: "ed-row" }, imageField("참고 이미지 (선택, 학생에게 문제와 함께 보여 줌)", m.image, (v) => { m.image = v || undefined; }, `missions/${m.id}`)));
    return card;
  }

  function sectionPlaces() {
    const wrap = el("div", {});
    wrap.append(el("h2", { class: "mission-section" }, "장소와 미션"));
    placeList().forEach(([id, p]) => {
      const card = el("div", { class: `card ${focusPlaceId === id ? "focus" : ""}`, "data-place-id": id });
      const placeActions = el("div", { class: "card-actions" });
      card.append(el("h2", {}, [el("span", { class: "ttl" }, `${p.emoji || ""} ${p.name || "(이름 없음)"}`), el("span", { class: "sp" }), placeActions]));
      placeActions.append(
        el("button", { class: "btn small ghost", title: "저장소의 기본 파일(data/missions.json)에 있는 이 장소의 내용으로 바꿉니다", onclick: async () => {
          const def = await loadDefaultData();
          const dp = def.places && def.places[id];
          if (!dp) { alert("기본 파일에 같은 장소가 없습니다."); return; }
          if (!confirm(`"${p.name}"의 이름·안내문·미션을 기본 파일 내용으로 바꿀까요? 다른 장소와 일정은 그대로 둡니다.`)) return;
          draft.places[id] = clone(dp);
          markDirty(); render();
        } }, "기본 파일에서 가져오기"),
        el("button", { class: "btn small ghost danger", onclick: () => {
        const used = (draft.trip.days || []).some((d) => (d.stops || []).some((s) => s.placeId === id));
        if (!confirm(`"${p.name}" 장소를 삭제할까요?${used ? " 일정에서도 함께 빠집니다." : ""}`)) return;
        delete draft.places[id];
        for (const d of draft.trip.days || []) d.stops = (d.stops || []).filter((s) => s.placeId !== id);
        markDirty(); render();
      } }, "장소 삭제"));
      card.append(el("div", { class: "ed-row three" }, [
        field("이름", p.name, (v) => { p.name = v; }),
        select("아이콘", p.emoji || "📍", EMOJIS.map((e) => [e, e]), (v) => { p.emoji = v; }),
        select("종류", p.type || "info", [["mission", "미션 장소"], ["info", "안내만"]], (v) => { p.type = v; if (v === "mission" && !p.missions) p.missions = []; render(); }),
      ]));
      card.append(el("div", { class: "ed-row" }, [
        field("안내문 (학생에게 보이는 설명)", p.intro, (v) => { p.intro = v; }, { multiline: true }),
        imageField("안내 이미지 (선택)", p.image, (v) => { p.image = v || undefined; }, `places/${id}`),
      ]));
      if (p.type === "mission") {
        card.append(el("label", { class: "muted small", style: "display:block;margin-top:10px;font-weight:700" }, `미션 ${(p.missions || []).length}개`));
        (p.missions || []).forEach((m, mi) => card.append(missionEditor(p, m, mi)));
        card.append(el("div", { class: "ed-actions" }, [
          el("button", { class: "btn small", onclick: () => addMission(p, "choice") }, "+ 퀴즈"),
          el("button", { class: "btn small", onclick: () => addMission(p, "text") }, "+ 생각 쓰기"),
          el("button", { class: "btn small", onclick: () => addMission(p, "photo") }, "+ 사진 미션"),
        ]));
      }
      wrap.append(card);
    });
    wrap.append(el("div", { class: "ed-actions" }, el("button", { class: "btn small", onclick: () => {
      const id = uniqueId("place");
      draft.places[id] = { name: "새 장소", emoji: "📍", type: "info", intro: "" };
      markDirty(); render();
      setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }), 50);
    } }, "+ 장소 추가")));
    return wrap;
  }
  function scrollToCard(jumpId) {
    const card = container.querySelector(`[data-jump-id="${jumpId}"]`);
    if (!card) return;
    const bar = container.querySelector(".ed-toolbar");
    const offset = (bar ? bar.getBoundingClientRect().bottom : 0) + 8;
    window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - offset, behavior: "smooth" });
    card.classList.add("focus");
    setTimeout(() => card.classList.remove("focus"), 2000);
  }
  function scrollToPlace(id) {
    const card = container.querySelector(`[data-place-id="${id}"]`);
    if (!card) return;
    const bar = container.querySelector(".ed-toolbar");
    const offset = (bar ? bar.getBoundingClientRect().bottom : 0) + 8;
    window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - offset, behavior: "smooth" });
    card.classList.add("focus");
    setTimeout(() => card.classList.remove("focus"), 2000);
  }
  function goToPlace(id) {
    tab = "places"; focusPlaceId = id; render();
    setTimeout(() => scrollToPlace(id), 50);
    setTimeout(() => { focusPlaceId = null; }, 2500);
  }
  function addMission(p, type) {
    p.missions = p.missions || [];
    const m = { id: uniqueId("m"), type, title: "", where: "", question: "" };
    if (type === "choice") { m.options = ["", "", "", ""]; m.answer = 0; }
    if (type === "photo") { m.maxPhotos = 1; m.caption = ""; }
    p.missions.push(m);
    markDirty(); render();
  }

  // ------------------------------------------------ 검사와 저장
  function validate() {
    const errs = [];
    if (!draft.trip.title) errs.push("여행 이름을 적어 주세요.");
    if (!(draft.trip.classes || []).length) errs.push("반을 하나 이상 추가해 주세요.");
    for (const [, p] of placeList()) {
      if (!p.name) errs.push("이름이 비어 있는 장소가 있습니다.");
      for (const m of p.missions || []) {
        if (!m.title) errs.push(`${p.name}: 제목이 비어 있는 미션이 있습니다.`);
        if (m.type === "choice") {
          const opts = (m.options || []).filter((o) => o.trim());
          if (opts.length < 2) errs.push(`${p.name} · ${m.title || "미션"}: 보기를 2개 이상 적어 주세요.`);
          if (!m.options || !m.options[m.answer] || !m.options[m.answer].trim()) errs.push(`${p.name} · ${m.title || "미션"}: 정답 보기를 골라 주세요.`);
        }
      }
    }
    for (const d of draft.trip.days || []) for (const s of d.stops || []) {
      if (!s.placeId && !(s.label || "").trim()) errs.push(`${d.label}: 직접 입력 항목의 내용을 적어 주세요.`);
      if (s.placeId && !draft.places[s.placeId]) errs.push(`${d.label}: 없는 장소가 일정에 있습니다.`);
    }
    return errs;
  }
  async function save(force = false) {
    const errs = validate();
    if (errs.length) { alert("저장 전에 고쳐 주세요:\n- " + errs.join("\n- ")); return; }
    // 빈 보기 제거, 미션 id 보장
    for (const [, p] of placeList()) for (const m of p.missions || []) {
      if (m.type === "choice") { const ansText = m.options[m.answer]; m.options = m.options.filter((o) => o.trim()); m.answer = Math.max(0, m.options.indexOf(ansText)); }
      if (!m.id) m.id = uniqueId("m");
    }
    saving = true; renderToolbarStatus();
    const r = await backend.saveConfig(draft, force ? null : updatedAt);
    saving = false;
    if (r.ok) {
      updatedAt = r.updatedAt; dirty = false; source = "server";
      statusText = "저장했습니다. 학생 앱에 바로 반영됩니다.";
      ctx.onSaved && ctx.onSaved(clone(draft), updatedAt);
    } else if (r.reason === "conflict") {
      if (confirm("다른 선생님이 먼저 저장한 내용이 있습니다. 내 내용으로 덮어쓸까요? (취소하면 저장하지 않습니다)")) return save(true);
      statusText = "저장하지 않았습니다.";
    } else {
      statusText = `저장 실패: ${r.message || ""}`;
    }
    renderToolbarStatus();
  }
  async function resetToDefault() {
    if (!confirm("저장소의 기본 파일(data/missions.json) 내용으로 되돌립니다. 저장을 눌러야 서버에 반영됩니다. 계속할까요?")) return;
    draft = clone(await loadDefaultData());
    markDirty(); render();
  }

  // ------------------------------------------------ 렌더링
  const toolbarStatus = el("span", { class: "status" });
  function renderToolbarStatus() {
    const src = source === "server" ? "서버 편집본" : source === "cache" ? "저장된 편집본(캐시)" : "기본 파일";
    toolbarStatus.textContent = saving ? "저장 중…" : `${src}${updatedAt ? " · 마지막 저장 " + new Date(updatedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}${dirty ? " · 저장 안 된 변경 있음" : ""}${statusText ? " · " + statusText : ""}`;
  }
  function render() {
    container.innerHTML = "";
    container.className = "editor";
    const saveBtn = el("button", { class: "btn small gold", onclick: () => save(false) }, "저장");
    const subtabs = [["basics", "기본 정보"], ["schedule", "일정"], ["places", "장소와 미션"]];
    const toolbar = el("div", { class: "ed-toolbar" }, [
      el("div", { class: "ed-toolbar-top" }, [
        el("div", { class: "tabs sub" }, subtabs.map(([k, l]) => el("button", { class: k === tab ? "active" : "", onclick: () => { tab = k; render(); window.scrollTo({ top: 0 }); } }, l))),
        el("div", { class: "actions" }, [
          el("button", { class: "btn small ghost", onclick: resetToDefault }, "기본 파일로 되돌리기"),
          saveBtn,
        ]),
      ]),
      toolbarStatus,
    ]);
    // 일정 탭: 날짜 바로가기 칩
    if (tab === "schedule" && (draft.trip.days || []).length) {
      toolbar.append(el("div", { class: "place-jump" }, [
        el("span", { class: "muted small", style: "flex:none" }, "바로가기"),
        ...(draft.trip.days || []).map((d, i) => el("button", { class: "chip gray jump", onclick: () => scrollToCard(`day-${i}`) }, d.label || `${d.day}일차`)),
      ]));
    }
    // 장소와 미션 탭: 장소 바로가기 칩 (누르면 그 장소 카드로 스크롤)
    if (tab === "places" && placeList().length) {
      toolbar.append(el("div", { class: "place-jump" }, [
        el("span", { class: "muted small", style: "flex:none" }, "바로가기"),
        ...placeList().map(([id, p]) => el("button", { class: "chip gray jump", onclick: () => scrollToPlace(id) }, `${p.emoji || ""} ${p.name || "(이름 없음)"}`)),
      ]));
    }
    container.append(toolbar);
    renderToolbarStatus();
    container.append(el("p", { class: "muted small" }, `장소 ${placeList().length}곳 · 미션 ${missionCount()}개. 고친 뒤 위의 "저장"을 눌러야 학생 앱에 반영됩니다.`));
    if (tab === "basics") container.append(sectionBasics());
    else if (tab === "schedule") container.append(sectionSchedule());
    else container.append(sectionPlaces());
  }
  render();
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
  return { isDirty: () => dirty };
}
