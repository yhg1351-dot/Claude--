// IndexedDB 저장소: 전송 대기열(outbox)과 사진 원본(photos)을 폰에 보관한다.
const DB_NAME = "museum-quiz";
const DB_VERSION = 2;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("outbox")) {
        const s = db.createObjectStore("outbox", { keyPath: "id" });
        s.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains("photos")) {
        db.createObjectStore("photos", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("drafts")) {
        // 입력 중인 답과 사진 (카메라 앱에서 돌아올 때 페이지가 새로 고쳐져도 유지)
        db.createObjectStore("drafts", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("localSubmissions")) {
        // 데모 모드 전용: 서버 대신 여기에 제출 내용을 저장
        db.createObjectStore("localSubmissions", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        let result;
        try {
          result = fn(store);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function reqToPromise(storeName, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export const store = {
  put: (name, value) => tx(name, "readwrite", (s) => s.put(value)),
  get: (name, key) => reqToPromise(name, "readonly", (s) => s.get(key)),
  del: (name, key) => tx(name, "readwrite", (s) => s.delete(key)),
  all: (name) => reqToPromise(name, "readonly", (s) => s.getAll()),
  clear: (name) => tx(name, "readwrite", (s) => s.clear()),
};

// localStorage 헬퍼 (실패해도 앱이 멈추지 않도록 감싼다)
export const ls = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  },
};

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
