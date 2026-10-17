FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn==23.0.0

COPY pothole_agent ./pothole_agent
# The compacted Philadelphia street graph (3 MB) the pothole-aware router loads.
COPY data/philly_graph.json.gz ./data/philly_graph.json.gz

ENV PYTHONUNBUFFERED=1 \
    PRELOAD_GRAPH=1

# Cloud Run provides $PORT; default to 8080 for local docker runs.
# One worker: the street graph costs ~170 MB resident, requests are I/O bound
# (city API, OSRM, model), and routing itself takes tens of milliseconds, so
# threads carry the concurrency. --timeout 0 lets SSE streams run as long as
# the agent needs.
CMD exec gunicorn --bind :${PORT:-8080} --workers 1 --threads 16 --timeout 0 "pothole_agent.webapp:create_app()"
