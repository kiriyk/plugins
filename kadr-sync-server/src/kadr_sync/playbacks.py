"""Playback registration and per-playback launch tokens."""
from __future__ import annotations

import json
import sqlite3
from typing import Optional

from .items import item_key, load_item
from .keys import hash_secret, new_launch_token
from .models import PlaybackIn

TOKEN_TTL_MS = 12 * 3600 * 1000


class PlaybackTaken(Exception):
    """The playback_id already belongs to another profile."""


def register_playback(conn: sqlite3.Connection, profile_id: int, body: PlaybackIn, now_ms: int) -> dict:
    token = new_launch_token()
    expires_ms = now_ms + TOKEN_TTL_MS
    key = item_key(body.content.content_id, body.content.episode_id)
    row = conn.execute("SELECT profile_id FROM playbacks WHERE playback_id=?", (body.playback_id,)).fetchone()
    if row is not None:
        if row["profile_id"] != profile_id:
            raise PlaybackTaken(body.playback_id)
        conn.execute("UPDATE playbacks SET token_hash=?, token_expires_ms=? WHERE playback_id=?",
                     (hash_secret(token), expires_ms, body.playback_id))
        replay = True
    else:
        conn.execute(
            "INSERT INTO playbacks(playback_id, profile_id, item_key, device_id, mode, base_revision, "
            "head_revision, content_json, source_json, token_hash, token_expires_ms, created_ms) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (body.playback_id, profile_id, key, body.device_id, body.mode, body.base_revision,
             body.base_revision, json.dumps(body.content.model_dump(), ensure_ascii=False),
             json.dumps(body.source.model_dump(), ensure_ascii=False),
             hash_secret(token), expires_ms, now_ms),
        )
        replay = False
    item = load_item(conn, profile_id, key)
    return {"playback_id": body.playback_id, "item_key": key, "launch_token": token,
            "expires_ms": expires_ms, "item_revision": item.revision if item else 0, "replay": replay}


def get_playback(conn: sqlite3.Connection, profile_id: int, playback_id: str) -> Optional[dict]:
    row = conn.execute(
        "SELECT playback_id, item_key, mode, last_sequence, next_requested, created_ms "
        "FROM playbacks WHERE playback_id=? AND profile_id=?", (playback_id, profile_id)).fetchone()
    if row is None:
        return None
    return {"playback_id": row["playback_id"], "item_key": row["item_key"], "mode": row["mode"],
            "last_sequence": row["last_sequence"], "next_requested": bool(row["next_requested"]),
            "created_ms": row["created_ms"]}


def playback_for_token(conn: sqlite3.Connection, token: str, now_ms: int) -> Optional[tuple[int, str]]:
    if not token.startswith("kadrl_"):
        return None
    row = conn.execute("SELECT profile_id, playback_id, token_expires_ms FROM playbacks WHERE token_hash=?",
                       (hash_secret(token),)).fetchone()
    if row is None or row["token_expires_ms"] is None or row["token_expires_ms"] < now_ms:
        return None
    return row["profile_id"], row["playback_id"]
