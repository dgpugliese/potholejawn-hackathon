# potholejawn

**Devpost submission copy — AI Agent Hackathon, Coffee and Code Philadelphia — Open Track**
Builder: David Pugliese (solo). Repo: https://github.com/dgpugliese/potholejawn-hackathon · Home: https://potholejawn.com

---

## Elevator pitch (one line)

Type two Philly addresses and an AI agent scans the city's live 311 data — 5.9 million rows — to route you around the potholes.

---

## Inspiration

Philadelphia publishes every 311 request since 2014 — about 5.9 million rows of open civic data — and almost nobody can use it. Answering a real question takes SQL skills and knowledge of the dataset's quirks (NULL zip codes, open cases with no close date, categories that changed names). Meanwhile, in 2026 roughly 19% of pothole reports are still sitting open, averaging 27 days to close. The data to drive around them exists, live, for free. It just needed an agent in front of it. And it's Philly, so obviously it's called potholejawn.

Here's the gap: **no navigation app actually routes you around potholes.** Waze lets users pin them and warns you as you approach — but its router only cares about travel time, so it drives you straight through a cratered block at full speed. Google patented road-quality routing in 2015 and never shipped a "avoid rough roads" toggle. Boston's Street Bump detected potholes for public works, not for drivers. potholejawn picks the route with fewer potholes and tells you why.

## What it does

**potholejawn** is a Waze-style map for pothole avoidance. You type where you are and where you're going in Philadelphia. An AI agent geocodes both places, fetches the driving route plus alternatives from OSRM, runs a PostGIS query against the city's live 311 API for open "Street Defect" reports within 30 meters of each route, weighs pothole count, report age, and drive time, and recommends the smoother drive — with every reported pothole plotted on the map and a plain-language briefing explaining the pick.

Real example from live data: Temple University to Citizens Bank Park. Same 17-minute drive; one route passes 9 open pothole reports, the other 13.

Before you even plan a trip, the map lights up with **every open pothole report in view** — 1,500+ across the city, live from 311, each clickable. Start typing and it autocompletes real Philly places — landmarks like the Liberty Bell or the Pennovation Center (where this was built) — or tap 📍 to route from your actual location. It's live at **potholejawn.com**, installable to a phone home screen as a PWA, in a map-first UI modeled on the navigation apps everyone already knows.

The repo also ships a second agent — a 311 **accountability analyst** — that answers open-ended questions ("where is the city slowest at fixing potholes?") right in the app or from the CLI by writing its own SQL, running it through a guardrail validator, reading errors, and retrying until it has an answer. Both agents share one generic tool loop.

## How we built it

- **Agent core** (`pothole_agent/agent.py`): one generic tool-calling loop (`run_agent`) built directly on the Anthropic API — no framework. The model decides which tools to call and in what order; tool errors are returned to the model so it can self-correct; a hard 12-step limit prevents runaway loops; every thought, tool call, error, and token count is logged to a JSONL audit file per run.
- **Trip agent** (`trip.py`): four tools — `geocode_address`, `find_routes`, `scan_route`, `recommend_route` — sharing state through a `TripContext`. A deterministic `ensure_complete` pass scans any route the agent skipped, so the map is never half-drawn.
- **Analyst agent** (`agent.py` + `tools.py`): `get_schema`, `list_categories`, `run_sql`. It's told to state a plan, query in focused steps, and never state a number it didn't get from a query.
- **Data layer** (`routing.py`): US Census geocoder for street addresses with OpenStreetMap Nominatim fallback for landmarks (neither alone covers Philly well), OSRM for routes, and a PostGIS `ST_DWithin` query against the city's public Carto SQL API for potholes along a route buffer.
- **UI** (`webapp.py` + Leaflet): Flask serving a static map. Agent steps stream to the browser live over Server-Sent Events, so you watch the agent think — geocode, route, scan, recommend — instead of staring at a spinner. A "What the agent did" panel shows the full audit trail including token usage.
- **Cost engineering**: Anthropic prompt caching on the agent loop (steps 2+ read the prompt prefix from cache at ~10% price) plus a one-hour trip-result cache, and per-IP + global rate limiting on the public deployment.
- **Tests**: 42 pytest tests running against a fake model client — no API key or network needed for CI.

## Challenges we ran into

- **The data is hostile.** zipcode, address, lat, and lon are frequently NULL; zips need regex filtering (`^191[0-9]{2}$`); open cases have no close date, so naive "average time to fix" numbers lie. We encoded these quirks into the agents' instructions rather than pretending the data is clean.
- **No single geocoder works for Philly.** The Census geocoder nails street addresses and intersections but not landmarks; Nominatim is the reverse. The geocode tool chains them.
- **Letting a model write SQL against a live city API is scary.** We treat model-written SQL as untrusted input: a dedicated validator (`guardrails.py`) enforces single-statement read-only SELECTs, a table allowlist, no comments, no admin functions (`pg_sleep`, `pg_read_file`, `dblink`, ...), and wraps every query in a hard 200-row LIMIT. Getting that right without breaking legitimate queries (CTEs, `EXTRACT(... FROM ...)`) took real care.
- **Demos die.** Public geocoders, the OSRM demo server, and the model API can all flake. The whole system degrades gracefully — see safety, below.
- **Basemap roulette.** OpenStreetMap's volunteer tile servers blocked the public deployment mid-afternoon; CARTO's rasters watermark without a key now; we landed on Esri's World Street Map. Third provider's the charm.

## Accomplishments that we're proud of

- **True agentic design, not a script with an LLM stapled on.** The agent picks its own tools and order, reads its own SQL errors and fixes them, records its route choice as structured output, and everything it does is auditable after the fact.
- **The demo cannot die.** If the API key is missing or the model call fails, a plain-Python fallback planner produces the same map with a simpler briefing — same result shape, honest `mode` flag. If the agent skips a route, the deterministic pass scans it anyway.
- **Defense in depth for a one-day hack**: SQL guardrails, a route-SQL path the model never touches (built in `routing.py` from validated numbers only, buffer clamped 10–100 m), a Philadelphia bounding-box geofence on every coordinate, `textContent`-only DOM insertion, Subresource Integrity pins on CDN assets, a step limit, per-IP and global rate limiting on the public deployment, and a full JSONL audit trail.
- **Honest framing baked in**: markers are labeled resident *reports*, not verified potholes; the analyst is instructed to report open-case share next to any time-to-close figure and to never confuse "more reports" with "more potholes."
- 42 tests, pinned dependencies, zero lint findings, zero known-CVE dependencies — built solo in one day.

## What we learned

- A minimal hand-rolled tool loop beats a framework for a hackathon: ~160 lines gives you tool choice, error-driven retry, step limits, and a full audit trail you actually understand.
- Feeding tool errors back to the model is the single highest-leverage agentic pattern — the analyst routinely writes SQL that fails on this dataset's quirks and fixes it on the next turn.
- Guardrails and graceful degradation aren't polish, they're what makes an agent demoable: the fallback planner and `ensure_complete` turned "hope the model behaves on stage" into "the map always renders."
- Civic open data is a goldmine wrapped in landmines; the agent's system prompt is where the landmine map lives.

## What's next

- Live at **potholejawn.com** (and potholejawn.app) as the product home — installable as a PWA today, app stores via Capacitor next.
- A true roughness-weighted router: custom edge penalties on the street graph (weighted A*) instead of choosing among OSRM's time-optimal alternatives — tuned so one cratered block doesn't cause an eight-block detour through Philly's narrow one-way grid.
- Severity weighting with time decay: reports age out unless reinforced (Philly closes tickets on inspection, not repair, and cold patches die each freeze-thaw), plus PavePHL/StreetSmartPHL resurfacing schedules as positive weights.
- A "report a pothole" deep link to Philly 311 from any marker.
- Self-hosted OSRM with live traffic instead of the public demo server.
- Same pattern, other cities: any Socrata/Carto 311 feed can slot in behind the same agent loop.

## Built with

`python` · `anthropic-api` · `claude` · `flask` · `leaflet` · `postgis` · `carto-sql-api` · `osrm` · `us-census-geocoder` · `nominatim` · `openstreetmap` · `server-sent-events` · `pytest` · `open-data-philly`

---

### Judging criteria map (for reference, not part of the Devpost body)

- **Technical execution**: two agents on one shared loop, live city API, multi-source geocoding, PostGIS spatial queries, SSE streaming, 42 tests.
- **Agentic design**: model chooses tools and order; SQL errors fed back for self-correction; structured `recommend_route` output; 12-step limit; per-run JSONL audit trail.
- **Innovation**: routing on live 311 data — the pothole layer Waze doesn't have — plus an accountability analyst over the same loop.
- **Impact**: 5.9M rows of public data made usable by anyone who can type two addresses; drivers, journalists, and council staff.
- **Safety**: SQL guardrails treating model output as untrusted, route SQL the model never writes, geofence, SRI, XSS-safe rendering, step limit, graceful fallback, honest "reports not potholes" framing.
- **Demo clarity**: one input box to a picked route in under a minute, agent steps visible live, audit panel on screen.
