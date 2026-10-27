"""
Public web service for the Google version: tmu-case-db-web.

The ONE public door in project jicl-database. It does two things:

  1. Serves the built website (dist/) -- pages, JS, CSS, data files.
  2. Forwards a short allowlist of read-only API calls under /api/* to the
     PRIVATE backend tmu-case-db-gcs, adding a Google-signed ID token.

The backend refuses every call without a valid token (403), so browsers can
reach the data only through here, and only through the routes listed in
API_ROUTES. Everything else under /api/ -- including /mcp, which is on hold --
gets a 404 from this service and never reaches the backend.

Why the browser cannot call the backend itself: a visitor's browser has no
Google identity to sign with. This service runs as the backend's own service
account (tmu-case-db-gcs@...), which has roles/run.invoker on the backend, and
gets its token from the Cloud Run metadata server -- no key file anywhere.

Rate limit: RATE_PER_MIN requests per visitor IP per minute on /api/*, counted
per container. The IP comes from client_ip(), which reads the X-Forwarded-For
entry Google's front end appended -- never one the visitor can write. With --max-instances 2 the real ceiling is at most twice that.
It is a guard against a runaway script, not a security boundary.

Local testing (no metadata server):
    BACKEND_URL=http://127.0.0.1:8080 WEB_NO_AUTH=1 uvicorn web:app --port 8090
"""
from __future__ import annotations

import base64
import json
import os
import re
import threading
import time
from collections import deque
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response

HERE = Path(__file__).resolve().parent
DIST = Path(os.environ.get("WEB_DIST", HERE / "dist")).resolve()
BACKEND_URL = os.environ["BACKEND_URL"].rstrip("/")
AUDIENCE = os.environ.get("BACKEND_AUDIENCE", BACKEND_URL)
NO_AUTH = os.environ.get("WEB_NO_AUTH") == "1"
RATE_PER_MIN = int(os.environ.get("WEB_RATE_PER_MIN", "120"))
# How many X-Forwarded-For entries, counted from the RIGHT, were added by
# Google's own front end. Cloud Run on its run.app URL appends exactly one: the
# visitor's real IP. Put an external load balancer in front and it becomes 2.
TRUSTED_PROXY_HOPS = int(os.environ.get("WEB_TRUSTED_PROXY_HOPS", "1"))
TIMEOUT_SECONDS = 60.0          # backend cold start + first semantic load

# The only backend routes a browser may reach. Matched against the path AFTER
# /api is removed. Anything else is a 404 here and is never forwarded.
API_ROUTES = re.compile(r"^/(search|keywords|facets|health|case/[A-Za-z0-9_-]{1,32})$")

# Response headers worth passing back. Hop-by-hop headers and anything the
# backend might set about itself are dropped.
PASS_HEADERS = ("content-type", "cache-control")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_client = httpx.AsyncClient(timeout=TIMEOUT_SECONDS)


# ---------------------------------------------------------------------------
# ID token for the backend, from the metadata server, reused until near expiry.
# ---------------------------------------------------------------------------
_token_lock = threading.Lock()
_token: tuple[str, float] | None = None       # (token, expires_at)

METADATA_IDENTITY = ("http://metadata.google.internal/computeMetadata/v1/"
                     "instance/service-accounts/default/identity")


def _jwt_exp(token: str) -> float:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return float(json.loads(base64.urlsafe_b64decode(payload))["exp"])


async def backend_token() -> str | None:
    global _token
    if NO_AUTH:
        return None
    now = time.time()
    with _token_lock:
        if _token and _token[1] - 300 > now:          # 5 min safety margin
            return _token[0]
    r = await _client.get(METADATA_IDENTITY, params={"audience": AUDIENCE},
                          headers={"Metadata-Flavor": "Google"}, timeout=10)
    r.raise_for_status()
    tok = r.text.strip()
    with _token_lock:
        _token = (tok, _jwt_exp(tok))
    return tok


# ---------------------------------------------------------------------------
# Per-IP rate limit (sliding one-minute window, in memory, per container).
# ---------------------------------------------------------------------------
_hits: dict[str, deque] = {}
_hits_lock = threading.Lock()


def client_ip(request: Request) -> str:
    """The visitor's IP, as Google's front end recorded it.

    NOT the leftmost X-Forwarded-For entry: a visitor can send that header
    themselves, and Google's front end APPENDS to it rather than replacing it.
    Counting by the leftmost entry let anyone dodge the rate limit by sending a
    new made-up IP each time (confirmed on the live service). The entry
    TRUSTED_PROXY_HOPS from the right is the one Google wrote.
    """
    hosts = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",")
             if h.strip()]
    if len(hosts) >= TRUSTED_PROXY_HOPS:
        return hosts[-TRUSTED_PROXY_HOPS]
    return request.client.host if request.client else "unknown"


def allow(ip: str) -> bool:
    now = time.monotonic()
    with _hits_lock:
        q = _hits.setdefault(ip, deque())
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= RATE_PER_MIN:
            return False
        q.append(now)
        if len(_hits) > 10_000:                       # drop idle visitors
            for k in [k for k, v in _hits.items() if not v or now - v[-1] > 60]:
                del _hits[k]
        return True


# ---------------------------------------------------------------------------
# /api/* -> backend (GET only, allowlisted paths only)
# ---------------------------------------------------------------------------
@app.get("/api/{path:path}")
async def api(path: str, request: Request):
    sub = "/" + path
    if not API_ROUTES.match(sub):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    if not allow(client_ip(request)):
        return JSONResponse({"detail": "Too many requests, wait a minute."},
                            status_code=429, headers={"Retry-After": "60"})

    # Only the query string is passed on. No cookies, no client Authorization,
    # no other client headers reach the backend.
    headers = {}
    tok = await backend_token()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    try:
        r = await _client.get(BACKEND_URL + sub, params=request.query_params,
                              headers=headers)
    except httpx.TimeoutException:
        return JSONResponse({"detail": "The search service took too long."},
                            status_code=504)
    except httpx.HTTPError:
        return JSONResponse({"detail": "Could not reach the search service."},
                            status_code=502)
    out = {k: v for k, v in r.headers.items() if k.lower() in PASS_HEADERS}
    return Response(content=r.content, status_code=r.status_code, headers=out)


# ---------------------------------------------------------------------------
# Everything else: the built site, with index.html for client-side routes.
# ---------------------------------------------------------------------------
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
}


@app.get("/{path:path}")
async def site(path: str):
    target = (DIST / path).resolve()
    # Never serve anything outside dist/ (e.g. /../web.py).
    if target.is_relative_to(DIST) and target.is_file():
        return FileResponse(target, headers=SECURITY_HEADERS)
    if path.startswith("api"):                       # e.g. /api with no route
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    # React Router handles /search, /dataset, ... in the browser.
    return FileResponse(DIST / "index.html", headers=SECURITY_HEADERS)
