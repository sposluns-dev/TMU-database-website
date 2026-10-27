# Cloud Run container for the PUBLIC web service (tmu-case-db-web).
#
# Serves the built website and forwards an allowlist of read-only /api/* calls
# to the private backend tmu-case-db-gcs. See web.py.
#
# dist/ is NOT kept in this folder: deploy-web.sh builds the frontend into
# web-gcs/dist/ for the length of the upload, then deletes it.
FROM python:3.12-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY web.py .
COPY dist/ ./dist/

ENV PYTHONUNBUFFERED=1

# NO --proxy-headers here, deliberately. With --forwarded-allow-ips='*' uvicorn
# takes the LEFTMOST X-Forwarded-For entry as the client, and a visitor can write
# that entry themselves -- it let anyone dodge the rate limit. web.py reads the
# entry Google's front end appended instead (client_ip()). This app builds no
# redirects, so it does not need the forwarded scheme either.
CMD exec uvicorn web:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 \
    --no-proxy-headers
