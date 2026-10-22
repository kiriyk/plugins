"""HTTP API v1. Every route requires Authorization: Bearer."""
from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from typing import Callable, Iterator, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import db, profiles

MAX_BODY_BYTES = 256 * 1024


@dataclass(frozen=True)
class Principal:
    profile_id: int
    playback_id: Optional[str] = None  # set when authenticated by a launch token


def create_app(db_path: str, clock: Callable[[], int] = db.now_ms) -> FastAPI:
    db.init(db_path)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def limit_body(request: Request, call_next):
        if request.method == "POST":
            length = request.headers.get("content-length")
            if length is None:
                return JSONResponse({"error": "length_required"}, status_code=411)
            if not length.isdigit() or int(length) > MAX_BODY_BYTES:
                return JSONResponse({"error": "too_large"}, status_code=413)
        return await call_next(request)

    # Lampa runs in a WebView on another origin. Auth is a bearer header, not cookies,
    # so a wildcard origin exposes nothing without a key. Added last: outermost.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"],
                       allow_headers=["Authorization", "Content-Type"], max_age=600)

    def connection() -> Iterator[sqlite3.Connection]:
        conn = db.connect(db_path)
        try:
            yield conn
        finally:
            conn.close()

    def principal(request: Request, conn: sqlite3.Connection = Depends(connection)) -> Principal:
        header = request.headers.get("authorization", "")
        if not header.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="unauthorized")
        secret = header[len("Bearer "):].strip()
        profile_id = profiles.profile_for_key(conn, secret)
        if profile_id is not None:
            return Principal(profile_id)
        raise HTTPException(status_code=401, detail="unauthorized")

    def profile_principal(who: Principal = Depends(principal)) -> Principal:
        if who.playback_id is not None:
            raise HTTPException(status_code=403, detail="forbidden")
        return who

    @app.get("/v1/profile")
    def get_profile(who: Principal = Depends(profile_principal),
                    conn: sqlite3.Connection = Depends(connection)):
        return profiles.profile_json(conn, who.profile_id)

    return app


def from_env() -> FastAPI:
    return create_app(os.environ.get("KADR_DB", "/data/kadr.sqlite3"))
