"""Device pairing: the TV shows a short code, the operator approves it with the local CLI.

The two pairing routes work without a key; a code is useless until approved on the server
machine, and the key goes only to the holder of the poll token issued with that code.
"""
from __future__ import annotations

import re
import secrets
import sqlite3
from typing import Optional

from . import profiles
from .keys import hash_secret, new_profile_key

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
TTL_MS = 10 * 60 * 1000
MAX_PENDING = 20


class PairingError(Exception):
    pass


class TooManyPairings(Exception):
    pass


def _purge(conn: sqlite3.Connection, now_ms: int) -> None:
    conn.execute("DELETE FROM pairings WHERE expires_ms < ?", (now_ms,))


def normalize(code: str) -> str:
    text = re.sub(r"[^A-Za-z0-9]", "", code or "").upper()
    return f"{text[:3]}-{text[3:]}" if len(text) == 6 else text


def start(conn: sqlite3.Connection, now_ms: int) -> dict:
    _purge(conn, now_ms)
    if conn.execute("SELECT count(*) FROM pairings").fetchone()[0] >= MAX_PENDING:
        raise TooManyPairings()
    while True:
        raw = "".join(secrets.choice(ALPHABET) for _ in range(6))
        code = f"{raw[:3]}-{raw[3:]}"
        if conn.execute("SELECT 1 FROM pairings WHERE code=?", (code,)).fetchone() is None:
            break
    token = secrets.token_urlsafe(32)
    expires_ms = now_ms + TTL_MS
    conn.execute("INSERT INTO pairings(code, poll_hash, expires_ms) VALUES (?, ?, ?)",
                 (code, hash_secret(token), expires_ms))
    return {"code": code, "poll_token": token, "expires_ms": expires_ms}


def poll(conn: sqlite3.Connection, token: str, now_ms: int) -> Optional[dict]:
    _purge(conn, now_ms)
    row = conn.execute("SELECT code, profile_name, delivery FROM pairings WHERE poll_hash=?",
                       (hash_secret(token),)).fetchone()
    if row is None:
        return None
    if row["delivery"] is None:
        return {"status": "pending"}
    conn.execute("DELETE FROM pairings WHERE code=?", (row["code"],))
    return {"status": "approved", "name": row["profile_name"], "key": row["delivery"]}


def approve(conn: sqlite3.Connection, code: str, name: str, now_ms: int, create: bool = False) -> str:
    _purge(conn, now_ms)
    code = normalize(code)
    row = conn.execute("SELECT delivery FROM pairings WHERE code=?", (code,)).fetchone()
    if row is None or row["delivery"] is not None:
        raise PairingError(f"Код {code} не найден или истёк. Нажмите «Привязать по коду» на телевизоре ещё раз.")
    profile = conn.execute("SELECT id FROM profiles WHERE name=?", (name.strip(),)).fetchone()
    if profile is None:
        if not create:
            raise PairingError(f"Профиль {name!r} не найден. Добавьте --create, чтобы создать его.")
        profiles.create_profile(conn, name, now_ms)
        profile = conn.execute("SELECT id FROM profiles WHERE name=?", (name.strip(),)).fetchone()
    key = new_profile_key()
    conn.execute("INSERT INTO device_keys(profile_id, key_hash, created_ms) VALUES (?, ?, ?)",
                 (profile["id"], hash_secret(key), now_ms))
    conn.execute("UPDATE pairings SET profile_name=?, delivery=? WHERE code=?", (name.strip(), key, code))
    return name.strip()
