"""Trip planner tests. All network calls are replaced with fakes."""

import pytest

from pothole_agent import routing, trip
from pothole_agent.routing import (
    Route,
    RoutingError,
    build_pothole_sql,
    in_philadelphia,
)
from pothole_agent.webapp import create_app

CITY_HALL = {"lat": 39.9526, "lon": -75.1652, "matched_address": "CITY HALL", "source": "fake"}
STADIUM = {"lat": 39.9061, "lon": -75.1665, "matched_address": "STADIUM", "source": "fake"}
LINE = [[-75.1652, 39.9526], [-75.1660, 39.9300], [-75.1665, 39.9061]]


def _pothole(n, days):
    return {
        "id": n,
        "address": f"{n} BROAD ST",
        "lat": 39.93,
        "lon": -75.166,
        "reported": "2026-01-01",
        "days_open": days,
        "meters_from_route": 5.0,
        "mile_marker": 1.0,
    }


@pytest.fixture
def fake_services(monkeypatch):
    places = {"start": CITY_HALL, "end": STADIUM}
    monkeypatch.setattr(
        trip, "geocode", lambda address: places["start" if "hall" in address.lower() else "end"]
    )
    monkeypatch.setattr(
        trip,
        "fetch_routes",
        lambda *_: [Route("A", 3.4, 12, LINE), Route("B", 3.9, 13, LINE)],
    )
    # The smooth router is faked as a slightly slower route with two reports, so
    # the deterministic pick still lands on B here; test_smooth_route_wins covers
    # the case where S is the better drive.
    monkeypatch.setattr(
        trip,
        "plan_smooth_route",
        lambda *_, avoidance="balanced", **__: Route("S", 3.6, 14, LINE, kind="smooth"),
    )
    counts = {"A": 5, "B": 1, "S": 2}
    monkeypatch.setattr(
        trip,
        "potholes_along",
        lambda route, buffer_m=30: [_pothole(i, 100 + i) for i in range(counts[route.route_id])],
    )


def test_bounds_check():
    assert in_philadelphia(39.9526, -75.1652)
    assert not in_philadelphia(40.7128, -74.0060)  # New York


def test_fetch_routes_rejects_points_outside_the_city():
    with pytest.raises(RoutingError):
        routing.fetch_routes(40.7128, -74.0060, 39.95, -75.16)


def test_pothole_sql_contains_only_validated_numbers():
    sql = build_pothole_sql(LINE, buffer_m=99999)
    assert ", 100)" in sql, "buffer should be clamped to the maximum"
    assert "status = 'Open'" in sql and "Street Defect" in sql
    with pytest.raises((ValueError, TypeError)):
        build_pothole_sql([["0); DROP TABLE x; --", 1], [2, 3]])


def test_long_routes_are_thinned():
    long_line = [[-75.2 + i * 1e-5, 39.9] for i in range(5000)]
    assert len(routing._thin(long_line)) <= routing.MAX_ROUTE_POINTS + 1
    assert routing._thin(long_line)[-1] == long_line[-1]


def test_fallback_planner_prefers_fewer_potholes(fake_services):
    result = trip.plan_trip("City Hall", "Stadium")
    assert result["recommended"] == "B"
    assert [len(r["potholes"]) for r in result["routes"]] == [5, 1, 2]
    assert "Route B" in result["briefing"]
    assert result["comparison"] == {
        "against": "A",
        "reports_avoided": 4,
        "extra_minutes": 1,
        "extra_miles": 0.5,
    }
    assert "avoids 4 reported potholes for about 1 extra minute" in result["briefing"]


def test_smooth_route_wins_when_it_is_the_better_drive(fake_services, monkeypatch):
    monkeypatch.setattr(
        trip,
        "plan_smooth_route",
        lambda *_, avoidance="balanced", **__: Route("S", 3.6, 14, LINE, kind="smooth"),
    )
    counts = {"A": 5, "B": 4, "S": 0}
    monkeypatch.setattr(
        trip,
        "potholes_along",
        lambda route, buffer_m=30: [_pothole(i, 100 + i) for i in range(counts[route.route_id])],
    )
    result = trip.plan_trip("City Hall", "Stadium", avoidance="strong")
    assert result["recommended"] == "S" and result["avoidance"] == "strong"
    smooth = next(r for r in result["routes"] if r["route_id"] == "S")
    assert smooth["kind"] == "smooth" and smooth["potholes"] == []
    assert result["briefing"].startswith("The smooth route (3.6 mi, about 14 min) has no open")
    assert "avoids 5 reported potholes for about 2 extra minutes" in result["briefing"]


def test_smooth_router_failure_is_reported_not_fatal(fake_services, monkeypatch):
    from pothole_agent.streetgraph import GraphError

    def broken(*_, **__):
        raise GraphError("graph file missing")

    monkeypatch.setattr(trip, "plan_smooth_route", broken)
    result = trip.plan_trip("City Hall", "Stadium")
    assert result["recommended"] == "B"
    assert [r["route_id"] for r in result["routes"]] == ["A", "B"]
    assert "graph file missing" in result["smooth_error"]
    assert "pothole-aware router was unavailable" in result["briefing"]


def test_unknown_route_id_is_an_error(fake_services):
    context = trip.TripContext()
    with pytest.raises(RoutingError):
        context.scan_route("Z")


def test_api_validates_input():
    client = create_app().test_client()
    assert client.post("/api/trip", json={"start": "", "end": "x"}).status_code == 400
    assert client.post("/api/trip", json={"start": "a" * 500, "end": "x"}).status_code == 400
    assert client.get("/healthz").get_json()["ok"] is True
    assert "agent_available" not in client.get("/healthz").get_json()


def test_plan_trip_streams_steps_live(fake_services):
    seen = []
    result = trip.plan_trip("City Hall", "Stadium", on_step=seen.append)
    assert seen == result["steps"], "on_step should see every recorded step, in order"
    assert seen, "the planner should narrate its steps"
    assert seen[0]["type"] == "step"
    assert any("Picked route B" in step.get("text", "") for step in seen)


def _sse_events(body):
    """Parse an SSE body into (event_name, payload) pairs."""
    import json as _json

    events = []
    for chunk in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in chunk.splitlines())
        events.append((lines["event"], _json.loads(lines["data"])))
    return events


def test_stream_endpoint_emits_steps_then_result(fake_services):
    client = create_app().test_client()
    response = client.get("/api/trip/stream?start=City%20Hall&end=Stadium")
    assert response.status_code == 200
    assert response.headers["Content-Type"].startswith("text/event-stream")
    events = _sse_events(response.get_data(as_text=True))
    names = [name for name, _ in events]
    assert names[-1] == "result" and names.count("result") == 1
    assert names.count("step") >= 2, "steps should stream before the result"
    result = events[-1][1]
    assert result["recommended"] == "B"


def test_stream_endpoint_validates_input():
    client = create_app().test_client()
    assert client.get("/api/trip/stream?start=&end=x").status_code == 400
    assert client.get("/api/trip/stream?start=" + "a" * 500 + "&end=x").status_code == 400


def test_stream_endpoint_reports_routing_errors(fake_services, monkeypatch):
    monkeypatch.setattr(
        trip, "geocode", lambda address: (_ for _ in ()).throw(RoutingError("no match"))
    )
    client = create_app().test_client()
    response = client.get("/api/trip/stream?start=Nowhere&end=Stadium")
    events = _sse_events(response.get_data(as_text=True))
    assert events[-1][0] == "trip_error"
    assert "no match" in events[-1][1]["error"]


def test_api_returns_trip(fake_services):
    response = (
        create_app().test_client().post("/api/trip", json={"start": "City Hall", "end": "Stadium"})
    )
    assert response.status_code == 200
    assert response.get_json()["recommended"] == "B"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_api_passes_avoidance_through_and_normalises_junk(fake_services):
    client = create_app().test_client()
    strong = client.post(
        "/api/trip", json={"start": "City Hall", "end": "Stadium", "avoid": "strong"}
    )
    assert strong.get_json()["avoidance"] == "strong"
    junk = client.post("/api/trip", json={"start": "City Hall", "end": "Stadium", "avoid": "<x>"})
    assert junk.get_json()["avoidance"] == "balanced"
    streamed = client.get("/api/trip/stream?start=City%20Hall&end=Stadium&avoid=strong")
    assert _sse_events(streamed.get_data(as_text=True))[-1][1]["avoidance"] == "strong"


def test_build_bbox_sql_clamps_to_philly():
    from pothole_agent.routing import PHILLY_BOUNDS, build_bbox_sql

    sql = build_bbox_sql(0.0, -100.0, 89.0, 0.0)
    min_lat, max_lat, min_lon, max_lon = PHILLY_BOUNDS
    assert f"lat BETWEEN {min_lat} AND {max_lat}" in sql
    assert f"lon BETWEEN {min_lon} AND {max_lon}" in sql
    assert "status = 'Open'" in sql


def test_potholes_endpoint_rejects_bad_bbox():
    from pothole_agent.webapp import create_app

    client = create_app().test_client()
    assert client.get("/api/potholes?bbox=junk").status_code == 400
    assert client.get("/api/potholes").status_code == 400


def test_geocode_accepts_philly_coordinates_without_network(monkeypatch):
    from pothole_agent import routing

    # Any network call would be a bug: coordinates must short-circuit.
    monkeypatch.setattr(
        routing.requests, "get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("network"))
    )
    found = routing.geocode("39.9526, -75.1652")
    assert found["lat"] == 39.9526 and found["lon"] == -75.1652
    assert found["source"] == "device coordinates"
    assert "39.95260" in found["matched_address"]


def test_geocode_rejects_coordinates_outside_philly():
    from pothole_agent.routing import RoutingError, geocode

    with pytest.raises(RoutingError):
        geocode("40.7128, -74.0060")  # New York City


def test_navigate_endpoint_validates_and_reroutes(monkeypatch):
    from pothole_agent import webapp

    calls = []

    def fake_navigate(start_lat, start_lon, end_lat, end_lon, avoidance):
        calls.append((start_lat, start_lon, end_lat, end_lon, avoidance))
        return {"route_id": "S", "coordinates": LINE, "steps": [], "potholes": []}

    monkeypatch.setattr(webapp, "navigate", fake_navigate)
    client = create_app().test_client()
    assert client.get("/api/navigate?from=junk&to=39.9,-75.1").status_code == 400
    assert client.get("/api/navigate?from=40.7128,-74.0060&to=39.9,-75.1").status_code == 400
    ok = client.get("/api/navigate?from=39.95,-75.16&to=39.9061,-75.1665&avoid=strong")
    assert ok.status_code == 200 and ok.get_json()["route_id"] == "S"
    assert calls == [(39.95, -75.16, 39.9061, -75.1665, "strong")]


def test_road_endpoint_validates_and_answers(monkeypatch):
    from pothole_agent import webapp

    monkeypatch.setattr(
        webapp, "road_at", lambda lat, lon: {"name": "North Broad Street", "posted_mph": 25}
    )
    client = create_app().test_client()
    assert client.get("/api/road?at=junk").status_code == 400
    assert client.get("/api/road?at=40.7128,-74.0060").status_code == 400
    body = client.get("/api/road?at=39.95,-75.16").get_json()
    assert body["road"]["posted_mph"] == 25


def test_navigate_alternatives_flag(monkeypatch):
    from pothole_agent import webapp

    monkeypatch.setattr(webapp, "alternatives", lambda *_: [{"route_id": "S"}, {"route_id": "A"}])
    client = create_app().test_client()
    body = client.get("/api/navigate?from=39.95,-75.16&to=39.9061,-75.1665&alternatives=1")
    assert [r["route_id"] for r in body.get_json()["routes"]] == ["S", "A"]


def test_briefing_names_the_roughest_stretch(fake_services, monkeypatch):
    def clustered(route, buffer_m=30):
        if route.route_id != "A":
            return []
        miles = [0.3, 2.1, 2.2, 2.4, 3.9]
        return [{**_pothole(i, 10 + i), "mile_marker": m} for i, m in enumerate(miles)]

    monkeypatch.setattr(trip, "potholes_along", clustered)
    counts_b = trip.plan_trip("City Hall", "Stadium")
    assert counts_b["recommended"] in ("B", "S")  # A is the rough one; just check the text
    context = trip.TripContext()
    context.geocode_address("City Hall", "start")
    context.geocode_address("Stadium", "end")
    context.find_routes(0, 0, 0, 0)
    context.ensure_complete()
    context.recommended = "A"
    text = trip.briefing(context)
    assert "roughest stretch starts around mile 2.1" in text
    assert "3 reports in half a mile" in text
    assert "open for 14 days" in text  # the oldest report
    assert trip.worst_stretch([]) is None
    assert trip.worst_stretch([{"mile_marker": 1.0, "address": "x"}]) is None
