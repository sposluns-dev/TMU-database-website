"""
Semantic (embedding) search over the JICL corpus — used ONLY by mcp_server.py.

The website's REST API deliberately has no route to this: semantic search is an
MCP-only capability for now. It is the one place mcp_server.py does NOT go
through the HTTP API, because the ranking here (cosine over chunk vectors) has
no REST equivalent to drift from.

Inputs, all produced by scripts/build_embeddings.py into db/embeddings/:

    vectors.npy     float16 [n_chunks, 384], L2-normalized
    chunks.jsonl    {"i","case_id","start","end"} per vector row
    manifest.json   model, prefixes, and the cases.db sha256 it was built from
    query-model/    model.onnx + tokenizer.json, the same model as ONNX

QUERY ENCODING RUNS ON onnxruntime, NOT PyTorch. The index was built with
sentence-transformers; queries are embedded here with the pinned ONNX export of
the same weights, which keeps ~1 GB of torch out of the Cloud Run image.
Measured parity on 12 EN/FR legal queries: cosine 1.00000 (mean and minimum,
to 5 places) against the sentence-transformers vectors — the same vectors.

E5 is prefix-sensitive. Queries get "query: " (read from the manifest);
dropping it does not error, it silently degrades every result.

THE FINGERPRINT CHECK IS LOAD-BEARING. chunks.jsonl stores character offsets
into cases.text, not the text itself. Against a different cases.db those offsets
point at the wrong passages — plausible-looking but wrong, and nothing would
flag it. So load() refuses an index whose manifest sha256 does not match the
database, and the tool returns that as an error telling you to rebuild.

Everything loads lazily on the first call (~2-3 s: 470 MB ONNX model, 82 MB
vectors, a sha256 of cases.db) so the website's cold starts do not pay for a
feature it never uses. Measured on macOS once loaded: ~1.7 GB peak RSS, of
which the ONNX session alone is ~1.3 GB (onnxruntime holds the 470 MB weights
plus an optimized copy; disabling the arena or graph optimization changed
nothing). Hence Cloud Run at 3Gi — at 2Gi one OOM would take the website down
with it, since both run in the same container.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def _first_existing(*paths) -> Path | None:
    for p in paths:
        if p and Path(p).exists():
            return Path(p).resolve()
    return None


EMB_DIR = _first_existing(
    os.environ.get("JICL_EMBEDDINGS", ""),
    HERE / "embeddings",                   # baked into the image
    ROOT / "db" / "embeddings",            # local dev
)
DB_PATH = _first_existing(
    os.environ.get("SEARCH_DB", ""),
    HERE / "cases.db",
    ROOT / "db" / "cases.db",
)

MAX_QUERY_TOKENS = 512          # E5's window; longer queries are truncated
CANDIDATE_CHUNKS = 3000         # top chunks considered before grouping by case
PASSAGE_CHARS = 700             # per returned passage; get_case has the rest


class SemanticIndexError(RuntimeError):
    """The index is missing or does not match cases.db. Message is user-facing."""


_lock = threading.Lock()
_state: dict[str, Any] | None = None


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def load() -> dict[str, Any]:
    """Load everything once; thread-safe. Raises SemanticIndexError with a fix."""
    global _state
    if _state is not None:
        return _state
    with _lock:
        if _state is not None:
            return _state

        if EMB_DIR is None or not (EMB_DIR / "manifest.json").exists():
            raise SemanticIndexError(
                "semantic index not found — run scripts/build_embeddings.py "
                "(or set JICL_EMBEDDINGS to the db/embeddings directory)")
        if DB_PATH is None:
            raise SemanticIndexError("cases.db not found — set SEARCH_DB")

        manifest = json.loads((EMB_DIR / "manifest.json").read_text())
        if manifest.get("partial"):
            raise SemanticIndexError("semantic index is a partial --limit build; "
                              "run scripts/build_embeddings.py without --limit")
        if manifest["cases_db_sha256"] != _sha256(DB_PATH):
            raise SemanticIndexError(
                "semantic index was built from a different cases.db, so its "
                "passage offsets would be wrong — rebuild it with "
                "scripts/build_embeddings.py")

        import onnxruntime as ort
        from tokenizers import Tokenizer

        qm = EMB_DIR / "query-model"
        tok = Tokenizer.from_file(str(qm / "tokenizer.json"))
        tok.enable_truncation(MAX_QUERY_TOKENS)
        tok.no_padding()
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1       # one query at a time; Cloud Run 1 vCPU
        session = ort.InferenceSession(str(qm / "model.onnx"), opts,
                                       providers=["CPUExecutionProvider"])

        # float32 for the matmul: numpy has no BLAS path for float16, and a
        # float16 product over 106k rows is ~20x slower.
        vectors = np.load(EMB_DIR / "vectors.npy").astype(np.float32)
        chunk_case, chunk_start, chunk_end = [], [], []
        with open(EMB_DIR / "chunks.jsonl", encoding="utf-8") as f:
            for line in f:
                c = json.loads(line)
                chunk_case.append(c["case_id"])
                chunk_start.append(c["start"])
                chunk_end.append(c["end"])
        if len(chunk_case) != vectors.shape[0]:
            raise SemanticIndexError("chunks.jsonl and vectors.npy disagree in length — rebuild")

        con = sqlite3.connect(f"file:{DB_PATH}?mode=ro&immutable=1",
                              uri=True, check_same_thread=False)
        meta = {
            r[0]: {"case_id": r[0], "case_name": r[1], "citation": r[2],
                   "court": r[3], "date": r[4], "language": r[5],
                   "level": "upper" if r[0].startswith("UC") else "lower"}
            for r in con.execute(
                "SELECT case_id, case_name, citation, court, date, language FROM cases")
        }

        _state = {
            "manifest": manifest, "tok": tok, "session": session,
            "input_names": {i.name for i in session.get_inputs()},
            "vectors": vectors, "con": con, "meta": meta,
            "chunk_case": np.array(chunk_case),
            "chunk_start": np.array(chunk_start, dtype=np.int64),
            "chunk_end": np.array(chunk_end, dtype=np.int64),
        }
        return _state


def embed_query(text: str) -> np.ndarray:
    """E5 query vector: prefix, mean-pool over the attention mask, L2-normalize."""
    s = load()
    enc = s["tok"].encode(s["manifest"]["query_prefix"] + text)
    ids = np.array([enc.ids], dtype=np.int64)
    mask = np.array([enc.attention_mask], dtype=np.int64)
    feeds = {"input_ids": ids, "attention_mask": mask}
    if "token_type_ids" in s["input_names"]:
        feeds["token_type_ids"] = np.zeros_like(ids)
    hidden = s["session"].run(["last_hidden_state"], feeds)[0]      # [1, T, 384]
    m = mask[..., None].astype(np.float32)
    v = (hidden * m).sum(axis=1) / np.clip(m.sum(axis=1), 1e-9, None)
    v = v[0]
    return v / np.linalg.norm(v)


def search(query: str, *, limit: int = 10, passages_per_case: int = 2,
           court: list[str] | None = None, level: str = "",
           language: str = "", date_from: str = "",
           date_to: str = "") -> dict[str, Any]:
    """Rank CASES by their best-matching chunk; return each with its top passages."""
    s = load()
    meta = s["meta"]
    scores = s["vectors"] @ embed_query(query)

    # Filters are applied at chunk level before ranking, so a filtered search
    # still returns `limit` cases instead of whatever survived a global top-k.
    if court or level or language or date_from or date_to:
        courts = {c.upper() for c in (court or [])}
        want_level = {"UC": "upper", "LC": "lower"}.get(level.upper(), "")
        ok_cases = {
            cid for cid, m in meta.items()
            if (not courts or (m["court"] or "").upper() in courts)
            and (not want_level or m["level"] == want_level)
            and (not language or m["language"] == language)
            and (not date_from or (m["date"] or "") >= date_from)
            and (not date_to or ((m["date"] or "9999") <= date_to))
        }
        if not ok_cases:
            return {"query": query, "returned": 0, "results": [],
                    "note": "no cases match those filters"}
        scores = np.where(np.isin(s["chunk_case"], list(ok_cases)), scores, -np.inf)

    k = min(CANDIDATE_CHUNKS, scores.shape[0])
    top = np.argpartition(-scores, k - 1)[:k]
    top = top[np.argsort(-scores[top])]

    by_case: dict[str, list[int]] = {}
    for i in top:
        if not np.isfinite(scores[i]):
            break
        cid = s["chunk_case"][i]
        hits = by_case.setdefault(cid, [])
        if len(hits) < passages_per_case:
            hits.append(int(i))
        if len(by_case) >= limit and all(
                len(v) >= passages_per_case for v in by_case.values()):
            break

    results = []
    for cid, idxs in list(by_case.items())[:limit]:
        passages = []
        for i in idxs:
            start, end = int(s["chunk_start"][i]), int(s["chunk_end"][i])
            # SQLite substr() is 1-based and counts characters, matching the
            # Python str offsets build_embeddings.py recorded.
            (text,) = s["con"].execute(
                "SELECT substr(text, ?, ?) FROM cases WHERE case_id = ?",
                (start + 1, min(end - start, PASSAGE_CHARS), cid)).fetchone()
            passages.append({"score": round(float(scores[i]), 4),
                             "start_char": start, "end_char": end,
                             "text": text})
        results.append({**meta[cid], "score": passages[0]["score"],
                        "passages": passages})

    return {"query": query, "model": s["manifest"]["model"],
            "returned": len(results), "results": results}
