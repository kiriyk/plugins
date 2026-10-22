"""Watch record of one movie or one episode."""
from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict, dataclass
from typing import Optional

COLUMNS = ("item_key, content_id, episode_id, season, episode, meta_json, position_ms, duration_ms, "
           "status, manual_ms, completed_before, source_json, device_id, playback_id, client_ms, "
           "server_ms, revision, deleted")


@dataclass
class Item:
    item_key: str
    content_id: str
    episode_id: Optional[str]
    season: Optional[int]
    episode: Optional[int]
    meta: dict
    position_ms: int
    duration_ms: Optional[int]
    status: str                # in_progress | watched
    manual_ms: Optional[int]   # server time of the last explicit status command
    completed_before: bool
    source: dict
    device_id: Optional[str]
    playback_id: Optional[str]
    client_ms: Optional[int]
    server_ms: int
    revision: int
    deleted: bool = False


def item_key(content_id: str, episode_id: Optional[str]) -> str:
    return f"{content_id}/{episode_id}" if episode_id else content_id


def _from_row(row: sqlite3.Row) -> Item:
    return Item(
        item_key=row["item_key"], content_id=row["content_id"], episode_id=row["episode_id"],
        season=row["season"], episode=row["episode"], meta=json.loads(row["meta_json"]),
        position_ms=row["position_ms"], duration_ms=row["duration_ms"], status=row["status"],
        manual_ms=row["manual_ms"], completed_before=bool(row["completed_before"]),
        source=json.loads(row["source_json"]), device_id=row["device_id"],
        playback_id=row["playback_id"], client_ms=row["client_ms"], server_ms=row["server_ms"],
        revision=row["revision"], deleted=bool(row["deleted"]),
    )


def load_item(conn: sqlite3.Connection, profile_id: int, key: str) -> Optional[Item]:
    row = conn.execute(f"SELECT {COLUMNS} FROM items WHERE profile_id=? AND item_key=?",
                       (profile_id, key)).fetchone()
    return _from_row(row) if row else None


def load_items(conn: sqlite3.Connection, profile_id: int) -> list[Item]:
    rows = conn.execute(f"SELECT {COLUMNS} FROM items WHERE profile_id=?", (profile_id,)).fetchall()
    return [_from_row(row) for row in rows]


def save_item(conn: sqlite3.Connection, profile_id: int, item: Item) -> None:
    placeholders = ", ".join("?" * 19)
    conn.execute(
        f"INSERT OR REPLACE INTO items(profile_id, {COLUMNS}) VALUES ({placeholders})",
        (profile_id, item.item_key, item.content_id, item.episode_id, item.season, item.episode,
         json.dumps(item.meta, ensure_ascii=False), item.position_ms, item.duration_ms, item.status,
         item.manual_ms, int(item.completed_before), json.dumps(item.source, ensure_ascii=False),
         item.device_id, item.playback_id, item.client_ms, item.server_ms, item.revision, int(item.deleted)),
    )


def item_json(item: Item) -> dict:
    data = asdict(item)
    data["manual"] = item.manual_ms is not None
    return data


def item_from_json(data: dict) -> Item:
    return Item(**{key: value for key, value in data.items() if key not in ("manual", "up_next")})
