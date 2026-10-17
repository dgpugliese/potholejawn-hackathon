"""Trip planning: find routes, scan them for potholes, recommend one.

Plain Python end to end, no model call: geocode both ends, fetch OSRM's
fastest routes, plan the smooth route on the street graph, scan every route
against the city's live 311 data, score, and write a briefing from the numbers.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .routing import (
    DEFAULT_BUFFER_M,
    Route,
    RoutingError,
    fetch_routes,
    geocode,
    potholes_along,
)
from .smooth import DEFAULT_AVOIDANCE, SMOOTH_ROUTE_ID, normalize_avoidance, pick_route
from .smooth import smooth_route as plan_smooth_route
from .streetgraph import GraphError

STRETCH_MILES = 0.5  # window used to find the roughest part of a route


class TripContext:
    """Holds the state of one trip so each step can build on the last."""

    def __init__(self, avoidance: str = DEFAULT_AVOIDANCE) -> None:
        self.avoidance = normalize_avoidance(avoidance)
        self.places: dict[str, dict[str, Any]] = {}
        self.routes: dict[str, Route] = {}
        self.recommended: str | None = None
        self.reason: str = ""
        self.smooth_error: str | None = None

    def geocode_address(self, address: str, role: str = "") -> dict[str, Any]:
        found = geocode(address)
        key = (
            role if role in ("start", "end") else ("start" if "start" not in self.places else "end")
        )
        self.places[key] = found
        return {"role": key, **found}

    def find_routes(
        self, start_lat: float, start_lon: float, end_lat: float, end_lon: float
    ) -> dict[str, Any]:
        routes = fetch_routes(start_lat, start_lon, end_lat, end_lon)
        smooth = self.routes.get(SMOOTH_ROUTE_ID)
        self.routes = {route.route_id: route for route in routes}
        if smooth is not None:  # keep a smooth route planned before this call
            self.routes[SMOOTH_ROUTE_ID] = smooth
        return {"routes": [route.summary() for route in routes]}

    def find_smooth_route(
        self, start_lat: float, start_lon: float, end_lat: float, end_lon: float
    ) -> dict[str, Any]:
        try:
            route = plan_smooth_route(
                start_lat, start_lon, end_lat, end_lon, avoidance=self.avoidance
            )
        except GraphError as error:
            self.smooth_error = str(error)
            raise RoutingError(f"Smooth router unavailable: {error}") from error
        self.routes[route.route_id] = route
        return {
            **route.summary(),
            "avoidance": self.avoidance,
            "snapped_to_road_network": route.source == "osrm",
        }

    def scan_route(self, route_id: str, buffer_m: int = DEFAULT_BUFFER_M) -> dict[str, Any]:
        route = self.routes.get(route_id)
        if route is None:
            raise RoutingError(f"Unknown route_id '{route_id}'. Known: {sorted(self.routes)}")
        route.potholes = potholes_along(route, buffer_m)
        return {**route.summary(), "open_reports": len(route.potholes)}

    def ensure_complete(self) -> None:
        """Plan and scan anything still missing, then pick, so the map is never half-drawn."""
        start, end = self.places.get("start"), self.places.get("end")
        if SMOOTH_ROUTE_ID not in self.routes and self.smooth_error is None and start and end:
            try:
                self.find_smooth_route(start["lat"], start["lon"], end["lat"], end["lon"])
            except RoutingError:
                pass  # smooth_error records why; the fast routes still work
        for route in self.routes.values():
            if route.potholes is None:
                route.potholes = potholes_along(route)
        if self.recommended not in self.routes and self.routes:
            best = pick_route(list(self.routes.values()), self.avoidance)
            self.recommended = best.route_id
            self.reason = "Best balance of open pothole reports and drive time."

    def fastest(self) -> Route | None:
        fast = [r for r in self.routes.values() if r.kind == "fast"]
        return min(fast, key=lambda r: r.minutes) if fast else None

    def comparison(self) -> dict[str, Any] | None:
        """How the recommended route compares with the fastest one, for the UI."""
        chosen = self.routes.get(self.recommended or "")
        fastest = self.fastest()
        if chosen is None or fastest is None or chosen is fastest:
            return None
        return {
            "against": fastest.route_id,
            "reports_avoided": len(fastest.potholes or []) - len(chosen.potholes or []),
            "extra_minutes": round(chosen.minutes - fastest.minutes),
            "extra_miles": round(chosen.miles - fastest.miles, 1),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "start": self.places.get("start"),
            "end": self.places.get("end"),
            "recommended": self.recommended,
            "reason": self.reason,
            "avoidance": self.avoidance,
            "smooth_error": self.smooth_error,
            "comparison": self.comparison(),
            "routes": [
                {
                    **route.summary(),
                    "source": route.source,
                    "coordinates": route.coordinates,
                    "steps": route.steps,
                    "via": route.via,
                    "potholes": route.potholes or [],
                }
                for route in self.routes.values()
            ],
        }


def worst_stretch(potholes: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The half-mile window with the most reports, if any window has two or more."""
    markers = sorted(float(p["mile_marker"]) for p in potholes if "mile_marker" in p)
    best_start, best_count = None, 1
    for i, start in enumerate(markers):
        count = sum(1 for m in markers[i:] if m <= start + STRETCH_MILES)
        if count > best_count:
            best_start, best_count = start, count
    if best_start is None:
        return None
    inside = [
        p for p in potholes if best_start <= float(p["mile_marker"]) <= best_start + STRETCH_MILES
    ]
    return {"from_mile": best_start, "count": best_count, "address": inside[0]["address"]}


def briefing(context: TripContext) -> str:
    """A plain-language summary written from the numbers, nothing invented."""
    route = context.routes[context.recommended]
    potholes = route.potholes or []
    label = "The smooth route" if route.kind == "smooth" else f"Route {route.route_id}"
    if not potholes:
        text = (
            f"{label} ({route.miles} mi, about {route.minutes} min) has no open "
            "pothole reports from the last 12 months."
        )
    else:
        oldest = max(potholes, key=lambda p: p["days_open"])
        plural = "s" if len(potholes) != 1 else ""
        text = (
            f"{label} ({route.miles} mi, about {route.minutes} min) passes "
            f"{len(potholes)} open pothole report{plural}."
        )
        stretch = worst_stretch(potholes)
        if stretch:
            text += (
                f" The roughest stretch starts around mile {stretch['from_mile']}, near "
                f"{stretch['address']}, with {stretch['count']} reports in half a mile."
            )
        text += (
            f" The oldest report is near {oldest['address']} around mile "
            f"{oldest['mile_marker']}, open for {oldest['days_open']} days."
        )
    comparison = context.comparison()
    if comparison and comparison["reports_avoided"] > 0:
        extra = comparison["extra_minutes"]
        plural = "s" if extra != 1 else ""
        cost = f"about {extra} extra minute{plural}" if extra > 0 else "no extra time"
        text += (
            f" Compared with the fastest route ({comparison['against']}), it avoids "
            f"{comparison['reports_avoided']} reported pothole"
            f"{'s' if comparison['reports_avoided'] != 1 else ''} for {cost}."
        )
    if context.smooth_error:
        text += (
            " The pothole-aware router was unavailable, so only the standard routes were compared."
        )
    return text


def plan_trip(
    start: str,
    end: str,
    on_step: Callable[[dict[str, Any]], None] | None = None,
    avoidance: str = DEFAULT_AVOIDANCE,
) -> dict[str, Any]:
    """Plan a trip. Returns routes, potholes, a recommendation, and the steps taken.

    ``on_step`` (optional) is called with each step as it happens, so a caller
    can stream progress to a UI while the run is still in flight.
    ``avoidance`` ("balanced" or "strong") sets how much time a pothole is worth.
    """
    context = TripContext(avoidance)
    steps: list[dict[str, Any]] = []

    def record(text: str) -> None:
        event = {"type": "step", "text": text}
        steps.append(event)
        if on_step:
            on_step(event)

    record(f"Looking up '{start}' and '{end}'.")
    first = context.geocode_address(start, "start")
    last = context.geocode_address(end, "end")
    record("Fetching the fastest driving routes.")
    context.find_routes(first["lat"], first["lon"], last["lat"], last["lon"])
    record("Planning a smooth route around every open pothole report.")
    try:
        context.find_smooth_route(first["lat"], first["lon"], last["lat"], last["lon"])
    except RoutingError as error:
        record(str(error))
    record(f"Scanning {len(context.routes)} route(s) against the city's 311 data.")
    context.ensure_complete()
    record(f"Picked route {context.recommended}: {context.reason}")
    return {**context.to_dict(), "briefing": briefing(context), "steps": steps}
