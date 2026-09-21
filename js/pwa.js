// 홈 화면에 앱 추가(PWA 설치)와 앱 안 브라우저(카카오톡 등) 안내. 학생 앱과 교사 앱이 함께 쓴다.
// 사용법: setupPwa({ onChange, onInstalled }) 를 한 번 부른 뒤 installButton()/inAppNotice() 로 요소를 만든다.

const mk = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
};

function modal({ title, body, buttons }) {
  return new Promise((resolve) => {
    const box = mk("div", { class: "box" }, [mk("h3", {}, title), mk("div", { style: "font-size:15px;color:var(--ink-2)" }, body)]);
    const ov = mk("div", { class: "overlay" }, box);
    const row = mk("div", { class: "row", style: "margin-top:14px" });
    for (const b of buttons) row.append(mk("button", { class: `btn ${b.kind || ""}`, onclick: () => { ov.remove(); resolve(b.value); } }, b.label));
    box.append(row);
    document.body.append(ov);
  });
}

let installPrompt = null; // 안드로이드 크롬·삼성 인터넷 등이 주는 설치 창
let installWaiters = [];
let hooks = { onChange: () => {}, onInstalled: () => {} };

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  installWaiters.splice(0).forEach((fn) => fn(e));
  hooks.onChange();
});
window.addEventListener("appinstalled", () => { installPrompt = null; hooks.onInstalled(); hooks.onChange(); });

export function setupPwa(h = {}) {
  hooks = { ...hooks, ...h };
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

export function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
export function isIOS() { return /iPhone|iPad|iPod/i.test(navigator.userAgent) && !window.MSStream; }

// 설치 창이 아직 준비 중이면 잠깐(최대 ms) 기다렸다가 돌려준다
function waitInstallPrompt(ms) {
  if (installPrompt) return Promise.resolve(installPrompt);
  return new Promise((resolve) => {
    const t = setTimeout(() => { installWaiters = installWaiters.filter((f) => f !== done); resolve(null); }, ms);
    const done = (e) => { clearTimeout(t); resolve(e); };
    installWaiters.push(done);
  });
}
function browserKind() {
  const ua = navigator.userAgent || "";
  if (isIOS()) return /CriOS/i.test(ua) ? "ios-chrome" : "ios";
  if (/SamsungBrowser/i.test(ua)) return "samsung";
  if (/Android/i.test(ua) && /Chrome\//i.test(ua)) return "chrome";
  return "other";
}
function installSteps(kind) {
  switch (kind) {
    case "ios": return ["아래 가운데 공유 버튼(네모에 화살표)을 누르세요.", "목록에서 '홈 화면에 추가'를 찾아 누르세요.", "오른쪽 위 '추가'를 누르면 끝!"];
    case "ios-chrome": return ["주소창 오른쪽 공유 버튼(네모에 화살표)을 누르세요.", "목록에서 '홈 화면에 추가'를 찾아 누르세요.", "오른쪽 위 '추가'를 누르면 끝!"];
    case "samsung": return ["아래 오른쪽 메뉴(≡)를 누르세요.", "'현재 페이지 추가' → '홈 화면'을 누르세요.", "'추가'를 누르면 끝!"];
    case "chrome": return ["오른쪽 위 메뉴(⋮)를 누르세요.", "'홈 화면에 추가'(또는 '앱 설치')를 누르세요.", "'설치'를 누르면 끝! (설치가 안 보이면 '바로가기 만들기'도 괜찮아요)"];
    default: return ["브라우저 메뉴를 여세요.", "'홈 화면에 추가' 또는 '앱 설치'를 누르세요.", "'추가' 또는 '설치'를 누르면 끝!"];
  }
}

// 설치 버튼. 이미 홈 화면에서 실행 중이거나 앱 안 브라우저면 null.
export function installButton({ compact = false, label = "📲 홈 화면에 앱 추가", title = "홈 화면에 앱 추가하기" } = {}) {
  if (isStandalone() || inAppBrowser()) return null;
  const btn = mk("button", { class: compact ? "btn small" : "btn", onclick: async () => {
    btn.disabled = true;
    const p = await waitInstallPrompt(2500); // 크롬이 설치 창을 늦게 주는 경우 대비
    btn.disabled = false;
    if (p) {
      try {
        p.prompt();
        await p.userChoice;
      } catch (e) {}
      installPrompt = null; // 한 번 쓴 설치 창은 다시 못 씀 → 이후엔 직접 추가 안내
      hooks.onChange();
      return;
    }
    const kind = browserKind();
    await modal({
      title,
      body: mk("div", {}, [
        mk("p", { class: "muted small", style: "margin:0 0 8px" }, kind === "chrome"
          ? "이 폰의 크롬에서는 자동 설치 창이 열리지 않아요. 아래 순서대로 직접 추가해 주세요."
          : "아래 순서대로 직접 추가해 주세요."),
        mk("ol", { style: "padding-left:20px;margin:0;line-height:1.7" }, installSteps(kind).map((t) => mk("li", {}, t))),
      ]),
      buttons: [{ label: "알겠어요", value: true, kind: "primary" }],
    });
  } }, label);
  return btn;
}

// 카카오톡·네이버·인스타그램 등 앱 안의 브라우저인지 (카메라·저장·설치 기능이 불안정함)
export function inAppBrowser() {
  const ua = navigator.userAgent || "";
  if (/KAKAOTALK/i.test(ua)) return "kakao";
  if (/NAVER\(inapp|; wv\)|Instagram|FBAN|FBAV|Line\//i.test(ua)) return "other";
  return null;
}
export function inAppNotice(text) {
  const kind = inAppBrowser();
  if (!kind) return null;
  const url = location.href.split("#")[0];
  const isAndroid = /Android/i.test(navigator.userAgent);
  const box = mk("div", { class: "notice warn", style: "margin:8px 0 4px" }, [
    mk("div", {}, [mk("strong", {}, "앱 안의 브라우저로 열렸어요."), " ", text || "사진 찍기가 잘 안 될 수 있으니 크롬이나 사파리로 열어 주세요."]),
  ]);
  if (kind === "kakao") {
    box.append(mk("button", { class: "btn small", style: "margin-top:8px", onclick: () => { location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`; } }, "기본 브라우저로 열기"));
  } else if (isAndroid) {
    box.append(mk("button", { class: "btn small", style: "margin-top:8px", onclick: () => { location.href = `intent://${url.replace(/^https?:\/\//, "")}#Intent;scheme=https;package=com.android.chrome;end`; } }, "크롬으로 열기"));
  } else {
    box.append(mk("div", { class: "small", style: "margin-top:6px" }, "오른쪽 위 메뉴에서 'Safari로 열기' 또는 '다른 브라우저로 열기'를 눌러 주세요."));
  }
  return box;
}
