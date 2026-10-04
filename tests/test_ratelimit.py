"""Tests for the in-memory rate limiter on the agent endpoints. No network."""

from pothole_agent import webapp
from pothole_agent.webapp import create_app


def _client(monkeypatch):
    monkeypatch.setattr(webapp, "plan_trip", lambda *a, **k: {"ok": True})
    return create_app().test_client()


def test_per_ip_limit_trips(monkeypatch):
    monkeypatch.setattr(webapp, "RATE_MAX_PER_IP", 2)
    client = _client(monkeypatch)
    headers = {"CF-Connecting-IP": "203.0.113.9"}
    for _ in range(2):
        assert client.get("/api/trip/stream?start=A&end=B", headers=headers).status_code == 200
    limited = client.get("/api/trip/stream?start=A&end=B", headers=headers)
    assert limited.status_code == 429
    assert "Rate limit" in limited.get_json()["error"]
    # Legacy POST endpoint shares the same limiter.
    posted = client.post("/api/trip", json={"start": "A", "end": "B"}, headers=headers)
    assert posted.status_code == 429


def test_global_hourly_limit_trips_across_ips(monkeypatch):
    monkeypatch.setattr(webapp, "RATE_MAX_PER_HOUR", 1)
    client = _client(monkeypatch)
    first = {"CF-Connecting-IP": "203.0.113.1"}
    second = {"CF-Connecting-IP": "198.51.100.2"}
    assert client.get("/api/trip/stream?start=A&end=B", headers=first).status_code == 200
    limited = client.get("/api/trip/stream?start=A&end=B", headers=second)
    assert limited.status_code == 429
    assert "Rate limit" in limited.get_json()["error"]


def test_localhost_is_exempt(monkeypatch):
    monkeypatch.setattr(webapp, "RATE_MAX_PER_IP", 0)
    monkeypatch.setattr(webapp, "RATE_MAX_PER_HOUR", 0)
    monkeypatch.setattr(webapp, "RATE_MAX_CONCURRENT", 0)
    client = _client(monkeypatch)  # test client's remote_addr is 127.0.0.1
    for _ in range(3):
        assert client.get("/api/trip/stream?start=A&end=B").status_code == 200
    assert client.post("/api/trip", json={"start": "A", "end": "B"}).status_code == 200


def test_spoofed_local_ip(monkeypatch):
    monkeypatch.setattr(webapp, "RATE_MAX_PER_IP", 1)
    client = _client(monkeypatch)
    # Simulate a public IP trying to spoof a local IP
    headers = {"CF-Connecting-IP": "127.0.0.1"}

    # Send requests spoofing CF-Connecting-IP
    assert client.get("/api/trip/stream?start=A&end=B", headers=headers, environ_base={'REMOTE_ADDR': '203.0.113.5'}).status_code == 200
    limited = client.get("/api/trip/stream?start=A&end=B", headers=headers, environ_base={'REMOTE_ADDR': '203.0.113.5'})
    assert limited.status_code == 429
    assert "Rate limit" in limited.get_json()["error"]
