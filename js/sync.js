// 전송 대기열(outbox) 처리기.
// 제출은 먼저 폰(IndexedDB)에 저장되고, 이 모듈이 순서대로 서버에 보낸다.
// 실패하면 점점 간격을 늘려 재시도하고, 인터넷이 다시 연결되면 곧바로 재개한다.
import { store, ls, uuid } from "./store.js";
import { backend } from "./backend.js";

const listeners = new Set();
export function onSync(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(ev) {
  for (const fn of listeners) {
    try { fn(ev); } catch (e) { console.error(e); }
  }
}

let running = false;
let timer = null;
let blockedByToken = false;

export function photoPath(code, missionId, submissionId, index) {
  return `${code}/${missionId}/${submissionId}_${index}.jpg`;
}
// 교사 화면 목록용 작은 미리보기 사진의 경로 (원본 옆에 _t 를 붙임)
export function thumbPath(path) {
  return path.replace(/\.jpg$/, "_t.jpg");
}

// 새 제출을 대기열에 넣는다.
// photos: 각 항목은 Blob(새 사진) 또는 { blob, thumb, path, uploaded }.
//   path 가 있으면 이전 제출에서 유지하는 사진: 파일은 이미 폰에 있고, uploaded=true 면 서버에도 있어 다시 올리지 않는다.
export async function enqueue({ code, placeId, missionId, answer, photos, thumbs }) {
  const id = uuid();
  const entries = (photos || []).map((x, i) => (x instanceof Blob ? { blob: x, thumb: thumbs && thumbs[i] } : x));
  const keptPaths = new Set(entries.filter((e) => e.path).flatMap((e) => [e.path, thumbPath(e.path)]));
  // 같은 미션의 이전 대기 항목(있으면)은 새 제출로 대체된다. 이미 올라간 사진 표시는 이어받는다.
  const existing = (await store.all("outbox")).filter((i) => i.code === code && i.missionId === missionId);
  const alreadyUp = new Set();
  for (const old of existing) (old.photoPaths || []).forEach((pth, i) => { if (old.uploaded && old.uploaded[i]) alreadyUp.add(pth); });

  const photoPaths = [];
  const uploaded = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.path) {
      photoPaths.push(e.path);
      uploaded.push(!!e.uploaded || alreadyUp.has(e.path));
      continue;
    }
    const path = photoPath(code, missionId, id, i);
    await store.put("photos", { key: path, blob: e.blob, code, missionId, createdAt: Date.now() });
    if (e.thumb) await store.put("photos", { key: thumbPath(path), blob: e.thumb, code, missionId, createdAt: Date.now() });
    photoPaths.push(path);
    uploaded.push(false);
  }
  const item = {
    id, code, placeId, missionId, answer, photoPaths,
    uploaded,
    attempts: 0, nextAt: 0, createdAt: Date.now(), lastError: null,
  };
  await store.put("outbox", item); // 새 항목을 먼저 저장하고 나서 이전 것을 지운다 (저장이 실패해도 이전 제출이 사라지지 않게)
  for (const old of existing) if (old.id !== item.id) await store.del("outbox", old.id);
  // 이전 사진 중 유지하지 않는 것은 정리
  const newPaths = new Set(photoPaths.flatMap((pth) => [pth, thumbPath(pth)]));
  const oldPhotos = (await store.all("photos")).filter((ph) => ph.key.startsWith(`${code}/${missionId}/`) && !keptPaths.has(ph.key) && !newPaths.has(ph.key));
  for (const ph of oldPhotos) await store.del("photos", ph.key);
  emit({ type: "queued", missionId });
  blockedByToken = false;
  kick();
  return item;
}

// 설정된 시각(ISO 문자열) 이전에 만들어진 대기 항목을 보내지 않고 지운다 (사진 원본도 함께).
// 지운 항목의 missionId 목록을 돌려준다.
export async function purgeStale(beforeIso) {
  const cutoff = beforeIso ? Date.parse(beforeIso) : NaN;
  if (!cutoff) return [];
  const removed = [];
  for (const item of await store.all("outbox")) {
    if (!(item.createdAt < cutoff)) continue;
    await store.del("outbox", item.id);
    for (const path of item.photoPaths || []) { try { await store.del("photos", path); await store.del("photos", thumbPath(path)); } catch (e) {} }
    removed.push(item.missionId);
  }
  return removed;
}

// code 를 주면 그 모둠의 항목만 (다른 모둠 코드로 접속 중일 때 섞이지 않게)
export async function pending(code) {
  return (await store.all("outbox")).filter((i) => !code || i.code === code).sort((a, b) => a.createdAt - b.createdAt);
}
// 전송 중에 같은 미션이 다시 제출되면 이 항목은 대기열에서 빠진다. 그 뒤엔 저장도 결과 반영도 하지 않는다.
async function stillQueued(item) {
  return !!(await store.get("outbox", item.id));
}

// 대기 중인 항목을 지금 바로 다시 보내기 (재시도 대기 시간 무시)
export async function retryNow() {
  for (const item of await pending()) {
    item.nextAt = 0;
    item.dead = false; // 서버가 내용을 거부했던 항목도 한 번 더 시도
    await store.put("outbox", item);
  }
  blockedByToken = false;
  kick();
}

export function kick() {
  if (!running) process();
}

export function resumeAfterLogin() {
  blockedByToken = false;
  kick();
}

function backoffMs(attempts) {
  return Math.min(2000 * Math.pow(2, attempts), 60000);
}

async function sendItem(item, token) {
  // 1) 사진 업로드 (아직 안 올라간 것만)
  for (let i = 0; i < item.photoPaths.length; i++) {
    if (item.uploaded[i]) continue;
    const row = await store.get("photos", item.photoPaths[i]);
    if (!row || !row.blob) {
      // 사진이 사라졌으면(저장소 정리 등) 그 경로를 제출에서 빼고 계속 진행 (교사 화면에 깨진 사진이 남지 않게)
      item.photoPaths.splice(i, 1);
      item.uploaded.splice(i, 1);
      i -= 1;
      if (!(await stillQueued(item))) return { ok: false, reason: "stale" };
      await store.put("outbox", item);
      continue;
    }
    emit({ type: "uploading", missionId: item.missionId, index: i, total: item.photoPaths.length });
    const r = await backend.uploadPhoto(item.code, item.photoPaths[i], row.blob);
    if (!r.ok) return r;
    // 작은 미리보기도 함께 올린다 (없으면 교사 화면이 원본을 대신 보여 주므로 생략 가능)
    const t = await store.get("photos", thumbPath(item.photoPaths[i]));
    if (t && t.blob) {
      const rt = await backend.uploadPhoto(item.code, thumbPath(item.photoPaths[i]), t.blob);
      if (!rt.ok) return rt;
    }
    item.uploaded[i] = true;
    if (!(await stillQueued(item))) return { ok: false, reason: "stale" };
    await store.put("outbox", item);
  }
  if (!(await stillQueued(item))) return { ok: false, reason: "stale" };
  // 2) 답변 저장
  return backend.submit(token, {
    id: item.id,
    placeId: item.placeId,
    missionId: item.missionId,
    answer: item.answer,
    photoPaths: item.photoPaths,
  });
}

async function process() {
  if (running || blockedByToken) return;
  running = true;
  emit({ type: "start" });
  try {
    for (;;) {
      const session = ls.get("mq-session");
      if (!session || !session.token) break;
      if (!navigator.onLine) break;
      const items = await pending(session.code); // 지금 접속한 모둠의 항목만
      const now = Date.now();
      const item = items.find((i) => i.nextAt <= now && !i.dead);
      if (!item) break;

      const r = await sendItem(item, session.token);
      if (r.reason === "stale" || !(await stillQueued(item))) {
        // 보내는 사이 같은 미션을 다시 제출해 이 항목은 대체됨 → 결과를 반영하지 않고 다음 항목으로
        continue;
      }
      if (r.ok) {
        await store.del("outbox", item.id);
        emit({ type: "sent", missionId: item.missionId, item });
      } else if (r.reason === "bad_data" || (r.reason === "invalid" && (item.invalidCount || 0) >= 2)) {
        // 서버가 내용 자체를 거부(사진 수 초과, 경로 불일치 등). 재접속해도 소용없으니 멈추고 알린다.
        // (옛 서버 함수는 토큰 오류와 같은 'invalid' 를 주므로, 재접속 뒤에도 3번 연속이면 내용 오류로 본다)
        item.dead = true;
        item.attempts += 1;
        item.lastError = "서버가 이 제출을 받지 않았어요. 미션에서 다시 제출해 주세요.";
        await store.put("outbox", item);
        emit({ type: "error", missionId: item.missionId, message: item.lastError, attempts: item.attempts });
        continue;
      } else if (r.reason === "invalid") {
        item.invalidCount = (item.invalidCount || 0) + 1;
        await store.put("outbox", item);
        blockedByToken = true;
        emit({ type: "invalid_token" });
        break;
      } else {
        item.attempts += 1;
        item.nextAt = Date.now() + backoffMs(item.attempts);
        item.lastError = r.message || r.reason;
        await store.put("outbox", item);
        emit({ type: "error", missionId: item.missionId, message: item.lastError, attempts: item.attempts });
        break; // 잠시 쉬었다가 타이머로 재시도
      }
    }
  } catch (e) {
    console.error("sync error", e);
    emit({ type: "error", message: String(e && e.message || e) });
  } finally {
    running = false;
    emit({ type: "idle", pending: (await pending()).length });
  }
}

export function startSyncLoop() {
  if (timer) return;
  timer = setInterval(kick, 15000);
  window.addEventListener("online", () => setTimeout(kick, 500));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") kick();
  });
  kick();
}
