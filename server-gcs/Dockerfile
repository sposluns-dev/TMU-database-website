# Cloud Run container for the PARALLEL Google version (tmu-case-db-gcs).
#
# Same code as server/Dockerfile, with one difference: cases.db and the semantic
# index are NOT baked in. start.sh downloads them from the Cloud Storage bucket
# ($JICL_BUCKET) into /app when the container starts, then runs uvicorn.
#
# Only the ONNX query model (~465 MB) stays in the image. It is pinned and changes
# only when the model does, so it is copied first and its layer is reused by
# every code-only deploy.
#
# app.py, mcp_server.py, semantic.py, requirements.txt, keyword-vocab.csv and
# query-model/ are NOT kept in this folder. deploy-gcs.sh copies them in from
# server/ and db/embeddings/ for the length of the upload, so both versions
# always run the same code.
FROM python:3.12-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY query-model/ ./embeddings/query-model/
COPY keyword-vocab.csv app.py mcp_server.py semantic.py start.sh ./

# The SAME paths as server/Dockerfile. start.sh writes the downloaded files to
# exactly these places, so app.py and semantic.py need no changes. The index
# files land in /app/embeddings/ beside the baked query-model/, which is where
# semantic.py expects both.
ENV SEARCH_DB=/app/cases.db \
    JICL_EMBEDDINGS=/app/embeddings \
    SEARCH_VOCAB=/app/keyword-vocab.csv \
    SEARCH_IMMUTABLE=1 \
    PYTHONUNBUFFERED=1

CMD ["sh", "/app/start.sh"]
