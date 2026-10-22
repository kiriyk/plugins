from helpers import auth, item_state, progress, send, start

KEY = "tmdb:tv:1399/s1e2"


def make_conflict(client, key):
    tv, _ = start(client, key, device_id="tv-living-01")
    phone, _ = start(client, key, device_id="phone-kirill-1")
    send(client, key, progress(tv, 1, 600_000))
    conflict_id = send(client, key, progress(phone, 1, 900_000, device_id="phone-kirill-1"))[0]["conflict_id"]
    return tv, phone, conflict_id


def test_conflict_shows_both_positions_devices_and_times(server):
    client, keys, _ = server
    _, _, conflict_id = make_conflict(client, keys["a"])
    data = client.get(f"/v1/conflicts/{conflict_id}", headers=auth(keys["a"])).json()
    assert data["version"] == 1 and data["status"] == "open"
    assert data["options"]["current"]["position_ms"] == 600_000
    assert data["options"]["current"]["device_id"] == "tv-living-01"
    assert data["options"]["playback"]["position_ms"] == 900_000
    assert data["options"]["playback"]["device_id"] == "phone-kirill-1"
    assert data["options"]["playback"]["client_ms"] > 0


def test_resolution_with_a_stale_version_asks_to_refresh(server):
    client, keys, _ = server
    _, phone, conflict_id = make_conflict(client, keys["a"])
    send(client, keys["a"], progress(phone, 2, 950_000, device_id="phone-kirill-1"))
    response = client.post(f"/v1/conflicts/{conflict_id}/resolve", json={"version": 1, "choice": "playback"},
                           headers=auth(keys["a"]))
    assert response.status_code == 409
    assert response.json()["conflict"]["version"] == 2
    assert response.json()["conflict"]["options"]["playback"]["position_ms"] == 950_000


def test_resolution_creates_a_new_revision_and_closes_the_conflict(server):
    client, keys, path = server
    _, phone, conflict_id = make_conflict(client, keys["a"])
    response = client.post(f"/v1/conflicts/{conflict_id}/resolve", json={"version": 1, "choice": "playback"},
                           headers=auth(keys["a"]))
    assert response.status_code == 200 and response.json()["revision"] == 2
    item = item_state(path, KEY)
    assert item.position_ms == 900_000 and item.revision == 2
    assert client.get(f"/v1/conflicts/{conflict_id}", headers=auth(keys["a"])).json()["status"] == "resolved"
    again = client.post(f"/v1/conflicts/{conflict_id}/resolve", json={"version": 1, "choice": "current"},
                        headers=auth(keys["a"]))
    assert again.status_code == 409


def test_chosen_playback_continues_without_a_new_dialog(server):
    client, keys, path = server
    _, phone, conflict_id = make_conflict(client, keys["a"])
    client.post(f"/v1/conflicts/{conflict_id}/resolve", json={"version": 1, "choice": "playback"},
                headers=auth(keys["a"]))
    result = send(client, keys["a"], progress(phone, 3, 1_000_000, device_id="phone-kirill-1"))[0]
    assert result["status"] == "applied"
    assert item_state(path, KEY).position_ms == 1_000_000


def test_another_profile_cannot_see_or_resolve(server):
    client, keys, _ = server
    _, _, conflict_id = make_conflict(client, keys["a"])
    assert client.get(f"/v1/conflicts/{conflict_id}", headers=auth(keys["b"])).status_code == 404
    response = client.post(f"/v1/conflicts/{conflict_id}/resolve", json={"version": 1, "choice": "current"},
                           headers=auth(keys["b"]))
    assert response.status_code == 404
