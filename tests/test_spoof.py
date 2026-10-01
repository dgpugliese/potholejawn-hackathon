from pothole_agent import webapp
from pothole_agent.webapp import create_app

def _client(monkeypatch):
    monkeypatch.setattr(webapp, "plan_trip", lambda *a, **k: {"ok": True})
    return create_app().test_client()

def test_ip_spoofing(monkeypatch):
    monkeypatch.setattr(webapp, "RATE_MAX_PER_IP", 1)
    client = _client(monkeypatch)

    # Simulate an external IP
    env = {"REMOTE_ADDR": "203.0.113.1"}

    # First request
    res1 = client.get("/api/trip/stream?start=A&end=B", environ_base=env)
    assert res1.status_code == 200

    # Second request from same IP should be rate limited
    res2 = client.get("/api/trip/stream?start=A&end=B", environ_base=env)
    assert res2.status_code == 429

    # Attacker tries to spoof localhost to bypass limit
    headers = {"CF-Connecting-IP": "127.0.0.1"}
    res3 = client.get("/api/trip/stream?start=A&end=B", headers=headers, environ_base=env)
    assert res3.status_code == 429

    # Attacker tries to spoof another IP to bypass limit
    headers = {"CF-Connecting-IP": "8.8.8.8"}
    res4 = client.get("/api/trip/stream?start=A&end=B", headers=headers, environ_base=env)
    assert res4.status_code == 429

    # Local proxy legitimately sets header
    env_local = {"REMOTE_ADDR": "127.0.0.1"}
    headers = {"CF-Connecting-IP": "1.1.1.1"}
    res5 = client.get("/api/trip/stream?start=A&end=B", headers=headers, environ_base=env_local)
    assert res5.status_code == 200
    res6 = client.get("/api/trip/stream?start=A&end=B", headers=headers, environ_base=env_local)
    assert res6.status_code == 429
