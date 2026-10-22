"""Change log behind the opaque /v1/changes cursor."""
from __future__ import annotations

import sqlite3


def record(conn: sqlite3.Connection, profile_id: int, kind: str, key: str) -> None:
    conn.execute("INSERT INTO changes(profile_id, kind, key) VALUES (?, ?, ?)", (profile_id, kind, key))
