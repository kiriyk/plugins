from helpers import auth, item_state, progress, send, start

KEY = "tmdb:tv:1399/s1e2"


def statuses(results):
    return [result["status"] for result in results]


def test_sequential_events_of_one_playback_apply_without_conflict(server):
    client, keys, path = server
    pb, _ = start(client, keys["a"])
    assert statuses(send(client, keys["a"], progress(pb, 1, 60_000), progress(pb, 2, 120_000))) == ["applied", "applied"]
    item = item_state(path, KEY)
    assert item.position_ms == 120_000 and item.revision == 2 and item.status == "in_progress"


def test_duplicate_event_id_and_stale_sequence_do_not_roll_back(server):
    client, keys, path = server
    pb, _ = start(client, keys["a"])
    event = progress(pb, 2, 100_000)
    assert statuses(send(client, keys["a"], event)) == ["applied"]
    assert statuses(send(client, keys["a"], event)) == ["duplicate"]
    assert statuses(send(client, keys["a"], progress(pb, 1, 50_000))) == ["stale"]
    assert item_state(path, KEY).position_ms == 100_000


def test_reversed_batch_and_client_clock_do_not_decide_order(server):
    client, keys, path = server
    pb, _ = start(client, keys["a"])
    future = 4_070_908_800_000  # 2099
    results = send(client, keys["a"], progress(pb, 3, 300_000), progress(pb, 2, 200_000, client_ms=future))
    assert statuses(results) == ["applied", "stale"]
    assert item_state(path, KEY).position_ms == 300_000


def test_playback_that_never_started_keeps_previous_progress(server):
    client, keys, path = server
    pb1, _ = start(client, keys["a"])
    send(client, keys["a"], progress(pb1, 1, 1_540_000))  # 25:40
    pb2, _ = start(client, keys["a"], base_revision=1)
    result = send(client, keys["a"], progress(pb2, 1, 1_530_000, started=False))
    assert result[0]["status"] == "ignored" and result[0]["reason"] == "not_started"
    assert item_state(path, KEY).position_ms == 1_540_000


def test_unknown_duration_is_never_watched_and_threshold_is_95(server):
    client, keys, path = server
    pb, _ = start(client, keys["a"])
    send(client, keys["a"], progress(pb, 1, 3_500_000, duration_ms=None))
    assert item_state(path, KEY).status == "in_progress"
    send(client, keys["a"], progress(pb, 2, 3_419_999))
    assert item_state(path, KEY).status == "in_progress"
    send(client, keys["a"], progress(pb, 3, 3_420_000))
    item = item_state(path, KEY)
    assert item.status == "watched" and item.completed_before is True


def test_rewatch_updates_progress_and_keeps_past_completion(server):
    client, keys, path = server
    pb1, _ = start(client, keys["a"])
    send(client, keys["a"], progress(pb1, 1, 3_500_000))
    revision = item_state(path, KEY).revision
    pb2, _ = start(client, keys["a"], base_revision=revision, mode="start")
    send(client, keys["a"], progress(pb2, 1, 60_000))
    item = item_state(path, KEY)
    assert item.status == "in_progress" and item.position_ms == 60_000 and item.completed_before is True


def test_launch_token_writes_only_its_own_playback(server):
    client, keys, path = server
    pb, data = start(client, keys["a"])
    token = auth(data["launch_token"])
    response = client.post("/v1/events", json={"events": [progress(pb, 1, 60_000)]}, headers=token)
    assert statuses(response.json()["results"]) == ["applied"]
    other, _ = start(client, keys["a"], episode_id="s1e3")
    response = client.post("/v1/events", json={"events": [progress(other, 1, 1_000)]}, headers=token)
    assert statuses(response.json()["results"]) == ["forbidden"]


def test_other_profile_cannot_write_into_a_playback(server):
    client, keys, path = server
    pb, _ = start(client, keys["a"])
    assert statuses(send(client, keys["b"], progress(pb, 1, 60_000))) == ["unknown_playback"]
    assert item_state(path, KEY) is None


def test_independent_playbacks_from_one_stale_revision_conflict(server):
    client, keys, path = server
    tv, _ = start(client, keys["a"], device_id="tv-living-01")
    phone, _ = start(client, keys["a"], device_id="phone-kirill-1")
    assert statuses(send(client, keys["a"], progress(tv, 1, 600_000))) == ["applied"]
    first = send(client, keys["a"], progress(phone, 1, 900_000, device_id="phone-kirill-1"))[0]
    assert first["status"] == "conflict"
    second = send(client, keys["a"], progress(phone, 2, 950_000, device_id="phone-kirill-1"))[0]
    assert second["status"] == "conflict" and second["conflict_id"] == first["conflict_id"]
    assert item_state(path, KEY).position_ms == 600_000


def test_identical_state_from_another_branch_merges_silently(server):
    client, keys, path = server
    tv, _ = start(client, keys["a"], device_id="tv-living-01")
    tablet, _ = start(client, keys["a"], device_id="tablet-00001")
    send(client, keys["a"], progress(tv, 1, 600_000))
    result = send(client, keys["a"], progress(tablet, 1, 603_000, device_id="tablet-00001"))[0]
    assert result["status"] == "merged" and result["revision"] == 1


def test_client_ahead_of_server_after_backup_restore_applies_without_conflict(server):
    client, keys, path = server
    pb1, _ = start(client, keys["a"])
    send(client, keys["a"], progress(pb1, 1, 600_000))  # server revision 1
    pb2, _ = start(client, keys["a"], base_revision=7)  # client cache newer than restored server
    assert statuses(send(client, keys["a"], progress(pb2, 1, 650_000))) == ["applied"]
    other, _ = start(client, keys["a"], episode_id="s1e5", base_revision=3)  # record missing on server
    assert statuses(send(client, keys["a"], progress(other, 1, 10_000))) == ["applied"]
    assert item_state(path, KEY).position_ms == 650_000
