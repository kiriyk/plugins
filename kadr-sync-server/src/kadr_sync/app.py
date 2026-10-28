"""HTTP API v1. Every route requires Authorization: Bearer."""
from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from typing import Callable, Iterator, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import conflicts, db, pairing, playbacks, profiles, queries, ratings
from .events import apply_events
from .models import EventsIn, PairPollIn, PlaybackIn, ResolveIn

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
        found = playbacks.playback_for_token(conn, secret, clock())
        if found is not None:
            return Principal(found[0], found[1])
        raise HTTPException(status_code=401, detail="unauthorized")

    def profile_principal(who: Principal = Depends(principal)) -> Principal:
        if who.playback_id is not None:
            raise HTTPException(status_code=403, detail="forbidden")
        return who

    # Pairing works before the device has a key: see pairing.py for why this is safe.
    @app.post("/v1/pair/start")
    def pair_start(conn: sqlite3.Connection = Depends(connection)):
        try:
            with db.write(conn):
                return pairing.start(conn, clock())
        except pairing.TooManyPairings:
            raise HTTPException(status_code=429, detail="too_many_pairings")

    @app.post("/v1/pair/poll")
    def pair_poll(body: PairPollIn, conn: sqlite3.Connection = Depends(connection)):
        with db.write(conn):
            result = pairing.poll(conn, body.poll_token, clock())
        if result is None:
            raise HTTPException(status_code=404, detail="not_found")
        return result

    @app.get("/v1/profile")
    def get_profile(who: Principal = Depends(profile_principal),
                    conn: sqlite3.Connection = Depends(connection)):
        return profiles.profile_json(conn, who.profile_id)

    @app.post("/v1/playbacks")
    def post_playback(body: PlaybackIn, who: Principal = Depends(profile_principal),
                      conn: sqlite3.Connection = Depends(connection)):
        try:
            with db.write(conn):
                return playbacks.register_playback(conn, who.profile_id, body, clock())
        except playbacks.PlaybackTaken:
            raise HTTPException(status_code=409, detail="playback_id_taken")

    @app.get("/v1/playbacks/{playback_id}")
    def get_playback(playback_id: str, who: Principal = Depends(profile_principal),
                     conn: sqlite3.Connection = Depends(connection)):
        found = playbacks.get_playback(conn, who.profile_id, playback_id)
        if found is None:
            raise HTTPException(status_code=404, detail="not_found")
        return found

    @app.post("/v1/events")
    def post_events(body: EventsIn, who: Principal = Depends(principal),
                    conn: sqlite3.Connection = Depends(connection)):
        with db.write(conn):
            return {"results": apply_events(conn, who.profile_id, body.events, who.playback_id, clock())}

    @app.get("/v1/conflicts/{conflict_id}")
    def get_conflict(conflict_id: str, who: Principal = Depends(profile_principal),
                     conn: sqlite3.Connection = Depends(connection)):
        found = conflicts.conflict_json(conn, who.profile_id, conflict_id)
        if found is None:
            raise HTTPException(status_code=404, detail="not_found")
        return found

    @app.post("/v1/conflicts/{conflict_id}/resolve")
    def resolve_conflict(conflict_id: str, body: ResolveIn, who: Principal = Depends(profile_principal),
                         conn: sqlite3.Connection = Depends(connection)):
        try:
            with db.write(conn):
                return conflicts.resolve(conn, who.profile_id, conflict_id, body.version, body.choice, clock())
        except conflicts.ConflictNotFound:
            raise HTTPException(status_code=404, detail="not_found")
        except conflicts.ConflictChanged as changed:
            return JSONResponse({"error": "conflict_changed", "conflict": changed.current}, status_code=409)

    @app.get("/v1/history")
    def get_history(mode: str = Query("all", alias="filter", pattern="^(continue|all)$"),
                    limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                    who: Principal = Depends(profile_principal),
                    conn: sqlite3.Connection = Depends(connection)):
        return queries.history(conn, who.profile_id, mode, limit, offset)

    @app.get("/v1/ratings")
    def get_ratings(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                    who: Principal = Depends(profile_principal),
                    conn: sqlite3.Connection = Depends(connection)):
        return ratings.list_ratings(conn, who.profile_id, limit, offset)

    @app.get("/v1/changes")
    def get_changes(cursor: Optional[str] = Query(None, max_length=24),
                    who: Principal = Depends(profile_principal),
                    conn: sqlite3.Connection = Depends(connection)):
        try:
            return queries.changes_since(conn, who.profile_id, cursor)
        except ValueError:
            raise HTTPException(status_code=400, detail="bad_cursor")

    return app


def from_env() -> FastAPI:
    return create_app(os.environ.get("KADR_DB", "/data/kadr.sqlite3"))
