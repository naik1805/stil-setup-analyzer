"""Local web server for the STIL test-setup dashboard."""

from __future__ import annotations

import json
import os
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from stil_setup import analyze_stil, compare_reports
from optimize_setup import explain_many, optimize_many
from ltd_gbc import save_reviews, train_gbc
from sys_stats import HwRecorder, system_util
from cuda_job import cuda_info

ROOT = Path(__file__).resolve().parent
STIL_DIR = Path(os.environ.get("STIL_DIR", str(ROOT.parent)))
STATIC = ROOT / "static"
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8765"))


def list_stil_files() -> list[dict]:
    files = []
    for p in sorted(STIL_DIR.glob("*.stil")):
        files.append(
            {
                "name": p.name,
                "size_bytes": p.stat().st_size,
                "mtime": int(p.stat().st_mtime),
            }
        )
    return files


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        print("[dashboard]", fmt % args)

    def _json(self, code: int, payload) -> None:
        data = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path in ("/health", "/api/health"):
            self._json(200, {"ok": True})
            return
        if parsed.path == "/api/files":
            self._json(200, {"files": list_stil_files(), "folder": str(STIL_DIR)})
            return
        if parsed.path == "/api/hw":
            self._json(200, system_util())
            return
        if parsed.path == "/api/analyze":
            name = (qs.get("name") or [""])[0]
            path = (STIL_DIR / Path(name).name).resolve()
            if not str(path).startswith(str(STIL_DIR.resolve())) or not path.is_file():
                self._json(404, {"error": f"STIL not found: {name}"})
                return
            self._json(200, analyze_stil(path))
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if parsed.path == "/api/analyze-upload":
            qs = urllib.parse.parse_qs(parsed.query)
            name = (qs.get("name") or ["upload.stil"])[0]
            text = body.decode("utf-8", errors="replace")
            self._json(200, analyze_stil(Path(name), raw=text))
            return
        if parsed.path == "/api/compare":
            try:
                req = json.loads(body.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid JSON"})
                return
            with HwRecorder() as rec:
                reports = []
                for name in req.get("names") or []:
                    path = (STIL_DIR / Path(name).name).resolve()
                    if path.is_file():
                        reports.append(analyze_stil(path))
                for item in req.get("uploads") or []:
                    reports.append(
                        analyze_stil(Path(item.get("name") or "upload.stil"), raw=item.get("text") or "")
                    )
                compare = compare_reports(reports)
            self._json(200, {
                "reports": reports,
                "compare": compare,
                "cuda": cuda_info(),
                "hw_peak": rec.snapshot(),
            })
            return
        if parsed.path == "/api/optimize":
            try:
                req = json.loads(body.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid JSON"})
                return
            items = []
            for name in req.get("names") or []:
                path = (STIL_DIR / Path(name).name).resolve()
                if path.is_file():
                    items.append({"path": path})
            for item in req.get("uploads") or []:
                items.append(
                    {
                        "path": Path(item.get("name") or "upload.stil"),
                        "text": item.get("text") or "",
                    }
                )
            with HwRecorder() as rec:
                payload = optimize_many(items)
            payload["hw_peak"] = rec.snapshot()
            self._json(200, payload)
            return
        if parsed.path == "/api/explain-setup":
            try:
                req = json.loads(body.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid JSON"})
                return
            items = []
            for name in req.get("names") or []:
                path = (STIL_DIR / Path(name).name).resolve()
                if path.is_file():
                    items.append({"path": path})
            for item in req.get("uploads") or []:
                items.append(
                    {
                        "path": Path(item.get("name") or "upload.stil"),
                        "text": item.get("text") or "",
                    }
                )
            self._json(200, explain_many(items))
            return
        if parsed.path == "/api/review":
            try:
                req = json.loads(body.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid JSON"})
                return
            items = req.get("items") or []
            with HwRecorder() as rec:
                n = save_reviews(items)
                status = train_gbc()
            self._json(200, {"saved": n, "model": status, "hw_peak": rec.snapshot()})
            return
        self._json(404, {"error": "unknown endpoint"})


def main() -> None:
    STATIC.mkdir(exist_ok=True)
    try:
        import torch

        if torch.cuda.is_available():
            torch.zeros(1, device="cuda")
            print(f"CUDA: {torch.cuda.get_device_name(0)}")
        else:
            print("CUDA: not available")
    except Exception as exc:
        print(f"CUDA init failed: {exc}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"STIL setup dashboard: http://{HOST}:{PORT}")
    print(f"Reading STILs from: {STIL_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
