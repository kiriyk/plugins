from helpers import auth, rating, send, start, unrate


def ratings(client, key, query=""):
    response = client.get("/v1/ratings" + query, headers=auth(key))
    assert response.status_code == 200, response.text
    return response.json()


def feed(client, key):
    return client.get("/v1/changes", headers=auth(key)).json()["ratings"]


def test_rating_is_saved_listed_and_in_the_feed(server):
    client, keys, _ = server
    assert send(client, keys["a"], rating("tmdb:movie:7", 8, 1000, "Сильный финал"))[0]["status"] == "applied"
    listed = ratings(client, keys["a"])
    assert listed["total"] == 1
    entry = listed["ratings"][0]
    assert (entry["content_id"], entry["score"], entry["comment"], entry["meta"]["title"], entry["deleted"]) == \
        ("tmdb:movie:7", 8, "Сильный финал", "Фильм", False)
    assert entry["rated_ms"] == 1000
    assert [r["score"] for r in feed(client, keys["a"])] == [8]


def test_later_edit_wins_and_an_older_one_is_stale(server):
    client, keys, _ = server
    send(client, keys["a"], rating("tmdb:movie:7", 8, 2000))
    assert send(client, keys["a"], rating("tmdb:movie:7", 5, 1000))[0]["status"] == "stale"
    assert ratings(client, keys["a"])["ratings"][0]["score"] == 8
    assert send(client, keys["a"], rating("tmdb:movie:7", 6, 2000))[0]["status"] == "applied"
    assert ratings(client, keys["a"])["ratings"][0]["score"] == 6


def test_delete_hides_the_rating_and_beats_an_older_one(server):
    client, keys, _ = server
    send(client, keys["a"], rating("tmdb:movie:7", 8, 2000))
    assert send(client, keys["a"], unrate("tmdb:movie:7", 3000))[0]["status"] == "applied"
    assert ratings(client, keys["a"]) == {"ratings": [], "total": 0}
    assert [r["deleted"] for r in feed(client, keys["a"])] == [True]
    assert send(client, keys["a"], rating("tmdb:movie:7", 9, 2500))[0]["status"] == "stale"
    send(client, keys["a"], unrate("tmdb:tv:60625", 3000))
    assert send(client, keys["a"], rating("tmdb:tv:60625", 7, 1000))[0]["status"] == "stale"
    assert ratings(client, keys["a"])["total"] == 0


def test_rating_validation(server):
    client, keys, _ = server
    bad = [rating("tmdb:movie:7", 0, 1), rating("tmdb:movie:7", 11, 1), rating("tmdb:movie:7", 5, 1, "x" * 2001),
           rating("movie7", 5, 1)]
    for event in bad:
        response = client.post("/v1/events", json={"events": [event]}, headers=auth(keys["a"]))
        assert response.status_code == 422, event
    assert send(client, keys["a"], rating("tmdb:movie:7", 5, 1, "x" * 2000))[0]["status"] == "applied"


def test_launch_token_cannot_rate(server):
    client, keys, _ = server
    _, answer = start(client, keys["a"])
    results = send(client, answer["launch_token"], rating("tmdb:movie:7", 8, 1000))
    assert results[0]["status"] == "forbidden"
    assert ratings(client, keys["a"])["total"] == 0


def test_ratings_are_per_profile(server):
    client, keys, _ = server
    send(client, keys["a"], rating("tmdb:movie:7", 8, 1000))
    assert ratings(client, keys["b"])["total"] == 0
    assert feed(client, keys["b"]) == []


def test_ratings_list_newest_first_and_pages(server):
    client, keys, _ = server
    for number, client_ms in ((1, 1), (3, 3), (2, 2)):
        send(client, keys["a"], rating(f"tmdb:movie:{number}", 5, client_ms))
    assert [r["content_id"] for r in ratings(client, keys["a"])["ratings"]] == \
        ["tmdb:movie:3", "tmdb:movie:2", "tmdb:movie:1"]
    page = ratings(client, keys["a"], "?limit=2&offset=2")
    assert (len(page["ratings"]), page["total"]) == (1, 3)
