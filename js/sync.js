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

// 새 제출을 대기열에 넣는다. photos: Blob[]
export async function enqueue({ code, placeId, missionId, answer, photos }) {
  const id = uuid();
  // 같은 미션의 이전 대기 항목은 새 제출로 대체된다
  const existing = (await store.all("outbox")).filter((i) => i.code === code && i.missionId === missionId);
  for (const old of existing) await store.del("outbox", old.id);
  // 이전 사진도 정리
  const oldPhotos = (await store.all("photos")).filter((p) => p.key.startsWith(`${code}/${missionId}/`));
  for (const p of oldPhotos) await store.del("photos", p.key);

  const photoPaths = [];
  for (let i = 0; i < (photos || []).length; i++) {
    const path = photoPath(code, missionId, id, i);
    await store.put("photos", { key: path, blob: photos[i], code, missionId, createdAt: Date.now() });
    photoPaths.push(path);
  }
  const item = {
    id, code, placeId, missionId, answer, photoPaths,
    uploaded: photoPaths.map(() => false),
    attempts: 0, nextAt: 0, createdAt: Date.now(), lastError: null,
  };
  await store.put("outbox", item);
  emit({ type: "queued", missionId });
  blockedByToken = false;
  kick();
  return item;
}

export async function pending() {
  return (await store.all("outbox")).sort((a, b) => a.createdAt - b.createdAt);
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
      // 사진이 사라졌으면(저장소 정리 등) 그 사진은 제외하고 계속 진행
      item.uploaded[i] = true;
      continue;
    }
    emit({ type: "uploading", missionId: item.missionId, index: i, total: item.photoPaths.length });
    const r = await backend.uploadPhoto(item.code, item.photoPaths[i], row.blob);
    if (!r.ok) return r;
    item.uploaded[i] = true;
    await store.put("outbox", item);
  }
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
      const items = await pending();
      const now = Date.now();
      const item = items.find((i) => i.nextAt <= now);
      if (!item) break;

      const r = await sendItem(item, session.token);
      if (r.ok) {
        await store.del("outbox", item.id);
        emit({ type: "sent", missionId: item.missionId, item });
      } else if (r.reason === "invalid") {
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
