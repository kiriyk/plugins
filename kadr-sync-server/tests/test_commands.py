from helpers import auth, item_state, progress, send, start, uid

from kadr_sync import db

KEY = "tmdb:tv:1399/s1e2"


def command(kind, **fields):
    return {"type": kind, "event_id": uid("ev"), "device_id": "phone-kirill-1", "client_ms": 1, **fields}


def test_manual_mark_wins_over_an_older_playback_until_rewatch(server, clock):
    client, keys, path = server
    pb1, _ = start(client, keys["a"])
    send(client, keys["a"], progress(pb1, 1, 600_000))
    clock.advance(1000)  # the mark is made after this playback started
    assert send(client, keys["a"], command("status", item_key=KEY, status="watched"))[0]["status"] == "applied"
    result = send(client, keys["a"], progress(pb1, 2, 700_000))[0]
    assert result["status"] == "applied"
    item = item_state(path, KEY)
    assert item.status == "watched" and item.manual_ms is not None and item.position_ms == 700_000
    clock.advance(1000)
    pb2, _ = start(client, keys["a"], base_revision=item.revision)
    send(client, keys["a"], progress(pb2, 1, 60_000))
    item = item_state(path, KEY)
    assert item.status == "in_progress" and item.manual_ms is None and item.completed_before is True


def test_manual_unwatched_is_synced_as_a_new_revision(server):
    client, keys, path = server
    pb, _ = start(client, keys["a"])
    send(client, keys["a"], progress(pb, 1, 3_500_000))
    before = item_state(path, KEY).revision
    send(client, keys["a"], command("status", item_key=KEY, status="unwatched"))
    item = item_state(path, KEY)
    assert item.status == "in_progress" and item.revision == before + 1 and item.completed_before is True


def test_status_for_an_unknown_item(server):
    client, keys, _ = server
    result = send(client, keys["a"], command("status", item_key="tmdb:movie:550", status="watched"))[0]
    assert result["status"] == "unknown_item"


def test_deleted_record_is_not_restored_by_an_older_playback(server, clock):
    client, keys, path = server
    pb1, _ = start(client, keys["a"])
    send(client, keys["a"], progress(pb1, 1, 600_000))
    send(client, keys["a"], command("delete", item_key=KEY))
    assert item_state(path, KEY).deleted is True
    result = send(client, keys["a"], progress(pb1, 2, 700_000))[0]
    assert result["status"] == "ignored" and result["reason"] == "deleted"
    clock.advance(1)
    pb2, _ = start(client, keys["a"], base_revision=item_state(path, KEY).revision)
    assert send(client, keys["a"], progress(pb2, 1, 30_000))[0]["status"] == "applied"
    assert item_state(path, KEY).deleted is False


def test_source_preferences_are_kept_per_content(server):
    client, keys, path = server
    prefs = {"adapter": "showy", "balanser": "rezka", "voice": "Кубик в Кубе", "quality": "1080p", "ids": {}}
    send(client, keys["a"], command("prefs", content_id="tmdb:tv:1399", prefs=prefs))
    result = send(client, keys["a"], command("prefs", content_id="tmdb:tv:1399", prefs={**prefs, "quality": "720p"}))
    assert result[0]["revision"] == 2
    conn = db.connect(path)
    row = conn.execute("SELECT prefs_json FROM prefs WHERE content_id='tmdb:tv:1399'").fetchone()
    assert "Кубик в Кубе" in row[0] and "720p" in row[0]
    conn.close()


def test_next_episode_request_through_the_launch_token(server):
    client, keys, _ = server
    pb, data = start(client, keys["a"])
    token = auth(data["launch_token"])
    response = client.post("/v1/events", json={"events": [
        {"type": "next_requested", "event_id": uid("ev"), "device_id": "tv-living-01", "client_ms": 1, "playback_id": pb}]},
        headers=token)
    assert response.json()["results"][0]["status"] == "applied"
    assert client.get(f"/v1/playbacks/{pb}", headers=auth(keys["a"])).json()["next_requested"] is True
    denied = client.post("/v1/events", json={"events": [command("status", item_key=KEY, status="watched")]},
                         headers=token)
    assert denied.json()["results"][0]["status"] == "forbidden"
