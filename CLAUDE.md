# Project context for Claude Code

Started as a one-day hackathon build (Sept 20, 2026); now being turned into a real
product. Live at potholejawn.com on Google Cloud (Cloud Run). All infrastructure
stays on Google Cloud.

## What this is
potholejawn: a Waze-style map that routes around potholes. User enters start and
destination in Philly; the app fetches OSRM's fastest routes, plans its own
pothole-aware route on a street graph with live 311 reports as penalties, verifies
every route against the city's data, and recommends one. See README.md.
- `agent.py`       generic tool loop (`run_agent`) plus the 311 analyst (`investigate`),
                   which is CLI-only since Oct 2026 (the Ask tab was removed from the UI)
- `trip.py`        trip agent, its tools (TripContext), and the no-LLM fallback planner
- `routing.py`     geocoders, OSRM (routes, via-snap, directions), PostGIS queries
                   (SQL built from numbers only)
- `streetgraph.py` street graph builder (Overpass -> data/philly_graph.json.gz) and
                   the penalised A* router
- `smooth.py`      graph singleton, citywide report cache, snap-and-verify, scoring
- `webapp.py`      Flask API plus static Leaflet UI in `static/`
- `guardrails.py`  validator for model-written SQL (analyst agent only)

## Deployment
Google Cloud project potholejawn-prod, Cloud Run service `potholejawn` (us-east4).
`cloudbuild.yaml` tests, builds, pushes, deploys; the Anthropic key lives in Secret
Manager. See docs/deploy.md. The street graph ships in the image; rebuild it with
`python -m pothole_agent.streetgraph build` every few months.

## Rules
- Never commit secrets. `.env` is gitignored; keep it that way.
- Keep dependencies pinned in requirements.txt and keep the list short.
- Every new behaviour gets a test. Run `pytest -q` before each commit.
- All model-written SQL must go through `validate_sql`. Never bypass it.
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
live navigation (GPS following, voice, pothole-ahead alerts, off-route re-routing
via /api/navigate, preview mode), and the Cloud Build pipeline are built and
tested (65 tests, fallback and navigation paths verified live in a browser). The agent path with `find_smooth_route` is unit-tested with a fake client;
run it once against the real API after setting ANTHROPIC_API_KEY in .env.

## Next steps, in order
1. Create the `anthropic-api-key` secret and IAM bindings (docs/deploy.md), rotate
   the key, deploy with `gcloud builds submit --config cloudbuild.yaml .`.
2. Run one real agent trip and tune TRIP_SYSTEM_PROMPT so the briefing compares the
   smooth route with the fastest one in plain numbers.
3. Uptime check and an alert on 5xx in Cloud Monitoring; a Cloud Scheduler job that
   rebuilds the street graph monthly is optional.
4. Product ideas: self-hosted OSRM on Cloud Run for traffic-aware times; severity
   from report text; a "was this patched?" feedback loop; other cities' 311 feeds.
