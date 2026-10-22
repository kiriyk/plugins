from helpers import auth, progress, send, start, uid


def get(client, key, url):
    response = client.get(url, headers=auth(key))
    assert response.status_code == 200, response.text
    return response.json()


def test_continue_shelf_shows_one_series_poster_with_the_latest_episode(server, clock):
    client, keys, _ = server
    a = keys["a"]
    ep2, _ = start(client, a, episode_id="s1e2")
    send(client, a, progress(ep2, 1, 600_000))
    clock.advance(1000)
    ep3, _ = start(client, a, episode_id="s1e3")
    send(client, a, progress(ep3, 1, 300_000))
    movie, _ = start(client, a, content_id="tmdb:movie:550", episode_id=None)
    send(client, a, progress(movie, 1, 3_500_000))  # watched
    shelf = get(client, a, "/v1/history?filter=continue")
    assert [item["item_key"] for item in shelf["items"]] == ["tmdb:tv:1399/s1e3"]
    everything = get(client, a, "/v1/history?filter=all")
    assert {item["item_key"] for item in everything["items"]} == {
        "tmdb:tv:1399/s1e2", "tmdb:tv:1399/s1e3", "tmdb:movie:550"}


def test_finished_episode_stays_on_the_shelf_as_up_next(server):
    client, keys, _ = server
    pb, _ = start(client, keys["a"], episode_id="s1e2")
    send(client, keys["a"], progress(pb, 1, 3_500_000))
    shelf = get(client, keys["a"], "/v1/history?filter=continue")
    assert shelf["items"][0]["item_key"] == "tmdb:tv:1399/s1e2"
    assert shelf["items"][0]["up_next"] is True


def test_changes_cursor_is_incremental_and_carries_deletions(server):
    client, keys, _ = server
    a = keys["a"]
    first = get(client, a, "/v1/changes")
    assert first["items"] == [] and first["cursor"] == "c0"
    pb, _ = start(client, a)
    send(client, a, progress(pb, 1, 60_000), progress(pb, 2, 90_000))
    second = get(client, a, f"/v1/changes?cursor={first['cursor']}")
    assert len(second["items"]) == 1 and second["items"][0]["position_ms"] == 90_000
    send(client, a, {"type": "delete", "event_id": uid("ev"), "device_id": "tv-living-01", "client_ms": 1,
                     "item_key": "tmdb:tv:1399/s1e2"})
    third = get(client, a, f"/v1/changes?cursor={second['cursor']}")
    assert third["items"][0]["deleted"] is True
    fourth = get(client, a, f"/v1/changes?cursor={third['cursor']}")
    assert fourth["items"] == [] and fourth["cursor"] == third["cursor"]
    assert client.get("/v1/changes?cursor=zzz", headers=auth(a)).status_code == 400


def test_changes_include_conflicts_and_next_requests(server):
    client, keys, _ = server
    a = keys["a"]
    tv, _ = start(client, a, device_id="tv-living-01")
    phone, _ = start(client, a, device_id="phone-kirill-1")
    send(client, a, progress(tv, 1, 600_000))
    send(client, a, progress(phone, 1, 900_000, device_id="phone-kirill-1"))
    send(client, a, {"type": "next_requested", "event_id": uid("ev"), "device_id": "tv-living-01",
                     "client_ms": 1, "playback_id": tv})
    changes = get(client, a, "/v1/changes")
    assert changes["conflicts"][0]["options"]["playback"]["position_ms"] == 900_000
    assert changes["playbacks"][0]["next_requested"] is True


def test_profiles_are_isolated(server):
    client, keys, _ = server
    pb, _ = start(client, keys["a"])
    send(client, keys["a"], progress(pb, 1, 60_000))
    assert get(client, keys["b"], "/v1/history?filter=all")["items"] == []
    assert get(client, keys["b"], "/v1/changes")["items"] == []
    assert client.get("/v1/history").status_code == 401
