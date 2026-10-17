"""Trip planning: find routes, scan them for potholes, recommend one.

Two paths produce the same result shape:
  * agent path: Claude drives the tools and explains its choice
  * fallback path: plain Python, used when no API key is set or the agent fails
The map therefore always works, and the agent adds judgment on top.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from .agent import run_agent
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

TRIP_SYSTEM_PROMPT = """\
You are a driving assistant for Philadelphia that helps people avoid potholes.
The user gives a start and a destination. Work like this:
1. geocode_address for both places (call them together in one turn).
2. find_routes between the two points: the fastest route plus alternatives.
3. find_smooth_route between the same points: our own router re-plans the
   drive with every open pothole report as a time penalty on its street.
4. scan_route for every route, including the smooth one (call them together
   in one turn). This verifies each route's count against the city's data.
5. recommend_route with the best route_id and a one-sentence reason. Weigh
   pothole count first, then how long reports have sat open, then drive time.
   Rule of thumb: an extra minute is worth it for each report avoided; a
   route that is much slower for a tiny difference is not worth it.
6. Reply with a short plain-text briefing, 3 to 5 sentences, no markdown:
   which route you picked and why, how it compares with the fastest route
   (reports avoided, extra minutes), where the worst stretch is (use the
   addresses and mile markers), and the oldest open report on the way.

Only state numbers that came from tool results. These are resident reports of
street defects, not verified potholes, and some may already be patched, so
say "reported" rather than promising what is on the road. If find_smooth_route
fails, say the smooth router was unavailable and choose among the others.
"""


class TripContext:
    """Holds the state of one trip so tools can share it and the UI can draw it."""

    def __init__(self, avoidance: str = DEFAULT_AVOIDANCE) -> None:
        self.avoidance = normalize_avoidance(avoidance)
        self.places: dict[str, dict[str, Any]] = {}
        self.routes: dict[str, Route] = {}
        self.recommended: str | None = None
        self.reason: str = ""
        self.smooth_error: str | None = None

    # --- tools exposed to the model -------------------------------------
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
            "note": "Planned with every open report as a street penalty. Scan it to verify.",
        }

    def scan_route(self, route_id: str, buffer_m: int = DEFAULT_BUFFER_M) -> dict[str, Any]:
        route = self.routes.get(route_id)
        if route is None:
            raise RoutingError(f"Unknown route_id '{route_id}'. Known: {sorted(self.routes)}")
        route.potholes = potholes_along(route, buffer_m)
        return {
            **route.summary(),
            "open_reports": len(route.potholes),
            "reports": [
                {k: p[k] for k in ("address", "days_open", "mile_marker")}
                for p in route.potholes[:40]
            ],
        }

    def recommend_route(self, route_id: str, reason: str = "") -> dict[str, Any]:
        if route_id not in self.routes:
            raise RoutingError(f"Unknown route_id '{route_id}'. Known: {sorted(self.routes)}")
        self.recommended, self.reason = route_id, str(reason)[:300]
        return {"recommended": route_id}

    def tool_functions(self) -> dict[str, Callable[..., Any]]:
        return {
            "geocode_address": self.geocode_address,
            "find_routes": self.find_routes,
            "find_smooth_route": self.find_smooth_route,
            "scan_route": self.scan_route,
            "recommend_route": self.recommend_route,
        }

    # --- deterministic helpers ------------------------------------------
    def ensure_complete(self) -> None:
        """Fill in anything the agent skipped so the map is never half-drawn."""
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


TRIP_TOOL_SPECS = [
    {
        "name": "geocode_address",
        "description": "Look up coordinates for a Philadelphia address, intersection, or landmark.",
        "input_schema": {
            "type": "object",
            "properties": {
                "address": {"type": "string"},
                "role": {"type": "string", "enum": ["start", "end"]},
            },
            "required": ["address", "role"],
        },
    },
    {
        "name": "find_routes",
        "description": "Get the main driving route and alternatives between two points.",
        "input_schema": {
            "type": "object",
            "properties": {
                "start_lat": {"type": "number"},
                "start_lon": {"type": "number"},
                "end_lat": {"type": "number"},
                "end_lon": {"type": "number"},
            },
            "required": ["start_lat", "start_lon", "end_lat", "end_lon"],
        },
    },
    {
        "name": "find_smooth_route",
        "description": (
            "Plan the pothole-aware route between two points: our own street router "
            "treats every open report as a time penalty, then snaps the result to the "
            "road network. Returns route_id 'S'. Always scan it afterwards."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_lat": {"type": "number"},
                "start_lon": {"type": "number"},
                "end_lat": {"type": "number"},
                "end_lon": {"type": "number"},
            },
            "required": ["start_lat", "start_lon", "end_lat", "end_lon"],
        },
    },
    {
        "name": "scan_route",
        "description": (
            "List open pothole (Street Defect) reports from the last 12 months within "
            "buffer_m meters of a route, in driving order with mile markers."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "route_id": {"type": "string"},
                "buffer_m": {"type": "integer", "description": "10 to 100, default 30"},
            },
            "required": ["route_id"],
        },
    },
    {
        "name": "recommend_route",
        "description": "Record your final route choice. Call once, before your briefing.",
        "input_schema": {
            "type": "object",
            "properties": {"route_id": {"type": "string"}, "reason": {"type": "string"}},
            "required": ["route_id", "reason"],
        },
    },
]


def fallback_briefing(context: TripContext) -> str:
    """Plain-Python briefing used when the agent is unavailable."""
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
        text = (
            f"{label} ({route.miles} mi, about {route.minutes} min) passes "
            f"{len(potholes)} open pothole report(s). The oldest is near {oldest['address']} "
            f"around mile {oldest['mile_marker']}, reported {oldest['days_open']} days ago."
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
    use_agent: bool = True,
    client: Any = None,
    run_dir: str = "runs",
    on_step: Callable[[dict[str, Any]], None] | None = None,
    avoidance: str = DEFAULT_AVOIDANCE,
) -> dict[str, Any]:
    """Plan a trip. Returns routes, potholes, a recommendation, and the agent's steps.

    ``on_step`` (optional) is called with each step event as it happens, so a
    caller can stream progress to a UI while the run is still in flight.
    ``avoidance`` ("balanced" or "strong") sets how much time a pothole is worth.
    """
    context = TripContext(avoidance)
    steps: list[dict[str, Any]] = []
    briefing, mode = "", "fallback"

    def record(event: dict[str, Any]) -> None:
        steps.append(event)
        if on_step:
            on_step(event)

    if use_agent:
        try:
            briefing = run_agent(
                f"I am driving from: {start}\nTo: {end}\nWhich route has the fewest potholes?",
                system_prompt=TRIP_SYSTEM_PROMPT,
                tool_specs=TRIP_TOOL_SPECS,
                tool_functions=context.tool_functions(),
                client=client,
                on_event=record,
                run_dir=run_dir,
                # Opt-in cheaper model for the trip loop (e.g. claude-haiku-4-5);
                # unset means run_agent's normal POTHOLE_MODEL/default applies.
                model=os.environ.get("POTHOLE_TRIP_MODEL"),
            )
            mode = "agent"
        except RoutingError:
            raise
        except Exception as error:  # no key, network trouble, model error: degrade gracefully
            record({"type": "agent_unavailable", "detail": f"{type(error).__name__}: {error}"})

    if not context.routes:  # agent did not get far enough, or was skipped
        record({"type": "fallback", "text": f"Looking up '{start}' and '{end}'."})
        first = context.places.get("start") or context.geocode_address(start, "start")
        last = context.places.get("end") or context.geocode_address(end, "end")
        record({"type": "fallback", "text": "Fetching the fastest driving routes."})
        context.find_routes(first["lat"], first["lon"], last["lat"], last["lon"])
        record(
            {
                "type": "fallback",
                "text": "Planning a smooth route around every open pothole report.",
            }
        )
        try:
            context.find_smooth_route(first["lat"], first["lon"], last["lat"], last["lon"])
        except RoutingError as error:
            record({"type": "fallback", "text": str(error)})
        record(
            {
                "type": "fallback",
                "text": f"Scanning {len(context.routes)} route(s) against the city's 311 data.",
            }
        )
        mode = "fallback"

    context.ensure_complete()
    if mode == "fallback" or not briefing.strip():
        briefing = fallback_briefing(context)
    if mode == "fallback":
        record(
            {"type": "fallback", "text": f"Picked route {context.recommended}: {context.reason}"}
        )
    return {**context.to_dict(), "briefing": briefing, "mode": mode, "steps": steps}
