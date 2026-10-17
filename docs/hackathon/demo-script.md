# Demo video script — potholejawn (≤ 3:00)

One continuous screen recording, one browser window — everything happens in the map UI now. Speak plainly, no filler. Total spoken script below runs about 2:40 at normal pace, leaving buffer.

## Pre-flight checklist (do all of this BEFORE recording)

- [ ] `ANTHROPIC_API_KEY` set in `.env`; server running: `python -m pothole_agent.webapp`; tunnel to potholejawn.com up if demoing the live site
- [ ] **Hard refresh** the browser (Cmd+Shift+R) so the latest UI and service worker are loaded
- [ ] **Panel closed**, map at **zoom ~12 centered on Philly** — citywide dots visible, "open pothole reports in view" counter showing
- [ ] Browser **zoom 125–150%** so text is legible in the recording
- [ ] Do one throwaway trip first (warms geocoder/OSRM caches and confirms the agent path works — briefing should NOT say fallback), then close the panel and reset the view
- [ ] Trip to run, exactly: destination `Citizens Bank Park` in the pill (pick it from the autocomplete dropdown); start `Temple University` via autocomplete — verified: route A 9 open reports, route B 13, ~17 min drive
- [ ] Analyst question ready to paste into the panel's "Ask the analyst" box: `Which zip codes wait longest for pothole repairs?`
- [ ] Close notifications / other tabs; hide bookmarks bar
- [ ] Timer visible to yourself, not on screen

## Script

### 0:00 – 0:15 — Hook

Open on the full-map view: citywide dots, the emblem watermark, the "Where to?" pill.

> "This is potholejawn — potholejawn dot com. Every yellow dot is an open pothole report in Philadelphia right now — over fifteen hundred, live from the city's 311 data, five point nine million rows since 2014. This agent uses that data to route you around them. Watch."

### 0:15 – 0:35 — Start the trip

Start typing `Citizens` into the pill and pick **Citizens Bank Park** from the autocomplete dropdown; the panel slides in. Start typing `Temple` in the start field and pick **Temple University** (or hit the 📍 button to use your real location).

> "I start typing where I'm going — the app suggests real Philly places as I type, Citizens Bank Park. Where I'm starting — Temple University, or one tap to use my actual location. That's it. The agent figures out the rest."

### 0:35 – 1:10 — Live agent steps (SSE)

The steps stream live in the panel while the agent works. Point at each step as it appears.

> "Now watch the agent work in real time, right here in the panel. It's deciding which tools to call, on its own: it geocodes both places — Census geocoder for addresses, OpenStreetMap for landmarks. It pulls the driving route and an alternative from OSRM. Now it's scanning each route — that's a live PostGIS query against the city's 311 API for open street-defect reports within thirty meters of the road. And it records its recommendation as structured output before writing the briefing."

(If a step lingers, fill with: "This is hitting the real city API right now — no cached data.")

### 1:10 – 1:45 — The result

Map renders: two routes, pothole markers, recommended route highlighted; the A/B route signs show the counts. Read a line of the briefing.

> "Here's the answer. Two routes, same seventeen-minute drive — the route signs say it: one passes nine open pothole reports, the other thirteen. Every marker is a real open 311 report, plotted along the route with mile markers. The agent picked the cleaner route and explains why, in plain English — where the worst stretch is and the oldest open report on the way. And note the wording: these are resident *reports*, not verified potholes. The app is honest about that."

### 1:45 – 2:10 — "What the agent did" audit

Open the "What the agent did" section in the panel. Scroll it slowly.

> "Full transparency: every thought, every tool call, every result, even token usage. There's a hard twelve-step limit so it can never loop forever, and this whole trail is also written to a JSONL audit log on disk."

### 2:10 – 2:40 — Analyst agent, in the panel

Scroll to the "Ask the analyst" box in the panel, paste and run:

```
Which zip codes wait longest for pothole repairs?
```

> "Same app, second agent — a 311 accountability analyst, right here in the panel. Ask it an open question and it writes its own SQL against those five point nine million rows. Every query it writes is treated as untrusted: a guardrail forces read-only single SELECTs on an allowlisted table, capped at two hundred rows. When a query fails, the error goes back to the model and it fixes its own SQL and retries — you can see the queries streaming here."

(You don't need it to finish on camera — show a couple of query/retry steps, then cut to the final answer if time allows.)

### 2:40 – 2:55 — Safety & fallback, one breath

Close the panel; back to the full map.

> "One more thing: if the model API ever goes down, a plain-Python fallback produces the same map and a simpler briefing — the demo never dies. Coordinates are geofenced to Philadelphia, and the route query is built from validated numbers the model never touches."

### 2:55 – 3:00 — Close

> "potholejawn. Built solo in a day at Coffee and Code Philly. Live at potholejawn dot com — add it to your home screen, it installs as an app."

## Cut-for-time priority (if running long)

1. Trim the audit-panel scroll to 10 seconds.
2. Cut the analyst's final answer; show only the SQL-retry steps.
3. Trim the hook to one sentence.
Never cut: the citywide dots open, live steps streaming, the 9-vs-13 comparison, the guardrails/fallback sentence.
