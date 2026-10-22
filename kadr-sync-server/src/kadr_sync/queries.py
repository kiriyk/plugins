"""Read models: history list and the change feed behind an opaque cursor."""
from __future__ import annotations

import json
import sqlite3
from typing import Optional

from .conflicts import conflict_json
from .items import Item, item_json, load_item, load_items
from .playbacks import get_playback


def _on_shelf(item: Item) -> bool:
    if item.status == "in_progress":
        return item.position_ms > 0
    return item.episode_id is not None  # finished episode: the plugin offers the next one


def history(conn: sqlite3.Connection, profile_id: int, mode: str, limit: int, offset: int) -> dict:
    items = [item for item in load_items(conn, profile_id) if not item.deleted]
    if mode == "continue":
        latest: dict[str, Item] = {}
        for item in items:
            best = latest.get(item.content_id)
            if best is None or item.server_ms > best.server_ms:
                latest[item.content_id] = item
        items = [item for item in latest.values() if _on_shelf(item)]
    items.sort(key=lambda item: item.server_ms, reverse=True)
    page = []
    for item in items[offset:offset + limit]:
        data = item_json(item)
        if mode == "continue":
            data["up_next"] = item.status == "watched"
        page.append(data)
    return {"items": page, "total": len(items)}


def parse_cursor(cursor: Optional[str]) -> int:
    if not cursor:
        return 0
    if not cursor.startswith("c") or not cursor[1:].isdigit():
        raise ValueError("bad cursor")
    return int(cursor[1:])


def changes_since(conn: sqlite3.Connection, profile_id: int, cursor: Optional[str], limit: int = 500) -> dict:
    after = parse_cursor(cursor)
    rows = conn.execute("SELECT seq, kind, key FROM changes WHERE profile_id=? AND seq>? ORDER BY seq LIMIT ?",
                        (profile_id, after, limit + 1)).fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    last = rows[-1]["seq"] if rows else after
    result: dict = {"cursor": f"c{last}", "more": more, "items": [], "conflicts": [], "prefs": [], "playbacks": []}
    seen = set()
    for row in rows:
        marker = (row["kind"], row["key"])
        if marker in seen:
            continue
        seen.add(marker)
        if row["kind"] == "item":
            item = load_item(conn, profile_id, row["key"])
            if item is not None:
                result["items"].append(item_json(item))
        elif row["kind"] == "conflict":
            found = conflict_json(conn, profile_id, row["key"])
            if found is not None:
                result["conflicts"].append(found)
        elif row["kind"] == "prefs":
            pref = conn.execute("SELECT prefs_json, revision FROM prefs WHERE profile_id=? AND content_id=?",
                                (profile_id, row["key"])).fetchone()
            if pref is not None:
                result["prefs"].append({"content_id": row["key"], "prefs": json.loads(pref["prefs_json"]),
                                        "revision": pref["revision"]})
        elif row["kind"] == "playback":
            found = get_playback(conn, profile_id, row["key"])
            if found is not None:
                result["playbacks"].append(found)
    return result
