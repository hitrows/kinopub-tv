// Cloudflare Worker: stateless relay between an old Samsung Orsay TV and Kinopub.
//
// The TV can't do modern TLS, so it talks plain HTTP to this worker. Unlike
// proxy/proxy.py nothing is stored here: the TV keeps its own token and sends
// it in X-KP-Token. Video doesn't pass through either: Kinopub's CDN serves
// HLS segments over plain HTTP, so playlists point the TV straight at it.
//
//   GET /auth/start                 -> {user_code, verification_uri, expires_in, interval, code}
//   GET /auth/poll?code=            -> token JSON once the code is confirmed, else {error}
//   GET /auth/refresh?rt=           -> refreshed token JSON
//   GET /api/<path>?<query>         -> Kinopub /v1/<path>; URLs rewritten through this worker
//   GET /s/<b64>/<name>             -> posters etc.; .m3u8 playlists are rewritten
//   GET /hls/<b64 master>/<n>/index.m3u8  -> HLS with audio track n
//   GET /srt/<b64>/subs.json        -> .srt as [[start, end, text], ...]

const API = "https://api.service-kp.com";
const UA = "KinoPubOrsay/1.0";
const ALLOWED = ["service-kp.com", "cdntogo.net", "staticpop.net", "kino.pub", "kino.watch"];
// Hosts whose files the TV may fetch directly over plain HTTP.
const DIRECT_HTTP = ["cdntogo.net"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "X-KP-Token",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const base = "http://" + url.host; // the TV only speaks HTTP
    let p = url.pathname;
    if (p === "/kp" || p.startsWith("/kp/")) p = p.slice(3) || "/";
    try {
      if (p === "/log") {
        console.log("tv", url.search);
        return new Response(null, { status: 204, headers: CORS });
      }
      if (p === "/auth/start") return await authStart(env);
      if (p === "/auth/poll") return await authPoll(env, url.searchParams.get("code") || "");
      if (p === "/auth/refresh") return await authRefresh(env, url.searchParams.get("rt") || "");
      if (p.startsWith("/api/")) return await apiCall(request, env, base, p.slice(5), url.search);
      if (p.startsWith("/hls/")) return await hls(base, p);
      if (p.startsWith("/srt/")) return await srt(p);
      if (p.startsWith("/s/")) return await relay(request, base, p, ctx);
      if (p === "/" || p === "/health") return json(200, { ok: true, service: "kp-orsay" });
      return json(404, { error: "not_found" });
    } catch (e) {
      return json(e.status || 502, { error: String(e.message || e) });
    }
  },
};

function json(status, obj, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS, ...(extra || {}) },
  });
}

function creds(env) {
  return { client_id: env.KP_CLIENT_ID || "xbmc", client_secret: env.KP_CLIENT_SECRET || "cgg3gtifu46urtfp2zp1nqtba0k2ezxh" };
}

async function oauth(env, path, params) {
  const q = new URLSearchParams({ ...params, ...creds(env) });
  const r = await fetch(API + path + "?" + q, { method: "POST", headers: { "User-Agent": UA } });
  let body = {};
  try { body = await r.json(); } catch (e) {}
  return { status: r.status, body };
}

async function authStart(env) {
  const { status, body } = await oauth(env, "/oauth2/device", { grant_type: "device_code" });
  if (status !== 200 || !body.code) return json(502, body);
  return json(200, {
    user_code: body.user_code, verification_uri: body.verification_uri,
    expires_in: body.expires_in || 300, interval: body.interval || 5, code: body.code,
  });
}

async function authPoll(env, code) {
  if (!code) return json(400, { error: "no_code" });
  const { status, body } = await oauth(env, "/oauth2/device", { grant_type: "device_token", code });
  if (status === 200 && body.access_token) {
    await fetch(API + "/v1/device/notify", {
      method: "POST",
      headers: { Authorization: "Bearer " + body.access_token, "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "Samsung Smart TV", hardware: "Samsung Orsay", software: UA + " cloud" }),
    }).catch(() => {});
    return json(200, body);
  }
  return json(200, { error: body.error || "pending" });
}

async function authRefresh(env, rt) {
  if (!rt) return json(401, { error: "no_refresh_token" });
  const { status, body } = await oauth(env, "/oauth2/token", { grant_type: "refresh_token", refresh_token: rt });
  if (status === 200 && body.access_token) return json(200, body);
  return json(401, { error: body.error || "refresh_failed" });
}

async function apiCall(request, env, base, path, search) {
  const tok = request.headers.get("X-KP-Token");
  if (!tok) return json(401, { error: "not_authorized" });
  const r = await fetch(API + "/v1/" + path + search, { headers: { Authorization: "Bearer " + tok, "User-Agent": UA } });
  let body;
  try { body = await r.json(); } catch (e) { return json(502, { error: "bad_api_response_" + r.status }); }
  return json(r.status, rewrite(body, base));
}

/* ---------- URL helpers ---------- */

function b64enc(s) {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64dec(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(s + "=".repeat((4 - (s.length % 4)) % 4));
}

function hostOk(host, list) {
  host = (host || "").toLowerCase();
  return list.some((h) => host === h || host.endsWith("." + h));
}

function remote(b64) {
  const url = b64dec(b64);
  if (!hostOk(new URL(url).hostname, ALLOWED)) {
    const e = new Error("host not allowed"); e.status = 403; throw e;
  }
  return url;
}

function proxify(base, url) {
  let name = (new URL(url).pathname.split("/").pop() || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-60);
  return base + "/s/" + b64enc(url) + "/" + name;
}

function rewrite(obj, base) {
  if (Array.isArray(obj)) return obj.map((v) => rewrite(v, base));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k in obj) out[k] = rewrite(obj[k], base);
    return out;
  }
  if (typeof obj === "string" && /^https?:\/\//.test(obj)) return proxify(base, obj);
  return obj;
}

// Media segments go straight to the CDN over HTTP; playlists come back here.
function playlistUrl(base, abs) {
  const u = new URL(abs);
  if (!/\.m3u8$/.test(u.pathname) && hostOk(u.hostname, DIRECT_HTTP)) return abs.replace(/^https:/, "http:");
  return proxify(base, abs);
}

function rewriteM3u8(text, src, base) {
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (t && !t.startsWith("#")) return playlistUrl(base, new URL(t, src).href);
    if (t.includes('URI="')) return line.replace(/URI="([^"]+)"/g, (_, u) => 'URI="' + playlistUrl(base, new URL(u, src).href) + '"');
    return line;
  }).join("\n") + "\n";
}

function playlistResponse(text) {
  return new Response(text, { headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", ...CORS } });
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  return { text: await r.text(), final: r.url || url };
}

/* ---------- media ---------- */

async function hls(base, p) {
  const parts = p.split("/");
  const master = remote(parts[2]);
  const track = parseInt(parts[3], 10) || 1;
  const m = await fetchText(master);
  let variant = null;
  for (const line of m.text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) { variant = new URL(t, m.final).href; break; }
  }
  if (!variant) return json(502, { error: "no variant in master playlist" });
  variant = variant.replace(/index-v(\d+)-?a\d+\.m3u8/, "index-v$1-a" + track + ".m3u8");
  const v = await fetchText(variant);
  return playlistResponse(rewriteM3u8(v.text, v.final, base));
}

async function relay(request, base, p, ctx) {
  const url = remote(p.split("/")[2]);
  if (/\.m3u8($|\?)/.test(p) || /\.m3u8($|\?)/.test(url)) {
    const r = await fetchText(url);
    return playlistResponse(rewriteM3u8(r.text, r.final, base));
  }
  const headers = { "User-Agent": UA };
  const range = request.headers.get("Range");
  if (range) headers.Range = range;
  const r = await fetch(url, { headers, cf: { cacheEverything: true, cacheTtl: 86400 } });
  const out = new Headers();
  for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"]) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  if ((out.get("Content-Type") || "").startsWith("image")) out.set("Cache-Control", "public, max-age=604800");
  for (const k in CORS) out.set(k, CORS[k]);
  return new Response(r.body, { status: r.status, headers: out });
}

/* ---------- subtitles ---------- */

// cp1251 upper half, for subtitle files that aren't UTF-8.
const CP1251 = "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕї" +
  "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя";

function decodeSubs(buf) {
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch (e) {
    let s = "";
    for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP1251[b - 0x80];
    return s;
  }
}

function srtSeconds(t) {
  const m = /(\d+):(\d+):(\d+)(?:[,.](\d+))?/.exec(t);
  if (!m) return null;
  // Kinopub's files mix ",46" (centiseconds) and ",460" (ms): treat it as a fraction.
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? parseFloat("0." + m[4]) : 0);
}

async function srt(p) {
  const r = await fetch(remote(p.split("/")[2]), { headers: { "User-Agent": UA } });
  const text = decodeSubs(await r.arrayBuffer()).replace(/\r/g, "");
  const cues = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.trim().split("\n").filter((l) => l.trim());
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->");
    const start = srtSeconds(a), end = srtSeconds(b);
    const body = lines.slice(i + 1).join("\n").replace(/<[^>]+>|\{[^}]*\}/g, "").trim();
    if (start !== null && end !== null && body) cues.push([Math.round(start * 100) / 100, Math.round(end * 100) / 100, body]);
  }
  cues.sort((x, y) => x[0] - y[0]);
  return json(200, cues, { "Cache-Control": "public, max-age=86400" });
}
