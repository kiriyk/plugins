import uuid

from kadr_sync import db
from kadr_sync.items import load_item


def uid(prefix: str = "id") -> str:
    return f"{prefix}{uuid.uuid4().hex[:16]}"


def auth(key: str) -> dict:
    return {"Authorization": f"Bearer {key}"}


def playback(content_id="tmdb:tv:1399", episode_id="s1e2", base_revision=0, mode="resume",
             device_id="tv-living-01", playback_id=None):
    episode = int(episode_id.split("e")[1]) if episode_id else None
    return {
        "playback_id": playback_id or uid("pb"),
        "device_id": device_id,
        "mode": mode,
        "start_position_ms": 0,
        "base_revision": base_revision,
        "content": {
            "content_id": content_id,
            "episode_id": episode_id,
            "season": 1 if episode_id else None,
            "episode": episode,
            "meta": {"title": "Игра престолов", "original_title": "Game of Thrones", "poster": "/p.jpg"},
        },
        "source": {"adapter": "online_mod", "balanser": "rezka", "voice": "LostFilm", "quality": "1080p", "ids": {}},
        "has_next": True,
    }


def progress(playback_id, sequence, position_ms, duration_ms=3_600_000, started=True,
             event_id=None, device_id="tv-living-01", client_ms=1_800_000_000_000):
    return {
        "type": "progress",
        "event_id": event_id or uid("ev"),
        "device_id": device_id,
        "client_ms": client_ms,
        "playback_id": playback_id,
        "sequence": sequence,
        "position_ms": position_ms,
        "duration_ms": duration_ms,
        "started": started,
    }


def start(client, key, **kwargs):
    body = playback(**kwargs)
    response = client.post("/v1/playbacks", json=body, headers=auth(key))
    assert response.status_code == 200, response.text
    return body["playback_id"], response.json()


def send(client, key, *events):
    response = client.post("/v1/events", json={"events": list(events)}, headers=auth(key))
    assert response.status_code == 200, response.text
    return response.json()["results"]


def item_state(path, key, profile="A"):
    conn = db.connect(path)
    try:
        profile_id = conn.execute("SELECT id FROM profiles WHERE name=?", (profile,)).fetchone()["id"]
        return load_item(conn, profile_id, key)
    finally:
        conn.close()
