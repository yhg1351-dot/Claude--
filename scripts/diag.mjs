// Supabase 연결 점검 스크립트 (공개 키만 사용). GitHub Actions에서 실행해 결과를 로그로 확인한다.
import { readFileSync } from "node:fs";
const cfgSrc = readFileSync(new URL("../js/config.js", import.meta.url), "utf8");
const URL_ = /supabaseUrl:\s*"([^"]+)"/.exec(cfgSrc)[1];
const KEY = /supabaseAnonKey:\s*"([^"]+)"/.exec(cfgSrc)[1];
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const code = "6999";
const log = (...a) => console.log(...a);

async function rpc(name, args, headers = H) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(args) });
  return [r.status, await r.text()];
}
log("URL", URL_, "key prefix", KEY.slice(0, 15));
log("claim_group", await rpc("claim_group", { p_code: code, p_device_id: "diag-device-00000001" }));
log("is_group_active(6999)", await rpc("is_group_active", { p_code: code }));
log("is_group_active(6102)", await rpc("is_group_active", { p_code: "6102" }));

const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
async function upload(path, headers) {
  const r = await fetch(`${URL_}/storage/v1/object/photos/${path}`, { method: "POST", headers: { ...headers, "Content-Type": "image/jpeg" }, body: jpeg });
  return [r.status, await r.text()];
}
const ts = Date.now();
log("upload (apikey + bearer)", await upload(`${code}/diag/${ts}_0.jpg`, { apikey: KEY, Authorization: `Bearer ${KEY}` }));
log("upload (apikey only)", await upload(`${code}/diag/${ts}_1.jpg`, { apikey: KEY }));
log("upload to inactive folder (expect 403)", await upload(`6998/diag/${ts}_2.jpg`, { apikey: KEY, Authorization: `Bearer ${KEY}` }));
const b = await fetch(`${URL_}/storage/v1/bucket/photos`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
log("bucket info", b.status, await b.text());
const l = await fetch(`${URL_}/storage/v1/object/list/photos`, { method: "POST", headers: H, body: JSON.stringify({ prefix: "", limit: 5 }) });
log("list as anon (expect empty/denied)", l.status, (await l.text()).slice(0, 200));
