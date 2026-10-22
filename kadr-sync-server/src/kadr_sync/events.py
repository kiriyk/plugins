"""Event application. Every event is idempotent by event_id; order within a playback is its sequence."""
from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Callable, Optional

from . import changes, profiles
from .items import Item, item_json, load_item, save_item
from .models import ProgressEvent

SAME_POSITION_MS = 5000
TOKEN_TYPES = {"progress", "next_requested"}


def auto_status(position_ms: int, duration_ms: Optional[int], threshold: int) -> str:
    if not duration_ms or duration_ms <= 0:
        return "in_progress"
    return "watched" if position_ms * 100 >= duration_ms * threshold else "in_progress"


def playback_row(conn: sqlite3.Connection, profile_id: int, playback_id: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM playbacks WHERE playback_id=? AND profile_id=?",
                        (playback_id, profile_id)).fetchone()


def advance_heads(conn: sqlite3.Connection, profile_id: int, key: str, old: int, new: int) -> None:
    """Playbacks that were on the latest revision stay on it after a non-progress change."""
    conn.execute("UPDATE playbacks SET head_revision=? WHERE profile_id=? AND item_key=? AND head_revision=?",
                 (new, profile_id, key, old))


def _proposed(current: Optional[Item], pb: sqlite3.Row, event: ProgressEvent, now_ms: int, threshold: int) -> Item:
    content = json.loads(pb["content_json"])
    manual_active = current is not None and current.manual_ms is not None and pb["created_ms"] < current.manual_ms
    status = current.status if manual_active else auto_status(event.position_ms, event.duration_ms, threshold)
    return Item(
        item_key=pb["item_key"], content_id=content["content_id"], episode_id=content.get("episode_id"),
        season=content.get("season"), episode=content.get("episode"), meta=content.get("meta") or {},
        position_ms=event.position_ms, duration_ms=event.duration_ms, status=status,
        manual_ms=current.manual_ms if manual_active else None,
        completed_before=bool(current and current.completed_before) or status == "watched",
        source=json.loads(pb["source_json"]), device_id=pb["device_id"], playback_id=pb["playback_id"],
        client_ms=event.client_ms, server_ms=now_ms, revision=0, deleted=False,
    )


def _same_state(current: Item, proposed: Item) -> bool:
    return abs(current.position_ms - proposed.position_ms) <= SAME_POSITION_MS and current.status == proposed.status


def _touch_open_conflicts(conn: sqlite3.Connection, profile_id: int, key: str, exclude_playback: str) -> None:
    rows = conn.execute("SELECT id FROM conflicts WHERE profile_id=? AND item_key=? AND status='open' "
                        "AND playback_id != ?", (profile_id, key, exclude_playback)).fetchall()
    for row in rows:
        conn.execute("UPDATE conflicts SET version=version+1 WHERE id=?", (row["id"],))
        changes.record(conn, profile_id, "conflict", row["id"])


def _write(conn: sqlite3.Connection, profile_id: int, pb: sqlite3.Row, current: Optional[Item], proposed: Item) -> dict:
    proposed.revision = (current.revision if current else 0) + 1
    save_item(conn, profile_id, proposed)
    conn.execute("UPDATE playbacks SET head_revision=?, branch_json=NULL WHERE playback_id=?",
                 (proposed.revision, pb["playback_id"]))
    changes.record(conn, profile_id, "item", proposed.item_key)
    _touch_open_conflicts(conn, profile_id, proposed.item_key, pb["playback_id"])
    return {"status": "applied", "revision": proposed.revision}


def _branch(conn: sqlite3.Connection, profile_id: int, pb: sqlite3.Row, proposed: Item, now_ms: int) -> str:
    conn.execute("UPDATE playbacks SET branch_json=? WHERE playback_id=?",
                 (json.dumps(item_json(proposed), ensure_ascii=False), pb["playback_id"]))
    row = conn.execute("SELECT id FROM conflicts WHERE profile_id=? AND playback_id=? AND status='open'",
                       (profile_id, pb["playback_id"])).fetchone()
    if row is not None:
        conflict_id = row["id"]
        conn.execute("UPDATE conflicts SET version=version+1 WHERE id=?", (conflict_id,))
    else:
        conflict_id = uuid.uuid4().hex
        conn.execute("INSERT INTO conflicts(id, profile_id, item_key, playback_id, version, status, created_ms) "
                     "VALUES (?, ?, ?, ?, 1, 'open', ?)", (conflict_id, profile_id, pb["item_key"], pb["playback_id"], now_ms))
    changes.record(conn, profile_id, "conflict", conflict_id)
    return conflict_id


def apply_progress(conn: sqlite3.Connection, profile_id: int, event: ProgressEvent, now_ms: int, threshold: int) -> dict:
    pb = playback_row(conn, profile_id, event.playback_id)
    if pb is None:
        return {"status": "unknown_playback"}
    if event.sequence is None:
        # Fallback report from Lampa: only when KADR never reported this playback.
        if pb["last_sequence"] > 0:
            return {"status": "stale"}
    elif event.sequence <= pb["last_sequence"]:
        return {"status": "stale"}
    else:
        conn.execute("UPDATE playbacks SET last_sequence=? WHERE playback_id=?", (event.sequence, pb["playback_id"]))
    if not event.started:
        return {"status": "ignored", "reason": "not_started"}
    current = load_item(conn, profile_id, pb["item_key"])
    if current is not None and current.deleted and pb["created_ms"] <= current.server_ms:
        return {"status": "ignored", "reason": "deleted"}
    proposed = _proposed(current, pb, event, now_ms, threshold)
    current_revision = current.revision if current else 0
    if current_revision == pb["head_revision"] or (current is not None and current.deleted):
        return _write(conn, profile_id, pb, current, proposed)
    if current is not None and _same_state(current, proposed):
        conn.execute("UPDATE playbacks SET head_revision=? WHERE playback_id=?", (current.revision, pb["playback_id"]))
        return {"status": "merged", "revision": current.revision}
    return {"status": "conflict", "conflict_id": _branch(conn, profile_id, pb, proposed, now_ms)}


HANDLERS: dict[str, Callable] = {"progress": apply_progress}


def apply_events(conn: sqlite3.Connection, profile_id: int, events: list, token_playback_id: Optional[str],
                 now_ms: int) -> list[dict]:
    threshold = profiles.watched_threshold(conn, profile_id)
    results = []
    for event in events:
        if token_playback_id is not None and (
                event.type not in TOKEN_TYPES or getattr(event, "playback_id", None) != token_playback_id):
            results.append({"event_id": event.event_id, "status": "forbidden"})
            continue
        seen = conn.execute("SELECT 1 FROM events WHERE profile_id=? AND event_id=?",
                            (profile_id, event.event_id)).fetchone()
        if seen:
            results.append({"event_id": event.event_id, "status": "duplicate"})
            continue
        handler = HANDLERS.get(event.type)
        outcome = handler(conn, profile_id, event, now_ms, threshold) if handler else {"status": "unsupported"}
        conn.execute("INSERT INTO events(profile_id, event_id, received_ms) VALUES (?, ?, ?)",
                     (profile_id, event.event_id, now_ms))
        results.append({"event_id": event.event_id, **outcome})
    return results
