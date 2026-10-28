"""Own ratings: one per title (movie or whole series), the latest edit by device time wins."""
from __future__ import annotations

import json
import sqlite3
from typing import Optional

from . import changes
from .models import RatingDeleteEvent, RatingEvent


def rating_json(row: sqlite3.Row) -> dict:
    return {"content_id": row["content_id"], "score": row["score"], "comment": row["comment"],
            "meta": json.loads(row["meta_json"]), "rated_ms": row["rated_ms"], "server_ms": row["server_ms"],
            "device_id": row["device_id"], "deleted": bool(row["deleted"])}


def load_rating(conn: sqlite3.Connection, profile_id: int, content_id: str) -> Optional[dict]:
    row = conn.execute("SELECT * FROM ratings WHERE profile_id=? AND content_id=?", (profile_id, content_id)).fetchone()
    return rating_json(row) if row else None


def _write(conn: sqlite3.Connection, profile_id: int, content_id: str, client_ms: int, now_ms: int, device_id: str,
           score: Optional[int], comment: Optional[str], meta_json: Optional[str]) -> dict:
    row = conn.execute("SELECT rated_ms, meta_json FROM ratings WHERE profile_id=? AND content_id=?",
                       (profile_id, content_id)).fetchone()
    # Equal times: the edit that arrived later wins.
    if row is not None and client_ms < row["rated_ms"]:
        return {"status": "stale"}
    # A delete keeps the title so other devices can still name what was removed; a delete with no rating
    # leaves a tombstone, so an older rating that arrives later loses to it.
    meta = meta_json if meta_json is not None else (row["meta_json"] if row else "{}")
    conn.execute("INSERT OR REPLACE INTO ratings(profile_id, content_id, score, comment, meta_json, rated_ms, server_ms,"
                 " device_id, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 (profile_id, content_id, score, comment, meta, client_ms, now_ms, device_id, int(score is None)))
    changes.record(conn, profile_id, "rating", content_id)
    return {"status": "applied"}


def apply_rating(conn: sqlite3.Connection, profile_id: int, event: RatingEvent, now_ms: int, threshold: int) -> dict:
    comment = event.comment.strip() if event.comment else None
    return _write(conn, profile_id, event.content_id, event.client_ms, now_ms, event.device_id, event.score,
                  comment or None, json.dumps(event.meta.model_dump(), ensure_ascii=False))


def apply_rating_delete(conn: sqlite3.Connection, profile_id: int, event: RatingDeleteEvent, now_ms: int,
                        threshold: int) -> dict:
    return _write(conn, profile_id, event.content_id, event.client_ms, now_ms, event.device_id, None, None, None)


def list_ratings(conn: sqlite3.Connection, profile_id: int, limit: int, offset: int) -> dict:
    rows = conn.execute("SELECT * FROM ratings WHERE profile_id=? AND deleted=0 ORDER BY rated_ms DESC, server_ms DESC",
                        (profile_id,)).fetchall()
    return {"ratings": [rating_json(row) for row in rows[offset:offset + limit]], "total": len(rows)}
