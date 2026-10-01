#!/usr/bin/env python3
"""Serve frontend/ locally against the live site.

    python scripts/live_preview.py          # http://localhost:8010/

A file that exists in frontend/ is served from disk (so a page or a
stylesheet being worked on is the local one); anything else, the API
above all, is fetched from https://oceanofjobs.com and passed through.
No database, no credentials: the point is seeing a frontend change on
real listings in under a second. dev_server.py is the other way round,
the real handler against a local jobs.db.
"""

import argparse
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
ORIGIN = "https://oceanofjobs.com"
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".js": "application/javascript; charset=utf-8", ".json": "application/json",
         ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg",
         ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml"}
HOP = {"host", "connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "accept-encoding"}


def local_file(path: str) -> Path | None:
    rel = path.lstrip("/") or "index.html"
    for candidate in (rel, rel + ".html"):
        f = (FRONTEND_DIR / candidate).resolve()
        if f.is_file() and FRONTEND_DIR in f.parents:
            return f
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, self.path))

    def _serve(self):
        path = urlsplit(self.path).path
        f = local_file(path) if self.command == "GET" else None
        if f:
            body = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", TYPES.get(f.suffix, "application/octet-stream"))
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        headers["Accept-Encoding"] = "identity"
        req = urllib.request.Request(ORIGIN + self.path, data=data, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                self._relay(r.status, r.headers, r.read())
        except urllib.error.HTTPError as e:
            self._relay(e.code, e.headers, e.read())
        except Exception as e:  # noqa: BLE001
            self.send_error(502, str(e))

    def _relay(self, status, headers, body):
        self.send_response(status)
        for k, v in headers.items():
            if k.lower() not in HOP:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _serve


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8010)
    args = ap.parse_args()
    print(f"frontend/ on http://localhost:{args.port}/ (everything else from {ORIGIN})")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
