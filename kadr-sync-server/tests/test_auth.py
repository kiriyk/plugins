import logging

from kadr_sync import db, profiles


def auth(key):
    return {"Authorization": f"Bearer {key}"}


def test_requests_without_a_valid_key_get_no_data(server):
    client, keys, _ = server
    assert client.get("/v1/profile").status_code == 401
    assert client.get("/v1/profile", headers=auth("kadr_wrong")).status_code == 401
    assert client.get("/v1/profile", headers={"Authorization": keys["a"]}).status_code == 401


def test_profile_is_resolved_from_the_key(server):
    client, keys, _ = server
    assert client.get("/v1/profile", headers=auth(keys["a"])).json() == {
        "name": "A", "settings": {"watched_threshold": 95}}
    assert client.get("/v1/profile", headers=auth(keys["b"])).json()["name"] == "B"


def test_revoked_key_is_rejected(server):
    client, keys, path = server
    conn = db.connect(path)
    with db.write(conn):
        profiles.revoke_key(conn, "A")
    conn.close()
    assert client.get("/v1/profile", headers=auth(keys["a"])).status_code == 401


def test_oversized_body_is_rejected_before_routing(server):
    client, keys, _ = server
    response = client.post("/v1/events", content=b"x" * (256 * 1024 + 1),
                           headers={**auth(keys["a"]), "Content-Type": "application/json"})
    assert response.status_code == 413


def test_cors_preflight_needs_no_key_and_returns_no_data(server):
    client, _, _ = server
    response = client.options("/v1/profile", headers={
        "Origin": "http://lampa.mx",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"
    assert "name" not in response.text


def test_keys_are_never_logged(server, caplog):
    client, keys, _ = server
    caplog.set_level(logging.DEBUG)
    client.get("/v1/profile", headers=auth(keys["a"]))
    client.get("/v1/profile", headers=auth("kadr_wrong_secret"))
    assert keys["a"] not in caplog.text
    assert "kadr_wrong_secret" not in caplog.text
