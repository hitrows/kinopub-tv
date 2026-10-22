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
//                                      (?_post=1: sent as a form POST with the other params)
//   GET /item?id=                   -> an item page without per-episode media (a long series
//                                      is megabytes otherwise); full item cached for /media
//   GET /media?id=&mid=             -> files, audio tracks and subtitles of one video/episode
//   GET /continue                   -> unfinished films and series, most recent first
//   GET /search?q=                  -> Kinopub search; a Latin query that finds little is
//                                      retried with the Russian titles TMDB knows for it
//   GET /s/<b64>/<name>             -> posters etc.; .m3u8 playlists are rewritten
//   GET /hls/<b64 master>/<n>/index.m3u8  -> HLS with audio track n
//   GET /srt/<b64>/subs.json        -> .srt as [[start, end, text], ...]
//   GET /recs                       -> {items}: TMDB recommendations for the viewing history,
//                                      only titles Kinopub has (needs TMDB_TOKEN secret)
//   GET /app/manifest.json          -> {version, js, css} of the newest TV app
//   GET /app/js/..., /app/css/..., /app/img/...
//                                   -> the TV app's files from GitHub (repo APP_REPO,
//                                      git ref APP_REF, default tag "cloud"), so the
//                                      installed app updates itself on launch

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
      if (p.startsWith("/app/")) return await appFile(env, base, p.slice(5));
      if (p === "/recs") return await recs(request, env, base, ctx);
      if (p === "/search") return await search(request, env, base);
      if (p === "/item") return await itemPage(request, base, ctx);
      if (p === "/media") return await media(request, base, ctx);
      if (p === "/continue") return await continueWatching(request, base);
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
  const q = new URLSearchParams(search);
  let r;
  if (q.get("_post")) {
    // the TV only sends GETs; writes (bookmarks, device settings) come as ?_post=1
    q.delete("_post");
    r = await fetch(API + "/v1/" + path, { method: "POST", body: q,
      headers: { Authorization: "Bearer " + tok, "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" } });
  } else r = await fetch(API + "/v1/" + path + search, { headers: { Authorization: "Bearer " + tok, "User-Agent": UA } });
  let body;
  try { body = await r.json(); } catch (e) { return json(502, { error: "bad_api_response_" + r.status }); }
  if (isList(path)) body = slimList(body);
  return json(r.status, rewrite(body, base));
}

/* ---------- lists: only what a poster grid shows ---------- */

// A page of 30 items is ~67 KB with cast, plots and genres the grid never
// shows; parsing that is real work for a 2013 TV. Item pages stay complete.
function isList(path) {
  return !/^items\/\d+/.test(path) || /^items\/(search|fresh|hot|popular)/.test(path);
}

function slimItem(it) {
  if (!it || typeof it !== "object") return it;
  const out = {};
  for (const k of ["id", "type", "title", "new", "total", "watched", "count"]) if (it[k] !== undefined) out[k] = it[k];
  if (it.posters) out.posters = { small: it.posters.small };
  return out;
}

function slimList(body) {
  if (!body || typeof body !== "object") return body;
  const out = { ...body };
  if (Array.isArray(body.items)) out.items = body.items.map(slimItem);
  if (Array.isArray(body.history)) out.history = body.history.map((h) => ({ item: slimItem(h.item) }));
  return out;
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

/* ---------- self-updating TV app ---------- */

async function raw(env, path) {
  const repo = env.APP_REPO || "hitrows/kinopub-tv";
  const ref = env.APP_REF || "cloud";
  const r = await fetch("https://raw.githubusercontent.com/" + repo + "/" + ref + "/" + path,
    { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!r.ok) { const e = new Error("app file not found: " + path); e.status = 404; throw e; }
  return r;
}

async function appFile(env, base, path) {
  const version = (await (await raw(env, "VERSION")).text()).trim();
  if (path === "manifest.json") {
    // 1.9 -> 1090, 1.9.1 -> 1091. Shells up to 1.9 compare "a.b" as a*1000 + b,
    // so they get "1.91": newer than any of theirs and in the right order.
    const n = (version.split(".").map((x) => parseInt(x, 10) || 0).concat([0, 0]));
    const build = n[0] * 1000 + n[1] * 10 + n[2];
    return json(200, { version: n[0] + "." + (build % 1000), build, js: "js/app-" + version + ".js", css: "css/app-" + version + ".css" },
      { "Cache-Control": "max-age=60" });
  }
  const code = { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000", ...CORS };
  if (/^js\/app-[\d.]+\.js$/.test(path)) {
    const src = (await (await raw(env, "tv/js/app.js")).text())
      .replace("__PROXY__", base).replace("__VERSION__", version).replace("__CLOUD__", "1");
    return new Response(src, { headers: code });
  }
  if (/^css\/app-[\d.]+\.css$/.test(path))
    return new Response(await (await raw(env, "tv/css/app.css")).text(), { headers: { ...code, "Content-Type": "text/css; charset=utf-8" } });
  if (/^img\/[\w.-]+\.png$/.test(path)) {
    const r = await raw(env, "tv/" + path);
    return new Response(r.body, { headers: { ...code, "Content-Type": "image/png" } });
  }
  return json(404, { error: "not_found" });
}

/* ---------- recommendations (TMDB) ---------- */

// Seeds: the last titles from Kinopub's history. TMDB finds each by its IMDb
// id and recommends; titles recommended by several seeds rank higher. Each
// candidate is looked up in Kinopub by title and year, so everything shown
// can be played. Free Workers allow 50 subrequests: 1 history + 2 x 8 seeds
// + 24 lookups stays under it. Results are cached per user for 6 hours.
const SEEDS = 8, CANDIDATES = 24, RECS_TTL = 6 * 3600;
// History's "time" is where playback stopped and "counter" how many episodes
// or views there were: a title opened for a moment says nothing about taste,
// a series binged for a dozen episodes says a lot.
const MIN_POSITION = 600;
const seedWeight = (h) => Math.min(1 + (h.counter || 0) / 3, 4);
const TV_TYPES = ["serial", "docuserial", "tvshow"];

async function tmdb(env, path) {
  const r = await fetch("https://api.themoviedb.org/3" + path, {
    headers: { Authorization: "Bearer " + env.TMDB_TOKEN, Accept: "application/json" },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  return r.ok ? r.json() : null;
}

async function kp(tok, path) {
  const r = await fetch(API + "/v1/" + path, { headers: { Authorization: "Bearer " + tok, "User-Agent": UA } });
  if (r.status === 401) { const e = new Error("not_authorized"); e.status = 401; throw e; }
  return r.ok ? r.json() : null;
}

async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const norm = (t) => String(t || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, "");

// Categories for the "Для тебя" shelves. Each shelf is its own request (its
// own 50-subrequest budget) and is seeded by what was watched in that
// category, so a run of anime doesn't push movies and series out.
const CATS = {
  new: { kp: (it) => (it.year || 0) >= thisYear() - 1, tmdb: (r) => yearOf(r) >= thisYear() - 1 && !tmdbKids(r), balanced: true, fill: "items/fresh?type=movie" },
  movie: { kp: (it) => !TV_TYPES.includes(it.type) && it.type !== "concert" && !isAnime(it) && !isDoc(it),
    tmdb: (r, media) => media === "movie" && !tmdbAnime(r) && !tmdbKids(r) && !has(r, 99) && !has(r, 10402), fill: "items/popular?type=movie" },
  serial: { kp: (it) => TV_TYPES.includes(it.type) && !isAnime(it) && !isDoc(it),
    tmdb: (r, media) => media === "tv" && !tmdbAnime(r) && !tmdbKids(r) && !has(r, 99), fill: "items/popular?type=serial" },
  anime: { kp: isAnime, tmdb: tmdbAnime, fill: "items?genre=25&sort=-views" },
  concert: { kp: (it) => it.type === "concert", tmdb: (r) => has(r, 10402), fill: "items/popular?type=concert" },
  doc: { kp: isDoc, tmdb: (r) => has(r, 99), fill: "items/popular?type=documovie" },
};
// Workers' clock reads 1970 at startup; the year is read per request.
const thisYear = () => new Date().getUTCFullYear();
const ROW = 18;
function has(r, g) { return (r.genre_ids || []).includes(g); }
function yearOf(r) { return parseInt((r.release_date || r.first_air_date || "").slice(0, 4), 10) || 0; }
function tmdbAnime(r) { return has(r, 16) && r.original_language === "ja"; }
// TMDB has a Kids genre for TV; for films, a family cartoon is the giveaway
function tmdbKids(r) { return has(r, 10762) || (has(r, 16) && has(r, 10751)); }
function isAnime(it) { return (it.genres || []).some((g) => g.id === 25); }
function isDoc(it) { return it.type === "documovie" || it.type === "docuserial" || (it.genres || []).some((g) => g.id === 24); }

async function recs(request, env, base, ctx) {
  const tok = request.headers.get("X-KP-Token");
  if (!tok) return json(401, { error: "not_authorized" });
  if (!env.TMDB_TOKEN) return json(200, { items: [], error: "no_tmdb_token" });
  let catName = new URL(request.url).searchParams.get("cat");
  if (!CATS[catName]) catName = "new";
  const cat = CATS[catName];

  const cacheKey = new Request("https://kp-orsay.cache/recs/v5/" + catName + "/" + (await sha(tok)));
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const hist = await history(tok, ctx);
  const seen = new Set(), strong = [], weak = [];
  for (const h of (hist && hist.history) || []) {
    const it = h.item;
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    if (!it.imdb) continue;
    const s = { item: it, weight: seedWeight(h) };
    if ((h.time || 0) >= MIN_POSITION || (h.counter || 0) >= 2) strong.push(s);
    else weak.push(s);
  }
  // seeds from this category first; too few of them: the most watched overall
  // (TMDB results are filtered by category anyway)
  const byWeight = (a, b) => b.weight - a.weight;
  let seeds;
  if (cat.balanced) {
    // equally from films, series and anime, so one binge doesn't take over
    const groups = [CATS.movie.kp, CATS.serial.kp, isAnime].map((f) => strong.filter((s) => f(s.item)).sort(byWeight));
    seeds = [];
    for (let i = 0; seeds.length < 6 && i < 6; i++) for (const g of groups) if (g[i] && seeds.length < 6) seeds.push(g[i]);
  } else {
    const own = strong.filter((s) => cat.kp(s.item)).sort(byWeight);
    const rest = strong.filter((s) => !own.includes(s)).slice(0, 20).sort(byWeight);
    seeds = own.slice(0, SEEDS);
    for (const s of rest) if (seeds.length < (own.length >= 2 ? SEEDS : 6)) seeds.push(s);
  }
  while (seeds.length < 3 && weak.length) seeds.push(weak.shift());

  // TMDB: imdb id -> tmdb id -> recommendations in this category
  const scores = new Map();
  await Promise.all(seeds.slice(0, 6).map(async ({ item: seed, weight }) => {
    const imdb = "tt" + String(seed.imdb).padStart(7, "0");
    const found = await tmdb(env, "/find/" + imdb + "?external_source=imdb_id");
    if (!found) return;
    const wantTv = TV_TYPES.includes(seed.type);
    const hit = (wantTv ? found.tv_results : found.movie_results)[0] || found.movie_results[0] || found.tv_results[0];
    if (!hit) return;
    const media = found.tv_results.includes(hit) ? "tv" : "movie";
    const rec = await tmdb(env, "/" + media + "/" + hit.id + "/recommendations?language=ru-RU&page=1");
    ((rec && rec.results) || []).forEach((r, rank) => {
      const rmedia = r.media_type || media;
      if (!cat.tmdb(r, rmedia)) return;
      const key = rmedia + r.id;
      const c = scores.get(key) || { media: rmedia, title: r.title || r.name, original: r.original_title || r.original_name, year: yearOf(r), score: 0 };
      c.score += weight * (1 + (20 - rank) / 20) + Math.min(r.vote_average || 0, 10) / 50;
      scores.set(key, c);
    });
  }));

  // back to Kinopub, keeping only what fits the category
  const top = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, CANDIDATES);
  const found = await Promise.all(top.map(async (c) => {
    const res = await kp(tok, "items/search?perpage=5&q=" + encodeURIComponent(c.title));
    const want = [norm(c.title), norm(c.original)];
    for (const it of (res && res.items) || []) {
      if (TV_TYPES.includes(it.type) !== (c.media === "tv")) continue;
      if (c.year && it.year && Math.abs(it.year - c.year) > 1) continue;
      if (String(it.title).split(" / ").map(norm).some((n) => want.includes(n))) return it;
    }
    return null;
  }));

  const out = [], used = new Set();
  const take = (it) => {
    if (!it || seen.has(it.id) || used.has(it.id) || !cat.kp(it) || out.length >= ROW) return;
    used.add(it.id);
    out.push(slimItem(it));
  };
  if (cat.balanced) {
    // take turns: film, series, anime, film, ...
    const kinds = [CATS.movie.kp, CATS.serial.kp, isAnime, () => true];
    const queues = kinds.map(() => []);
    for (const it of found) if (it) queues[kinds.findIndex((f) => f(it))].push(it);
    for (let i = 0; queues.some((q) => q[i]); i++) for (const q of queues) take(q[i]);
  } else found.forEach(take);
  // a short row is topped up with what's popular in the category and not watched yet
  if (out.length < ROW) {
    const more = await kp(tok, cat.fill + (cat.fill.includes("?") ? "&" : "?") + "perpage=40");
    ((more && more.items) || []).forEach(take);
  }

  const resp = json(200, rewrite({ items: out }, base), { "Cache-Control": "private, max-age=" + RECS_TTL });
  const stored = new Response(resp.clone().body, resp);
  stored.headers.set("Cache-Control", "public, max-age=" + RECS_TTL);
  ctx.waitUntil(caches.default.put(cacheKey, stored));
  return resp;
}

/* ---------- search ---------- */

// Kinopub knows a title by its Russian and original names. "Attack on Titan"
// (English name of a Japanese show) finds nothing there, so a Latin query
// that finds little is also looked up in TMDB and retried in Russian.
async function search(request, env, base) {
  const tok = request.headers.get("X-KP-Token");
  if (!tok) return json(401, { error: "not_authorized" });
  const q = (new URL(request.url).searchParams.get("q") || "").trim();
  if (q.length < 2) return json(200, { items: [] });
  const first = await kp(tok, "items/search?perpage=30&q=" + encodeURIComponent(q));
  const items = ((first && first.items) || []).slice(0);
  if (env.TMDB_TOKEN && /^[\x00-\x7f]+$/.test(q) && items.length < 5) {
    // TMDB's /search/multi ranks oddly ("Spirited Away" -> documentaries about it):
    // search films and series separately and take the most voted
    const [mv, tv] = await Promise.all(["movie", "tv"].map((m) => tmdb(env, "/search/" + m + "?language=ru-RU&query=" + encodeURIComponent(q))));
    const hits = [...((mv && mv.results) || []).slice(0, 5), ...((tv && tv.results) || []).slice(0, 5)]
      .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
    const names = [];
    for (const r of hits) {
      const name = r.title || r.name;
      const plain = name && name.replace(/ё/g, "е").replace(/Ё/g, "Е"); // Kinopub often writes е for ё
      if (plain && !names.includes(plain) && plain.toLowerCase() !== q.toLowerCase()) names.push(plain);
      if (names.length >= 3) break;
    }
    const more = await Promise.all(names.map((n) => kp(tok, "items/search?perpage=10&q=" + encodeURIComponent(n))));
    const have = new Set(items.map((i) => i.id));
    for (const res of more) for (const it of (res && res.items) || []) if (!have.has(it.id)) { have.add(it.id); items.push(it); }
  }
  return json(200, rewrite({ items: items.map(slimItem) }, base));
}

/* ---------- per-user caches ---------- */

// The six "Для тебя" shelves and "Продолжить" all start from the history:
// fetch it once per user every 10 minutes instead of on every request.
async function cached(key, ttl, ctx, make) {
  const req = new Request("https://kp-orsay.cache/" + key);
  const hit = await caches.default.match(req);
  if (hit) return hit.json();
  const value = await make();
  if (value) ctx.waitUntil(caches.default.put(req, new Response(JSON.stringify(value), { headers: { "Cache-Control": "public, max-age=" + ttl } })));
  return value;
}

async function history(tok, ctx) {
  return cached("hist/" + (await sha(tok)), 600, ctx, () => kp(tok, "history?perpage=50"));
}

/* ---------- item pages ---------- */

// A series' item carries every format, audio track and subtitle of every
// episode: The Simpsons is 4 MB, seconds of parsing on a 2013 TV. The page
// gets only what it shows; one episode's media comes from /media on play.
async function fullItem(tok, id, ctx, fresh) {
  const key = "item/" + (await sha(tok)) + "/" + id;
  if (fresh) {
    const res = await kp(tok, "items/" + id);
    if (res && res.item) ctx.waitUntil(caches.default.put(new Request("https://kp-orsay.cache/" + key),
      new Response(JSON.stringify(res), { headers: { "Cache-Control": "public, max-age=900" } })));
    return res;
  }
  return cached(key, 900, ctx, () => kp(tok, "items/" + id));
}

const slimVideo = (v) => ({ id: v.id, number: v.number, title: v.title, duration: v.duration, watched: v.watched, watching: v.watching });

async function itemPage(request, base, ctx) {
  const tok = request.headers.get("X-KP-Token");
  if (!tok) return json(401, { error: "not_authorized" });
  const id = parseInt(new URL(request.url).searchParams.get("id"), 10);
  const res = await fullItem(tok, id, ctx, true); // always fresh: watching positions change
  if (!res || !res.item) return json(404, { error: "not_found" });
  const it = res.item, out = {};
  for (const k of ["id", "type", "title", "year", "countries", "genres", "plot", "kinopoisk_rating", "imdb_rating", "posters", "trailer"]) out[k] = it[k];
  if (out.posters) out.posters = { medium: it.posters.medium };
  if (it.seasons) out.seasons = it.seasons.map((s) => ({ number: s.number, episodes: (s.episodes || []).map(slimVideo) }));
  else out.videos = (it.videos || []).map(slimVideo);
  return json(200, rewrite({ item: out }, base));
}

async function media(request, base, ctx) {
  const tok = request.headers.get("X-KP-Token");
  if (!tok) return json(401, { error: "not_authorized" });
  const q = new URL(request.url).searchParams;
  const id = parseInt(q.get("id"), 10), mid = parseInt(q.get("mid"), 10);
  const res = await fullItem(tok, id, ctx, false);
  const it = res && res.item;
  let v = null;
  for (const s of (it && it.seasons) || []) for (const e of s.episodes || []) if (e.id === mid) v = e;
  for (const e of (it && it.videos) || []) if (e.id === mid) v = e;
  if (!v) return json(404, { error: "not_found" });
  return json(200, rewrite({
    files: (v.files || []).map((f) => ({ quality: f.quality, w: f.w, h: f.h, url: { http: f.url.http, hls: f.url.hls } })),
    audios: (v.audios || []).map((a) => ({ index: a.index, lang: a.lang, codec: a.codec, type: a.type && { title: a.type.title }, author: a.author && { title: a.author.title } })),
    subtitles: (v.subtitles || []).map((t) => ({ lang: t.lang, shift: t.shift, forced: t.forced, url: t.url })),
  }, base));
}

/* ---------- continue watching ---------- */

// Unfinished films and series in the order they were last watched.
async function continueWatching(request, base) {
  const tok = request.headers.get("X-KP-Token");
  if (!tok) return json(401, { error: "not_authorized" });
  const [hist, mv, sr] = await Promise.all([kp(tok, "history?perpage=50"), kp(tok, "watching/movies"), kp(tok, "watching/serials")]);
  const open = new Map();
  for (const it of [...((mv && mv.items) || []), ...((sr && sr.items) || [])]) open.set(it.id, it);
  const out = [], seen = new Set();
  for (const h of (hist && hist.history) || []) {
    const it = h.item;
    if (!it || seen.has(it.id) || !open.has(it.id)) continue;
    seen.add(it.id);
    out.push({ ...slimItem(open.get(it.id)), posters: { small: (it.posters || open.get(it.id).posters || {}).small } });
  }
  // anything unfinished that isn't in the recent history goes last
  for (const [id, it] of open) if (!seen.has(id)) out.push(slimItem(it));
  return json(200, rewrite({ items: out.slice(0, 24) }, base));
}
