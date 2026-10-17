"""A pothole-aware street router for Philadelphia.

OSRM only knows about travel time, so the best it can do is offer alternatives
and let us pick the least bad one. This module routes on our own copy of the
city's street graph (OpenStreetMap, via Overpass) with every open pothole
report turned into a time penalty on the street segment it sits on. A* then
finds the drive that is genuinely smoothest for the time it costs.

Two parts:
  * ``build_graph``   one-off: download the drivable network and write a compact
                      gzipped JSON file (``data/philly_graph.json.gz``).
  * ``StreetGraph``   runtime: load the file, snap points to the graph, apply
                      penalties, and run A*.

No SQL, no model input, and nothing here ever reaches the browser unescaped.
"""

from __future__ import annotations

import gzip
import heapq
import json
import math
import re
import time
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
BUILD_USER_AGENT = "potholejawn/1.0 (graph build; github.com/dgpugliese/potholejawn-hackathon)"
DEFAULT_GRAPH_PATH = Path(__file__).resolve().parent.parent / "data" / "philly_graph.json.gz"
GRAPH_FORMAT = 1

# Drivable highway classes, with a default speed (km/h) when OSM has no maxspeed.
# These follow OSRM's car profile so our times line up with the routes it returns.
HIGHWAY_SPEEDS_KMH = {
    "motorway": 90,
    "trunk": 85,
    "primary": 65,
    "secondary": 55,
    "tertiary": 40,
    "unclassified": 25,
    "residential": 25,
    "living_street": 10,
    "motorway_link": 45,
    "trunk_link": 40,
    "primary_link": 30,
    "secondary_link": 25,
    "tertiary_link": 20,
}
# Seconds lost at each intersection: a little when continuing straight (lights,
# stop signs), more when turning onto another street. Grade-separated roads pay
# nothing. Calibrated against OSRM durations on real Philly trips.
FREE_FLOW = {"motorway", "motorway_link", "trunk", "trunk_link"}
STRAIGHT_SECONDS = 3.0
TURN_SECONDS = 12.0
MAX_SPEED_MPS = 37.0  # above any posted limit (130 km/h cap), so the A* heuristic stays admissible
MPH_TO_KMH = 1.609344

# Pothole matching and penalties.
MATCH_RADIUS_M = 30.0  # same corridor the Carto scan uses, so counts agree
PENALTY_SECONDS = {"balanced": 45.0, "strong": 180.0}  # per report, before age weighting
DEFAULT_AVOIDANCE = "balanced"
SNAP_MAX_M = 400.0  # how far a start or end may be from the nearest intersection

# Report-age weighting: a fresh report is more likely to still be a hole than a
# year-old one the city may have patched without closing the ticket.
AGE_WEIGHTS = ((30, 1.0), (180, 0.8), (10_000, 0.6))

# Equirectangular projection centred on Philadelphia: good to <0.1% at this scale.
_LAT0 = math.radians(40.0)
_M_PER_DEG_LAT = 111_132.0
_M_PER_DEG_LON = 111_320.0 * math.cos(_LAT0)
_CELL_DEG = 0.004  # ~450 m grid cells for the spatial indexes


class GraphError(ValueError):
    """A routing problem the user can fix, e.g. a point far from any street."""


def _project(lat: float, lon: float) -> tuple[float, float]:
    return lon * _M_PER_DEG_LON, lat * _M_PER_DEG_LAT


def _cell(lat: float, lon: float) -> tuple[int, int]:
    return int(math.floor(lat / _CELL_DEG)), int(math.floor(lon / _CELL_DEG))


def _dist_m(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    ax, ay = _project(a_lat, a_lon)
    bx, by = _project(b_lat, b_lon)
    return math.hypot(ax - bx, ay - by)


def _point_segment_distance(
    px: float, py: float, ax: float, ay: float, bx: float, by: float
) -> float:
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


# --------------------------------------------------------------------------- build


_MAXSPEED_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(mph|km/h|kph)?\s*$", re.IGNORECASE)


def _tagged_speed_kmh(tags: dict[str, str]) -> float:
    """The posted limit in km/h, or 0 when OSM has none (resolved at load time)."""
    match = _MAXSPEED_RE.match(tags.get("maxspeed", ""))
    if not match:
        return 0.0
    value = float(match.group(1))
    unit = (match.group(2) or "mph").lower()  # a bare number from a US mapper means mph
    if unit == "mph":
        value *= MPH_TO_KMH
    return max(5.0, min(130.0, value))


def edge_seconds(length_m: float, tagged_kmh: float, highway: str) -> float:
    """Free-flow travel time for one segment at its posted or default speed."""
    kmh = tagged_kmh or HIGHWAY_SPEEDS_KMH.get(highway, 25)
    return length_m / (kmh / 3.6)


def junction_seconds(prev_edge: list[Any] | None, edge: list[Any]) -> float:
    """Delay for entering ``edge`` from ``prev_edge`` (None at the trip start)."""
    if edge[6] in FREE_FLOW or prev_edge is None:
        return 0.0
    same_street = bool(edge[5]) and prev_edge[5] == edge[5]
    return STRAIGHT_SECONDS if same_street else TURN_SECONDS


def _oneway(tags: dict[str, str]) -> int:
    """1 = forward only, -1 = reverse only, 0 = both ways."""
    value = tags.get("oneway", "")
    if value in ("yes", "true", "1"):
        return 1
    if value == "-1":
        return -1
    if value in ("no", "false", "0"):
        return 0
    if tags.get("junction") in ("roundabout", "circular") or tags.get("highway") == "motorway":
        return 1
    return 0


def _drivable(tags: dict[str, str]) -> bool:
    if tags.get("highway") not in HIGHWAY_SPEEDS_KMH:
        return False
    if tags.get("area") == "yes":
        return False
    if tags.get("access") in ("private", "no") and tags.get("motor_vehicle") not in ("yes",):
        return False
    return tags.get("motor_vehicle") not in ("no", "private")


def overpass_query(south: float, west: float, north: float, east: float) -> str:
    classes = "|".join(HIGHWAY_SPEEDS_KMH)
    return (
        "[out:json][timeout:400];"
        f'way["highway"~"^({classes})$"]["area"!="yes"]({south},{west},{north},{east});'
        "out body;>;out skel qt;"
    )


def download_osm(bounds: tuple[float, float, float, float], path: Path) -> None:
    """Fetch the raw drivable network for (min_lat, max_lat, min_lon, max_lon)."""
    min_lat, max_lat, min_lon, max_lon = bounds
    response = requests.post(
        OVERPASS_URL,
        data={"data": overpass_query(min_lat, min_lon, max_lat, max_lon)},
        headers={"User-Agent": BUILD_USER_AGENT, "Accept": "application/json"},
        timeout=600,
    )
    response.raise_for_status()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(response.content)


def compact_osm(raw: dict[str, Any]) -> dict[str, Any]:
    """Turn raw Overpass JSON into the compact graph document.

    Vertices are intersections (nodes shared by two or more ways) and way ends.
    Each edge keeps the shape nodes between its two vertices so the map can draw
    it and potholes can be matched to it.
    """
    coords: dict[int, tuple[float, float]] = {}
    ways: list[dict[str, Any]] = []
    for element in raw.get("elements", []):
        if element["type"] == "node":
            coords[element["id"]] = (element["lat"], element["lon"])
        elif element["type"] == "way" and _drivable(element.get("tags", {})):
            ways.append(element)

    use_count: dict[int, int] = defaultdict(int)
    for way in ways:
        for node_id in way["nodes"]:
            use_count[node_id] += 1

    vertex_index: dict[int, int] = {}
    vertices: list[list[float]] = []

    def vertex(node_id: int) -> int:
        if node_id not in vertex_index:
            vertex_index[node_id] = len(vertices)
            lat, lon = coords[node_id]
            vertices.append([round(lat, 6), round(lon, 6)])
        return vertex_index[node_id]

    edges: list[list[Any]] = []
    for way in ways:
        tags = way.get("tags", {})
        nodes = [n for n in way["nodes"] if n in coords]
        if len(nodes) < 2:
            continue
        direction = _oneway(tags)
        if direction == -1:
            nodes.reverse()
        speed = _tagged_speed_kmh(tags)
        name = tags.get("name") or tags.get("ref") or ""
        highway = tags["highway"]
        start = 0
        for index in range(1, len(nodes)):
            is_vertex = index == len(nodes) - 1 or use_count[nodes[index]] > 1
            if not is_vertex:
                continue
            chain = nodes[start : index + 1]
            length = 0.0
            for a, b in zip(chain, chain[1:], strict=False):
                length += _dist_m(*coords[a], *coords[b])
            shape = [[round(coords[n][0], 6), round(coords[n][1], 6)] for n in chain[1:-1]]
            edges.append(
                [
                    vertex(chain[0]),
                    vertex(chain[-1]),
                    round(length, 1),
                    round(speed, 1),
                    1 if direction else 0,
                    name,
                    highway,
                    shape,
                ]
            )
            start = index
    return {
        "format": GRAPH_FORMAT,
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "osm_timestamp": raw.get("osm3s", {}).get("timestamp_osm_base", ""),
        "vertices": vertices,
        "edges": edges,
    }


def build_graph(
    bounds: tuple[float, float, float, float],
    out_path: Path = DEFAULT_GRAPH_PATH,
    raw_path: Path | None = None,
) -> dict[str, int]:
    """Download (unless ``raw_path`` exists) and write the compact graph file."""
    raw_path = raw_path or out_path.with_name("philly_osm_raw.json")
    if not raw_path.exists():
        download_osm(bounds, raw_path)
    with raw_path.open(encoding="utf-8") as handle:
        raw = json.load(handle)
    document = compact_osm(raw)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(out_path, "wt", encoding="utf-8", compresslevel=9) as handle:
        json.dump(document, handle, separators=(",", ":"))
    return {"vertices": len(document["vertices"]), "edges": len(document["edges"])}


# --------------------------------------------------------------------------- runtime


@dataclass
class SmoothRoute:
    coordinates: list[list[float]]  # [lon, lat] pairs, GeoJSON order
    meters: float
    seconds: float
    penalty_seconds: float
    report_ids: list[Any]
    via: list[dict[str, float]]  # waypoints with bearings, for a legal-turn snap
    streets: list[dict[str, Any]] = field(default_factory=list)  # simple directions


class StreetGraph:
    """The in-memory street network plus the spatial indexes the router needs."""

    def __init__(self, document: dict[str, Any]) -> None:
        if document.get("format") != GRAPH_FORMAT:
            raise GraphError("Unsupported graph file format; rebuild it.")
        self.built = document.get("built", "")
        self.osm_timestamp = document.get("osm_timestamp", "")
        self.vertices: list[list[float]] = document["vertices"]
        self.edges: list[list[Any]] = document["edges"]
        self.xy = [_project(lat, lon) for lat, lon in self.vertices]
        # Travel time per edge, in seconds.
        self.seconds = [edge_seconds(e[2], e[3], e[6]) for e in self.edges]
        # Adjacency: vertex -> list of (edge index, neighbour, forward?)
        self.out: list[list[tuple[int, int, bool]]] = [[] for _ in self.vertices]
        for index, (u, v, _length, _speed, oneway, *_rest) in enumerate(self.edges):
            self.out[u].append((index, v, True))
            if not oneway:
                self.out[v].append((index, u, False))
        self._vertex_cells: dict[tuple[int, int], list[int]] = defaultdict(list)
        for index, (lat, lon) in enumerate(self.vertices):
            self._vertex_cells[_cell(lat, lon)].append(index)
        self._edge_cells: dict[tuple[int, int], list[int]] = defaultdict(list)
        for index in range(len(self.edges)):
            seen: set[tuple[int, int]] = set()
            for lat, lon in self.edge_points(index):
                cell = _cell(lat, lon)
                if cell not in seen:
                    seen.add(cell)
                    self._edge_cells[cell].append(index)

    # ----- loading -----
    @classmethod
    def load(cls, path: Path = DEFAULT_GRAPH_PATH) -> StreetGraph:
        if not Path(path).exists():
            raise GraphError(
                f"Street graph file not found at {path}. "
                "Run `python -m pothole_agent.streetgraph build` to create it."
            )
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            return cls(json.load(handle))

    # ----- geometry helpers -----
    def edge_points(self, index: int, forward: bool = True) -> list[list[float]]:
        """All [lat, lon] points of an edge, from u to v (or reversed)."""
        u, v, _l, _s, _o, _n, _h, shape = self.edges[index]
        points = [self.vertices[u], *shape, self.vertices[v]]
        return points if forward else points[::-1]

    def nearest_vertex(self, lat: float, lon: float, max_m: float = SNAP_MAX_M) -> int:
        px, py = _project(lat, lon)
        row, col = _cell(lat, lon)
        best, best_d = -1, max_m
        for ring in range(0, 3):
            for dr in range(-ring, ring + 1):
                for dc in range(-ring, ring + 1):
                    if max(abs(dr), abs(dc)) != ring:
                        continue
                    for index in self._vertex_cells.get((row + dr, col + dc), ()):
                        x, y = self.xy[index]
                        d = math.hypot(px - x, py - y)
                        if d < best_d:
                            best, best_d = index, d
            if best >= 0:
                return best
        raise GraphError("That point is too far from any street in the graph.")

    def edges_near(self, lat: float, lon: float, radius_m: float = MATCH_RADIUS_M) -> list[int]:
        """Edges whose centreline passes within radius_m of a point."""
        px, py = _project(lat, lon)
        row, col = _cell(lat, lon)
        reach = int(math.ceil(radius_m / (_CELL_DEG * _M_PER_DEG_LAT))) + 1
        found: list[int] = []
        seen: set[int] = set()
        for dr in range(-reach, reach + 1):
            for dc in range(-reach, reach + 1):
                for index in self._edge_cells.get((row + dr, col + dc), ()):
                    if index in seen:
                        continue
                    seen.add(index)
                    points = [_project(a, b) for a, b in self.edge_points(index)]
                    for (ax, ay), (bx, by) in zip(points, points[1:], strict=False):
                        if _point_segment_distance(px, py, ax, ay, bx, by) <= radius_m:
                            found.append(index)
                            break
        return found

    # ----- penalties -----
    @staticmethod
    def age_weight(days_open: float | None) -> float:
        if days_open is None:
            return 1.0
        for limit, weight in AGE_WEIGHTS:
            if days_open <= limit:
                return weight
        return AGE_WEIGHTS[-1][1]

    def penalties(
        self, reports: Iterable[dict[str, Any]], avoidance: str = DEFAULT_AVOIDANCE
    ) -> tuple[dict[int, float], dict[int, list[Any]]]:
        """Map each report onto the street edges it sits on.

        Returns (edge -> penalty seconds, edge -> report ids). A report that
        touches several edges (an intersection) penalises all of them: every
        way through that corner is rough.
        """
        per_report = PENALTY_SECONDS.get(avoidance, PENALTY_SECONDS[DEFAULT_AVOIDANCE])
        penalty: dict[int, float] = defaultdict(float)
        matched: dict[int, list[Any]] = defaultdict(list)
        for report in reports:
            lat, lon = report.get("lat"), report.get("lon")
            if lat is None or lon is None:
                continue
            weight = per_report * self.age_weight(report.get("days_open"))
            for edge in self.edges_near(float(lat), float(lon)):
                penalty[edge] += weight
                matched[edge].append(report.get("id"))
        return dict(penalty), dict(matched)

    # ----- search -----
    def route(
        self,
        start_lat: float,
        start_lon: float,
        end_lat: float,
        end_lon: float,
        penalty: dict[int, float] | None = None,
        matched: dict[int, list[Any]] | None = None,
    ) -> SmoothRoute:
        """A* on travel time plus pothole penalties. Raises GraphError if unreachable.

        The search state is (vertex, edge we arrived by) so that turns can cost
        more than going straight; -1 stands for "just started".
        """
        penalty = penalty or {}
        matched = matched or {}
        source = self.nearest_vertex(start_lat, start_lon)
        target = self.nearest_vertex(end_lat, end_lon)
        tx, ty = self.xy[target]

        def heuristic(vertex: int) -> float:
            x, y = self.xy[vertex]
            return math.hypot(x - tx, y - ty) / MAX_SPEED_MPS

        State = tuple[int, int]
        origin: State = (source, -1)
        best: dict[State, float] = {origin: 0.0}
        came_from: dict[State, tuple[State, bool]] = {}
        frontier: list[tuple[float, float, State]] = [(heuristic(source), 0.0, origin)]
        closed: set[State] = set()
        goal: State | None = origin if source == target else None
        while frontier and goal is None:
            _f, cost, state = heapq.heappop(frontier)
            if state in closed:
                continue
            closed.add(state)
            vertex, arrived_by = state
            prev_edge = self.edges[arrived_by] if arrived_by >= 0 else None
            for edge, neighbour, forward in self.out[vertex]:
                if edge == arrived_by:
                    continue  # no immediate U-turns
                data = self.edges[edge]
                new_cost = (
                    cost
                    + self.seconds[edge]
                    + junction_seconds(prev_edge, data)
                    + penalty.get(edge, 0.0)
                )
                next_state: State = (neighbour, edge)
                if new_cost < best.get(next_state, math.inf):
                    best[next_state] = new_cost
                    came_from[next_state] = (state, forward)
                    if neighbour == target:
                        goal = next_state  # first time we settle the target wins
                        break
                    heapq.heappush(
                        frontier, (new_cost + heuristic(neighbour), new_cost, next_state)
                    )
        if goal is None:
            raise GraphError("No drivable path between those points in the street graph.")

        steps: list[tuple[int, bool]] = []
        state = goal
        while state != origin:
            prev_state, forward = came_from[state]
            steps.append((state[1], forward))
            state = prev_state
        steps.reverse()
        return self._assemble(
            steps, source, (start_lat, start_lon), (end_lat, end_lon), penalty, matched
        )

    def _assemble(
        self,
        steps: list[tuple[int, bool]],
        source: int,
        start: tuple[float, float],
        end: tuple[float, float],
        penalty: dict[int, float],
        matched: dict[int, list[Any]],
    ) -> SmoothRoute:
        points: list[list[float]] = [list(self.vertices[source])]
        meters = seconds = penalised = 0.0
        report_ids: list[Any] = []
        streets: list[dict[str, Any]] = []
        via: list[dict[str, float]] = []
        prev_edge: list[Any] | None = None
        for edge, forward in steps:
            segment = self.edge_points(edge, forward)
            points.extend(segment[1:])
            length = self.edges[edge][2]
            meters += length
            seconds += self.seconds[edge] + junction_seconds(prev_edge, self.edges[edge])
            prev_edge = self.edges[edge]
            penalised += penalty.get(edge, 0.0)
            report_ids.extend(matched.get(edge, []))
            name = self.edges[edge][5] or self.edges[edge][6].replace("_", " ")
            if streets and streets[-1]["name"] == name:
                streets[-1]["meters"] += length
            else:
                streets.append({"name": name, "meters": length})
            mid = segment[len(segment) // 2]
            bearing = _bearing(segment[0], segment[-1])
            via.append({"lat": mid[0], "lon": mid[1], "bearing": bearing, "meters": length})
        # Straight connectors from the true endpoints to the snapped intersections,
        # so the drawn line starts and ends where the user asked.
        coordinates = [[start[1], start[0]]] + [[p[1], p[0]] for p in points] + [[end[1], end[0]]]
        for s in streets:
            s["meters"] = round(s["meters"])
        return SmoothRoute(
            coordinates=coordinates,
            meters=round(meters, 1),
            seconds=round(seconds, 1),
            penalty_seconds=round(penalised, 1),
            report_ids=report_ids,
            via=_thin_via(via),
            streets=streets,
        )


def _bearing(a: list[float], b: list[float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    d_lon = lon2 - lon1
    x = math.sin(d_lon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(d_lon)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


VIA_SPACING_M = 900.0
MIN_VIA_METERS = 60.0  # slivers at interchanges make poor waypoints


def _thin_via(via: list[dict[str, float]], max_points: int = 10) -> list[dict[str, float]]:
    """Pick the waypoints that pin the route down for the OSRM snap.

    One waypoint per ~900 m of route, each the longest segment in its stretch:
    a point on a long run of Broad St unambiguously means "use Broad St", while
    one on a 20 m sliver at an interchange can snap to the wrong ramp. Fewer,
    better-placed points also mean fewer chances for OSRM to double back.
    """
    total = sum(v["meters"] for v in via)
    buckets = max(1, min(max_points, int(total // VIA_SPACING_M)))
    chosen: list[dict[str, float]] = []
    travelled = 0.0
    bucket_best: dict[int, int] = {}
    usable = any(v["meters"] >= MIN_VIA_METERS for v in via)
    for index, point in enumerate(via):
        bucket = min(buckets - 1, int(travelled / max(total, 1.0) * buckets))
        travelled += point["meters"]
        if usable and point["meters"] < MIN_VIA_METERS:
            continue
        best = bucket_best.get(bucket)
        if best is None or via[best]["meters"] < point["meters"]:
            bucket_best[bucket] = index
    for index in sorted(bucket_best.values()):
        point = via[index]
        chosen.append({"lat": point["lat"], "lon": point["lon"], "bearing": point["bearing"]})
    return chosen


# --------------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> None:
    import argparse

    from .routing import PHILLY_BOUNDS

    parser = argparse.ArgumentParser(description="Build the Philadelphia street graph.")
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build", help="download OSM data and write data/philly_graph.json.gz")
    build.add_argument("--out", type=Path, default=DEFAULT_GRAPH_PATH)
    build.add_argument("--raw", type=Path, default=None, help="reuse a raw Overpass JSON file")
    args = parser.parse_args(argv)
    if args.command == "build":
        started = time.monotonic()
        stats = build_graph(PHILLY_BOUNDS, args.out, args.raw)
        size_mb = args.out.stat().st_size / 1e6
        print(
            f"Wrote {args.out} ({size_mb:.1f} MB): {stats['vertices']:,} intersections, "
            f"{stats['edges']:,} street segments in {time.monotonic() - started:.0f}s."
        )


if __name__ == "__main__":
    main()
