import re

import pytest

from kadr_sync import db, pairing, profiles
from kadr_sync.cli import main


def start(client):
    response = client.post("/v1/pair/start", json={})
    assert response.status_code == 200, response.text
    return response.json()


def poll(client, token):
    return client.post("/v1/pair/poll", json={"poll_token": token})


def approve(path, code, name, now, create=False):
    conn = db.connect(path)
    try:
        with db.write(conn):
            return pairing.approve(conn, code, name, now, create=create)
    finally:
        conn.close()


def test_pairing_needs_no_key_and_hands_out_a_working_device_key_once(server, clock):
    client, keys, path = server
    started = start(client)
    assert re.fullmatch(r"[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}", started["code"])
    assert len(started["poll_token"]) >= 30
    assert poll(client, started["poll_token"]).json() == {"status": "pending"}

    assert approve(path, started["code"].lower().replace("-", ""), "A", clock()) == "A"
    answer = poll(client, started["poll_token"]).json()
    assert answer["status"] == "approved" and answer["name"] == "A"
    assert answer["key"].startswith("kadr_") and answer["key"] != keys["a"]
    profile = client.get("/v1/profile", headers={"Authorization": f"Bearer {answer['key']}"})
    assert profile.json()["name"] == "A"
    assert client.get("/v1/profile", headers={"Authorization": f"Bearer {keys['a']}"}).status_code == 200
    assert poll(client, started["poll_token"]).status_code == 404

    conn = db.connect(path)
    stored = " ".join(str(value) for row in conn.execute("SELECT * FROM pairings") for value in row)
    conn.close()
    assert answer["key"] not in stored


def test_expired_and_unknown_codes_are_refused(server, clock):
    client, _, path = server
    started = start(client)
    clock.advance(pairing.TTL_MS + 1)
    with pytest.raises(pairing.PairingError):
        approve(path, started["code"], "A", clock())
    assert poll(client, started["poll_token"]).status_code == 404
    with pytest.raises(pairing.PairingError):
        approve(path, "AAA-AAA", "A", clock())
    assert poll(client, "x" * 40).status_code == 404


def test_unknown_profile_is_refused_unless_created(server, clock):
    client, _, path = server
    started = start(client)
    with pytest.raises(pairing.PairingError):
        approve(path, started["code"], "Новый", clock())
    assert approve(path, started["code"], "Новый", clock(), create=True) == "Новый"
    assert poll(client, started["poll_token"]).json()["name"] == "Новый"


def test_pending_codes_are_capped(server):
    client, _, _ = server
    for _ in range(pairing.MAX_PENDING):
        start(client)
    assert client.post("/v1/pair/start", json={}).status_code == 429


def test_revoking_the_profile_key_revokes_paired_devices(server, clock):
    client, _, path = server
    started = start(client)
    approve(path, started["code"], "A", clock())
    device_key = poll(client, started["poll_token"]).json()["key"]
    conn = db.connect(path)
    with db.write(conn):
        profiles.revoke_key(conn, "A")
    conn.close()
    assert client.get("/v1/profile", headers={"Authorization": f"Bearer {device_key}"}).status_code == 401


def test_cli_pair_command(tmp_path, capsys):
    path = str(tmp_path / "cli.sqlite3")
    assert main(["--db", path, "create-profile", "Дом"]) == 0
    conn = db.connect(path)
    with db.write(conn):
        started = pairing.start(conn, db.now_ms())
    conn.close()
    capsys.readouterr()
    assert main(["--db", path, "pair", started["code"], "Дом"]) == 0
    out = capsys.readouterr().out
    assert "Дом" in out and "kadr_" not in out
    assert main(["--db", path, "pair", "ZZZ-ZZZ", "Дом"]) == 2
