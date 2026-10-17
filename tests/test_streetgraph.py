"""Street graph and smooth-route tests on a tiny synthetic network. No network."""

from __future__ import annotations

import gzip
import json

import pytest

from pothole_agent import smooth, streetgraph
from pothole_agent.routing import Route, _describe_step
from pothole_agent.streetgraph import GraphError, StreetGraph, compact_osm

# A 3x3 grid of streets around 39.95, -75.16 with ~110 m blocks.
#
#   n0 - n1 - n2     rows are "Row 0/1/2 St", columns are "Col 0/1/2 St"
#   |    |    |
#   n3 - n4 - n5     "Col 1 St" (n1-n4-n7) is one-way southbound
#   |    |    |
#   n6 - n7 - n8
STEP = 0.001


def _node(node_id: int, row: int, col: int) -> dict:
    return {"type": "node", "id": node_id, "lat": 39.95 - row * STEP, "lon": -75.16 + col * STEP}


def _way(way_id: int, nodes: list[int], name: str, **tags: str) -> dict:
    return {
        "type": "way",
        "id": way_id,
        "nodes": nodes,
        "tags": {"highway": "residential", "name": name, **tags},
    }


def grid_osm() -> dict:
    elements = [_node(r * 3 + c, r, c) for r in range(3) for c in range(3)]
    elements += [
        _way(100, [0, 1, 2], "Row 0 St"),
        _way(101, [3, 4, 5], "Row 1 St"),
        _way(102, [6, 7, 8], "Row 2 St"),
        _way(103, [0, 3, 6], "Col 0 St"),
        _way(104, [1, 4, 7], "Col 1 St", oneway="yes"),  # southbound only
        _way(105, [2, 5, 8], "Col 2 St"),
        _way(106, [0, 4], "Private Lane", access="private"),  # must be dropped
        {"type": "way", "id": 107, "nodes": [6, 8], "tags": {"highway": "footway"}},
    ]
    return {"elements": elements, "osm3s": {"timestamp_osm_base": "2026-10-17T00:00:00Z"}}


@pytest.fixture
def graph() -> StreetGraph:
    return StreetGraph(compact_osm(grid_osm()))


def _corner(graph: StreetGraph, row: int, col: int) -> tuple[float, float]:
    return 39.95 - row * STEP, -75.16 + col * STEP


def test_compact_osm_keeps_only_drivable_ways(graph):
    names = {edge[5] for edge in graph.edges}
    assert "Private Lane" not in names and "" not in names
    assert len(graph.vertices) == 9
    # Each 3-node way splits into two segments at the shared middle node.
    assert len(graph.edges) == 12
    assert graph.osm_timestamp == "2026-10-17T00:00:00Z"


def test_oneway_is_respected(graph):
    down = graph.route(*_corner(graph, 0, 1), *_corner(graph, 2, 1))
    assert [s["name"] for s in down.streets] == ["Col 1 St"]
    up = graph.route(*_corner(graph, 2, 1), *_corner(graph, 0, 1))
    assert "Col 1 St" not in [s["name"] for s in up.streets], "northbound must detour"
    assert up.meters > down.meters


def test_penalty_causes_a_detour_and_reports_are_attributed(graph):
    start, end = _corner(graph, 1, 0), _corner(graph, 1, 2)
    direct = graph.route(*start, *end)
    assert [s["name"] for s in direct.streets] == ["Row 1 St"]
    # One open report sitting on Row 1 St between col 0 and col 1.
    pothole = {"id": 42, "lat": 39.95 - STEP, "lon": -75.16 + STEP / 2, "days_open": 10}
    penalty, matched = graph.penalties([pothole], "strong")
    assert len(penalty) == 1 and list(matched.values()) == [[42]]
    detour = graph.route(*start, *end, penalty, matched)
    assert detour.report_ids == [] and detour.meters > direct.meters
    assert "Row 1 St" not in [s["name"] for s in detour.streets[:1]]


def test_balanced_penalty_is_smaller_than_strong(graph):
    pothole = {"id": 1, "lat": 39.95 - STEP, "lon": -75.16 + STEP / 2, "days_open": 400}
    balanced, _ = graph.penalties([pothole], "balanced")
    strong, _ = graph.penalties([pothole], "strong")
    edge = next(iter(balanced))
    assert balanced[edge] < strong[edge]
    # Age weighting: a year-old report counts for less than a fresh one.
    fresh, _ = graph.penalties([{**pothole, "days_open": 1}], "balanced")
    assert fresh[edge] > balanced[edge]
    assert StreetGraph.age_weight(None) == 1.0


def test_reports_far_from_any_street_are_ignored(graph):
    far = {"id": 9, "lat": 39.95 + 0.05, "lon": -75.16, "days_open": 1}
    penalty, matched = graph.penalties([far])
    assert penalty == {} and matched == {}
    assert graph.penalties([{"id": 1, "lat": None, "lon": None}]) == ({}, {})


def test_points_far_from_the_graph_are_rejected(graph):
    with pytest.raises(GraphError):
        graph.route(39.95, -75.16, 40.10, -75.00)


def test_route_geometry_starts_and_ends_at_the_request(graph):
    start, end = (39.95 - STEP * 0.4, -75.16 + STEP * 0.1), _corner(graph, 2, 2)
    route = graph.route(*start, *end)
    assert route.coordinates[0] == [start[1], start[0]]  # [lon, lat]
    assert route.coordinates[-1] == [end[1], end[0]]
    assert route.via and all({"lat", "lon", "bearing"} <= set(v) for v in route.via)


def test_same_point_route_is_empty_not_an_error(graph):
    route = graph.route(*_corner(graph, 0, 0), *_corner(graph, 0, 0))
    assert route.meters == 0 and route.streets == []


def test_via_thinning_keeps_long_segments_and_order():
    via = [
        {"lat": 1, "lon": 1, "bearing": 0, "meters": 50},
        {"lat": 2, "lon": 2, "bearing": 0, "meters": 1500},
        {"lat": 3, "lon": 3, "bearing": 0, "meters": 20},
        {"lat": 4, "lon": 4, "bearing": 0, "meters": 1200},
        {"lat": 5, "lon": 5, "bearing": 0, "meters": 30},
    ]
    chosen = streetgraph._thin_via(via, max_points=10)
    assert [v["lat"] for v in chosen] == [2, 4]
    assert "meters" not in chosen[0]


def test_graph_round_trips_through_the_gzip_file(tmp_path):
    path = tmp_path / "graph.json.gz"
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        json.dump(compact_osm(grid_osm()), handle)
    loaded = StreetGraph.load(path)
    assert len(loaded.edges) == 12
    with pytest.raises(GraphError):
        StreetGraph.load(tmp_path / "missing.json.gz")
    with pytest.raises(GraphError):
        StreetGraph({"format": 999})


# ----- smooth.py -------------------------------------------------------------


@pytest.fixture
def smooth_env(monkeypatch, graph):
    smooth.shared.reset()
    monkeypatch.setattr(smooth.shared, "graph", lambda *_: graph)
    monkeypatch.setattr(smooth.shared, "reports", list)
    return graph


def test_smooth_route_uses_osrm_snap_when_it_follows_the_plan(smooth_env, monkeypatch):
    calls = []

    def fake_via(start, end, via, route_id="S"):
        calls.append(len(via))
        return Route(route_id, 0.2, 2, [[0, 0]], kind="smooth", steps=[{"text": "ok"}])

    monkeypatch.setattr(smooth, "fetch_route_via", fake_via)
    route = smooth.smooth_route(39.95 - STEP, -75.16, 39.95 - STEP, -75.16 + 2 * STEP)
    assert route.source == "osrm" and route.steps == [{"text": "ok"}]
    assert calls == [1], "a short route needs one via point and one OSRM call"


def test_smooth_route_falls_back_to_graph_geometry_when_snap_wanders(smooth_env, monkeypatch):
    attempts = []

    def wandering(start, end, via, route_id="S"):
        attempts.append(len(via))
        return Route(route_id, 9.9, 30, [[0, 0]], kind="smooth")  # far longer than planned

    monkeypatch.setattr(smooth, "fetch_route_via", wandering)
    route = smooth.smooth_route(39.95, -75.16, 39.95 - 2 * STEP, -75.16 + 2 * STEP)
    assert route.source == "graph" and route.kind == "smooth"
    assert route.steps[0]["text"].startswith("Head out on")
    assert route.steps[-1]["text"] == "Arrive at your destination"
    assert len(attempts) >= 1


def test_smooth_route_falls_back_when_osrm_is_down(smooth_env, monkeypatch):
    monkeypatch.setattr(smooth, "fetch_route_via", lambda *a, **k: None)
    route = smooth.smooth_route(39.95, -75.16, 39.95 - 2 * STEP, -75.16 + 2 * STEP)
    assert route.source == "graph" and route.miles > 0


def test_graph_status_reports_missing_file(monkeypatch, tmp_path):
    smooth.shared.reset()
    monkeypatch.setattr(streetgraph, "DEFAULT_GRAPH_PATH", tmp_path / "nope.json.gz")
    monkeypatch.setattr(smooth, "DEFAULT_GRAPH_PATH", tmp_path / "nope.json.gz")
    status = smooth.graph_status()
    assert status["available"] is False and "nope.json.gz" in status["error"]
    smooth.shared.reset()


def test_pick_route_trades_minutes_for_reports():
    def with_reports(route_id, minutes, n, kind="fast"):
        route = Route(route_id, 1.0, minutes, [[0, 0]], kind=kind)
        route.potholes = [{"days_open": 5} for _ in range(n)]
        return route

    fast = with_reports("A", 10, 6)
    smooth_route = with_reports("S", 12, 0, "smooth")
    assert smooth.pick_route([fast, smooth_route]).route_id == "S"
    # Balanced: 45 s per report. Two extra minutes for one report is not worth it...
    barely = with_reports("S", 12, 5, "smooth")
    assert smooth.pick_route([fast, barely], "balanced").route_id == "A"
    # ...but with strong avoidance (3 min per report) it is.
    assert smooth.pick_route([fast, barely], "strong").route_id == "S"
    assert smooth.normalize_avoidance("STRONG") == "strong"
    assert smooth.normalize_avoidance("<script>") == "balanced"


def test_describe_step_formats_osrm_maneuvers():
    turn = {
        "maneuver": {"type": "turn", "modifier": "left"},
        "name": "North Broad Street",
        "distance": 1609.344,
        "duration": 120,
    }
    assert _describe_step(turn) == {
        "text": "Turn left onto North Broad Street",
        "miles": 1.0,
        "minutes": 2.0,
        "location": None,
        "modifier": "left",
    }
    located = {**turn, "maneuver": {**turn["maneuver"], "location": [-75.16, 39.95]}}
    assert _describe_step(located)["location"] == [-75.16, 39.95]
    depart = {"maneuver": {"type": "depart", "bearing_after": 180}, "name": "", "ref": "I 95"}
    assert _describe_step(depart)["text"] == "Head south on I 95"
    assert _describe_step({"maneuver": {"type": "notification"}}) is None


def test_graph_route_steps_carry_locations_for_navigation(smooth_env, monkeypatch):
    monkeypatch.setattr(smooth, "fetch_route_via", lambda *a, **k: None)
    route = smooth.smooth_route(39.95, -75.16, 39.95 - 2 * STEP, -75.16 + 2 * STEP)
    assert all(isinstance(step["location"], list) for step in route.steps)
    assert route.steps[-1]["modifier"] == "arrive"
    assert route.steps[-1]["location"] == route.coordinates[-1]


def test_navigate_falls_back_to_osrm_when_graph_is_missing(monkeypatch):
    from pothole_agent import smooth as smooth_module

    def no_graph(*_, **__):
        raise smooth_module.GraphError("no graph")

    monkeypatch.setattr(smooth_module, "smooth_route", no_graph)
    monkeypatch.setattr(
        "pothole_agent.routing.fetch_routes", lambda *_: [Route("A", 1.0, 3, [[0, 0], [1, 1]])]
    )
    monkeypatch.setattr("pothole_agent.routing.potholes_along", lambda route, buffer_m=30: [])
    result = smooth_module.navigate(39.95, -75.16, 39.94, -75.15, "strong")
    assert result["route_id"] == "A" and result["potholes"] == []
    assert result["avoidance"] == "strong"


def test_road_info_reports_name_and_posted_limit():
    osm = grid_osm()
    for way in osm["elements"]:
        if way.get("id") == 101:
            way["tags"]["maxspeed"] = "35 mph"
    g = StreetGraph(compact_osm(osm))
    on_row_1 = g.road_info(39.95 - STEP, -75.16 + STEP / 2)
    assert on_row_1["name"] == "Row 1 St" and on_row_1["posted_mph"] == 35
    on_row_0 = g.road_info(39.95, -75.16 + STEP / 2)
    assert on_row_0["name"] == "Row 0 St" and on_row_0["posted_mph"] is None
    assert g.road_info(39.95 + 0.05, -75.16) is None


def test_alternatives_lists_distinct_options(smooth_env, monkeypatch):
    from pothole_agent import smooth as smooth_module

    monkeypatch.setattr(smooth_module, "fetch_route_via", lambda *a, **k: None)
    monkeypatch.setattr(
        "pothole_agent.routing.fetch_routes",
        lambda *_: [Route("A", 1.0, 3, [[0, 0], [1, 1]]), Route("B", 1.2, 4, [[0, 0], [2, 2]])],
    )
    monkeypatch.setattr("pothole_agent.routing.potholes_along", lambda route, buffer_m=30: [])
    options = smooth_module.alternatives(39.95, -75.16, 39.95 - 2 * STEP, -75.16 + 2 * STEP)
    labels = [o["label"] for o in options]
    # No reports on the grid, so balanced and strong plan the same drive: listed once.
    assert labels == ["Smooth route", "Fastest route", "Alternative"]
    assert options[0]["kind"] == "smooth" and options[1]["route_id"] == "A"
