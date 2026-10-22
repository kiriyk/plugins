from helpers import auth, playback, start

from kadr_sync import db, playbacks, profiles


def test_register_returns_a_scoped_launch_token(server):
    client, keys, _ = server
    playback_id, data = start(client, keys["a"])
    assert data["launch_token"].startswith("kadrl_")
    assert data["item_key"] == "tmdb:tv:1399/s1e2"
    assert data["item_revision"] == 0 and data["replay"] is False
    token = auth(data["launch_token"])
    assert client.get("/v1/profile", headers=token).status_code == 403
    assert client.get(f"/v1/playbacks/{playback_id}", headers=token).status_code == 403
    assert client.post("/v1/playbacks", json=playback(), headers=token).status_code == 403


def test_repeated_command_does_not_create_a_new_playback(server, clock):
    client, keys, path = server
    body = playback()
    first = client.post("/v1/playbacks", json=body, headers=auth(keys["a"])).json()
    second = client.post("/v1/playbacks", json=body, headers=auth(keys["a"])).json()
    assert second["replay"] is True
    conn = db.connect(path)
    assert conn.execute("SELECT count(*) FROM playbacks").fetchone()[0] == 1
    assert playbacks.playback_for_token(conn, first["launch_token"], clock()) is None
    assert playbacks.playback_for_token(conn, second["launch_token"], clock()) is not None
    conn.close()


def test_playback_id_of_another_profile_is_refused(server):
    client, keys, _ = server
    body = playback()
    assert client.post("/v1/playbacks", json=body, headers=auth(keys["a"])).status_code == 200
    assert client.post("/v1/playbacks", json=body, headers=auth(keys["b"])).status_code == 409


def test_launch_token_expires(server, clock):
    client, keys, path = server
    _, data = start(client, keys["a"])
    clock.advance(playbacks.TOKEN_TTL_MS + 1)
    conn = db.connect(path)
    assert playbacks.playback_for_token(conn, data["launch_token"], clock()) is None
    conn.close()


def test_revoking_the_profile_key_kills_launch_tokens(server, clock):
    client, keys, path = server
    _, data = start(client, keys["a"])
    conn = db.connect(path)
    with db.write(conn):
        profiles.revoke_key(conn, "A")
    assert playbacks.playback_for_token(conn, data["launch_token"], clock()) is None
    conn.close()


def test_playback_is_hidden_from_another_profile(server):
    client, keys, _ = server
    playback_id, _ = start(client, keys["a"])
    assert client.get(f"/v1/playbacks/{playback_id}", headers=auth(keys["b"])).status_code == 404
    found = client.get(f"/v1/playbacks/{playback_id}", headers=auth(keys["a"])).json()
    assert found["next_requested"] is False and found["item_key"] == "tmdb:tv:1399/s1e2"


def test_identifiers_and_metadata_are_validated(server):
    client, keys, _ = server
    bad_content = playback()
    bad_content["content"]["content_id"] = "https://cdn.example/x.m3u8"
    bad_episode = playback()
    bad_episode["content"]["episode_id"] = "1x2"
    bad_id = playback(playback_id="short")
    long_title = playback()
    long_title["content"]["meta"]["title"] = "я" * 301
    extra = playback()
    extra["profile_id"] = 2
    for body in (bad_content, bad_episode, bad_id, long_title, extra):
        assert client.post("/v1/playbacks", json=body, headers=auth(keys["a"])).status_code == 422


def test_cyrillic_metadata_is_kept(server):
    client, keys, path = server
    body = playback()
    client.post("/v1/playbacks", json=body, headers=auth(keys["a"]))
    conn = db.connect(path)
    stored = conn.execute("SELECT content_json FROM playbacks").fetchone()[0]
    assert "Игра престолов" in stored
    conn.close()
