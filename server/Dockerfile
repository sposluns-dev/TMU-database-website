# Cloud Run container for the TMU JICL search service.
FROM python:3.12-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# LAYER ORDER IS DELIBERATE — copy the big, rarely-changing file FIRST.
# Docker invalidates every layer after the first changed one, so if app.py were
# copied before cases.db, editing one line of Python would rebuild and re-push a
# fresh ~191 MB layer on every deploy and pile up storage in Artifact Registry.
# This way a code-only deploy reuses the cached DB layer and pushes ~10 KB.
COPY cases.db .
COPY keyword-vocab.csv .
COPY app.py .
# app.py imports this to mount /mcp. The import is guarded, so OMITTING IT FAILS
# SILENTLY: the REST API still serves and /health still returns 200, but /mcp
# 404s and the only clue is a one-line note in the Cloud Run logs. Copied by name
# because this Dockerfile copies files individually (see the layer note above),
# so a new module beside app.py is invisible to the image unless listed here.
COPY mcp_server.py .

ENV SEARCH_DB=/app/cases.db \
    SEARCH_VOCAB=/app/keyword-vocab.csv \
    SEARCH_IMMUTABLE=1 \
    PYTHONUNBUFFERED=1

# Cloud Run injects $PORT.
CMD exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1
