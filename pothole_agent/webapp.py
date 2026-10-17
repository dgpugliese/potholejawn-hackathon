"""Small Flask app: a map UI on top of the trip planner.

Run with:  python -m pothole_agent.webapp   then open http://127.0.0.1:5000
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

from .agent import investigate
from .routing import MAX_ADDRESS_CHARS, RoutingError, in_philadelphia, potholes_in_bbox
from .smooth import graph_status, navigate, normalize_avoidance
from .trip import plan_trip

STATIC_DIR = Path(__file__).parent / "static"
MAX_QUESTION_CHARS = 500
RUN_DIR = "runs"
NO_KEY_MESSAGE = (
    "Analyst needs an API key. Set ANTHROPIC_API_KEY and restart the server "
    "to ask follow-up questions. Trip planning still works without it."
)

# Rate limits for the agent endpoints (they spend API tokens per request).
# Overridable via env vars; localhost is always exempt for local demos/tests.
RATE_MAX_PER_IP = int(os.environ.get("RATE_MAX_PER_IP", "6"))  # runs per window per IP
RATE_WINDOW_SECONDS = int(os.environ.get("RATE_WINDOW_SECONDS", "300"))
RATE_MAX_PER_HOUR = int(os.environ.get("RATE_MAX_PER_HOUR", "60"))  # runs/hour, all IPs
RATE_MAX_CONCURRENT = int(os.environ.get("RATE_MAX_CONCURRENT", "3"))  # active runs
RATE_LIMIT_MESSAGE = "Rate limit reached — try again in a few minutes."
_LOCAL_IPS = {"127.0.0.1", "::1"}


class _RateLimiter:
    """In-memory, thread-safe sliding-window limiter. One per app instance."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._per_ip: dict[str, list[float]] = {}
        self._recent: list[float] = []
        self._active = 0

    def try_acquire(self, ip: str) -> bool:
        """Reserve a run slot for this IP; False means 'limited, refuse'."""
        if ip in _LOCAL_IPS:
            return True
        now = time.monotonic()
        with self._lock:
            hits = [t for t in self._per_ip.get(ip, []) if now - t < RATE_WINDOW_SECONDS]
            self._per_ip[ip] = hits
            self._recent = [t for t in self._recent if now - t < 3600]
            if (
                self._active >= RATE_MAX_CONCURRENT
                or len(hits) >= RATE_MAX_PER_IP
                or len(self._recent) >= RATE_MAX_PER_HOUR
            ):
                return False
            hits.append(now)
            self._recent.append(now)
            self._active += 1
            return True

    def release(self, ip: str) -> None:
        if ip in _LOCAL_IPS:
            return
        with self._lock:
            self._active = max(0, self._active - 1)


def _analyst_client():
    """Model client for the analyst; None means 'let the SDK build one'.

    Exists so tests can monkeypatch in a fake client without an API key.
    """
    return


def create_app() -> Flask:
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
    app.config["MAX_CONTENT_LENGTH"] = 16 * 1024  # requests are two short strings
    limiter = _RateLimiter()
    if os.environ.get("PRELOAD_GRAPH") == "1":
        # Load the street graph at start (about a quarter second) so the first
        # trip of a fresh container does not pay for it. A missing graph file is
        # logged, not fatal: the fast routes still work without it.
        status = graph_status()
        if status["available"]:
            app.logger.info("smooth router ready: %s segments", status["segments"])
        else:
            app.logger.warning("smooth router unavailable: %s", status["error"])

    def client_ip() -> str:
        # Behind the Cloudflare tunnel the real client is in CF-Connecting-IP.
        return request.headers.get("CF-Connecting-IP") or request.remote_addr or ""

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/healthz")
    def health():
        return jsonify(
            {
                "ok": True,
                "agent_available": bool(os.environ.get("ANTHROPIC_API_KEY")),
                "smooth_router": graph_status(),
            }
        )

    def validate_addresses(start, end) -> str | None:
        """Return an error message for the browser, or None if the input is fine."""
        for label, value in (("start", start), ("end", end)):
            if not isinstance(value, str) or not value.strip():
                return f"Enter a {label} address."
            if len(value) > MAX_ADDRESS_CHARS:
                return f"The {label} address is too long."
        return None

    # Viewport pothole layer: no LLM tokens spent, so no rate limit — just a
    # short shared cache to be polite to the city's API.
    potholes_cache: dict[str, tuple[float, list]] = {}
    potholes_cache_lock = threading.Lock()

    # Trip results: popular endpoint pairs repeat (demos, shares), and 311 data
    # moves slowly, so a repeat within the window costs zero API tokens.
    trip_cache: dict[tuple[str, str], tuple[float, dict]] = {}
    trip_cache_lock = threading.Lock()
    trip_cache_seconds = int(os.environ.get("TRIP_CACHE_SECONDS", "3600"))

    def trip_key(start: str, end: str, avoidance: str) -> tuple[str, str, str]:
        return (start.strip().lower(), end.strip().lower(), avoidance)

    def cached_trip(start: str, end: str, avoidance: str) -> dict | None:
        key = trip_key(start, end, avoidance)
        with trip_cache_lock:
            hit = trip_cache.get(key)
            if hit and time.monotonic() - hit[0] < trip_cache_seconds:
                return hit[1]
        return None

    def store_trip(start: str, end: str, avoidance: str, result: dict) -> None:
        if result.get("mode") != "agent":  # fallback runs are cheap to redo
            return
        key = trip_key(start, end, avoidance)
        with trip_cache_lock:
            if len(trip_cache) > 128:
                trip_cache.clear()
            trip_cache[key] = (time.monotonic(), result)

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

        Used by navigation mode when the driver leaves the route. No model
        tokens are spent, so it is not behind the agent rate limiter; the
        browser only calls it after an off-route fix, at most every few
        seconds.
        """
        start = parse_point(request.args.get("from", ""))
        end = parse_point(request.args.get("to", ""))
        if start is None or end is None:
            return jsonify({"error": "from and to must be lat,lon inside Philadelphia"}), 400
        avoidance = normalize_avoidance(request.args.get("avoid"))
        try:
            return jsonify(navigate(*start, *end, avoidance))
        except RoutingError as error:
            return jsonify({"error": str(error)}), 400
        except Exception:  # never leak internals to the browser
            app.logger.exception("re-route failed")
            return jsonify({"error": "Could not re-route right now. Keep following the road."}), 502

    @app.post("/api/trip")
    def trip():
        body = request.get_json(silent=True) or {}
        start, end = body.get("start"), body.get("end")
        problem = validate_addresses(start, end)
        if problem:
            return jsonify({"error": problem}), 400
        use_agent = bool(body.get("use_agent", True)) and bool(os.environ.get("ANTHROPIC_API_KEY"))
        avoidance = normalize_avoidance(body.get("avoid"))
        hit = cached_trip(start, end, avoidance)
        if hit is not None:  # before the limiter: cache hits are free
            return jsonify({**hit, "cached": True})
        ip = client_ip()
        if not limiter.try_acquire(ip):
            return jsonify({"error": RATE_LIMIT_MESSAGE}), 429
        try:
            result = plan_trip(start, end, use_agent=use_agent, avoidance=avoidance)
            store_trip(start, end, avoidance, result)
            return jsonify(result)
        except RoutingError as error:
            return jsonify({"error": str(error)}), 400
        except Exception:  # never leak internals to the browser
            app.logger.exception("trip planning failed")
            return jsonify(
                {"error": "A map or city data service is not responding. Try again."}
            ), 502
        finally:
            limiter.release(ip)

    @app.get("/api/trip/stream")
    def trip_stream():
        """Same planner as /api/trip, but streamed as Server-Sent Events.

        Emits `step` events as the agent (or the fallback planner) works, then
        one `result` event with the full trip payload, or one `trip_error`.
        """
        start, end = request.args.get("start"), request.args.get("end")
        problem = validate_addresses(start, end)
        if problem:
            return jsonify({"error": problem}), 400
        use_agent = bool(request.args.get("use_agent", "1") != "0") and bool(
            os.environ.get("ANTHROPIC_API_KEY")
        )
        avoidance = normalize_avoidance(request.args.get("avoid"))
        hit = cached_trip(start, end, avoidance)
        if hit is not None:  # before the limiter: cache hits are free

            def generate_cached():
                step = {"type": "cached", "text": "Serving a recent result for this exact trip."}
                yield f"event: step\ndata: {json.dumps(step)}\n\n"
                yield f"event: result\ndata: {json.dumps({**hit, 'cached': True}, default=str)}\n\n"

            return Response(
                generate_cached(),
                mimetype="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
        ip = client_ip()
        if not limiter.try_acquire(ip):
            return jsonify({"error": RATE_LIMIT_MESSAGE}), 429
        events: queue.Queue = queue.Queue()

        def worker() -> None:
            try:
                result = plan_trip(
                    start,
                    end,
                    use_agent=use_agent,
                    on_step=lambda e: events.put(("step", e)),
                    avoidance=avoidance,
                )
                store_trip(start, end, avoidance, result)
                events.put(("result", result))
            except RoutingError as error:
                events.put(("trip_error", {"error": str(error)}))
            except Exception:  # never leak internals to the browser
                app.logger.exception("trip planning failed")
                events.put(
                    (
                        "trip_error",
                        {"error": "A map or city data service is not responding. Try again."},
                    )
                )
            finally:
                limiter.release(ip)
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

    @app.get("/api/ask/stream")
    def ask_stream():
        """Run the 311 analyst agent on an open question, streamed as SSE.

        Mirrors /api/trip/stream: `step` events while the agent works, then one
        `result` event with the answer, or one `ask_error`. Every SQL query the
        model writes goes through validate_sql inside tools.run_sql.
        """
        question = request.args.get("q", "")
        if not isinstance(question, str) or not question.strip():
            return jsonify({"error": "Type a question first."}), 400
        if len(question) > MAX_QUESTION_CHARS:
            return jsonify({"error": "That question is too long."}), 400

        client = _analyst_client()
        events: queue.Queue = queue.Queue()

        if client is None and not os.environ.get("ANTHROPIC_API_KEY"):
            # The analyst has no fallback planner, so fail fast and friendly.
            events.put(("ask_error", {"error": NO_KEY_MESSAGE}))
            events.put(None)
        else:
            ip = client_ip()
            if not limiter.try_acquire(ip):
                return jsonify({"error": RATE_LIMIT_MESSAGE}), 429

            def worker() -> None:
                try:
                    answer = investigate(
                        question,
                        client=client,
                        on_event=lambda e: events.put(("step", e)),
                        run_dir=RUN_DIR,
                        plain_text=True,
                    )
                    events.put(("result", {"answer": answer}))
                except Exception:  # never leak internals to the browser
                    app.logger.exception("analyst question failed")
                    events.put(("ask_error", {"error": "The analyst hit an error. Try again."}))
                finally:
                    limiter.release(ip)
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
        return response

    return app


def main() -> None:
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass
    create_app().run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)


if __name__ == "__main__":
    main()
