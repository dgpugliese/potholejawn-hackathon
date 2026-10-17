# potholejawn — social / launch kit

Drafted 2026-09-20 (hackathon day). All facts sourced from `README.md` and `docs/devpost.md` — nothing invented. Post **after** judging wraps (see timing note at the bottom).

Links to use everywhere:
- Live: https://potholejawn.com (also https://potholejawn.app)
- Repo: https://github.com/dgpugliese/potholejawn-hackathon

---

## 1. r/philadelphia

**Rules check (2026-09-20):** Reddit blocks automated fetches of the live rules page, so this is based on secondary sources, not the live sidebar. What's confirmed: r/philadelphia mods actively remove self-promotion (they cited it among removal reasons during the 2023 I-95 event), and the sub has no free-for-all promo policy — Philly-local subs generally push promo to designated threads or require mod approval. **Treat self-promo as effectively banned. Before posting: read the live sidebar/rules yourself, and if in doubt, message the mods first ("Philly resident, built a free non-commercial pothole map at a local hackathon, is this OK as a post?"). Mod pre-clearance is the cheapest insurance there is.**

**The play:** don't post a product launch. Post the thing r/philadelphia actually loves — a map of Philly's dysfunction, made by a local, free, no login, no monetization. Lead with the data, not the app. Put the link in a comment, not the title or body, unless the mods say a link post is fine.

**Title:**

> I made a free map of every open pothole report in Philly — 1,500+ right now, live from 311

**Body:**

> I was at the Code & Coffee AI Agent Hackathon at the Pennovation Center today and built something I've wanted to exist for a while: a live map of every open pothole report in the city.
>
> The city publishes every 311 request since 2014 — about 5.9 million rows — but actually using that data takes SQL skills and patience for its quirks. So I put a map in front of it. Every yellow dot is an open "Street Defect" report, straight from the city's live 311 feed, clickable. There are 1,500+ open right now.
>
> You can also type two addresses and it compares driving routes by how many open pothole reports each one passes. Real example from today: Temple to Citizens Bank Park, same 17-minute drive — one route passes 9 open reports, the other 13. (Waze warns you about potholes; nothing actually *routes around* them.)
>
> A couple of honest caveats: these are resident *reports*, not verified potholes — the map says so. And it's a one-day hackathon build, so be gentle.
>
> Free, no login, no ads, nothing for sale. Built solo in a day by a Philly-area IT guy. If the mods allow it I'll drop the link in a comment. Happy to answer questions about the 311 data — it's grimmer than you'd think (roughly 19% of pothole reports are still sitting open).

**First comment (if allowed):**

> Link: https://potholejawn.com — works on your phone too, you can add it to your home screen. Code is open source: https://github.com/dgpugliese/potholejawn-hackathon

---

## 2. r/SideProject

**Conventions check:** r/SideProject welcomes self-promo from actual makers — the bar is substance, not karma. Show what you built and how, use the required flair (check which flairs are live when posting, likely "I made this" or similar), don't drive-by drop a link.

**Title:**

> Built in one day at a Philly hackathon: an AI agent that scans the city's live 311 data (5.9M rows) to route you around potholes

**Body:**

> potholejawn — type two Philadelphia addresses and an AI agent geocodes both, pulls route alternatives from OSRM, runs a PostGIS query against the city's live 311 API for open pothole reports within 30m of each route, and recommends the smoother drive with a plain-language briefing. The map opens on 1,500+ open pothole reports citywide before you type anything.
>
> The gap it fills: no nav app actually routes around potholes. Waze lets users pin them and warns you — but its router only optimizes travel time, so it sends you straight through a cratered block.
>
> Stack: Python/Flask, Leaflet, hand-rolled tool-calling loop on the Anthropic API (no framework, ~160 lines), SSE streaming so you watch the agent think, and a second agent that answers open-ended 311 questions by writing its own guarded SQL. 42 tests, SQL guardrails treating model output as untrusted, graceful fallback so the demo can't die.
>
> Live: https://potholejawn.com · Code (MIT): https://github.com/dgpugliese/potholejawn-hackathon
>
> Would love feedback on one thing specifically: the roadmap item of a true roughness-weighted router (custom edge penalties on the street graph instead of picking among OSRM's time-optimal alternatives). Anyone done custom-weight routing on OSM data?

---

## 3. r/InternetIsBeautiful

**Conventions check:** strict 90/10 self-promo rule — if David's recent Reddit history is mostly promoting his own stuff, don't post here (or wait and build normal activity first). No sign-up-required products (potholejawn qualifies: no login), no "very basic" sites, descriptive titles that say what the site does. Post it once; don't resubmit.

**Title:**

> A live map of every open pothole report in Philadelphia (1,500+), with an AI agent that routes you around them

**Body** (this sub is link-post style; if a comment is expected, use this as the first comment):

> Philadelphia publishes every 311 request since 2014 — 5.9 million rows of open data almost nobody can use. This puts a map in front of it: every open pothole report in the city, live and clickable, plus a "Where to?" box where an agent compares driving routes by how many open reports each passes and explains its pick. Free, no login, works as a phone home-screen app. Built solo in one day at a Philly hackathon; code is MIT on GitHub.

---

## 4. X/Twitter thread

**Tweet 1 — hook** *(image: `docs/screenshots/home.png`)*

> Philly publishes every 311 request since 2014 — 5.9 MILLION rows — and basically nobody can use it.
>
> So yesterday at a hackathon I built potholejawn: type two Philly addresses and an AI agent routes you around the potholes.
>
> Every yellow dot is an open pothole report. There are 1,500+.

**Tweet 2 — the receipt** *(image: `docs/screenshots/trip.png`)*

> Real result from live city data: Temple University → Citizens Bank Park.
>
> Same 17-minute drive. One route passes 9 open pothole reports. The other passes 13.
>
> The agent picks the smoother one and tells you why — and you can expand "What the agent did" to see every step it took.

**Tweet 3 — how it works** *(image: `docs/screenshots/mobile.png`)*

> Under the hood: a hand-rolled tool-calling loop on the Anthropic API. No framework, ~160 lines.
>
> The agent geocodes both ends, pulls route alternatives from OSRM, runs a PostGIS query against the city's live 311 API for open reports within 30m of each route, and streams its thinking to the browser live.

**Tweet 4 — the Waze gap** *(image: none, or re-use `trip.png` cropped to the route comparison)*

> Here's the thing: nobody routes around potholes. Not even Waze.
>
> Waze lets users pin them and beeps as you approach — then its router drives you straight through, because it only optimizes travel time. Google patented road-quality routing in 2015 and never shipped it.
>
> The data to avoid them is public. It just needed an agent in front of it.

**Tweet 5 — close** *(image: `docs/screenshots/home.png` if tweet 1 used something else, otherwise none)*

> potholejawn is live, free, no login: https://potholejawn.com
>
> Built solo in one day at the Code & Coffee Philadelphia AI Agent Hackathon at the Pennovation Center. Code is MIT: https://github.com/dgpugliese/potholejawn-hackathon
>
> It's Philly. Obviously it's called potholejawn.

---

## 5. LinkedIn

*(~150 words, David's Director of IT / AI platform voice, 3 hashtags max)*

> Yesterday I built and shipped an AI agent product in one day — solo — at the Code & Coffee Philadelphia AI Agent Hackathon.
>
> potholejawn (yes, really): type two Philly addresses and an agent scans the city's live 311 data — 5.9 million rows — to route you around open pothole reports. No navigation app does this today, including Waze.
>
> The part I'm proudest of isn't the demo — it's that it shipped like production software: a hand-rolled tool-calling loop on the Anthropic API, model-written SQL treated as untrusted input behind a guardrail validator, a geofence, rate limiting, prompt caching for cost control, graceful fallback so the demo can't die, and 42 passing tests. Live at potholejawn.com, open source, built with Claude as the pair programmer.
>
> One day is enough to ship real agentic software if you take the guardrails as seriously as the model.
>
> #AIAgents #Philadelphia #OpenData

*(Note: "Cloud Run" is not mentioned in README/devpost — if that's the actual host, add "deployed to Cloud Run" to the guardrails sentence; otherwise leave as is.)*

---

## 6. Hacker News — Show HN

**Title** (Show HN convention: plain, factual, no hype, say what it is):

> Show HN: An agent that routes you around Philadelphia potholes using live 311 data

**First comment (post immediately after submitting):**

> Built this solo yesterday at a Philly hackathon. Philadelphia publishes every 311 request since 2014 (~5.9M rows) via a public Carto SQL API — the trip agent geocodes both endpoints, pulls route alternatives from OSRM, and runs a PostGIS ST_DWithin query for open "Street Defect" reports within 30m of each route, then explains its pick; a second agent answers open-ended questions by writing its own SQL through a read-only guardrail validator (single SELECT, table allowlist, no comments, 200-row cap), reading its errors and retrying. The interesting engineering was mostly defensive: the model never writes the route SQL, every coordinate is geofenced to a Philly bounding box, and a plain-Python fallback planner produces the same map if the model call fails, so the demo can't die. No framework — one ~160-line tool loop on the Anthropic API. Happy to answer anything about the guardrails or the 311 data's quirks (which are considerable).

---

## Posting order + timing

Everything waits until **after hackathon judging** — don't scoop your own demo.

1. **Tonight (Sat, after judging)** — X/Twitter thread + LinkedIn. LinkedIn actually does fine on weekends for personal-story posts, and the "built today" framing is freshest now. Twitter thread same evening while "today" is literally true (edit to "yesterday"/date after).
2. **Sunday evening (6–9pm ET)** — r/philadelphia. Local subs peak evenings when people are home; Sunday evening is prime Philly-scrolling time. Message the mods Sunday afternoon if the sidebar is ambiguous.
3. **Monday or Tuesday, 8–10am ET** — Hacker News Show HN. HN traffic peaks weekday mornings US time; never launch a Show HN on a weekend. Have the first comment ready to paste.
4. **Monday–Wednesday** — r/SideProject (any weekday; it's a global sub, mornings ET do fine). Space it a day from HN so it doesn't look like a blast.
5. **Later in the week, only if David's account passes 90/10** — r/InternetIsBeautiful. This one can wait weeks with no cost; the sub rewards the site, not the news cycle.

One evergreen rule: reply to every comment in the first two hours on each platform. Engagement in the first window decides reach everywhere.
