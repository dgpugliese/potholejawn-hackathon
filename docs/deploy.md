# Deploying potholejawn on Google Cloud

Everything runs in one Google Cloud project. Nothing else is required: no
third-party host, CDN, or secret store. The web app holds no secrets at all.

| Piece | Google Cloud service | Why |
|---|---|---|
| App (Flask + gunicorn, street graph in memory) | **Cloud Run** (`potholejawn`, `us-east4`) | Scales to zero, HTTPS and a managed domain for free, 1 vCPU and 1 GiB is plenty |
| Container images | **Artifact Registry** (`cloud-run-source-deploy`) | Private, regional, used by Cloud Run directly |
| Build, test, and deploy on every push | **Cloud Build** (`cloudbuild.yaml`) | Runs `pytest`, builds the image, rolls out the revision |
| Logs, uptime, alerts | **Cloud Logging** and **Cloud Monitoring** | Request logs and the app's own `app.logger` lines land here automatically |
| Domains (`potholejawn.com`, `potholejawn.app`) | **Cloud Run domain mapping** (or a global HTTPS load balancer) | Managed certificates |

The street graph (`data/philly_graph.json.gz`, 3 MB) ships inside the image, so
a container is self-sufficient: it needs the city's 311 API and OSRM at request
time, nothing else.

## One-time project setup

Run once as a project owner. The names match `cloudbuild.yaml`.

```bash
gcloud config set project potholejawn-prod
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com monitoring.googleapis.com logging.googleapis.com

# Let Cloud Build deploy to Cloud Run.
PROJECT_NUMBER=$(gcloud projects describe potholejawn-prod --format='value(projectNumber)')
for role in roles/run.admin roles/iam.serviceAccountUser roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding potholejawn-prod \
    --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" --role=$role
done
```

If an Anthropic key was ever set as an environment variable on the service
(it was, before October 2026), the first deploy from `cloudbuild.yaml` clears
it (`--clear-env-vars`). Revoke that key in the Anthropic console anyway.

## Deploy

By hand, from a checkout (runs the tests first; a red test aborts the deploy):

```bash
gcloud builds submit --config cloudbuild.yaml --substitutions=_TAG=$(git rev-parse --short HEAD) .
```

Continuous deployment on every push to `main`: connect the GitHub repo once in
the console (Cloud Build > Triggers > Connect repository), then:

```bash
gcloud builds triggers create github \
  --name=potholejawn-main \
  --repo-name=potholejawn-hackathon --repo-owner=dgpugliese \
  --branch-pattern='^main$' \
  --build-config=cloudbuild.yaml \
  --substitutions=_TAG='$SHORT_SHA'
```

Verify a deploy:

```bash
URL=$(gcloud run services describe potholejawn --region us-east4 --format='value(status.url)')
curl -s "$URL/healthz"
# {"ok": true, "smooth_router": {"available": true, ...}}
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
- There is no model in the request path, so the only recurring cost is Cloud
  Run compute. `TRIP_CACHE_SECONDS` (default 600) caches trips per
  start/end/avoidance to spare OSRM and the city API on repeats.
- Memory: the graph is about 170 MB resident. The Dockerfile runs one gunicorn
  worker with 16 threads for that reason; do not raise workers without raising
  `--memory`.
