#!/usr/bin/env bash
#
# Deploy the PARALLEL Google version: tmu-case-db-gcs in project jicl-database.
#
# This never touches the live service. Every gcloud call passes --project
# explicitly, so it does not matter which gcloud configuration is active, and
# server/deploy.sh (tmu-case-db) is left exactly as it is.
#
# WHAT IT DOES
#   1. Checks db/embeddings/ was built from this db/cases.db (same check as deploy.sh).
#   2. Makes sure the service account exists and can READ the bucket (idempotent).
#   3. Uploads cases.db + the index files to gs://${BUCKET}.
#   4. Copies the code from ../server/ and the query model from ../db/embeddings/
#      into this folder, deploys, and deletes the copies however the script exits.
#
# PRIVATE BY DEFAULT. The service is deployed with --no-allow-unauthenticated, so
# only signed-in accounts with run.invoker can call it. To test it from the
# website on your laptop, open an authenticated tunnel and point the dev server at it:
#
#     gcloud run services proxy tmu-case-db-gcs --project jicl-database \
#         --region northamerica-northeast2 --port 8081
#     VITE_API_BASE=http://localhost:8081 npm run dev
#
# PUBLIC=1 ./deploy-gcs.sh makes it public like tmu-case-db (and the org policy
# may refuse that).
#
# ASCII ONLY and every expansion braced -- see the note at the top of deploy.sh.
#
# Usage:
#     ./deploy-gcs.sh
#     PUBLIC=1 ./deploy-gcs.sh
#     CORS_ORIGINS=https://example.org ./deploy-gcs.sh
#
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${PROJECT:-jicl-database}"
REGION="${REGION:-northamerica-northeast2}"
SERVICE="${SERVICE:-tmu-case-db-gcs}"
BUCKET="${BUCKET:-jicl-database-data}"
SA_NAME="${SA_NAME:-tmu-case-db-gcs}"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:5173}"
PUBLIC="${PUBLIC:-0}"

SRC_SERVER="../server"
SRC_DB="../db/cases.db"
SRC_EMB="../db/embeddings"
CODE_FILES="app.py mcp_server.py semantic.py requirements.txt keyword-vocab.csv"

# ---- 0. inputs ------------------------------------------------------------
for f in "${SRC_DB}" "${SRC_EMB}/manifest.json" "${SRC_EMB}/vectors.npy" \
         "${SRC_EMB}/chunks.jsonl" "${SRC_EMB}/query-model/model.onnx" \
         "${SRC_EMB}/query-model/tokenizer.json"; do
    if [ ! -f "${f}" ]; then
        echo "missing input: ${f}" >&2
        exit 1
    fi
done
for f in ${CODE_FILES}; do
    if [ ! -f "${SRC_SERVER}/${f}" ]; then
        echo "missing input: ${SRC_SERVER}/${f}" >&2
        exit 1
    fi
done

# ---- 1. index must match the database ---------------------------------------
# semantic.py refuses a mismatch at runtime, which would silently disable
# semantic_search. Catch it before anything is uploaded.
DB_SHA="$(shasum -a 256 "${SRC_DB}" | cut -d' ' -f1)"
if ! grep -q "\"cases_db_sha256\": \"${DB_SHA}\"" "${SRC_EMB}/manifest.json"; then
    echo "db/embeddings/ was built from a different cases.db." >&2
    echo "rebuild it: python3 scripts/build_embeddings.py" >&2
    exit 1
fi

# ---- 2. service account: read this bucket, nothing else ---------------------
if ! gcloud iam service-accounts describe "${SA}" --project "${PROJECT}" >/dev/null 2>&1; then
    echo "creating service account ${SA}..."
    gcloud iam service-accounts create "${SA_NAME}" --project "${PROJECT}" \
        --display-name "tmu-case-db-gcs runtime (reads ${BUCKET})"
fi
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member "serviceAccount:${SA}" --role roles/storage.objectViewer \
    --project "${PROJECT}" >/dev/null
echo "  ${SA} can read gs://${BUCKET}"

# ---- 3. upload the data ------------------------------------------------------
# rsync without --recursive copies only the top level of db/embeddings/, so the
# query-model/ folder (baked into the image instead) is never uploaded.
echo "uploading data to gs://${BUCKET}..."
gcloud storage cp "${SRC_DB}" "gs://${BUCKET}/cases.db" --project "${PROJECT}"
gcloud storage rsync "${SRC_EMB}" "gs://${BUCKET}/embeddings" --project "${PROJECT}"

# ---- 4. stage the code, deploy, clean up -------------------------------------
cleanup() {
    for f in ${CODE_FILES}; do rm -f "${f}"; done
    rm -rf query-model
}
trap cleanup EXIT

echo "staging code from ${SRC_SERVER}/..."
for f in ${CODE_FILES}; do cp "${SRC_SERVER}/${f}" "${f}"; done
cp -R "${SRC_EMB}/query-model" query-model

if [ "${PUBLIC}" = "1" ]; then
    AUTH_FLAG="--allow-unauthenticated"
else
    AUTH_FLAG="--no-allow-unauthenticated"
fi

# 4Gi, not 3Gi: the ~280 MB of downloaded data lives in Cloud Run's in-memory
# filesystem, on top of the ~1.7 GB semantic_search peak (see semantic.py).
# The ^@^ prefix makes @ the separator, so CORS_ORIGINS may contain commas.
echo "deploying ${SERVICE} to ${PROJECT} / ${REGION}..."
gcloud run deploy "${SERVICE}" \
    --source . \
    --project "${PROJECT}" \
    --region "${REGION}" \
    --service-account "${SA}" \
    --set-env-vars "^@^JICL_BUCKET=${BUCKET}@SEARCH_CORS_ORIGINS=${CORS_ORIGINS}" \
    ${AUTH_FLAG} \
    --memory 4Gi \
    --cpu-boost \
    --max-instances 4 \
    --min-instances 0

URL="$(gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --format='value(status.url)')"
echo
echo "Service URL: ${URL}"
echo "verifying..."
if [ "${PUBLIC}" = "1" ]; then
    CURL_AUTH=""
else
    CURL_AUTH="Authorization: Bearer $(gcloud auth print-identity-token)"
fi
if curl -s --max-time 120 ${CURL_AUTH:+-H "${CURL_AUTH}"} "${URL}/health"; then
    echo
    echo "OK. ${SERVICE} is live at ${URL}"
else
    echo "  health check failed. Logs:"
    echo "  gcloud run services logs read ${SERVICE} --project ${PROJECT} --region ${REGION} --limit 50"
fi
echo
