import sqlite3

import pytest

from kadr_sync import db, profiles
from kadr_sync.cli import main


@pytest.fixture
def conn(tmp_path):
    path = str(tmp_path / "profiles.sqlite3")
    db.init(path)
    connection = db.connect(path)
    yield connection
    connection.close()


def test_key_is_returned_once_and_stored_hashed(conn):
    key = profiles.create_profile(conn, "Кирилл", 1)
    assert key.startswith("kadr_") and len(key) > 40
    stored = conn.execute("SELECT key_hash FROM profiles").fetchone()["key_hash"]
    assert key not in stored and len(stored) == 64
    assert profiles.profile_for_key(conn, key) is not None


def test_duplicate_name_rejected(conn):
    profiles.create_profile(conn, "A", 1)
    with pytest.raises(profiles.ProfileError):
        profiles.create_profile(conn, "A", 2)


def test_rotate_keeps_profile_and_invalidates_old_key(conn):
    old = profiles.create_profile(conn, "A", 1)
    profile_id = profiles.profile_for_key(conn, old)
    new = profiles.rotate_key(conn, "A")
    assert profiles.profile_for_key(conn, old) is None
    assert profiles.profile_for_key(conn, new) == profile_id


def test_revoke_blocks_key(conn):
    key = profiles.create_profile(conn, "A", 1)
    profiles.revoke_key(conn, "A")
    assert profiles.profile_for_key(conn, key) is None
    assert profiles.list_profiles(conn) == [("A", False)]


def test_launch_token_is_not_a_profile_key(conn):
    profiles.create_profile(conn, "A", 1)
    assert profiles.profile_for_key(conn, "kadrl_anything") is None


def test_threshold_default_and_bounds(conn):
    key = profiles.create_profile(conn, "A", 1)
    profile_id = profiles.profile_for_key(conn, key)
    assert profiles.watched_threshold(conn, profile_id) == 95
    profiles.set_threshold(conn, "A", 90)
    assert profiles.watched_threshold(conn, profile_id) == 90
    with pytest.raises(profiles.ProfileError):
        profiles.set_threshold(conn, "A", 10)


def test_cli_create_check_and_duplicate(tmp_path, capsys):
    path = str(tmp_path / "cli.sqlite3")
    assert main(["--db", path, "check"]) == 1
    assert main(["--db", path, "create-profile", "Дом"]) == 0
    key = capsys.readouterr().out.strip().splitlines()[-1]
    assert key.startswith("kadr_")
    assert main(["--db", path, "check"]) == 0
    assert main(["--db", path, "create-profile", "Дом"]) == 2


def test_cli_backup_is_a_readable_copy(tmp_path):
    path = str(tmp_path / "cli.sqlite3")
    assert main(["--db", path, "create-profile", "Дом"]) == 0
    target = tmp_path / "backup.sqlite3"
    assert main(["--db", path, "backup", str(target)]) == 0
    copy = sqlite3.connect(target)
    assert copy.execute("SELECT name FROM profiles").fetchone()[0] == "Дом"
    copy.close()
