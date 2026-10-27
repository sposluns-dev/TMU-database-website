#!/bin/sh
#
# Container entrypoint for tmu-case-db-gcs.
#
# 1. Download cases.db and the semantic index from gs://$JICL_BUCKET into /app.
#    Cloud Run's filesystem is in memory, so these ~280 MB count against the
#    service's memory limit (hence 4Gi in deploy-gcs.sh, not 3Gi).
# 2. Start uvicorn exactly as server/Dockerfile does.
#
# The download uses only the Python standard library: an access token from the
# Cloud Run metadata server, then the Cloud Storage JSON API. No gcloud and no
# google-cloud-storage package in the image. The token belongs to the service's
# own service account, which can only READ this one bucket.
#
# If any download fails the container exits non-zero, Cloud Run marks the
# instance unhealthy and does not route traffic to it. A container that started
# with no database would answer every search with an error instead.
#
# Bucket layout (written by deploy-gcs.sh):
#     cases.db
#     embeddings/manifest.json  embeddings/chunks.jsonl  embeddings/vectors.npy
set -eu

python3 - <<'EOF'
import json, os, shutil, sys, time, urllib.parse, urllib.request

bucket = os.environ["JICL_BUCKET"]
objects = {
    "cases.db": "/app/cases.db",
    "embeddings/manifest.json": "/app/embeddings/manifest.json",
    "embeddings/chunks.jsonl": "/app/embeddings/chunks.jsonl",
    "embeddings/vectors.npy": "/app/embeddings/vectors.npy",
}

# Local testing: JICL_GCS_ENDPOINT points at a stand-in server and no token is
# fetched. On Cloud Run neither variable is set.
endpoint = os.environ.get("JICL_GCS_ENDPOINT", "https://storage.googleapis.com")
headers = {}
if "JICL_GCS_ENDPOINT" not in os.environ:
    md = urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/"
        "instance/service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"})
    with urllib.request.urlopen(md, timeout=10) as r:
        headers["Authorization"] = "Bearer " + json.load(r)["access_token"]

t0 = time.perf_counter()
for name, dest in objects.items():
    url = (f"{endpoint}/storage/v1/b/{bucket}/o/"
           f"{urllib.parse.quote(name, safe='')}?alt=media")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers),
                                timeout=300) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    os.replace(tmp, dest)      # never leave a half-written file at the real path
    print(json.dumps({"severity": "INFO", "event": "data_download", "object": name,
                      "bytes": os.path.getsize(dest)}))

print(json.dumps({"severity": "INFO", "event": "data_ready",
                  "seconds": round(time.perf_counter() - t0, 2)}))
EOF

# --forwarded-allow-ips='*' is load-bearing: see the long note in server/Dockerfile.
exec uvicorn app:app --host 0.0.0.0 --port "${PORT:-8080}" --workers 1 \
    --proxy-headers --forwarded-allow-ips='*'
