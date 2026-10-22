import pytest
from fastapi.testclient import TestClient

from kadr_sync import db, profiles
from kadr_sync.app import create_app


class Clock:
    def __init__(self) -> None:
        self.now = 1_800_000_000_000

    def __call__(self) -> int:
        return self.now

    def advance(self, ms: int) -> None:
        self.now += ms


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def server(tmp_path, clock):
    path = str(tmp_path / "api.sqlite3")
    app = create_app(path, clock=clock)
    conn = db.connect(path)
    keys = {}
    with db.write(conn):
        keys["a"] = profiles.create_profile(conn, "A", clock())
        keys["b"] = profiles.create_profile(conn, "B", clock())
    conn.close()
    return TestClient(app), keys, path
