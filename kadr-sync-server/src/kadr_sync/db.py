"""SQLite storage: one file, one writer at a time, WAL for concurrent reads."""
from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from typing import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    key_hash TEXT UNIQUE,
    created_ms INTEGER NOT NULL,
    settings_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items(
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    item_key TEXT NOT NULL,
    content_id TEXT NOT NULL,
    episode_id TEXT,
    season INTEGER,
    episode INTEGER,
    meta_json TEXT NOT NULL,
    position_ms INTEGER NOT NULL,
    duration_ms INTEGER,
    status TEXT NOT NULL,
    manual_ms INTEGER,
    completed_before INTEGER NOT NULL,
    source_json TEXT NOT NULL,
    device_id TEXT,
    playback_id TEXT,
    client_ms INTEGER,
    server_ms INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    deleted INTEGER NOT NULL,
    PRIMARY KEY(profile_id, item_key)
);
CREATE TABLE IF NOT EXISTS playbacks(
    playback_id TEXT PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    item_key TEXT NOT NULL,
    device_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    head_revision INTEGER NOT NULL,
    last_sequence INTEGER NOT NULL DEFAULT 0,
    content_json TEXT NOT NULL,
    source_json TEXT NOT NULL,
    branch_json TEXT,
    token_hash TEXT,
    token_expires_ms INTEGER,
    next_requested INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS playbacks_token ON playbacks(token_hash);
CREATE TABLE IF NOT EXISTS events(
    profile_id INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    received_ms INTEGER NOT NULL,
    PRIMARY KEY(profile_id, event_id)
);
CREATE TABLE IF NOT EXISTS conflicts(
    id TEXT PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    item_key TEXT NOT NULL,
    playback_id TEXT NOT NULL REFERENCES playbacks(playback_id),
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prefs(
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    content_id TEXT NOT NULL,
    prefs_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY(profile_id, content_id)
);
CREATE TABLE IF NOT EXISTS changes(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_profile ON changes(profile_id, seq);
"""


def now_ms() -> int:
    return int(time.time() * 1000)


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init(path: str) -> None:
    conn = connect(path)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
    finally:
        conn.close()


@contextmanager
def write(conn: sqlite3.Connection) -> Iterator[None]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")
