#!/usr/bin/env bash
#
# Deploy the PUBLIC web service tmu-case-db-web in project jicl-database.
#
# It serves the website and forwards read-only /api/* calls to the PRIVATE
# backend tmu-case-db-gcs (deploy that first with ../server-gcs/deploy-gcs.sh).
# Every gcloud call passes --project, so the active configuration does not
# matter and the live tmu-case-db is never touched.
#
# WHAT IT DOES
#   1. Looks up the backend URL.
#   2. Lets the backend's service account call the backend (run.invoker on that
#      ONE service). The web service runs as that same account -- no new one.
#   3. Builds the frontend into web-gcs/dist/ with VITE_API_BASE=/api (same
#      origin, so CORS never applies), base path / and the MCP card off.
#   4. Deploys, then deletes dist/ however the script exits.
#   5. Checks: site loads, /api/health works, /api/mcp is refused, and the
#      backend still refuses a direct anonymous call.
#
# This service is PUBLIC on purpose (--allow-unauthenticated): it is a website.
# The backend and the bucket stay private.
#
# ASCII ONLY and every expansion braced -- see the note at the top of deploy.sh.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${PROJECT:-jicl-database}"
REGION="${REGION:-northamerica-northeast2}"
SERVICE="${SERVICE:-tmu-case-db-web}"
BACKEND_SERVICE="${BACKEND_SERVICE:-tmu-case-db-gcs}"
SA="${SA:-tmu-case-db-gcs@${PROJECT}.iam.gserviceaccount.com}"
RATE_PER_MIN="${RATE_PER_MIN:-120}"

# ---- 1. backend URL ---------------------------------------------------------
BACKEND_URL="$(gcloud run services describe "${BACKEND_SERVICE}" --project "${PROJECT}" \
    --region "${REGION}" --format='value(status.url)')"
if [ -z "${BACKEND_URL}" ]; then
    echo "backend ${BACKEND_SERVICE} not found -- run ../server-gcs/deploy-gcs.sh first" >&2
    exit 1
fi
echo "backend: ${BACKEND_URL}"

# ---- 2. the web service's account may call the backend ----------------------
gcloud run services add-iam-policy-binding "${BACKEND_SERVICE}" \
    --project "${PROJECT}" --region "${REGION}" \
    --member "serviceAccount:${SA}" --role roles/run.invoker >/dev/null
echo "  ${SA} can call ${BACKEND_SERVICE}"

# ---- 3. build the frontend ---------------------------------------------------
cleanup() { rm -rf dist; }
trap cleanup EXIT

echo "building the website..."
# Shell variables win over .env.production, so the GitHub Pages settings in that
# file are overridden for this build only.
( cd .. && VITE_API_BASE=/api VITE_MCP_ENABLED=false npx tsc \
      && VITE_API_BASE=/api VITE_MCP_ENABLED=false npx vite build \
             --base=/ --outDir web-gcs/dist --emptyOutDir )

# ---- 4. deploy ----------------------------------------------------------------
echo "deploying ${SERVICE} to ${PROJECT} / ${REGION}..."
gcloud run deploy "${SERVICE}" \
    --source . \
    --project "${PROJECT}" \
    --region "${REGION}" \
    --service-account "${SA}" \
    --set-env-vars "BACKEND_URL=${BACKEND_URL},WEB_RATE_PER_MIN=${RATE_PER_MIN}" \
    --allow-unauthenticated \
    --memory 512Mi \
    --cpu 1 \
    --max-instances 2 \
    --min-instances 0

URL="$(gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --format='value(status.url)')"

# ---- 5. checks ----------------------------------------------------------------
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 120 "$@"; }
echo
echo "Website: ${URL}"
echo "checks (expected in brackets):"
echo "  site /             $(code "${URL}/")  [200]"
echo "  /api/health        $(code "${URL}/api/health")  [200]"
echo "  /api/mcp/          $(code "${URL}/api/mcp/")  [404]"
echo "  backend, no login  $(code "${BACKEND_URL}/health")  [403]"
echo
