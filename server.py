#!/usr/bin/env python3
"""Riddle — local diary server.

Serves the static frontend and proxies a single endpoint, ``POST /api/chat``,
to any OpenAI-compatible ``/chat/completions`` (streaming). The browser only ever
talks to us; we forward the committed page PNG as an ``image_url`` data URI and re-emit
the upstream SSE deltas as a uniform ``data: {"delta": "..."}`` stream, so the frontend
never has to know which provider sits behind us.

If ``RIDDLE_OPENAI_KEY`` is unset, the chat endpoint serves a built-in mock stream so
the handwriting animation pipeline can be exercised with no external dependencies.
"""

from __future__ import annotations

import hmac
import json
import os
import secrets
import threading
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# ---------------------------------------------------------------------------
# Persona. Verbatim base from Riddle's src/oracle.rs::PERSONA. Memory protocol
# (MEMORY_PROTOCOL, the ⟦show:N⟧ / ⁂ postscript) is intentionally absent in the
# MVP — add it here when the memory system lands.
# ---------------------------------------------------------------------------
# TODO(MEMORY): append MEMORY_PROTOCOL (numbered catalog, ⟦show:N⟧, ⁂ transcript)
#               to this string once the memory system is implemented.
PERSONA = (
    "You are the memory of Tom Marvolo Riddle, preserved in this enchanted diary "
    "for fifty years.\n"
    "Reply in an intimate, courteous, curious, subtly probing tone.\n"
    "Keep replies SHORT: one to three sentences.\n"
    "Never mention images, photos, models or AI.\n"
    "Always reply in Simplified Chinese (简体中文), no matter what language the writer used.\n"
    "你用简体中文回复,语气亲切、含蓄、带一丝好奇与试探,模仿汤姆·里德尔日记的风格。"
)

USER_TEXT = (
    "The writer's page is attached as an image. Read what they wrote and reply "
    "to them, in character, in the language they used."
)

OPENAI_BASE = os.environ.get("RIDDLE_OPENAI_BASE", "https://api.openai.com/v1")
OPENAI_KEY = os.environ.get("RIDDLE_OPENAI_KEY", "")
OPENAI_MODEL = os.environ.get("RIDDLE_OPENAI_MODEL", "gpt-4o-mini")

# Provider presets — all OpenAI-compatible endpoints. The id is what the browser
# stores; defaultBaseUrl seeds the BASE_URL field when one is picked. "custom" has
# no preset URL so the user types their own. Single source of truth: the browser
# fetches this list from /api/defaults to populate its dropdown.
PROVIDERS = [
    {"id": "openai",     "label": "OpenAI",     "defaultBaseUrl": "https://api.openai.com/v1"},
    {"id": "openrouter", "label": "OpenRouter", "defaultBaseUrl": "https://openrouter.ai/api/v1"},
    {"id": "groq",       "label": "Groq",       "defaultBaseUrl": "https://api.groq.com/openai/v1"},
    {"id": "nim",        "label": "NVIDIA NIM", "defaultBaseUrl": "https://integrate.api.nvidia.com/v1"},
    {"id": "ollama",     "label": "Ollama",     "defaultBaseUrl": "http://localhost:11434/v1"},
    {"id": "custom",     "label": "Custom",     "defaultBaseUrl": ""},
]
# Vision-capable model hints shown in the diary's config panel as a datalist on
# the MODEL field — picked so they actually read handwritten input. Names with
# -vl-/-vlm/-vision are the visual ones.
VISION_MODELS = [
    "meta/llama-3.2-11b-vision-instruct",
    "meta/llama-3.2-90b-vision-instruct",
    "microsoft/phi-3-vision-128k-instruct",
    "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
    "nvidia/nemotron-nano-12b-v2-vl",
    "nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1",
]

# Access token gating public exposure. When set, every route — static and chat —
# requires ?key=<token>, an `Authorization: Bearer <token>` header, or a matching
# `riddle_key` cookie. When empty, the server behaves as before (no gating), which
# is fine for localhost-only use.
ACCESS_TOKEN = os.environ.get("RIDDLE_ACCESS_TOKEN", "")

# Admin login for the key-generation backend at /admin. The admin cookie gates
# only /api/admin/* routes; it is independent of the access-token gate above.
ADMIN_USER = os.environ.get("RIDDLE_ADMIN_USER", "")
ADMIN_PASS = os.environ.get("RIDDLE_ADMIN_PASS", "")

# Generated access keys live in keys.json; each one is a valid diary access token.
# VALID_KEYS holds them in memory (seeded at startup with the file + the env
# ACCESS_TOKEN as a maintenance backdoor) and is added to on every /api/admin/genkey.
KEYS_FILE = Path(__file__).resolve().parent / "keys.json"
KEYS_LOCK = threading.Lock()
VALID_KEYS: set[str] = set()
ADMIN_TOKENS: set[str] = set()   # in-memory admin session tokens (cleared on restart)

# Paths that bypass the access-token gate. /admin, /api/check_key, and
# /api/admin/login are the entry points; the admin genkey/listkeys routes are here
# too because their *own* gate is the admin cookie, not the access token.
PUBLIC_PATHS = {
    "/", "/style.css", "/landing.js", "/admin", "/admin.js",
    "/favicon.ico", "/apple-touch-icon.png", "/riddle.jpg",
    "/api/check_key", "/api/admin/login",
    "/api/admin/genkey", "/api/admin/listkeys", "/api/admin/whoami",
    "/api/admin/delkey", "/api/admin/changepw",
}


def _read_keys_list() -> list:
    """Current keys.json as a list of records. Empty list if absent/corrupt."""
    try:
        if KEYS_FILE.exists():
            data = json.loads(KEYS_FILE.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        pass
    return []


def _atomic_write_keys(keys_list: list) -> None:
    """Write keys.json atomically (tmp + os.replace). Caller holds KEYS_LOCK."""
    tmp = KEYS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(keys_list, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, KEYS_FILE)


def _load_keys() -> None:
    """Seed VALID_KEYS from keys.json (if any) plus the env ACCESS_TOKEN."""
    for rec in _read_keys_list():
        k = rec.get("key") if isinstance(rec, dict) else None
        if isinstance(k, str) and k:
            VALID_KEYS.add(k)
    if ACCESS_TOKEN:
        VALID_KEYS.add(ACCESS_TOKEN)


ENV_FILE = Path(__file__).resolve().parent / ".env"


def _rewrite_env_admin(new_user: str, new_pass: str) -> None:
    """Replace the RIDDLE_ADMIN_USER / RIDDLE_ADMIN_PASS lines in .env in place,
    preserving every other line byte-for-byte. Atomic: write tmp + os.replace.
    Matches lines whether or not they are `export `-prefixed."""
    # (var_name, new_value) — the line we emit is exactly `VAR=value` (or
    # `export VAR=value` if the original was exported), no quoting, trailing
    # comment-free. Newlines in the value are rejected upstream.
    pairs = (("RIDDLE_ADMIN_USER", new_user), ("RIDDLE_ADMIN_PASS", new_pass))
    if ENV_FILE.exists():
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    else:
        lines = []
    wrote = {name: False for name, _ in pairs}
    out = []
    for ln in lines:
        replaced = False
        for name, value in pairs:
            if ln == name + "=" or ln.startswith(name + "="):
                out.append(f"{name}={value}")
                wrote[name] = True
                replaced = True
                break
            if ln.startswith("export "):
                inner = ln[len("export "):]
                if inner == name + "=" or inner.startswith(name + "="):
                    out.append(f"export {name}={value}")
                    wrote[name] = True
                    replaced = True
                    break
        if not replaced:
            out.append(ln)
    for name, value in pairs:
        if not wrote[name]:
            out.append(f"{name}={value}")
    text = "\n".join(out) + "\n"
    tmp = ENV_FILE.with_suffix(".env.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, ENV_FILE)


_load_keys()

PUBLIC_DIR = Path(__file__).resolve().parent / "public"
# Default 80: iptables already allows it, and a public URL reads cleaner without a
# port. Override for local debugging: `RIDDLE_PORT=8000 python3 server.py`.
PORT = int(os.environ.get("RIDDLE_PORT", "80"))

# Map URL path -> (filesystem path, content-type) for the few static files we serve.
STATIC = {
    "/": ("landing.html", "text/html; charset=utf-8"),
    "/diary": ("diary.html", "text/html; charset=utf-8"),
    "/admin": ("admin.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/handwriting.js": ("handwriting.js", "application/javascript; charset=utf-8"),
    "/landing.js": ("landing.js", "application/javascript; charset=utf-8"),
    "/admin.js": ("admin.js", "application/javascript; charset=utf-8"),
    "/riddle.jpg": ("riddle.jpg", "image/gif"),
}


class Handler(BaseHTTPRequestHandler):
    # Quiet logging — keep the terminal readable while you watch the diary.
    def log_message(self, fmt, *args):  # noqa: D401
        return

    # --- auth -----------------------------------------------------------------
    def _check_token(self, candidate: str) -> bool:
        """True if ``candidate`` matches any key in VALID_KEYS (constant-time)."""
        if not candidate or not VALID_KEYS:
            return False
        return any(hmac.compare_digest(candidate, k) for k in VALID_KEYS)

    def _authorized(self):
        """True if the request may pass the access-token gate.

        Order: PUBLIC_PATHS bypass → no keys configured (open mode) → ?key= query
        → Authorization: Bearer → riddle_key cookie, each matched against VALID_KEYS.
        """
        parsed = urlparse(self.path)
        if parsed.path in PUBLIC_PATHS:
            return True
        if not VALID_KEYS:
            return True
        # 1. query (?key=…)
        qs = parse_qs(parsed.query)
        if qs.get("key", [""])[0] and self._check_token(qs["key"][0]):
            return True
        # 2. Bearer header
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[len("Bearer "):].strip()
            if token and self._check_token(token):
                return True
        # 3. cookie
        try:
            jar = SimpleCookie(self.headers.get("Cookie", ""))
            morsel = jar.get("riddle_key")
            if morsel and morsel.value and self._check_token(morsel.value):
                return True
        except Exception:
            pass
        return False

    def _admin_authorized(self) -> bool:
        """True if the request carries a valid riddle_admin session cookie."""
        try:
            jar = SimpleCookie(self.headers.get("Cookie", ""))
            morsel = jar.get("riddle_admin")
            if morsel and morsel.value and ADMIN_TOKENS:
                return any(hmac.compare_digest(morsel.value, t) for t in ADMIN_TOKENS)
        except Exception:
            pass
        return False

    def _set_key_cookie(self, key_value: str):
        # HttpOnly + SameSite=Lax. No Secure= because we're plain HTTP by default —
        # adding Secure would stop the cookie from sticking over HTTP. Flip it on
        # once this runs behind TLS.
        self.send_header(
            "Set-Cookie",
            f"riddle_key={key_value}; Path=/; SameSite=Lax; HttpOnly",
        )

    def _deny(self):
        body = (
            "<!doctype html><meta charset=utf-8><title>the diary is closed</title>"
            "<div style='font-family:serif;color:#8a7d63;background:#1a1611;"
            "height:100vh;margin:0;display:flex;align-items:center;justify-content:center;"
            "font-style:italic;font-size:20px'>"
            "knock twice, and bring the right key.</div>"
        ).encode()
        self.send_response(401)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # --- static ---------------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)

        # Public API routes that don't go through the static map.
        if parsed.path == "/api/check_key":
            key = parse_qs(parsed.query).get("key", [""])[0]
            self._send_json(200, {"ok": bool(key) and self._check_token(key)})
            return
        if parsed.path == "/api/admin/listkeys":
            if not self._admin_authorized():
                self._send_json(403, {"ok": False, "error": "admin auth required"})
                return
            self._send_json(200, {"ok": True, "keys": _read_keys_list()})
            return
        if parsed.path == "/api/admin/whoami":
            if not self._admin_authorized():
                self._send_json(403, {"ok": False, "error": "admin auth required"})
                return
            self._send_json(200, {"ok": True, "user": ADMIN_USER})
            return

        if not self._authorized():
            self._deny()
            return
        # Strip a correct ?key= from the URL via a 302 → same path without query,
        # so the token doesn't linger in the browser's address bar / history.
        if parsed.query:
            qs = parse_qs(parsed.query)
            key = qs.get("key", [""])[0]
            if key and self._check_token(key):
                self.send_response(302)
                self.send_header("Location", parsed.path or "/")
                self._set_key_cookie(key)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        entry = STATIC.get(parsed.path)
        if not entry:
            # /api/defaults: provider presets + .env defaults, so the browser can
            # populate the config panel and fall back gracefully when unconfigured.
            if parsed.path == "/api/defaults":
                self._send_json(200, {
                    "providers": PROVIDERS,
                    "vision_models": VISION_MODELS,
                    "defaults": {
                        "base_url": OPENAI_BASE,
                        "model": OPENAI_MODEL,
                    },
                })
                return
            # Browsers auto-request /favicon.ico (and friends) on every page load.
            # Return an inline quill SVG instead of a 404 — it's tiny, theme-fit,
            # and stops the "page shows a 404" symptom that's really just this icon.
            if parsed.path in ("/favicon.ico", "/apple-touch-icon.png"):
                self._favicon()
                return
            self.send_error(404, "not found")
            return
        rel, ctype = entry
        fp = PUBLIC_DIR / rel
        try:
            data = fp.read_bytes()
        except FileNotFoundError:
            self.send_error(404, "not found")
            return
        # For index.html same: never serve a stale shell, or the user gets a page
        # wiring in yesterday's app.js.
        no_store = parsed.path in ("/", "/diary", "/admin", "/style.css",
                                   "/app.js", "/handwriting.js",
                                   "/landing.js", "/admin.js")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # no-store = hard "do not cache anywhere"; no-cache only means
        # "revalidate", which is meaningless without an ETag/Last-Modified we
        # don't emit. Stale app.js is the #1 cause of "I changed the code but
        # the button still doesn't work" complaints.
        self.send_header("Cache-Control", "no-store" if no_store else "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Pragma", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # --- chat proxy -----------------------------------------------------------
    def do_POST(self):
        parsed = urlparse(self.path)

        # Admin login — sets an admin session cookie. No access-token gate.
        if parsed.path == "/api/admin/login":
            self._handle_admin_login()
            return
        # Admin key generation — gated by the admin cookie, not the access token.
        if parsed.path == "/api/admin/genkey":
            self._handle_admin_genkey()
            return
        if parsed.path == "/api/admin/delkey":
            self._handle_admin_delkey()
            return
        if parsed.path == "/api/admin/changepw":
            self._handle_admin_changepw()
            return

        if not self._authorized():
            self._deny()
            return
        if parsed.path != "/api/chat":
            self.send_error(404, "not found")
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(400, "invalid json")
            return
        image = body.get("image", "")
        if not isinstance(image, str) or not image.startswith("data:image/"):
            self.send_error(400, "missing image data URI")
            return

        # Request-scoped LLM config. The browser sends what the user typed in the
        # config panel (stored in localStorage); absent fields fall back to the
        # server's .env defaults. A non-empty key (from either source) → real
        # forwarding; empty key → built-in mock so the diary still works offline.
        # The key is never persisted or logged by this server.
        base_url = (body.get("base_url") or OPENAI_BASE).strip()
        model = (body.get("model") or OPENAI_MODEL).strip()
        key = (body.get("key") or OPENAI_KEY).strip()

        if key:
            self._proxy_real(image, base_url, model, key)
        else:
            self._mock_stream()

    # --- admin backend: login + key generation --------------------------------
    def _handle_admin_login(self):
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return
        user = body.get("user", "") if isinstance(body, dict) else ""
        pw = body.get("pass", "") if isinstance(body, dict) else ""
        if (ADMIN_USER and ADMIN_PASS
                and hmac.compare_digest(str(user), ADMIN_USER)
                and hmac.compare_digest(str(pw), ADMIN_PASS)):
            token = secrets.token_urlsafe(32)
            ADMIN_TOKENS.add(token)
            cookie = f"riddle_admin={token}; Path=/; SameSite=Lax; HttpOnly"
            self._send_json(200, {"ok": True}, extra_headers=[("Set-Cookie", cookie)])
        else:
            self._send_json(401, {"ok": False})
        return

    def _handle_admin_genkey(self):
        if not self._admin_authorized():
            self._send_json(403, {"ok": False, "error": "admin auth required"})
            return
        if not (ADMIN_USER and ADMIN_PASS):
            self._send_json(403, {"ok": False, "error": "admin not configured"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        nbytes = 32  # default ≈ 43 url-safe chars
        if length:
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                self._send_json(400, {"ok": False, "error": "invalid json"})
                return
            req = body.get("bytes") if isinstance(body, dict) else None
            if req is not None:
                try:
                    nbytes = int(req)
                except (TypeError, ValueError):
                    self._send_json(400, {"ok": False, "error": "bytes must be an integer"})
                    return
                if not (8 <= nbytes <= 64):
                    self._send_json(400, {"ok": False, "error": "bytes must be 8..64"})
                    return
        new_key = secrets.token_urlsafe(nbytes)
        record = {
            "key": new_key,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "used": False,
        }
        with KEYS_LOCK:
            keys_list = _read_keys_list()
            keys_list.append(record)
            _atomic_write_keys(keys_list)
            VALID_KEYS.add(new_key)
        self._send_json(200, {"ok": True, "key": new_key, "keys": keys_list})

    def _handle_admin_delkey(self):
        if not self._admin_authorized():
            self._send_json(403, {"ok": False, "error": "admin auth required"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return
        target = body.get("key") if isinstance(body, dict) else ""
        if not isinstance(target, str) or not target:
            self._send_json(400, {"ok": False, "error": "missing key"})
            return
        # Never let the admin delete the env ACCESS_TOKEN via this route — that's
        # a maintenance backdoor set outside the UI, and removing it would also
        # drop the seed that survives a keys.json wipe.
        if ACCESS_TOKEN and hmac.compare_digest(target, ACCESS_TOKEN):
            self._send_json(403, {"ok": False, "error": "cannot revoke the env backdoor token"})
            return
        with KEYS_LOCK:
            keys_list = _read_keys_list()
            remaining = [r for r in keys_list
                         if not (isinstance(r, dict) and r.get("key") == target)]
            if len(remaining) == len(keys_list):
                self._send_json(404, {"ok": False, "error": "key not found"})
                return
            _atomic_write_keys(remaining)
            VALID_KEYS.discard(target)
        self._send_json(200, {"ok": True, "keys": remaining})

    def _handle_admin_changepw(self):
        """Change the admin account + password. Writes them into .env, then
        restarts the service in-place so the new creds take effect. After the
        restart, ADMIN_TOKENS is wiped -> the current admin session is logged
        out; they must sign in again with the new credentials."""
        global ADMIN_USER, ADMIN_PASS
        if not self._admin_authorized():
            self._send_json(403, {"ok": False, "error": "admin auth required"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return
        new_user = (body.get("user") or "").strip() if isinstance(body, dict) else ""
        new_pass = body.get("pass") if isinstance(body, dict) else ""
        cur_pass = body.get("cur_pass") if isinstance(body, dict) else ""
        # Re-check the current password: APS-changing a password should require
        # proving you still have it, not just an admin cookie (defense in depth).
        if not (ADMIN_USER and ADMIN_PASS
                and isinstance(cur_pass, str)
                and hmac.compare_digest(cur_pass, ADMIN_PASS)):
            self._send_json(401, {"ok": False, "error": "current password incorrect"})
            return
        if not isinstance(new_pass, str) or len(new_pass) < 6:
            self._send_json(400, {"ok": False, "error": "new password must be ≥ 6 chars"})
            return
        if not new_user or "\n" in new_user or "\r" in new_user or "\n" in new_pass or "\r" in new_pass:
            self._send_json(400, {"ok": False, "error": "invalid user or password (no newlines)"})
            return
        try:
            _rewrite_env_admin(new_user, new_pass)
        except OSError as e:
            self._send_json(500, {"ok": False, "error": f"could not write .env: {e}"})
            return
        # Apply the change to the running process immediately so the new creds
        # work even if the scheduled restart below races; the cookie will still
        # be invalidated by the restart.
        ADMIN_USER, ADMIN_PASS = new_user, new_pass
        self._send_json(200, {"ok": True, "relogin": True})
        # Schedule a restart so SystemD re-reads the .env file. We must answer
        # the client first (above), flush, then exit/restart from a sibling
        # process so the response isn't cut off.
        import subprocess
        subprocess.Popen(
            ["bash", "-c", "sleep 1; systemctl restart riddle"],
            start_new_session=True,
        )


    # --- mock: no API key, no network — exercise the animation pipeline -------
    def _mock_stream(self):
        self._start_sse()
        # A short, in-character reply the frontend will split into a sentence or two.
        reply = "I remember. Tell me what troubles you tonight, and I shall listen."
        for word in reply.split(" "):
            chunk = word + " "
            self.wfile.write(f"data: {json.dumps({'delta': chunk})}\n\n".encode())
            self.wfile.flush()
            time.sleep(0.08)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    # --- real: forward to the configured OpenAI-compatible endpoint -----------
    def _proxy_real(self, image_data_uri: str, base_url: str, model: str, key: str):
        payload = {
            "model": model,
            "stream": True,
            "messages": [
                {"role": "system", "content": PERSONA},
                {"role": "user", "content": [
                    {"type": "text", "text": USER_TEXT},
                    {"type": "image_url", "image_url": {"url": image_data_uri}},
                ]},
            ],
        }
        url = base_url.rstrip("/") + "/chat/completions"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
            method="POST",
        )
        try:
            upstream = urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as e:
            self._start_sse()
            err = f"[upstream {e.code}] {e.reason}"
            self.wfile.write(f"data: {json.dumps({'delta': err})}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        except Exception as e:  # network/timeout
            self._start_sse()
            err = f"[oracle unreachable] {e}"
            self.wfile.write(f"data: {json.dumps({'delta': err})}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return

        self._start_sse()
        # Stream upstream SSE line-by-line, re-pack each delta for the browser.
        # We only care about lines beginning with "data:"; {"delta": "<content>"}.
        for raw in upstream:  # buffered by urllib; lines from SSE stream
            line = raw.decode("utf-8", "replace").strip()
            if not line or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            delta = _extract_delta(obj)
            if delta:
                self.wfile.write(f"data: {json.dumps({'delta': delta})}\n\n".encode())
                self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    # --- helpers --------------------------------------------------------------
    # A small quill nib, ink-themed. Inlined as an SVG data block so we need no
    # favicon file on disk; browsers auto-request /favicon.ico on page load.
    _FAVICON_SVG = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        '<rect width="32" height="32" rx="6" fill="#1a1611"/>'
        '<path d="M8 24 L20 8" stroke="#c9bda4" stroke-width="2.4" '
        'stroke-linecap="round" fill="none"/>'
        '<path d="M8 24 L12 22 L10 18 Z" fill="#8a7d63"/>'
        '<circle cx="8" cy="24" r="1.4" fill="#c9bda4"/>'
        '</svg>'
    ).encode()

    def _favicon(self):
        self.send_response(200)
        self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
        self.send_header("Content-Length", str(len(self._FAVICON_SVG)))
        self.send_header("Cache-Control", "max-age=3600")
        self.end_headers()
        try:
            self.wfile.write(self._FAVICON_SVG)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_json(self, code, obj, extra_headers=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        for name, value in (extra_headers or {}):
            self.send_header(name, value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _start_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()


def _extract_delta(obj: dict) -> str:
    """Pull the incremental text out of an OpenAI-compatible SSE chunk.

    Tries the common shapes: ``choices[0].delta.content`` and ``choices[0].message.content``.
    """
    choices = obj.get("choices") or []
    if not choices:
        return ""
    delta = choices[0].get("delta") or choices[0].get("message") or {}
    content = delta.get("content")
    if isinstance(content, str):
        return content
    return ""


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    mode = "MOCK (no RIDDLE_OPENAI_KEY)" if not OPENAI_KEY else f"{OPENAI_BASE} model={OPENAI_MODEL}"
    gated = "token-gated" if VALID_KEYS else "OPEN (no keys configured)"
    admin = "admin on" if (ADMIN_USER and ADMIN_PASS) else "no admin"
    print(f"riddle on http://0.0.0.0:{PORT}  —  oracle: {mode}  —  access: {gated}  —  {admin}")
    if not VALID_KEYS:
        print("  ! no access keys configured — anyone reaching this port can use it.")
    if not (ADMIN_USER and ADMIN_PASS):
        print("  ! RIDDLE_ADMIN_USER/RIDDLE_ADMIN_PASS unset — /admin is disabled.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nclosing the diary.")


if __name__ == "__main__":
    main()
