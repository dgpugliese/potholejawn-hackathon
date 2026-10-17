"""The smooth route: pothole-aware routing wired to live 311 data.

Ties together the street graph (``streetgraph.py``), the citywide set of open
pothole reports (cached for a few minutes), and OSRM, which turns our graph
path into a legal, turn-restricted route with real durations and directions.
If OSRM cannot follow the path, the graph's own geometry is used instead, so a
smooth route is always produced when the graph is available.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

from .routing import METERS_PER_MILE, Route, fetch_route_via, open_reports_citywide
from .streetgraph import (
    DEFAULT_AVOIDANCE,
    DEFAULT_GRAPH_PATH,
    PENALTY_SECONDS,
    GraphError,
    SmoothRoute,
    StreetGraph,
)

log = logging.getLogger(__name__)

REPORTS_CACHE_SECONDS = int(os.environ.get("REPORTS_CACHE_SECONDS", "600"))
SMOOTH_ROUTE_ID = "S"
# A snapped route that is this much longer than the graph's plan means OSRM
# doubled back somewhere; retry with fewer waypoints, then give up on the snap.
SNAP_TOLERANCE = 1.25
AVOIDANCE_LEVELS = tuple(PENALTY_SECONDS)


class _GraphHolder:
    """Lazy, thread-safe singleton for the street graph and the report cache."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._graph: StreetGraph | None = None
        self._graph_error: str | None = None
        self._reports: list[dict[str, Any]] = []
        self._reports_at = 0.0
        self._penalties: dict[str, tuple[dict[int, float], dict[int, list[Any]]]] = {}

    def graph(self, path: Path | str | None = None) -> StreetGraph:
        with self._lock:
            if self._graph is None:
                if self._graph_error:
                    raise GraphError(self._graph_error)
                started = time.monotonic()
                try:
                    self._graph = StreetGraph.load(Path(path or DEFAULT_GRAPH_PATH))
                except (GraphError, OSError, ValueError) as error:
                    self._graph_error = str(error)
                    raise GraphError(self._graph_error) from error
                log.info(
                    "street graph loaded: %s intersections, %s segments, %.1fs",
                    len(self._graph.vertices),
                    len(self._graph.edges),
                    time.monotonic() - started,
                )
            return self._graph

    def reports(self) -> list[dict[str, Any]]:
        """Open reports citywide, refreshed every REPORTS_CACHE_SECONDS."""
        with self._lock:
            fresh = time.monotonic() - self._reports_at < REPORTS_CACHE_SECONDS
            if self._reports and fresh:
                return self._reports
        rows = open_reports_citywide()  # network call outside the lock
        with self._lock:
            self._reports = rows
            self._reports_at = time.monotonic()
            self._penalties.clear()
            return self._reports

    def penalties(self, avoidance: str) -> tuple[dict[int, float], dict[int, list[Any]]]:
        reports = self.reports()
        graph = self.graph()
        with self._lock:
            cached = self._penalties.get(avoidance)
            if cached is None:
                cached = graph.penalties(reports, avoidance)
                self._penalties[avoidance] = cached
            return cached

    def reset(self) -> None:
        with self._lock:
            self._graph = None
            self._graph_error = None
            self._reports = []
            self._reports_at = 0.0
            self._penalties.clear()


shared = _GraphHolder()


def graph_status() -> dict[str, Any]:
    """For /healthz: is the pothole-aware router available, and how fresh is it?"""
    try:
        graph = shared.graph()
    except GraphError as error:
        return {"available": False, "error": str(error)}
    return {
        "available": True,
        "intersections": len(graph.vertices),
        "segments": len(graph.edges),
        "osm_timestamp": graph.osm_timestamp,
        "built": graph.built,
    }


def normalize_avoidance(value: Any) -> str:
    value = str(value or "").strip().lower()
    return value if value in PENALTY_SECONDS else DEFAULT_AVOIDANCE


def _graph_route_to_route(plan: SmoothRoute, route_id: str) -> Route:
    steps = [
        {
            "text": f"Continue on {street['name']}",
            "miles": round(street["meters"] / METERS_PER_MILE, 2),
            "minutes": 0.0,
            "location": street["at"],  # [lon, lat] where the street begins
            "modifier": "",
        }
        for street in plan.streets
    ]
    if steps:
        steps[0]["text"] = steps[0]["text"].replace("Continue on", "Head out on", 1)
        steps.append(
            {
                "text": "Arrive at your destination",
                "miles": 0.0,
                "minutes": 0.0,
                "location": plan.coordinates[-1],
                "modifier": "arrive",
            }
        )
    return Route(
        route_id=route_id,
        kind="smooth",
        miles=round(plan.meters / METERS_PER_MILE, 1),
        minutes=max(1, round(plan.seconds / 60)),
        coordinates=plan.coordinates,
        steps=steps,
        source="graph",
        via=plan.via,
    )


def smooth_route(
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    avoidance: str = DEFAULT_AVOIDANCE,
    route_id: str = SMOOTH_ROUTE_ID,
) -> Route:
    """Plan the pothole-aware route between two points.

    1. A* on the street graph with every open report as a time penalty.
    2. Snap that path through OSRM (waypoints with bearings) for a legal route
       with real timing and turn-by-turn directions.
    3. If the snap wanders (much longer than planned) retry with fewer
       waypoints, and finally fall back to the graph geometry itself.

    The returned route is unscanned: the caller runs the same Carto corridor
    scan on it as on every other route, so its pothole count is verified
    against the city's data rather than taken from our matching.
    """
    avoidance = normalize_avoidance(avoidance)
    graph = shared.graph()
    penalty, matched = shared.penalties(avoidance)
    plan = graph.route(start_lat, start_lon, end_lat, end_lon, penalty, matched)
    planned_miles = plan.meters / METERS_PER_MILE
    via = plan.via
    attempts = [via, via[: max(2, len(via) // 2)], via[:1]] if via else []
    for waypoints in attempts:
        snapped = fetch_route_via((start_lat, start_lon), (end_lat, end_lon), waypoints, route_id)
        if snapped is None:
            continue
        if snapped.miles <= planned_miles * SNAP_TOLERANCE + 0.2:
            return snapped
        log.info(
            "smooth snap wandered: planned %.1f mi, got %.1f mi with %d via points",
            planned_miles,
            snapped.miles,
            len(waypoints),
        )
    return _graph_route_to_route(plan, route_id)


def navigate(
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    avoidance: str = DEFAULT_AVOIDANCE,
) -> dict[str, Any]:
    """A fresh route from the driver's current position, for live re-routing.

    No model call: the smooth router plus the Carto corridor scan, in about a
    second. If the street graph is unavailable, OSRM's fastest route is used so
    navigation never dead-ends.
    """
    from .routing import fetch_routes, potholes_along  # local import: avoids a cycle at load

    try:
        route = smooth_route(start_lat, start_lon, end_lat, end_lon, avoidance)
    except GraphError:
        route = fetch_routes(start_lat, start_lon, end_lat, end_lon)[0]
    route.potholes = potholes_along(route)
    return {
        "route_id": route.route_id,
        "kind": route.kind,
        "source": route.source,
        "miles": route.miles,
        "minutes": route.minutes,
        "coordinates": route.coordinates,
        "steps": route.steps,
        "via": route.via,
        "potholes": route.potholes,
        "avoidance": normalize_avoidance(avoidance),
    }


def score(route: Route, avoidance: str = DEFAULT_AVOIDANCE) -> float:
    """Minutes plus a time value for each reported pothole; lower is better.

    Uses the same per-report penalty the router optimised with, so the pick
    among scanned routes agrees with the way the smooth route was planned.
    """
    minutes_per_report = PENALTY_SECONDS[normalize_avoidance(avoidance)] / 60.0
    reports = route.potholes or []
    weighted = sum(StreetGraph.age_weight(p.get("days_open")) for p in reports)
    return route.minutes + minutes_per_report * weighted


def pick_route(routes: list[Route], avoidance: str = DEFAULT_AVOIDANCE) -> Route:
    """The deterministic choice: best score, then fewer reports, then faster."""
    return min(
        routes,
        key=lambda r: (round(score(r, avoidance), 2), len(r.potholes or []), r.minutes),
    )
