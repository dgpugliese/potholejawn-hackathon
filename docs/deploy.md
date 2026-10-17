# Deploying potholejawn on Google Cloud

Everything runs in one Google Cloud project. Nothing else is required: no
third-party host, CDN, or secret store.

| Piece | Google Cloud service | Why |
|---|---|---|
| App (Flask + gunicorn, street graph in memory) | **Cloud Run** (`potholejawn`, `us-east4`) | Scales to zero, HTTPS and a managed domain for free, 1 vCPU and 1 GiB is plenty |
| Container images | **Artifact Registry** (`cloud-run-source-deploy`) | Private, regional, used by Cloud Run directly |
| Build, test, and deploy on every push | **Cloud Build** (`cloudbuild.yaml`) | Runs `pytest`, builds the image, rolls out the revision |
| Anthropic API key | **Secret Manager** (`anthropic-api-key`) | Mounted as an env var at container start; never in the image, repo, or service config |
| Logs, uptime, alerts | **Cloud Logging** and **Cloud Monitoring** | Request logs and the agent's own `app.logger` lines land here automatically |
| Domains (`potholejawn.com`, `potholejawn.app`) | **Cloud Run domain mapping** (or a global HTTPS load balancer) | Managed certificates |

The street graph (`data/philly_graph.json.gz`, 3 MB) ships inside the image, so
a container is self-sufficient: it needs the city's 311 API and OSRM at request
time, nothing else.

## One-time project setup

Run these once as a project owner. Replace nothing; the names match
`cloudbuild.yaml`.

```bash
gcloud config set project potholejawn-prod
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  monitoring.googleapis.com logging.googleapis.com

# 1. Put the Anthropic key in Secret Manager (paste it at the prompt; it is not echoed).
read -s ANTHROPIC_API_KEY && printf '%s' "$ANTHROPIC_API_KEY" | \
  gcloud secrets create anthropic-api-key --replication-policy=automatic --data-file=-
unset ANTHROPIC_API_KEY

# 2. Let the Cloud Run runtime identity read it.
PROJECT_NUMBER=$(gcloud projects describe potholejawn-prod --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding anthropic-api-key \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor

# 3. Let Cloud Build deploy to Cloud Run.
for role in roles/run.admin roles/iam.serviceAccountUser roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding potholejawn-prod \
    --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" --role=$role
done
```

If the key was ever set as a plain environment variable on the service (it was,
before Secret Manager), **rotate it** in the Anthropic console after the first
deploy from `cloudbuild.yaml`, then add the new value as a new secret version:

```bash
read -s KEY && printf '%s' "$KEY" | gcloud secrets versions add anthropic-api-key --data-file=-; unset KEY
gcloud run services update potholejawn --region us-east4 --update-secrets=ANTHROPIC_API_KEY=anthropic-api-key:latest
```

## Deploy

By hand, from a checkout (runs the tests first; a red test aborts the deploy):

```bash
gcloud builds submit --config cloudbuild.yaml .
```

Continuous deployment on every push to `main`: connect the GitHub repo once in
the console (Cloud Build > Triggers > Connect repository), then:

```bash
gcloud builds triggers create github \
  --name=potholejawn-main \
  --repo-name=potholejawn-hackathon --repo-owner=dgpugliese \
  --branch-pattern='^main$' \
  --build-config=cloudbuild.yaml
```

Verify a deploy:

```bash
URL=$(gcloud run services describe potholejawn --region us-east4 --format='value(status.url)')
curl -s "$URL/healthz"
# {"ok": true, "agent_available": true, "smooth_router": {"available": true, ...}}
```

`smooth_router.available` must be `true`; if it is not, the image is missing
`data/philly_graph.json.gz` (see below).

Roll back in one command if a revision misbehaves:

```bash
gcloud run services update-traffic potholejawn --region us-east4 --to-revisions=PREVIOUS_REVISION=100
```

## Refreshing the street graph

The router's graph is built from OpenStreetMap and committed to the repo. It
changes slowly (new streets, closed ramps); rebuild it every few months:

```bash
python -m pothole_agent.streetgraph build      # ~2 min: downloads ~50 MB from Overpass, writes 3 MB
pytest -q && git commit -am "Refresh street graph"
```

The raw download is cached in `data/philly_osm_raw.json` (gitignored) and
reused if present; delete it to force a fresh download.

## Costs and knobs

- Cloud Run at `min-instances=0` costs nothing while idle. Set `--min-instances=1`
  (about $8/month at 1 vCPU, 1 GiB) if the ~2 s cold start matters for demos.
- Rate limits for the agent endpoints are env vars set in `cloudbuild.yaml`
  (`RATE_MAX_PER_IP`, `RATE_WINDOW_SECONDS`, `RATE_MAX_PER_HOUR`,
  `RATE_MAX_CONCURRENT`). The pothole layer and the fallback planner are not
  rate limited; they spend no model tokens.
- `TRIP_CACHE_SECONDS` (default 3600) caches agent-written trips per
  start/end/avoidance so repeated demos cost nothing.
- Memory: the graph is about 170 MB resident. The Dockerfile runs one gunicorn
  worker with 16 threads for that reason; do not raise workers without raising
  `--memory`.
