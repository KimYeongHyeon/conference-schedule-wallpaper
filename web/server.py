#!/usr/bin/env python3
"""Local-only launcher and API proxy for Schedule Wallpaper."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("SCHEDULE_WALLPAPER_DATA_DIR", APP_DIR / "data")).expanduser()
CACHE_PATH = DATA_DIR / "conference-deadlines-cache.json"
API_URL = "https://paperswithcode.co/api/v1/conferences/deadlines"
CACHE_TTL_SECONDS = 24 * 60 * 60
CACHE_LOCK = threading.Lock()


def validate_payload(payload: object) -> dict:
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise ValueError("API 응답에 results 배열이 없습니다.")
    results = payload["results"]
    top_tier = [item for item in results if item.get("tier") == "a"]
    deadline_count = sum(len(item.get("deadlines") or []) for item in results)
    if len(results) < 50:
        raise ValueError(f"전체 학회 수가 비정상적으로 적습니다: {len(results)}")
    if len(top_tier) < 20:
        raise ValueError(f"Top tier 학회 수가 비정상적으로 적습니다: {len(top_tier)}")
    if deadline_count < 100:
        raise ValueError(f"마감 데이터 수가 비정상적으로 적습니다: {deadline_count}")
    return payload


def read_cache() -> dict:
    with CACHE_PATH.open("r", encoding="utf-8") as handle:
        return validate_payload(json.load(handle))


def write_cache(payload: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix="deadlines-", suffix=".json", dir=DATA_DIR)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        os.replace(temp_name, CACHE_PATH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def cache_updated_at() -> str:
    return datetime.fromtimestamp(CACHE_PATH.stat().st_mtime, timezone.utc).isoformat()


def cache_is_fresh() -> bool:
    return CACHE_PATH.exists() and time.time() - CACHE_PATH.stat().st_mtime < CACHE_TTL_SECONDS


def fetch_live() -> dict:
    request = urllib.request.Request(
        API_URL,
        headers={
            "Accept": "application/json",
            "User-Agent": "ScheduleWallpaper/1.0 (local personal app)",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status != HTTPStatus.OK:
            raise urllib.error.HTTPError(API_URL, response.status, "Unexpected status", response.headers, None)
        return validate_payload(json.load(response))


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] == "/api/conference-deadlines":
            self.serve_conference_deadlines()
            return
        super().do_GET()

    def serve_conference_deadlines(self) -> None:
        with CACHE_LOCK:
            source = "daily-cache"
            live_error = None
            fresh_cache_ok = False
            if cache_is_fresh():
                try:
                    payload = read_cache()
                    fresh_cache_ok = True
                except Exception:
                    fresh_cache_ok = False
            if not fresh_cache_ok:
                try:
                    payload = fetch_live()
                    write_cache(payload)
                    source = "live"
                except Exception as error:  # The response names this fallback explicitly.
                    live_error = error
                    try:
                        payload = read_cache()
                        source = "stale-cache"
                    except Exception as cache_error:
                        self.send_json(
                            HTTPStatus.BAD_GATEWAY,
                            {
                                "error": "학회 데이터 동기화와 캐시 읽기에 모두 실패했습니다.",
                                "live_error": str(live_error),
                                "cache_error": str(cache_error),
                            },
                        )
                        return
        self.send_json(
            HTTPStatus.OK,
            {
                "source": source,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "cache_updated_at": cache_updated_at(),
                "refresh_interval_seconds": CACHE_TTL_SECONDS,
                "data": payload,
            },
        )

    def send_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")


class LocalServer(ThreadingHTTPServer):
    allow_reuse_address = True


def serve(port: int, launch: bool) -> None:
    server = LocalServer(("127.0.0.1", port), AppHandler)
    actual_port = server.server_address[1]
    url = f"http://127.0.0.1:{actual_port}/"
    print(f"Schedule Wallpaper: {url}", flush=True)
    print("종료하려면 이 창에서 Control-C를 누르세요.", flush=True)
    if launch:
        threading.Timer(0.45, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료했습니다.")
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0, help="0이면 사용 가능한 포트를 자동 선택")
    parser.add_argument("--serve", action="store_true", help="브라우저를 자동으로 열지 않음")
    args = parser.parse_args()
    serve(args.port, launch=not args.serve)


if __name__ == "__main__":
    main()
