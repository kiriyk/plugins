"""Profiles: one API key per profile, stored as a hash."""
from __future__ import annotations

import json
import sqlite3
from typing import Optional

from .keys import hash_secret, new_profile_key

DEFAULT_SETTINGS = {"watched_threshold": 95}


class ProfileError(Exception):
    pass


def _profile_id(conn: sqlite3.Connection, name: str) -> int:
    row = conn.execute("SELECT id FROM profiles WHERE name=?", (name,)).fetchone()
    if row is None:
        raise ProfileError(f"Профиль {name!r} не найден")
    return row["id"]


def create_profile(conn: sqlite3.Connection, name: str, now_ms: int) -> str:
    name = name.strip()
    if not name or len(name) > 64:
        raise ProfileError("Имя профиля: от 1 до 64 символов")
    key = new_profile_key()
    try:
        conn.execute(
            "INSERT INTO profiles(name, key_hash, created_ms, settings_json) VALUES (?, ?, ?, ?)",
            (name, hash_secret(key), now_ms, json.dumps(DEFAULT_SETTINGS)),
        )
    except sqlite3.IntegrityError as error:
        raise ProfileError(f"Профиль {name!r} уже существует") from error
    return key


def rotate_key(conn: sqlite3.Connection, name: str) -> str:
    profile_id = _profile_id(conn, name)
    key = new_profile_key()
    conn.execute("UPDATE profiles SET key_hash=? WHERE id=?", (hash_secret(key), profile_id))
    return key


def revoke_key(conn: sqlite3.Connection, name: str) -> None:
    profile_id = _profile_id(conn, name)
    conn.execute("UPDATE profiles SET key_hash=NULL WHERE id=?", (profile_id,))
    conn.execute("UPDATE playbacks SET token_hash=NULL WHERE profile_id=?", (profile_id,))
    conn.execute("DELETE FROM device_keys WHERE profile_id=?", (profile_id,))


def set_threshold(conn: sqlite3.Connection, name: str, percent: int) -> None:
    if not 50 <= percent <= 100:
        raise ProfileError("Порог просмотренности: от 50 до 100")
    profile_id = _profile_id(conn, name)
    row = conn.execute("SELECT settings_json FROM profiles WHERE id=?", (profile_id,)).fetchone()
    settings = json.loads(row["settings_json"])
    settings["watched_threshold"] = percent
    conn.execute("UPDATE profiles SET settings_json=? WHERE id=?", (json.dumps(settings), profile_id))


def list_profiles(conn: sqlite3.Connection) -> list[tuple[str, bool]]:
    rows = conn.execute("SELECT name, key_hash FROM profiles ORDER BY name").fetchall()
    return [(row["name"], row["key_hash"] is not None) for row in rows]


def profile_for_key(conn: sqlite3.Connection, key: str) -> Optional[int]:
    if not key.startswith("kadr_"):
        return None
    digest = hash_secret(key)
    row = conn.execute("SELECT id FROM profiles WHERE key_hash=?", (digest,)).fetchone()
    if row is None:
        row = conn.execute("SELECT profile_id AS id FROM device_keys WHERE key_hash=?", (digest,)).fetchone()
    return row["id"] if row else None


def profile_json(conn: sqlite3.Connection, profile_id: int) -> dict:
    row = conn.execute("SELECT name, settings_json FROM profiles WHERE id=?", (profile_id,)).fetchone()
    return {"name": row["name"], "settings": json.loads(row["settings_json"])}


def watched_threshold(conn: sqlite3.Connection, profile_id: int) -> int:
    return int(profile_json(conn, profile_id)["settings"].get("watched_threshold", 95))
