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

ENV SEARCH_DB=/app/cases.db \
    SEARCH_VOCAB=/app/keyword-vocab.csv \
    SEARCH_IMMUTABLE=1 \
    PYTHONUNBUFFERED=1

# Cloud Run injects $PORT.
CMD exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1
