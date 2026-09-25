#!/usr/bin/env python3
"""
Build db/embeddings/ from db/cases.db — the vector index behind the MCP
server's semantic search.

Like cases.db, the output is a BUILD ARTIFACT: everything in it is derived from
cases.text, so the script never preserves anything. It builds into a temp
directory and atomically swaps it in, so an interrupted run leaves the existing
index untouched.

Output (db/embeddings/):

    vectors.npy     float16 [n_chunks, dim], L2-normalized, so a query's scores
                    are one matrix-vector product (cosine == dot product).
    chunks.jsonl    one {"i","case_id","start","end"} per row of vectors.npy.
                    Offsets index into cases.text — the chunk TEXT is not stored,
                    so the index cannot drift out of sync with the database it
                    was built from; slice it back out with text[start:end].
    manifest.json   model, chunking parameters and the cases.db fingerprint the
                    index was built against. The server should refuse to load an
                    index whose fingerprint does not match its cases.db.

MODEL: intfloat/multilingual-e5-small. Multilingual because 119 of the cases are
in French, and a query in either language should reach both. Small (118M
params, 384 dims) because the SERVER has to embed every query at request time
with this same model — a large model here means a large, slow Cloud Run image.

E5 IS PREFIX-SENSITIVE: passages are embedded as "passage: ...", and queries
MUST be embedded as "query: ..." at search time. Omitting the query prefix does
not error; it just quietly degrades every result.

Each chunk is prefixed with its case name and citation, so a passage that never
names its own case ("the appellant's claim...") still carries that context into
its vector.

Usage:
    python scripts/build_embeddings.py              # full build
    python scripts/build_embeddings.py --limit 20   # quick timing run on 20 cases
"""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "cases.db"
OUT_DIR = ROOT / "db" / "embeddings"

MODEL_NAME = "intfloat/multilingual-e5-small"
PASSAGE_PREFIX = "passage: "
QUERY_PREFIX = "query: "   # recorded in the manifest for the server; unused here

# ~1,500 characters is ~350-450 tokens, comfortably inside E5's 512-token
# window once the case-name header is added — longer chunks would be silently
# truncated by the tokenizer. The overlap keeps a sentence that straddles a
# boundary retrievable from at least one side.
CHUNK_CHARS = 1500
OVERLAP_CHARS = 200
BATCH_SIZE = 64


def db_fingerprint(path: Path) -> str:
    """sha256 of cases.db — ties the index to the exact database it came from."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def chunk_spans(text: str):
    """Yield (start, end) spans of ~CHUNK_CHARS, ending on a paragraph or
    sentence break where one exists in the back third of the window."""
    n = len(text)
    start = 0
    while start < n:
        end = min(start + CHUNK_CHARS, n)
        if end < n:
            floor = start + (CHUNK_CHARS * 2) // 3
            for sep in ("\n\n", "\n", ". "):
                cut = text.rfind(sep, floor, end)
                if cut != -1:
                    end = cut + len(sep)
                    break
        # Skip whitespace-only tails; they would embed as noise.
        if text[start:end].strip():
            yield start, end
        if end >= n:
            break
        start = max(end - OVERLAP_CHARS, start + 1)


def pick_device() -> str:
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--limit", type=int, help="embed only the first N cases (timing test)")
    args = ap.parse_args()

    if not DB_PATH.exists():
        sys.exit(f"missing {DB_PATH} — run scripts/build_db.py first")

    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    sql = "SELECT case_id, case_name, citation, text FROM cases ORDER BY case_id"
    if args.limit:
        sql += f" LIMIT {int(args.limit)}"
    rows = con.execute(sql).fetchall()
    con.close()

    chunks, inputs = [], []
    for case_id, name, citation, text in rows:
        if not text:
            continue
        header = " — ".join(p for p in (name, citation) if p)
        for start, end in chunk_spans(text):
            chunks.append({"case_id": case_id, "start": start, "end": end})
            inputs.append(f"{PASSAGE_PREFIX}{header}\n{text[start:end]}")

    print(f"{len(rows)} cases -> {len(chunks):,} chunks")

    from sentence_transformers import SentenceTransformer
    device = pick_device()
    model = SentenceTransformer(MODEL_NAME, device=device)
    # fp16 on GPU: measured ~35% faster on an M2 Pro (79 vs 58 chunks/s) with
    # cosine 1.000 against fp32 vectors. CPU fp16 is slower, so leave it fp32.
    if device != "cpu":
        model = model.half()
    print(f"model {MODEL_NAME} on {device}, dim {model.get_sentence_embedding_dimension()}")

    t0 = time.time()
    vectors = model.encode(
        inputs,
        batch_size=BATCH_SIZE,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=True,
    ).astype(np.float16)
    elapsed = time.time() - t0
    print(f"embedded {len(inputs):,} chunks in {elapsed:.0f}s "
          f"({len(inputs) / max(elapsed, 1e-9):.0f} chunks/s)")

    manifest = {
        "model": MODEL_NAME,
        "dim": int(vectors.shape[1]),
        "dtype": "float16",
        "normalized": True,
        "passage_prefix": PASSAGE_PREFIX,
        "query_prefix": QUERY_PREFIX,
        "chunk_chars": CHUNK_CHARS,
        "overlap_chars": OVERLAP_CHARS,
        "n_cases": len({c["case_id"] for c in chunks}),
        "n_chunks": len(chunks),
        "partial": bool(args.limit),
        "cases_db_sha256": db_fingerprint(DB_PATH),
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    # Build beside the target, then swap, so a failed write never leaves a
    # half-written index where the server would load it.
    OUT_DIR.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=".embeddings-", dir=OUT_DIR.parent))
    try:
        np.save(tmp / "vectors.npy", vectors)
        with open(tmp / "chunks.jsonl", "w", encoding="utf-8") as f:
            for i, c in enumerate(chunks):
                f.write(json.dumps({"i": i, **c}) + "\n")
        (tmp / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        if OUT_DIR.exists():
            shutil.rmtree(OUT_DIR)
        os.replace(tmp, OUT_DIR)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise

    size_mb = sum(p.stat().st_size for p in OUT_DIR.iterdir()) / 1e6
    print(f"wrote {OUT_DIR.relative_to(ROOT)}/  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
