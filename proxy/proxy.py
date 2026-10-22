"""Kinopub proxy for an old Samsung Orsay TV (2012-2014, pre-Tizen).

The TV's browser can't speak modern TLS, so it talks plain HTTP to this
proxy, and the proxy talks HTTPS to Kinopub. It also builds and serves the
TV app itself, with this server's address baked in.

Standard library only. Configuration (environment):
  KP_PUBLIC   URL the TV uses to reach the API part, e.g. http://192.168.1.50/kp
              (default: http://<this machine's LAN IP>[:port]/kp)
  KP_BIND     address to listen on (default 0.0.0.0)
  KP_PORT     port (default 80: the TV fetches its app list from port 80)
  KP_DATA     where the login token is kept (default ./data next to the repo)
  KP_CLIENT_ID / KP_CLIENT_SECRET  Kinopub API client (default: the public
              credentials of Kinopub's own Kodi add-on)
  KP_CLOUD_URL  optional: also offer the cloud build of the app, which talks
              to a Cloudflare Worker (worker/) at this URL instead of this proxy
  KP_LOCAL    set to 0 to offer only the cloud build: then this proxy is needed
              only while the TV installs the app
  KP_APPLE_DIR  optional: also offer "KP Apple", the design study in ../apple
  KP_LOCAL_ROOT  optional: build "KP Local" from another checkout (a folder with
              tv/ and VERSION), e.g. to keep it on an older release while the
              cloud build moves on

App delivery (what the TV's "Start User App Sync" downloads):
  GET /widgetlist.xml         -> list of apps: "KP Local" (this proxy) and/or
                                 "Kinopub" (cloud build, with KP_CLOUD_URL)
  GET /Widget/<id>.zip        -> the app from ../tv, built on the fly

API endpoints (optionally under a /kp prefix):
  GET /auth/status            -> {"authorized": bool}
  GET /auth/start             -> {"user_code", "verification_uri", "expires_in"}
  GET /auth/poll              -> {"authorized": bool, "error"?}
  GET /api/<path>?<query>     -> Kinopub /v1/<path>, every http(s) URL in the
                                 JSON rewritten to go through /s/
  GET /s/<b64url>/<name>      -> streams the remote file (Range supported);
                                 .m3u8 playlists get their URLs rewritten too
  GET /hls/<b64master>/<n>/index.m3u8
                              -> the master playlist's video variant muxed
                                 with audio track n (Kinopub's CDN packages
                                 index-v1-a<n>.m3u8 on the fly)
  GET /srt/<b64url>/subs.json -> an .srt file as [[start, end, text], ...]
"""

import base64
import io
import json
import os
import re
import threading
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API = "https://api.service-kp.com"
CLIENT_ID = os.environ.get("KP_CLIENT_ID", "xbmc")
CLIENT_SECRET = os.environ.get("KP_CLIENT_SECRET", "cgg3gtifu46urtfp2zp1nqtba0k2ezxh")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TV_DIR = os.environ.get("KP_TV_DIR", os.path.join(ROOT, "tv"))
BIND = os.environ.get("KP_BIND", "0.0.0.0")
PORT = int(os.environ.get("KP_PORT", "80"))
DATA = os.environ.get("KP_DATA", os.path.join(ROOT, "data"))
TOKEN_FILE = os.path.join(DATA, "token.json")
UA = "KinoPubOrsay/1.0"

# Only Kinopub's own hosts may be fetched through /s/, /hls/ and /srt/.
ALLOWED_HOSTS = ("service-kp.com", "cdntogo.net", "staticpop.net", "kino.pub", "kino.watch")


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; picks the LAN interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


PUBLIC = os.environ.get("KP_PUBLIC") or "http://%s%s/kp" % (lan_ip(), "" if PORT == 80 else ":%d" % PORT)
PUBLIC = PUBLIC.rstrip("/")

lock = threading.Lock()
state = {"token": None, "device_code": None}


def load_token():
    try:
        with open(TOKEN_FILE) as f:
            state["token"] = json.load(f)
    except (OSError, ValueError):
        state["token"] = None


def save_token(tok):
    tok["obtained_at"] = int(time.time())
    os.makedirs(DATA, exist_ok=True)
    tmp = TOKEN_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(tok, f)
    os.replace(tmp, TOKEN_FILE)
    state["token"] = tok


def http_json(method, url, data=None, headers=None):
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("User-Agent", UA)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {"error": "http_%d" % e.code}


def oauth(path, **params):
    params.update(client_id=CLIENT_ID, client_secret=CLIENT_SECRET)
    return http_json("POST", API + path + "?" + urllib.parse.urlencode(params))


def forget_token():
    """Kinopub revoked the session: drop it so the TV can log in again."""
    state["token"] = None
    try:
        os.remove(TOKEN_FILE)
    except OSError:
        pass
    print("token revoked, waiting for a new login", flush=True)


def refresh():
    tok = state["token"]
    if not tok or not tok.get("refresh_token"):
        return False
    status, res = oauth("/oauth2/token", grant_type="refresh_token",
                        refresh_token=tok["refresh_token"])
    if status == 200 and res.get("access_token"):
        save_token(res)
        return True
    if status in (400, 401) and res.get("error") in ("invalid_refresh_token", "invalid_grant"):
        forget_token()
    return False


def ensure_fresh():
    tok = state["token"]
    if not tok:
        return
    expires = tok.get("obtained_at", 0) + int(tok.get("expires_in", 0))
    if time.time() > expires - 600:
        refresh()


def api(method, path, query="", data=None):
    with lock:
        ensure_fresh()
    for attempt in (0, 1):
        tok = state["token"]
        if not tok:
            return 401, {"error": "not_authorized"}
        url = API + "/v1/" + path + ("?" + query if query else "")
        status, res = http_json(method, url, data,
                                {"Authorization": "Bearer " + tok["access_token"]})
        if status != 401 or attempt:
            return status, res
        with lock:
            if not refresh():
                return 401, {"error": "not_authorized"}


def proxify(url):
    b = base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")
    name = urllib.parse.urlparse(url).path.rsplit("/", 1)[-1] or "file"
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)[-60:]
    return "%s/s/%s/%s" % (PUBLIC, b, name)


def rewrite(obj):
    if isinstance(obj, dict):
        return {k: rewrite(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [rewrite(v) for v in obj]
    if isinstance(obj, str) and obj.startswith(("https://", "http://")):
        return proxify(obj)
    return obj


def fetch_text(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", "replace"), r.geturl()


def rewrite_m3u8(text, base):
    """Point every URI in a playlist at this proxy."""
    out = []
    for line in text.splitlines():
        t = line.strip()
        if t and not t.startswith("#"):
            line = proxify(urllib.parse.urljoin(base, t))
        elif 'URI="' in t:
            line = re.sub(r'URI="([^"]+)"',
                          lambda m: 'URI="%s"' % proxify(urllib.parse.urljoin(base, m.group(1))), line)
        out.append(line)
    return "\n".join(out) + "\n"


SRT_TIME = re.compile(r"(\d+):(\d+):(\d+)(?:[,.](\d+))?")


def srt_seconds(t):
    m = SRT_TIME.search(t)
    if not m:
        return None
    h, mi, se, frac = m.groups()
    # Kinopub's files mix ",46" (centiseconds) and ",460" (ms): treat it as a fraction.
    return int(h) * 3600 + int(mi) * 60 + int(se) + (float("0." + frac) if frac else 0)


def parse_srt(raw):
    for enc in ("utf-8-sig", "cp1251"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    cues = []
    for block in re.split(r"\r?\n\s*\r?\n", text.replace("\r", "")):
        lines = [l for l in block.strip().split("\n") if l.strip()]
        for i, line in enumerate(lines):
            if "-->" in line:
                a, b = line.split("-->", 1)
                start, end = srt_seconds(a), srt_seconds(b)
                body = "\n".join(lines[i + 1:])
                body = re.sub(r"<[^>]+>|\{[^}]*\}", "", body).strip()
                if start is not None and end is not None and body:
                    cues.append([round(start, 2), round(end, 2), body])
                break
    cues.sort(key=lambda c: c[0])
    return cues


def unb64(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode()


def remote(b64):
    """Decode a proxied URL and refuse anything that isn't Kinopub's."""
    url = unb64(b64)
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if not any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS):
        raise PermissionError("host not allowed: " + host)
    return url


# ---------- the TV app, built on the fly ----------

_widget = {}

CLOUD_URL = os.environ.get("KP_CLOUD_URL", "").rstrip("/")
LOCAL_ROOT = os.environ.get("KP_LOCAL_ROOT", "")
APPLE_DIR = os.environ.get("KP_APPLE_DIR", "")
LOCAL = os.environ.get("KP_LOCAL", "1") != "0" or not CLOUD_URL


def variants():
    """The builds offered to the TV.

    The ids are what the TV installs under, so they stay put even though the
    names changed: the cloud build is the main "Kinopub" app, the build that
    goes through this proxy is "KP Local" with an orange icon.
    """
    out = []
    if CLOUD_URL:
        out.append({"id": "KPOrsay", "title": "Kinopub", "proxy": CLOUD_URL, "cloud": "1"})
    if LOCAL:
        local = {"id": "KinoPub", "title": "KP Local", "proxy": PUBLIC, "cloud": "0"}
        if LOCAL_ROOT:
            local["root"] = LOCAL_ROOT
        out.append(local)
    if APPLE_DIR:
        out.append({"id": "KPApple", "title": "KP Apple", "proxy": CLOUD_URL or PUBLIC, "cloud": "1",
                    "tv": APPLE_DIR, "version": "0.1"})
    return out


def app_version(root=ROOT):
    try:
        with open(os.path.join(root, "VERSION")) as f:
            return f.read().strip() or "0.0"
    except OSError:
        return "0.0"


def app_build(version):
    """1.9 -> 1090, 1.9.1 -> 1091, 1.10 -> 1100: one number that orders releases."""
    try:
        parts = [int(x) for x in version.split(".")] + [0, 0]
        return parts[0] * 1000 + parts[1] * 10 + parts[2]
    except ValueError:
        return 0


def smarthub_version(version):
    """Smart Hub shows an app's version only in its own x.yyy form: 1.9.1 -> 1.091."""
    b = app_build(version)
    return "%d.%03d" % (b // 1000, b % 1000)


def widget_zip(v):
    """Zip ../tv with the variant's server address baked in.

    The TV caches app files by name across reinstalls, so app.js / app.css
    are renamed per version (app-<version>.js).
    """
    root = v.get("root")
    tv_dir = v.get("tv") or (os.path.join(root, "tv") if root else TV_DIR)
    version = v.get("version") or (app_version(root) if root else app_version())
    files = []
    for base, _, names in os.walk(tv_dir):
        for n in sorted(names):
            if not n.startswith("."):
                files.append(os.path.join(base, n))
    key = (version, v["proxy"], tuple((f, os.path.getmtime(f)) for f in files))
    cached = _widget.get(v["id"])
    if cached and cached[0] == key:
        return cached[1]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path in files:
            rel = os.path.relpath(path, tv_dir).replace(os.sep, "/")
            local = v["cloud"] != "1"
            if rel.startswith("img/local/"):
                if not local:
                    continue
                rel = "img/" + rel[len("img/local/"):]  # the local build's orange icons
            elif local and os.path.exists(os.path.join(tv_dir, "img", "local", os.path.basename(rel))):
                continue
            with open(path, "rb") as f:
                data = f.read()
            if rel in ("index.html", "js/app.js", "css/app.css", "config.xml"):
                text = data.decode("utf-8")
                text = text.replace("__PROXY__", v["proxy"]).replace("__VERSION__", version)
                text = text.replace("__CLOUD__", v["cloud"]).replace("__BUILD__", str(app_build(version)))
                text = text.replace("<widgetname>KinoPub</widgetname>", "<widgetname>%s</widgetname>" % v["title"])
                text = text.replace("js/app.js", "js/app-%s.js" % version)
                text = text.replace("css/app.css", "css/app-%s.css" % version)
                text = re.sub(r"<ver>[^<]*</ver>", "<ver>%s</ver>" % smarthub_version(version), text)
                data = text.encode("utf-8")
            if rel == "js/app.js":
                rel = "js/app-%s.js" % version
            elif rel == "css/app.css":
                rel = "css/app-%s.css" % version
            z.writestr(rel, data)
    _widget[v["id"]] = (key, buf.getvalue())
    return buf.getvalue()


def widget_list():
    origin = PUBLIC[:-3] if PUBLIC.endswith("/kp") else PUBLIC
    items = "".join(
        '<widget id="%s">\n<title>%s</title>\n<compression size="%d" type="zip"/>\n'
        '<description>Kinopub for Samsung Orsay TVs</description>\n'
        '<download>%s/Widget/%s.zip</download>\n</widget>\n'
        % (v["id"], v["title"], len(widget_zip(v)), origin, v["id"]) for v in variants())
    return '<?xml version="1.0" encoding="UTF-8"?>\n<rsp stat="ok">\n<list>\n%s</list>\n</rsp>\n' % items


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if "/s/" not in self.path:
            super().log_message(fmt, *args)

    def send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        u = urllib.parse.urlsplit(self.path)
        p = u.path
        if p == "/kp" or p.startswith("/kp/"):
            p = p[3:] or "/"
        try:
            if p == "/widgetlist.xml":
                return self.send_bytes(widget_list().encode(), "text/xml; charset=utf-8", head)
            if p.startswith("/Widget/") and p.endswith(".zip"):
                for v in variants():
                    if p == "/Widget/%s.zip" % v["id"]:
                        return self.send_bytes(widget_zip(v), "application/zip", head)
            if p == "/log":
                # diagnostics sent by the TV app; the request line is the log entry
                self.send_response(204)
                self.send_header("Content-Length", "0")
                return self.end_headers()
            if p.startswith("/s/"):
                if p.endswith(".m3u8"):
                    url = remote(p.split("/")[2])
                    text, final = fetch_text(url)
                    return self.send_playlist(rewrite_m3u8(text, final))
                return self.stream(p, head)
            if p.startswith("/hls/"):
                return self.hls(p)
            if p.startswith("/srt/"):
                req = urllib.request.Request(remote(p.split("/")[2]), headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=20) as r:
                    return self.send_json(200, parse_srt(r.read()))
            if p == "/auth/status":
                return self.send_json(200, {"authorized": bool(state["token"])})
            if p == "/auth/start":
                return self.auth_start()
            if p == "/auth/poll":
                return self.auth_poll()
            if p.startswith("/api/"):
                method = "GET"
                q = urllib.parse.parse_qsl(u.query, keep_blank_values=True)
                # The TV only does GET; ?_post=1 turns it into a form POST.
                if any(k == "_post" for k, _ in q):
                    method = "POST"
                    data = {k: v for k, v in q if k != "_post"}
                    status, res = api(method, p[5:], data=data)
                else:
                    status, res = api(method, p[5:], u.query)
                return self.send_json(status, rewrite(res))
            if p == "/health":
                return self.send_json(200, {"ok": True})
            self.send_json(404, {"error": "not_found"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except PermissionError as e:
            self.send_json(403, {"error": str(e)})
        except Exception as e:  # keep the TV informed instead of hanging
            try:
                self.send_json(502, {"error": str(e)})
            except Exception:
                pass

    def send_bytes(self, body, ctype, head=False):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def send_playlist(self, text):
        body = text.encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.apple.mpegurl")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def hls(self, p):
        parts = p.split("/")
        master_url, track = remote(parts[2]), int(parts[3] or 1)
        master, final = fetch_text(master_url)
        variant = None
        for line in master.splitlines():
            t = line.strip()
            if t and not t.startswith("#"):
                variant = urllib.parse.urljoin(final, t)
                break
        if not variant:
            return self.send_json(502, {"error": "no variant in master playlist"})
        variant = re.sub(r"index-v(\d+)-?a\d+\.m3u8", r"index-v\1-a%d.m3u8" % track, variant)
        text, final = fetch_text(variant)
        self.send_playlist(rewrite_m3u8(text, final))

    def auth_start(self):
        status, res = oauth("/oauth2/device", grant_type="device_code")
        if status != 200 or "code" not in res:
            return self.send_json(502, res)
        state["device_code"] = res["code"]
        self.send_json(200, {"user_code": res["user_code"],
                             "verification_uri": res["verification_uri"],
                             "expires_in": res.get("expires_in", 300),
                             "interval": res.get("interval", 5)})

    def auth_poll(self):
        if state["token"]:
            return self.send_json(200, {"authorized": True})
        if not state["device_code"]:
            return self.send_json(200, {"authorized": False, "error": "no_code"})
        status, res = oauth("/oauth2/device", grant_type="device_token",
                            code=state["device_code"])
        if status == 200 and res.get("access_token"):
            save_token(res)
            state["device_code"] = None
            api("POST", "device/notify", data={
                "title": "Samsung Smart TV", "hardware": "Samsung Orsay",
                "software": UA})
            return self.send_json(200, {"authorized": True})
        self.send_json(200, {"authorized": False, "error": res.get("error", "pending")})

    def stream(self, p, head):
        parts = p.split("/")
        url = remote(parts[2])
        req = urllib.request.Request(url, method="HEAD" if head else "GET")
        req.add_header("User-Agent", UA)
        rng = self.headers.get("Range")
        if rng:
            req.add_header("Range", rng)
        try:
            r = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            r = e
        with r:
            self.send_response(r.status)
            for h in ("Content-Type", "Content-Length", "Content-Range",
                      "Accept-Ranges", "Last-Modified", "ETag"):
                v = r.headers.get(h)
                if v:
                    self.send_header(h, v)
            if not r.headers.get("Accept-Ranges"):
                self.send_header("Accept-Ranges", "bytes")
            if "image" in (r.headers.get("Content-Type") or ""):
                self.send_header("Cache-Control", "public, max-age=604800")
            if not r.headers.get("Content-Length"):
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            if head:
                return
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)


def main():
    load_token()
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    srv.daemon_threads = True
    print("kinopub proxy v%s on %s:%d, TV uses %s, authorized=%s"
          % (app_version(), BIND, PORT, PUBLIC, bool(state["token"])), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
