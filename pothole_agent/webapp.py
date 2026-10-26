"""Small Flask app: a map UI on top of the trip planner.

Run with:  python -m pothole_agent.webapp   then open http://127.0.0.1:5000

Every endpoint is plain computation plus calls to public data services; no
model is involved, so there is nothing to rate limit beyond politeness caches.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

from .routing import MAX_ADDRESS_CHARS, RoutingError, in_philadelphia, potholes_in_bbox
from .smooth import alternatives, graph_status, navigate, normalize_avoidance, road_at
from .trip import plan_trip

STATIC_DIR = Path(__file__).parent / "static"
SERVICE_ERROR = "A map or city data service is not responding. Try again."


def create_app() -> Flask:
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
    app.config["MAX_CONTENT_LENGTH"] = 16 * 1024  # requests are two short strings
    if os.environ.get("PRELOAD_GRAPH") == "1":
        # Load the street graph at start (about a quarter second) so the first
        # trip of a fresh container does not pay for it. A missing graph file is
        # logged, not fatal: the fast routes still work without it.
        status = graph_status()
        if status["available"]:
            app.logger.info("smooth router ready: %s segments", status["segments"])
        else:
            app.logger.warning("smooth router unavailable: %s", status["error"])

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    # Google's front end answers /healthz itself on run.app and mapped domains
    # (with its own 404), so the real check lives under /api/health. /healthz
    # stays for local use and for load balancers that reach the container.
    @app.get("/api/health")
    @app.get("/healthz")
    def health():
        return jsonify({"ok": True, "smooth_router": graph_status()})

    def validate_addresses(start, end) -> str | None:
        """Return an error message for the browser, or None if the input is fine."""
        for label, value in (("start", start), ("end", end)):
            if not isinstance(value, str) or not value.strip():
                return f"Enter a {label} address."
            if len(value) > MAX_ADDRESS_CHARS:
                return f"The {label} address is too long."
        return None

    # Viewport pothole layer: a short shared cache to be polite to the city's API.
    potholes_cache: dict[str, tuple[float, list]] = {}
    potholes_cache_lock = threading.Lock()

    # Trip results: popular endpoint pairs repeat (demos, shares) and 311 data
    # moves slowly, so a repeat within the window skips the routing services.
    trip_cache: dict[tuple[str, str, str], tuple[float, dict]] = {}
    trip_cache_lock = threading.Lock()
    trip_cache_seconds = int(os.environ.get("TRIP_CACHE_SECONDS", "600"))

    def trip_key(start: str, end: str, avoidance: str) -> tuple[str, str, str]:
        return (start.strip().lower(), end.strip().lower(), avoidance)

    def cached_trip(start: str, end: str, avoidance: str) -> dict | None:
        with trip_cache_lock:
            hit = trip_cache.get(trip_key(start, end, avoidance))
            if hit and time.monotonic() - hit[0] < trip_cache_seconds:
                return hit[1]
        return None

    def store_trip(start: str, end: str, avoidance: str, result: dict) -> None:
        with trip_cache_lock:
            if len(trip_cache) > 128:
                trip_cache.clear()
            trip_cache[trip_key(start, end, avoidance)] = (time.monotonic(), result)

    @app.get("/api/potholes")
    def potholes():
        """Open pothole reports inside a map viewport: ?bbox=south,west,north,east."""
        bbox = request.args.get("bbox", "")
        try:
            south, west, north, east = (float(part) for part in bbox.split(","))
        except ValueError:
            return jsonify({"error": "bbox must be south,west,north,east"}), 400
        # Round the box so nearby pans share a cache entry.
        key = ",".join(str(round(v, 2)) for v in (south, west, north, east))
        now = time.monotonic()
        with potholes_cache_lock:
            hit = potholes_cache.get(key)
            if hit and now - hit[0] < 300:
                return jsonify({"potholes": hit[1], "cached": True})
        try:
            rows = potholes_in_bbox(south, west, north, east)
        except RoutingError as error:
            return jsonify({"error": str(error)}), 400
        except Exception:  # never leak internals to the browser
            app.logger.exception("viewport pothole query failed")
            return jsonify({"error": "City data service is not responding."}), 502
        with potholes_cache_lock:
            if len(potholes_cache) > 64:
                potholes_cache.clear()
            potholes_cache[key] = (now, rows)
        return jsonify({"potholes": rows, "cached": False})

    def parse_point(value: str) -> tuple[float, float] | None:
        try:
            lat, lon = (float(part) for part in str(value).split(","))
        except ValueError:
            return None
        return (lat, lon) if in_philadelphia(lat, lon) else None

    @app.get("/api/navigate")
    def navigate_endpoint():
        """Re-route from a live position: ?from=lat,lon&to=lat,lon&avoid=balanced.

        Used by navigation mode when the driver leaves the route, and with
        alternatives=1 to list every option from the current position.
        """
        start = parse_point(request.args.get("from", ""))
        end = parse_point(request.args.get("to", ""))
        if start is None or end is None:
            return jsonify({"error": "from and to must be lat,lon inside Philadelphia"}), 400
        avoidance = normalize_avoidance(request.args.get("avoid"))
        try:
            if request.args.get("alternatives") == "1":
                return jsonify({"routes": alternatives(*start, *end)})
            return jsonify(navigate(*start, *end, avoidance))
        except RoutingError as error:
            return jsonify({"error": str(error)}), 400
        except Exception:  # never leak internals to the browser
            app.logger.exception("re-route failed")
            return jsonify({"error": "Could not re-route right now. Keep following the road."}), 502

    @app.get("/api/road")
    def road_endpoint():
        """Street name and posted speed limit at ?at=lat,lon, for the speedometer.

        Answered from the in-memory street graph: no network, well under a
        millisecond, so navigation can poll it every few seconds.
        """
        point = parse_point(request.args.get("at", ""))
        if point is None:
            return jsonify({"error": "at must be lat,lon inside Philadelphia"}), 400
        return jsonify({"road": road_at(*point)})

    @app.post("/api/trip")
    def trip():
        body = request.get_json(silent=True) or {}
        start, end = body.get("start"), body.get("end")
        problem = validate_addresses(start, end)
        if problem:
            return jsonify({"error": problem}), 400
        avoidance = normalize_avoidance(body.get("avoid"))
        hit = cached_trip(start, end, avoidance)
        if hit is not None:
            return jsonify({**hit, "cached": True})
        try:
            result = plan_trip(start, end, avoidance=avoidance)
            store_trip(start, end, avoidance, result)
            return jsonify(result)
        except RoutingError as error:
            return jsonify({"error": str(error)}), 400
        except Exception:  # never leak internals to the browser
            app.logger.exception("trip planning failed")
            return jsonify({"error": SERVICE_ERROR}), 502

    @app.get("/api/trip/stream")
    def trip_stream():
        """Same planner as /api/trip, but streamed as Server-Sent Events.

        Emits `step` events as the planner works, then one `result` event with
        the full trip payload, or one `trip_error`.
        """
        start, end = request.args.get("start"), request.args.get("end")
        problem = validate_addresses(start, end)
        if problem:
            return jsonify({"error": problem}), 400
        avoidance = normalize_avoidance(request.args.get("avoid"))
        hit = cached_trip(start, end, avoidance)
        if hit is not None:

            def generate_cached():
                step = {"type": "step", "text": "Serving a recent result for this exact trip."}
                yield f"event: step\ndata: {json.dumps(step)}\n\n"
                yield f"event: result\ndata: {json.dumps({**hit, 'cached': True}, default=str)}\n\n"

            return Response(
                generate_cached(),
                mimetype="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
        events: queue.Queue = queue.Queue()

        def worker() -> None:
            try:
                result = plan_trip(
                    start, end, on_step=lambda e: events.put(("step", e)), avoidance=avoidance
                )
                store_trip(start, end, avoidance, result)
                events.put(("result", result))
            except RoutingError as error:
                events.put(("trip_error", {"error": str(error)}))
            except Exception:  # never leak internals to the browser
                app.logger.exception("trip planning failed")
                events.put(("trip_error", {"error": SERVICE_ERROR}))
            finally:
                events.put(None)  # sentinel: stream is done

        threading.Thread(target=worker, daemon=True).start()

        def generate():
            while True:
                item = events.get()
                if item is None:
                    return
                kind, payload = item
                yield f"event: {kind}\ndata: {json.dumps(payload, default=str)}\n\n"

        return Response(
            generate(),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.after_request
    def security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com "
            "https://cdnjs.cloudflare.com; "
            "font-src https://fonts.gstatic.com; "
            "img-src 'self' data: https://server.arcgisonline.com; "
            "connect-src 'self' https://photon.komoot.io;"
        )
        return response

    return app


def main() -> None:
    create_app().run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)


if __name__ == "__main__":
    main()
