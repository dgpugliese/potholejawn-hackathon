# Project context for Claude Code

Started as a one-day hackathon build (Sept 20, 2026); now being turned into a real
product. Live at potholejawn.com on Google Cloud (Cloud Run). All infrastructure
stays on Google Cloud.

## What this is
potholejawn: a Waze-style map that routes around potholes. User enters a destination
(start defaults to their location); the app fetches OSRM's fastest routes, plans its
own pothole-aware route on a street graph with live 311 reports as penalties,
verifies every route against the city's data, and recommends one. No model is in
the web app's loop (removed Oct 17, 2026: it cost money, time, and a secret for a
paragraph the template now writes). See README.md.
- `agent.py`       generic tool loop (`run_agent`) plus the 311 analyst (`investigate`):
                   CLI-only research tool, optional `anthropic` extra
- `trip.py`        deterministic trip planner (TripContext, scoring, briefing text)
- `routing.py`     geocoders, OSRM (routes, via-snap, directions), PostGIS queries
                   (SQL built from numbers only)
- `streetgraph.py` street graph builder (Overpass -> data/philly_graph.json.gz) and
                   the penalised A* router
- `smooth.py`      graph singleton, citywide report cache, snap-and-verify, scoring
- `webapp.py`      Flask API plus static Leaflet UI in `static/`
- `guardrails.py`  validator for model-written SQL (analyst agent only)

## Deployment
Google Cloud project potholejawn-prod, Cloud Run service `potholejawn` (us-east4).
`cloudbuild.yaml` tests, builds, pushes, deploys. The web app needs no secrets.
See docs/deploy.md. The street graph ships in the image; rebuild it with
`python -m pothole_agent.streetgraph build` every few months.

## Rules
- Never commit secrets. `.env` is gitignored; keep it that way. The web app must
  stay secret-free; only the analyst CLI may use an API key.
- Keep dependencies pinned in requirements.txt and keep the list short.
- Every new behaviour gets a test. Run `pytest -q` before each commit.
- All model-written SQL (analyst CLI) must go through `validate_sql`. Never bypass it.
- Small commits with clear messages.
- The smooth route must always be scanned by the same Carto corridor query as the
  OSRM routes; never report our own matching count as the pothole count.

## Data facts (verified live today)
- Endpoint: https://phl.carto.com/api/v2/sql?q=<SQL>, no key, PostgreSQL dialect.
- Table `public_cases_fc`, ~5.9M rows, 2014 to today.
- zipcode/address/lat/lon are often NULL. Filter zips with `zipcode ~ '^191[0-9]{2}$'`.
- 2026 Street Defect: 8,401 reports, ~19% still open, avg 27 days to close.

- Geocoding: Census handles street addresses and intersections; Nominatim handles
  landmarks. Neither alone is enough. CARTO basemap tiles now need a key; use OSM tiles.
- Verified demo trip: Temple University -> Citizens Bank Park (route A 9 reports, B 13).

## Status (Oct 17, 2026)
Smooth router, directions, avoidance switch, share links, Google Maps hand-off,
live navigation (GPS following, voice, speedometer with posted limits, pothole-ahead
alerts, alternatives, off-route re-routing, preview mode), saved places, destination-
first flow, glass UI, and the Cloud Build pipeline are built and tested (60 tests,
verified live in a browser). The model and its rate limiter are gone from the web app.

## Next steps, in order
1. Deploy with `gcloud builds submit --config cloudbuild.yaml .` (no secrets needed);
   then map potholejawn.com to the service if not already.
2. Uptime check and an alert on 5xx in Cloud Monitoring; optional monthly Cloud
   Scheduler job that rebuilds the street graph.
3. Self-host OSRM (Cloud Run or a small VM) before real traffic: the public demo
   server has no uptime promise.
4. Android: TWA of the PWA first, then a Kotlin app and an Android Auto module on the
   Car App Library, sharing the same JSON API.
