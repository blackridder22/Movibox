"""Local, owned-media Stremio/Torznab fixture. No external services or credentials.
Run: python3 scripts/moviebox-bridge-fixture.py /absolute/path/to/generated.mp4
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

MEDIA = Path(sys.argv[1]).read_bytes()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 19421
ROOT = f"http://127.0.0.1:{PORT}"
TRANSFER_DELAY = float(sys.argv[3]) if len(sys.argv) > 3 else 0.06
SEARCH_DELAY = float(sys.argv[4]) if len(sys.argv) > 4 else 0
ID = "movibox-owned-bridge-fixture"
META = {"id": ID, "name": "MoviBox Owned Bridge Fixture", "type": "series", "releaseInfo": "2020", "genres": ["Documentary"], "description": "Locally generated test media; third episode intentionally unavailable.", "videos": [{"id": f"{ID}:1:{n}", "title": f"Owned episode {n}", "season": 1, "episode": n, "released": "2020-01-01T00:00:00Z"} for n in [1, 2, 3]]}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        route = urlparse(self.path)
        path = route.path
        if path == "/api":
            caps = "<caps><limits max='100'/><searching><search available='yes' supportedParams='q'/><tv-search available='yes' supportedParams='q,season,ep'/></searching></caps>"
            body = caps if parse_qs(route.query).get("t") == ["caps"] else "<rss><channel/></rss>"
            return self.send(body.encode(), "application/xml")
        if path.endswith("manifest.json"):
            body = {"id": "movibox-owned-bridge-fixture", "name": "Owned bridge fixture", "types": ["series"], "resources": ["catalog", "meta", "stream", "subtitles"], "catalogs": [{"type": "series", "id": "owned", "extra": [{"name": "search", "isRequired": False}]}]}
        elif path.startswith("/catalog/"):
            body = {"metas": [META]}
        elif path.startswith("/meta/"):
            body = {"meta": META}
        elif path.startswith("/stream/"):
            time.sleep(SEARCH_DELAY)
            episode = int(path.rsplit(":", 1)[-1].removesuffix(".json"))
            body = {"streams": [] if episode == 3 else [{"name": "1080p · English", "title": f"MoviBox.Owned.Bridge.Fixture.S01E{episode:02}.1080p.English.mp4", "url": f"{ROOT}/file/{episode}.mp4", "behaviorHints": {"filename": f"Owned.S01E{episode:02}.mp4", "videoSize": len(MEDIA)}}]}
        elif path.startswith("/subtitles/"):
            body = {"subtitles": [{"id": f"owned-{lang}", "lang": lang, "url": f"{ROOT}/subtitle-redirect/{lang}"} for lang in ["eng", "fre"]]}
        elif path.startswith("/subtitle-redirect/"):
            self.send_response(301); self.send_header("Location", f"/subtitle.srt?language={path.rsplit('/', 1)[-1]}"); self.end_headers(); return
        elif path == "/subtitle.srt":
            return self.send(b"1\n00:00:00,000 --> 00:00:01,000\nOwned subtitle fixture\n", "text/plain")
        elif path.startswith("/file/"):
            start = int(self.headers.get("Range", "bytes=0-").split("=")[-1].split("-")[0])
            if start >= len(MEDIA):
                self.send_response(416); self.send_header("Content-Range", f"bytes */{len(MEDIA)}"); self.end_headers(); return
            self.send_response(206 if start else 200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(MEDIA) - start))
            self.send_header("Accept-Ranges", "bytes")
            if start: self.send_header("Content-Range", f"bytes {start}-{len(MEDIA)-1}/{len(MEDIA)}")
            self.end_headers()
            try:
                for offset in range(start, len(MEDIA), 2048):
                    self.wfile.write(MEDIA[offset:offset+2048]); self.wfile.flush(); time.sleep(TRANSFER_DELAY)
            except (BrokenPipeError, ConnectionResetError): pass
            return
        else:
            self.send_error(404); return
        self.send(json.dumps(body).encode(), "application/json")

    def send(self, body, content_type):
        self.send_response(200); self.send_header("Content-Type", content_type); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

print(f"Owned-media fixture: {ROOT}/manifest.json | Torznab: {ROOT}/api", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
