// 일정·장소·미션 설정을 불러온다.
// 순서: 서버(교사가 편집한 내용) → 없으면 기본 파일(data/missions.json). 서버 내용은 폰에 캐시해 오프라인에도 쓴다.
import { ls } from "./store.js";
import { backend } from "./backend.js";

const CFG = window.APP_CONFIG || {};
const CACHE_KEY = "mq-config-cache";

export async function loadDefaultData() {
  const res = await fetch(`./data/missions.json?v=${encodeURIComponent(CFG.version || "1")}`, { cache: "no-cache" });
  return res.json();
}

// 반환: { data, source: "server" | "cache" | "default", updatedAt }
export async function loadTripData({ preferServer = true } = {}) {
  let cached = ls.get(CACHE_KEY);
  if (preferServer && navigator.onLine) {
    try {
      const r = await backend.loadConfig();
      if (r.ok && r.data && r.data.trip && r.data.places) {
        cached = { data: r.data, updatedAt: r.updatedAt };
        ls.set(CACHE_KEY, cached);
        return { data: r.data, source: "server", updatedAt: r.updatedAt };
      }
      if (r.ok && !r.data) {
        // 서버에 저장된 편집본이 없음 → 기본 파일 사용 (캐시는 비움)
        ls.remove(CACHE_KEY);
        cached = null;
      }
    } catch (e) { /* 네트워크 오류: 아래 캐시/기본 파일로 */ }
  }
  if (cached && cached.data && cached.data.trip) return { data: cached.data, source: "cache", updatedAt: cached.updatedAt };
  return { data: await loadDefaultData(), source: "default", updatedAt: null };
}
