"""Geocoding, routing, and pothole lookup along a route.

All SQL in this module is built by our own code from validated numbers. The
language model never writes it, so nothing here can be steered by a prompt.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import requests

from .tools import CARTO_URL, TIMEOUT_SECONDS

CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving"
USER_AGENT = "potholejawn/1.0 (+https://potholejawn.com)"

# Rough bounding box around Philadelphia: (min_lat, max_lat, min_lon, max_lon)
PHILLY_BOUNDS = (39.85, 40.15, -75.30, -74.94)
MAX_ADDRESS_CHARS = 200
MAX_ROUTE_POINTS = 1500
MIN_BUFFER_M, MAX_BUFFER_M, DEFAULT_BUFFER_M = 10, 100, 30
LOOKBACK_DAYS = 365
CITYWIDE_LIMIT = 5000  # safety cap on the citywide open-report query (~1,500 today)
METERS_PER_MILE = 1609.344


class RoutingError(ValueError):
    """A problem the user can fix, such as an address we could not find."""


@dataclass
class Route:
    route_id: str
    miles: float
    minutes: float
    coordinates: list[list[float]]  # [lon, lat] pairs, GeoJSON order
    potholes: list[dict[str, Any]] | None = field(default=None)
    kind: str = "fast"  # "fast": a time-optimal OSRM route; "smooth": pothole-aware
    steps: list[dict[str, Any]] = field(default_factory=list)  # turn-by-turn directions
    source: str = "osrm"  # "osrm" or "graph" (own router, when OSRM could not snap)
    via: list[dict[str, float]] = field(default_factory=list)  # waypoints that define it

    def summary(self) -> dict[str, Any]:
        """Small description that is safe to hand to the model (no geometry)."""
        return {
            "route_id": self.route_id,
            "kind": self.kind,
            "miles": self.miles,
            "minutes": self.minutes,
        }


def in_philadelphia(lat: float, lon: float) -> bool:
    min_lat, max_lat, min_lon, max_lon = PHILLY_BOUNDS
    return min_lat <= lat <= max_lat and min_lon <= lon <= max_lon


def _clean_address(address: str) -> str:
    if not isinstance(address, str) or not address.strip():
        raise RoutingError("Enter an address.")
    address = " ".join(address.split())[:MAX_ADDRESS_CHARS]
    if "philadelphia" not in address.lower() and "phila" not in address.lower():
        address += ", Philadelphia, PA"
    return address


def _geocode_census(address: str) -> dict[str, Any] | None:
    params = {"address": address, "benchmark": "Public_AR_Current", "format": "json"}
    response = requests.get(CENSUS_URL, params=params, timeout=TIMEOUT_SECONDS)
    matches = response.json().get("result", {}).get("addressMatches", [])
    if not matches:
        return None
    best = matches[0]
    return {
        "lat": float(best["coordinates"]["y"]),
        "lon": float(best["coordinates"]["x"]),
        "matched_address": best["matchedAddress"],
        "source": "US Census geocoder",
    }


def _geocode_nominatim(address: str) -> dict[str, Any] | None:
    params = {"q": address, "format": "json", "limit": 1, "countrycodes": "us"}
    headers = {"User-Agent": USER_AGENT}
    response = requests.get(NOMINATIM_URL, params=params, headers=headers, timeout=TIMEOUT_SECONDS)
    results = response.json()
    if not results:
        return None
    best = results[0]
    return {
        "lat": float(best["lat"]),
        "lon": float(best["lon"]),
        "matched_address": best["display_name"],
        "source": "OpenStreetMap Nominatim",
    }


# "lat, lon" pairs (e.g. from the browser's geolocation) skip the geocoders.
_COORD_RE = re.compile(r"^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$")


def geocode(address: str) -> dict[str, Any]:
    """Turn an address, place name, or "lat, lon" pair into Philly coordinates."""
    if isinstance(address, str):
        match = _COORD_RE.match(address)
        if match:
            lat, lon = float(match.group(1)), float(match.group(2))
            if not in_philadelphia(lat, lon):
                raise RoutingError(
                    "Those coordinates are outside Philadelphia. "
                    "This tool only covers trips inside the city."
                )
            return {
                "lat": lat,
                "lon": lon,
                "matched_address": f"{lat:.5f}, {lon:.5f} (pinned location)",
                "source": "device coordinates",
            }
    cleaned = _clean_address(address)
    for lookup in (_geocode_census, _geocode_nominatim):
        try:
            found = lookup(cleaned)
        except (requests.RequestException, ValueError, KeyError):
            found = None
        if found and in_philadelphia(found["lat"], found["lon"]):
            return found
    raise RoutingError(
        f"Could not find '{address}' in Philadelphia. Try a street address ('1500 Market St'), "
        "an intersection ('Broad St & Oregon Ave'), or a landmark ('30th Street Station')."
    )


def _check_point(lat: float, lon: float) -> tuple[float, float]:
    lat, lon = float(lat), float(lon)
    if not in_philadelphia(lat, lon):
        raise RoutingError("This tool only covers trips inside Philadelphia.")
    return lat, lon


_MANEUVER_TEXT = {
    "depart": "Head {dir}on {name}",
    "arrive": "Arrive at your destination",
    "turn": "Turn {mod} onto {name}",
    "new name": "Continue onto {name}",
    "continue": "Continue {mod} on {name}",
    "merge": "Merge {mod} onto {name}",
    "on ramp": "Take the ramp {mod} onto {name}",
    "off ramp": "Take the exit {mod} onto {name}",
    "fork": "Keep {mod} onto {name}",
    "end of road": "At the end of the road turn {mod} onto {name}",
    "roundabout": "Enter the roundabout and take the exit onto {name}",
    "rotary": "Enter the rotary and take the exit onto {name}",
    "exit roundabout": "Exit the roundabout onto {name}",
    "exit rotary": "Exit the rotary onto {name}",
}
_COMPASS = {
    "north": "N",
    "south": "S",
    "east": "E",
    "west": "W",
    "northeast": "NE",
    "northwest": "NW",
    "southeast": "SE",
    "southwest": "SW",
}


def _bearing_to_compass(bearing: float) -> str:
    names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
    return names[int(((bearing % 360) + 22.5) // 45) % 8]


def _describe_step(step: dict[str, Any]) -> dict[str, Any] | None:
    """Turn one OSRM step into a short instruction. Returns None for no-ops."""
    maneuver = step.get("maneuver", {})
    kind = maneuver.get("type", "")
    modifier = str(maneuver.get("modifier", "")).replace("slight ", "slightly ")
    name = step.get("name") or ""
    ref = step.get("ref") or ""
    if name and ref:
        name = f"{name} ({ref})"
    elif ref:
        name = ref
    template = _MANEUVER_TEXT.get(kind)
    if template is None:
        return None
    if kind == "depart":
        direction = _bearing_to_compass(maneuver.get("bearing_after", 0))
        text = template.format(dir=f"{direction} ", name=name or "the unnamed road")
    else:
        text = template.format(mod=modifier or "straight", name=name)
        if not name:  # ramps and exits are often unnamed: "Take the exit right"
            text = text.replace(" onto ", "").replace(" on ", "").rstrip()
    text = text.replace("  ", " ").replace("Continue straight on", "Continue on")
    location = maneuver.get("location")  # [lon, lat] where the maneuver happens
    return {
        "text": text,
        "miles": round(step.get("distance", 0.0) / METERS_PER_MILE, 2),
        "minutes": round(step.get("duration", 0.0) / 60, 1),
        "location": [round(float(location[0]), 6), round(float(location[1]), 6)]
        if isinstance(location, list) and len(location) == 2
        else None,
        "modifier": str(maneuver.get("modifier", "")) if kind != "arrive" else "arrive",
    }


def _route_from_osrm(raw: dict[str, Any], route_id: str, kind: str = "fast") -> Route:
    steps = []
    for leg in raw.get("legs", []):
        for step in leg.get("steps", []):
            described = _describe_step(step)
            if described is None:
                continue
            # Via-point legs produce an "arrive"/"depart" pair mid-route; drop them.
            if steps and described["text"].startswith(("Arrive", "Head")):
                continue
            if steps and described["miles"] == 0 and described["text"] == steps[-1]["text"]:
                continue
            steps.append(described)
    if steps and not steps[-1]["text"].startswith("Arrive"):
        last = raw["geometry"]["coordinates"][-1]
        steps.append(
            {
                "text": "Arrive at your destination",
                "miles": 0.0,
                "minutes": 0.0,
                "location": [round(last[0], 6), round(last[1], 6)],
                "modifier": "arrive",
            }
        )
    return Route(
        route_id=route_id,
        kind=kind,
        miles=round(raw["distance"] / METERS_PER_MILE, 1),
        minutes=max(1, round(raw["duration"] / 60)),
        coordinates=raw["geometry"]["coordinates"],
        steps=steps,
    )


def _osrm(coords: str, params: dict[str, str]) -> dict[str, Any]:
    response = requests.get(
        f"{OSRM_URL}/{coords}",
        params={"overview": "full", "geometries": "geojson", "steps": "true", **params},
        headers={"User-Agent": USER_AGENT},
        timeout=TIMEOUT_SECONDS,
    )
    return response.json()


def fetch_routes(start_lat: float, start_lon: float, end_lat: float, end_lon: float) -> list[Route]:
    """Ask OSRM for the main driving route plus alternatives, with directions."""
    start_lat, start_lon = _check_point(start_lat, start_lon)
    end_lat, end_lon = _check_point(end_lat, end_lon)
    coords = f"{start_lon:.6f},{start_lat:.6f};{end_lon:.6f},{end_lat:.6f}"
    payload = _osrm(coords, {"alternatives": "3"})
    if payload.get("code") != "Ok" or not payload.get("routes"):
        raise RoutingError("No driving route found between those two places.")
    return [
        _route_from_osrm(raw, "ABCD"[index] if index < 4 else str(index))
        for index, raw in enumerate(payload["routes"])
    ]


MAX_VIA_POINTS = 10


def fetch_route_via(
    start: tuple[float, float],
    end: tuple[float, float],
    via: list[dict[str, float]],
    route_id: str = "S",
) -> Route | None:
    """Ask OSRM for a legal, turn-restricted route through our chosen waypoints.

    Each via point carries the bearing of travel on its street, which stops
    OSRM from snapping to the opposite carriageway and doubling back. Returns
    None when OSRM cannot route it; the caller then falls back to the graph
    geometry.
    """
    start_lat, start_lon = _check_point(*start)
    end_lat, end_lon = _check_point(*end)
    points = [(start_lon, start_lat, None)]
    for point in via[:MAX_VIA_POINTS]:
        lat, lon = _check_point(point["lat"], point["lon"])
        points.append((lon, lat, float(point["bearing"])))
    points.append((end_lon, end_lat, None))
    coords = ";".join(f"{lon:.6f},{lat:.6f}" for lon, lat, _ in points)
    bearings = ";".join("" if b is None else f"{int(round(b)) % 360},25" for _, _, b in points)
    try:
        payload = _osrm(coords, {"bearings": bearings, "continue_straight": "true"})
    except (requests.RequestException, ValueError):
        return None
    if payload.get("code") != "Ok" or not payload.get("routes"):
        return None
    route = _route_from_osrm(payload["routes"][0], route_id, kind="smooth")
    route.via = list(via[:MAX_VIA_POINTS])
    return route


def _thin(coordinates: list[list[float]]) -> list[list[float]]:
    """Keep very long routes under MAX_ROUTE_POINTS so the query stays small."""
    if len(coordinates) <= MAX_ROUTE_POINTS:
        return coordinates
    stride = len(coordinates) // MAX_ROUTE_POINTS + 1
    thinned = coordinates[::stride]
    if thinned[-1] != coordinates[-1]:
        thinned.append(coordinates[-1])
    return thinned


def build_pothole_sql(coordinates: list[list[float]], buffer_m: int = DEFAULT_BUFFER_M) -> str:
    """Build the PostGIS query. Every interpolated value is a validated number."""
    if len(coordinates) < 2:
        raise RoutingError("A route needs at least two points.")
    buffer_m = max(MIN_BUFFER_M, min(MAX_BUFFER_M, int(buffer_m)))
    safe = [[round(float(lon), 5), round(float(lat), 5)] for lon, lat in _thin(coordinates)]
    line_json = json.dumps({"type": "LineString", "coordinates": safe}, separators=(",", ":"))
    line = f"ST_SetSRID(ST_GeomFromGeoJSON('{line_json}'), 4326)"
    return (
        "SELECT service_request_id, address, requested_datetime, lat, lon, "
        f"ROUND(ST_Distance(the_geom::geography, {line}::geography)::numeric, 1) "
        "AS meters_from_route, "
        f"ROUND(ST_LineLocatePoint({line}, the_geom)::numeric, 4) AS position "
        "FROM public_cases_fc "
        "WHERE service_name = 'Street Defect' AND status = 'Open' "
        f"AND requested_datetime >= NOW() - INTERVAL '{LOOKBACK_DAYS} days' "
        "AND the_geom IS NOT NULL "
        f"AND ST_DWithin(the_geom::geography, {line}::geography, {buffer_m}) "
        "ORDER BY position LIMIT 300"
    )


def build_bbox_sql(south: float, west: float, north: float, east: float, limit: int = 1500) -> str:
    """Open-report query for a map viewport. Every interpolated value is a validated number,
    clamped to the Philadelphia bounding box."""
    min_lat, max_lat, min_lon, max_lon = PHILLY_BOUNDS
    south = max(min_lat, min(max_lat, float(south)))
    north = max(min_lat, min(max_lat, float(north)))
    west = max(min_lon, min(max_lon, float(west)))
    east = max(min_lon, min(max_lon, float(east)))
    if south > north or west > east:
        raise RoutingError("Bounding box is inverted.")
    limit = max(1, min(CITYWIDE_LIMIT, int(limit)))
    return (
        "SELECT service_request_id, address, requested_datetime, lat, lon "
        "FROM public_cases_fc "
        "WHERE service_name = 'Street Defect' AND status = 'Open' "
        f"AND requested_datetime >= NOW() - INTERVAL '{LOOKBACK_DAYS} days' "
        "AND the_geom IS NOT NULL "
        f"AND lat BETWEEN {round(south, 5)} AND {round(north, 5)} "
        f"AND lon BETWEEN {round(west, 5)} AND {round(east, 5)} "
        f"ORDER BY requested_datetime DESC LIMIT {limit}"
    )


def _report_rows(sql: str) -> list[dict[str, Any]]:
    response = requests.post(CARTO_URL, data={"q": sql}, timeout=TIMEOUT_SECONDS)
    payload = response.json()
    if response.status_code != 200 or "error" in payload:
        raise RuntimeError(f"City data error: {payload.get('error', response.text[:200])}")
    now = datetime.now(UTC)
    potholes = []
    for row in payload.get("rows", []):
        reported = datetime.fromisoformat(row["requested_datetime"].replace("Z", "+00:00"))
        potholes.append(
            {
                "id": row["service_request_id"],
                "address": row["address"] or "Unknown address",
                "lat": row["lat"],
                "lon": row["lon"],
                "reported": reported.date().isoformat(),
                "days_open": (now - reported).days,
            }
        )
    return potholes


def potholes_in_bbox(south: float, west: float, north: float, east: float) -> list[dict[str, Any]]:
    """All open 'Street Defect' reports inside a map viewport, newest first."""
    return _report_rows(build_bbox_sql(south, west, north, east))


def open_reports_citywide() -> list[dict[str, Any]]:
    """Every open 'Street Defect' report in the city from the last 12 months.

    This is what the pothole-aware router penalises. About 1,500 rows today;
    the limit is a safety cap, not an expected size.
    """
    min_lat, max_lat, min_lon, max_lon = PHILLY_BOUNDS
    return _report_rows(build_bbox_sql(min_lat, min_lon, max_lat, max_lon, limit=CITYWIDE_LIMIT))


def potholes_along(route: Route, buffer_m: int = DEFAULT_BUFFER_M) -> list[dict[str, Any]]:
    """Open 'Street Defect' reports within buffer_m meters of the route, in driving order."""
    sql = build_pothole_sql(route.coordinates, buffer_m)
    response = requests.post(CARTO_URL, data={"q": sql}, timeout=TIMEOUT_SECONDS)
    payload = response.json()
    if response.status_code != 200 or "error" in payload:
        raise RuntimeError(f"City data error: {payload.get('error', response.text[:200])}")
    now = datetime.now(UTC)
    potholes = []
    for row in payload.get("rows", []):
        reported = datetime.fromisoformat(row["requested_datetime"].replace("Z", "+00:00"))
        potholes.append(
            {
                "id": row["service_request_id"],
                "address": row["address"] or "Unknown address",
                "lat": row["lat"],
                "lon": row["lon"],
                "reported": reported.date().isoformat(),
                "days_open": (now - reported).days,
                "meters_from_route": row["meters_from_route"],
                "mile_marker": round(float(row["position"]) * route.miles, 1),
            }
        )
    return potholes
