"""Open conflicts between independent playbacks and their resolution by the user."""
from __future__ import annotations

import json
import sqlite3
from typing import Optional

from . import changes
from .items import item_from_json, item_json, load_item, save_item


class ConflictNotFound(Exception):
    pass


class ConflictChanged(Exception):
    def __init__(self, current: dict) -> None:
        super().__init__("conflict_changed")
        self.current = current


def conflict_json(conn: sqlite3.Connection, profile_id: int, conflict_id: str) -> Optional[dict]:
    row = conn.execute(
        "SELECT c.id, c.item_key, c.version, c.status, c.created_ms, p.branch_json "
        "FROM conflicts c JOIN playbacks p ON p.playback_id = c.playback_id "
        "WHERE c.id=? AND c.profile_id=?", (conflict_id, profile_id)).fetchone()
    if row is None:
        return None
    current = load_item(conn, profile_id, row["item_key"])
    return {
        "id": row["id"], "item_key": row["item_key"], "version": row["version"],
        "status": row["status"], "created_ms": row["created_ms"],
        "options": {
            "current": item_json(current) if current else None,
            "playback": json.loads(row["branch_json"]) if row["branch_json"] else None,
        },
    }


def resolve(conn: sqlite3.Connection, profile_id: int, conflict_id: str, version: int, choice: str,
            now_ms: int) -> dict:
    data = conflict_json(conn, profile_id, conflict_id)
    if data is None:
        raise ConflictNotFound(conflict_id)
    chosen = data["options"][choice]
    if data["status"] != "open" or data["version"] != version or chosen is None:
        raise ConflictChanged(data)
    current = load_item(conn, profile_id, data["item_key"])
    old_revision = current.revision if current else 0
    item = item_from_json(chosen)
    item.revision = old_revision + 1
    item.server_ms = now_ms
    item.deleted = False
    save_item(conn, profile_id, item)
    conn.execute("UPDATE conflicts SET status='resolved' WHERE id=?", (conflict_id,))
    # Both branches continue from the chosen state without another dialog.
    conn.execute(
        "UPDATE playbacks SET head_revision=?, branch_json=NULL WHERE profile_id=? AND item_key=? "
        "AND (head_revision=? OR playback_id=(SELECT playback_id FROM conflicts WHERE id=?))",
        (item.revision, profile_id, item.item_key, old_revision, conflict_id))
    changes.record(conn, profile_id, "item", item.item_key)
    changes.record(conn, profile_id, "conflict", conflict_id)
    return {"revision": item.revision, "item": item_json(item)}
