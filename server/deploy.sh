#!/usr/bin/env bash
#
# Deploy the search service to Cloud Run.
#
# WHY THIS SCRIPT EXISTS
# `gcloud run deploy --source .` uploads only this directory, so the Dockerfile
# can only COPY files that physically sit here. keyword-vocab.csv now lives in
# server/ permanently (it is both edited here and read by the pipeline scripts),
# so the Dockerfile copies it directly and this script does not touch it.
#
# cases.db is different: it is a ~191 MB build artifact that lives in
# db/ (written by scripts/build_db.py) and must NOT be parked in server/
# -- editing the real file and forgetting to re-copy would silently ship stale
# data. So this script stages ONLY cases.db, deploys, and removes it again -- the
# duplicate exists just for the seconds the upload takes, always fresh.
#
# ASCII ONLY, DELIBERATELY. macOS ships bash 3.2, which in a single-byte locale
# (this Mac reports LC_CTYPE="C") treats the leading byte of a multi-byte UTF-8
# character as a letter. A "..." written as a real ellipsis straight after
# "$REGION" got absorbed into the variable name, and `set -u` then aborted with
# `REGION?: unbound variable`. Keep this file 7-bit ASCII and brace every
# expansion as ${VAR}, which terminates the name explicitly.
#
# Usage:
#     ./deploy.sh                     # deploy with the defaults below
#     REGION=us-central1 ./deploy.sh  # override region
#     SERVICE=tmu-case-db-test ./deploy.sh
#
set -euo pipefail
cd "$(dirname "$0")"

REGION="${REGION:-northamerica-northeast2}"
SERVICE="${SERVICE:-tmu-case-db}"
SRC_DB="../db/cases.db"

for f in "${SRC_DB}" "keyword-vocab.csv"; do
    if [ ! -f "${f}" ]; then
        echo "missing input: ${f}" >&2
        exit 1
    fi
done

# Remove the staged DB however we exit -- success, failure or Ctrl-C.
# (keyword-vocab.csv lives here permanently and is never staged/removed.)
cleanup() { rm -f cases.db; }
trap cleanup EXIT

echo "staging build inputs..."
cp "${SRC_DB}" cases.db
echo "  cases.db        $(du -h cases.db | cut -f1)"
echo "  keyword-vocab   $(wc -l < keyword-vocab.csv | tr -d ' ') lines"

echo "deploying ${SERVICE} to ${REGION}..."
gcloud run deploy "${SERVICE}" \
    --source . \
    --region "${REGION}" \
    --allow-unauthenticated \
    --memory 1Gi \
    --cpu-boost \
    --max-instances 4 \
    --min-instances 0

# Cloud Run answers on two hostnames. status.url reports only the legacy random
# one (tmu-case-db-oxql5sw2xa-pd.a.run.app); the newer deterministic form is
# SERVICE-PROJECTNUMBER.REGION.run.app. Prefer the deterministic one: it is
# readable, and it is derived from names rather than assigned randomly, so it
# survives deleting and recreating the service. Bake THAT into the frontend.
LEGACY_URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --format='value(status.url)')"
PROJECT_NUMBER="$(gcloud projects describe "$(gcloud config get-value project 2>/dev/null)" --format='value(projectNumber)' 2>/dev/null || true)"

if [ -n "${PROJECT_NUMBER}" ]; then
    URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
else
    URL="${LEGACY_URL}"
fi

echo
echo "Service URL: ${URL}"
echo "  (also answers on ${LEGACY_URL})"
echo "verifying..."
if curl -s --max-time 60 "${URL}/health"; then
    echo
    echo "OK. Backend is live at ${URL}"
    # The Pages frontend pins the API URL in its COMMITTED .env.production and
    # redeploys automatically on push to main -- no repo variable, no manual
    # workflow run. So only say something when THIS url isn't what the frontend
    # already builds against (i.e. the service was recreated under a new name).
    ENV_PROD="../TMU-database-website/.env.production"
    if [ -f "${ENV_PROD}" ] && grep -qF "VITE_API_BASE=${URL}" "${ENV_PROD}"; then
        echo "Frontend already targets this URL (${ENV_PROD}) and redeploys on push -- nothing else to do."
    else
        echo "NOTE: the URL changed. Update VITE_API_BASE in ${ENV_PROD} to:"
        echo "        ${URL}"
        echo "      then commit + push to main to rebuild GitHub Pages."
    fi
else
    echo "  health check failed. Logs:"
    echo "  gcloud run services logs read ${SERVICE} --region ${REGION} --limit 50"
fi
echo
