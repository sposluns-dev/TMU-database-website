"""
TMU JICL case database — search service.

A read-only FastAPI app over db/cases.db (Phase 2 of Prototype-Runbook.md).

RANKING — hybrid, per Keyword-Search-Design.md §8, adapted to the schema we built:

    relevance = -bm25(cases_fts, 0.0, 1.0)        # TextScore: the judgment
              + 1.0 * -bm25(names_fts, 3.0, 2.0, 1.0)   # NameScore: who was before the court
              + SUM(tier weight of each curated keyword the query matched)

Search therefore covers CASE NAME + PARTIES + TEXT, and one relevance number
combines all three. They live in two FTS tables rather than one because FTS5's
bm25() computes the document length |D| per ROW across all columns: a 4-token party
list sharing a row with a 50,000-token judgment gets normalised against 50,000 and
loses ~76% of its score to the length of a judgment the name need not even appear
in. names_fts averages ~20 tokens/row, so a party match keeps full strength and
LAMBDA_NAME stays at 1.0 with no compensating fudge factor. See the long note above
names_fts in db/schema.sql.

cases_fts covers `case_name` + the FULL judgment text, so free-text search is
genuine text matching — the curated keywords are NOT in the index and never inflate
term frequency there (§4: "never stuff synonyms into the stored field"). They enter
ranking only as an additive boost, which is the safety net for the case that is
correctly tagged but phrases the issue differently in its reasons.

The tag boost was never part of either bm25 score and is unchanged by the split.

QUERY EXPANSION happens here, at request time, from the `synonyms` column of
keyword-vocab.csv — held in memory, never as a database table. A user's phrase is
matched against the synonym rings; each ring becomes an OR-group in the FTS
expression, and the rings are ANDed together:

    "religious freedom hate speech"
      -> ("freedom of religion" OR "religious freedom" OR "liberte de religion" ...)
         AND ("hate speech" OR "hate propaganda" OR "discours haineux" ...)

Because the index is built with `remove_diacritics 2`, the French variants in those
rings match French judgments from an unaccented English query and vice-versa.

BOOLEAN GRAMMAR: the uppercase operators AND / OR / NOT and round parentheses
are passed through to FTS5 as real operators (`religious freedom AND jewish`,
`hate speech NOT immigration`, `religious AND (jewish OR muslim)`). Adjacent
operands with no operator keep the implicit-AND default, so `a b` == `a AND b`.

SAFETY: apart from those operators, user input NEVER reaches FTS5 as syntax —
every search term is re-emitted as a quoted phrase, so a stray `*`, `"`, lone
`(` or lowercase and/or/not is matched as literal text (or dropped) rather than
raising. A malformed query still returns no results with a warning, not a 500.

Run locally:
    pip install -r requirements.txt
    uvicorn app:app --reload --port 8080
"""
from __future__ import annotations

import csv
import json
import os
import re
import sqlite3
import threading
import unicodedata
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Iterable, NamedTuple

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# Configuration — env first so the container can override without a code change.
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def _first_existing(*paths: str) -> str | None:
    for p in paths:
        if p and os.path.exists(p):
            return os.path.abspath(p)
    return None


DB_PATH = _first_existing(
    os.environ.get("SEARCH_DB", ""),
    os.path.join(HERE, "cases.db"),                    # baked into the image
    os.path.join(ROOT, "db", "cases.db"),     # local dev
)
VOCAB_PATH = _first_existing(
    os.environ.get("SEARCH_VOCAB", ""),
    os.path.join(HERE, "keyword-vocab.csv"),
    os.path.join(ROOT, "keyword-vocab.csv"),
)

# cases_fts bm25 column weights: (case_name, text).
#
# case_name is 0.0 ON PURPOSE. Name and party scoring moved to names_fts (see the
# NameScore block below); leaving it weighted here as well would count the style of
# cause twice. The column stays IN the index because MATCH spans all columns, so a
# name-only hit is still a candidate row — it just contributes 0 to TextScore and
# earns its score through names_fts instead.
W_CASE_NAME = float(os.environ.get("SEARCH_W_NAME", 0.0))
W_TEXT = float(os.environ.get("SEARCH_W_TEXT", 1.0))

# Fallback if the database predates names_fts (see HAS_NAMES_FTS): with no name
# index to score against, case_name has to carry its own weight inside cases_fts
# again, and this is the value it had before the split.
W_NAME_LEGACY = float(os.environ.get("SEARCH_W_NAME_LEGACY", 8.0))

# names_fts bm25 column weights: (case_name, p_princ, p_other), and the multiplier
# on the whole NameScore.
#
#     relevance = TextScore + LAMBDA_NAME * NameScore + tag boost
#     TextScore = -bm25(cases_fts, 0.0, 1.0)
#     NameScore = -bm25(names_fts, 3.0, 2.0, 1.0)
#
# Lead parties appear in BOTH case_name and p_princ, interveners only in p_other, so
# the weighted term frequency is 5.0 for a named party against 1.0 for an intervener
# on the same surname. That double-count IS the role tiering.
#
# LAMBDA_NAME is 1.0 and expected to stay there. The alpha of 3-5 that a
# single-index design needs is pure compensation for BM25 normalising a 4-token
# party list against a 50,000-token judgment; scoring names in their own ~20-token
# index removes the distortion instead of offsetting it, so no fudge factor.
NF_W_NAME = float(os.environ.get("SEARCH_NF_W_NAME", 3.0))
NF_W_PRINC = float(os.environ.get("SEARCH_NF_W_PRINC", 2.0))
NF_W_OTHER = float(os.environ.get("SEARCH_NF_W_OTHER", 1.0))
LAMBDA_NAME = float(os.environ.get("SEARCH_LAMBDA", 1.0))

# Set at boot by _warm(). False means the served cases.db was built before
# names_fts existed — deploy.sh stages whatever db/cases.db happens to be,
# so shipping this code against a stale DB is a real possibility, and it must
# degrade to the previous ranking rather than 500 on every search.
HAS_NAMES_FTS = False

# How many columns names_fts has in the SERVED database. The schema changed from 3
# columns (case_name, p_princ, p_other) to 2 (case_name, parties) when role tiering
# was dropped, and deploy.sh stages whatever cases.db happens to be, so the served
# width is not knowable at author time. Probed once at boot by _warm().
#   2 -> current schema  (case_name, parties)
#   3 -> pre-role-drop   (case_name, p_princ, p_other)
#   0 -> no names_fts at all
#
# This is NOT needed to keep bm25 from erroring: measured on SQLite 3.x, bm25()
# accepts any number of weights against a 3-column index — 1 through 5 all return
# an identical score, so missing weights default to 0.0 and extras are ignored.
# It is here to (a) tell tier 1 whether a name index exists at all, and (b) warn at
# boot when the served database still predates the schema change, because tier 2
# will need the `parties` column that only the 2-column form has.
NAMES_FTS_COLS = 0


def name_score_expr() -> str:
    """bm25 over names_fts scoring the case_name column ONLY.

    Every other column is weighted 0.0: tier 1 ranks on the style of cause, and
    the party column belongs to tier 2. The weight list is written out to the
    served width rather than relying on the defaulting behaviour noted above —
    that behaviour is not something SQLite documents as a guarantee, and being
    explicit also states the intent (parties deliberately scored 0, not omitted).
    """
    weights = ", ".join(["1.0"] + ["0.0"] * (NAMES_FTS_COLS - 1))
    return f"-bm25(names_fts, {weights})"


def party_cols() -> str:
    """The names_fts column(s) holding party names, as an FTS5 column filter.

    Mirror image of name_score_expr(): case_name is excluded so this scores ONLY
    who was before the court. Which columns those are depends on the served
    schema — the current one flattens every party into a single `parties` column,
    the older one split them into p_princ (contesting) and p_other (interveners).
    """
    return "parties" if NAMES_FTS_COLS == 2 else "p_princ p_other"


def party_score_expr() -> str:
    """bm25 over names_fts scoring the party column(s) only, case_name at 0.0.

    On the 3-column schema both party columns get 1.0 rather than the 2.0/1.0
    split that index was built for: role tiering was deliberately dropped (see
    the `parties` note in schema.sql), so weighting them differently here would
    reintroduce, on old databases only, a distinction the corpus measurements
    said was not worth having.
    """
    weights = ", ".join(["0.0"] + ["1.0"] * (NAMES_FTS_COLS - 1))
    return f"-bm25(names_fts, {weights})"

# Tag-boost per tier. tier 1 = broad practice area (deliberately near-zero: it is a
# facet, not a ranking signal); tier 2 = topic/doctrine; tier 3 = named entity, the
# strongest evidence of a known-item match.
TIER_BOOST = {1: 0.3, 2: 2.0, 3: 3.0}

# A synonym is only worth ORing into the text query if it actually discriminates.
# "wrongful dismissal" expands to include "dismissed" — which appears in 1,003 of
# 1,597 judgments (every appeal that is "dismissed"), so it adds ~600 irrelevant
# candidates and, at IDF ≈ log(1597/1003) ≈ 0.2, contributes nothing to ranking
# either (Keyword-Search-Design.md §1). Variants above this document-frequency
# share are dropped from the OR-group — EXCEPT the phrase the user actually typed,
# which is always honoured. The tag boost is unaffected: the keyword still matched,
# so a correctly-tagged case still gets its tier weight.
DF_CEILING = float(os.environ.get("SEARCH_DF_CEILING", 0.25))

MAX_LIMIT = 1000

# ---------------------------------------------------------------------------
# Query-cost ceilings. This endpoint is public and unauthenticated, so the only
# thing standing between it and a wedged instance is the shape of the query.
#
# Measured on the real corpus before these limits existed: repeating one common
# term ("charter") cost 3s at 50 copies, 9.6s at 100, 31s at 200, and timed out
# past 400. It is NOT the operand count -- 200 DISTINCT nonsense terms return in
# 0.0s because each matches nothing and FTS5 exits early -- and it is not synonym
# expansion, which measured the same with expand=false. The cost is intersecting
# many posting lists for terms that match most of the corpus, doubled because the
# results query and the count query each score both FTS tables.
#
# MAX_Q_CHARS is enforced by FastAPI as max_length on `q`, so an oversized query
# is a 422 before any work happens. MAX_OPERANDS is enforced in build_query.
# A real search never approaches either.
MAX_Q_CHARS = int(os.environ.get("SEARCH_MAX_Q_CHARS", 500))
MAX_OPERANDS = int(os.environ.get("SEARCH_MAX_OPERANDS", 32))

# Result-card excerpt length, as a token budget for FTS5's snippet(). The card
# clamps to 5 lines (search.css .result-snippet) at roughly 120 characters each,
# so ~600 characters fill it; 55 tokens produced ~400 and left the last two lines
# empty. Overshooting slightly is deliberate -- the clamp trims the remainder, so
# a long excerpt fills all 5 lines while a short one still ends cleanly.
# Older FTS5 builds reject any budget over 64 outright, and the Cloud Run image
# may link an older libsqlite3 than a dev Mac, so _warm() asks the linked library
# at boot and lowers this if it has to.
SNIPPET_TOKENS = int(os.environ.get("SEARCH_SNIPPET_TOKENS", 100))

app = FastAPI(
    title="TMU JICL case search",
    description="Full-text + controlled-vocabulary search over the case database.",
    version="1.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("SEARCH_CORS_ORIGINS", "*").split(","),
    allow_methods=["GET"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Database — one read-only connection per thread (FastAPI runs sync endpoints in
# a threadpool). The DB is a build artifact and never written at runtime.
# ---------------------------------------------------------------------------
_local = threading.local()


def db() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        if DB_PATH is None:
            raise RuntimeError(
                "cases.db not found. Build it with `python3 scripts/build_db.py`, "
                "or set SEARCH_DB to its path."
            )
        # immutable=1 skips all locking; only safe because the file never changes
        # while the service runs (it is baked into the container image).
        flag = "immutable=1" if os.environ.get("SEARCH_IMMUTABLE", "1") == "1" else "mode=ro"
        conn = sqlite3.connect(f"file:{DB_PATH}?{flag}", uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # `fold` powers the case-name / citation lookup: LIKE is only
        # case-insensitive for ASCII, so folding both sides is what lets
        # "quebec" find "Québec" — the same normalization the FTS tokenizer
        # applies via `remove_diacritics 2`.
        conn.create_function("fold", 1, fold, deterministic=True)
        # `norm` is `fold` plus punctuation removal: "R. v. Keegstra" and
        # "r v keegstra" both become "r v keegstra". Tier-1 name ranking compares
        # the typed query against the style of cause, and a researcher does not
        # reproduce the periods in "R. v." — folding alone would miss the exact
        # match. Output is alphanumerics and single spaces only, so a value
        # interpolated into LIKE cannot smuggle in a % or _ wildcard.
        conn.create_function("norm", 1, norm, deterministic=True)
        _local.conn = conn
    return conn


# ---------------------------------------------------------------------------
# Text normalization — mirror what `unicode61 remove_diacritics 2` does in the
# index, so phrases we match in Python line up with tokens SQLite indexed.
# ---------------------------------------------------------------------------
def fold(s: str) -> str:
    """Lowercase and strip combining accents: 'Contrôle' -> 'controle'."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return s.lower()


_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)


def tokens(s: str) -> list[str]:
    """Alphanumeric runs — the same boundaries unicode61 tokenizes on."""
    return _TOKEN_RE.findall(fold(s))


def norm(s: str) -> str:
    """Folded, punctuation-stripped, single-spaced: 'R. v. Keegstra' -> 'r v keegstra'.

    The comparison form for tier-1 name matching. Registered as a SQL function
    (see db()) so both sides of the comparison are normalized identically.
    """
    return " ".join(tokens(s or ""))


def phrase(tok: Iterable[str]) -> str:
    """A quoted FTS5 phrase. Input is already alphanumeric, so nothing can escape."""
    return '"' + " ".join(tok) + '"'


# ---------------------------------------------------------------------------
# Controlled vocabulary + synonym rings, loaded once from keyword-vocab.csv.
# ---------------------------------------------------------------------------
class Vocab:
    def __init__(self, path: str | None):
        self.terms: dict[str, dict] = {}        # keyword_id -> row
        self.rings: dict[str, list[str]] = {}   # keyword_id -> folded variant phrases
        self.index: dict[str, str] = {}         # folded variant -> keyword_id
        self.max_words = 1
        if not path:
            return
        with open(path, encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                kid = (row.get("id") or "").strip()
                canonical = (row.get("canonical") or "").strip()
                if not kid or not canonical:
                    continue
                tier_raw = (row.get("tier") or "").strip()
                self.terms[kid] = {
                    "keyword_id": kid,
                    "canonical_en": canonical,
                    "canonical_fr": (row.get("canonical_fr") or "").strip() or None,
                    "tier": int(tier_raw) if tier_raw in ("1", "2", "3") else None,
                    "area": (row.get("area") or "").strip() or None,
                }
                variants = [canonical, row.get("canonical_fr") or ""]
                variants += (row.get("synonyms") or "").split("|")
                ring: list[str] = []
                for v in variants:
                    toks = tokens(v)
                    if not toks:
                        continue
                    key = " ".join(toks)
                    if key not in ring:
                        ring.append(key)
                    # First writer wins, so a term is attributed to one ring only.
                    self.index.setdefault(key, kid)
                    self.max_words = max(self.max_words, len(toks))
                self.rings[kid] = ring

    def match(self, toks: list[str]) -> tuple[list[tuple[str, str]], list[str]]:
        """Greedy longest-first scan.

        Returns (matches as (keyword_id, the phrase the user actually typed),
        leftover tokens). Spans are consumed, so 'Jewish students' matches K096
        rather than K093 plus a stray 'students'.
        """
        matched: list[tuple[str, str]] = []
        leftover: list[str] = []
        i = 0
        while i < len(toks):
            hit = None
            for n in range(min(self.max_words, len(toks) - i), 0, -1):
                kid = self.index.get(" ".join(toks[i:i + n]))
                if kid:
                    hit = (kid, n)
                    break
            if hit and not (hit[1] == 1 and len(toks[i]) <= 2):
                kid, n = hit
                if kid not in {m[0] for m in matched}:
                    matched.append((kid, " ".join(toks[i:i + n])))
                i += n
            else:
                leftover.append(toks[i])
                i += 1
        return matched, leftover

    # -- document frequency, measured against the real index -----------------
    def load_df(self, conn: sqlite3.Connection) -> None:
        """Count how many judgments contain each variant. ~0.8s for 668 variants."""
        df: dict[str, int] = {}
        for ring in self.rings.values():
            for v in ring:
                if v not in df:
                    df[v] = conn.execute(
                        "SELECT COUNT(*) FROM cases_fts WHERE cases_fts MATCH ?",
                        (phrase(v.split()),)).fetchone()[0]
        self.df = df
        self.n_docs = conn.execute("SELECT COUNT(*) FROM cases").fetchone()[0] or 1

    def useful_ring(self, kid: str, typed: str) -> list[str]:
        """The ring minus variants too common to discriminate (see DF_CEILING)."""
        ring = self.rings.get(kid, [])
        if not getattr(self, "df", None):
            return ring
        ceiling = DF_CEILING * self.n_docs
        kept = [v for v in ring if v == typed or self.df.get(v, 0) <= ceiling]
        return kept or [typed]


VOCAB = Vocab(VOCAB_PATH)


def _supported_snippet_tokens(want: int) -> int:
    """Largest snippet() token budget the linked SQLite accepts, at most `want`.

    FTS5 historically capped this at 64 and raised on anything larger; newer
    builds allow more. Probe a throwaway in-memory table rather than cases.db so
    the answer never depends on some particular document happening to match.
    """
    probe = sqlite3.connect(":memory:")
    try:
        probe.execute("CREATE VIRTUAL TABLE t USING fts5(a, b)")
        probe.execute("INSERT INTO t VALUES ('x', 'hello world')")
        for n in (want, 64):
            try:
                probe.execute(
                    f"SELECT snippet(t, 1, '', '', '…', {n}) FROM t WHERE t MATCH 'hello'"
                ).fetchone()
                return n
            except sqlite3.Error:
                continue
        return 64
    finally:
        probe.close()


def _warm() -> None:
    """Measure df once at boot, so the first user query isn't the one that pays."""
    global SNIPPET_TOKENS, HAS_NAMES_FTS, NAMES_FTS_COLS
    try:
        VOCAB.load_df(db())
    except Exception as e:                                  # pragma: no cover
        print(f"warning: df warmup skipped ({e}); expansion will not be IDF-pruned")

    # Probe the name/party index once rather than per request — both that it
    # exists AND how wide it is, because bm25() needs one weight per column.
    try:
        NAMES_FTS_COLS = len(db().execute(
            "SELECT * FROM names_fts LIMIT 0").description or ())
    except Exception as e:                                  # pragma: no cover
        print(f"warning: names_fts probe failed ({e})")
        NAMES_FTS_COLS = 0
    HAS_NAMES_FTS = NAMES_FTS_COLS > 0
    if not HAS_NAMES_FTS:                                   # pragma: no cover
        print("warning: names_fts is absent from this database — name ranking is "
              "DISABLED (tier 1 falls back to substring matching on "
              "case_name/citation). Rebuild with scripts/build_db.py.")
    elif NAMES_FTS_COLS == 3:                               # pragma: no cover
        print("note: names_fts has 3 columns (case_name, p_princ, p_other) — this "
              "database predates the role-tiering drop. Tier 1 is unaffected "
              "(it scores case_name only), but tier 2 will need the 2-column "
              "(case_name, parties) schema. Rebuild with scripts/build_db.py.")

    allowed = _supported_snippet_tokens(SNIPPET_TOKENS)
    if allowed != SNIPPET_TOKENS:                           # pragma: no cover
        print(
            f"note: libsqlite3 {sqlite3.sqlite_version} caps snippet() at "
            f"{allowed} tokens; excerpts will be shorter than requested "
            f"({SNIPPET_TOKENS})"
        )
        SNIPPET_TOKENS = allowed


# ---------------------------------------------------------------------------
# MCP endpoint at /mcp/ — optional, mounted only if fastmcp is installed.
#
# WHY THIS IS NOT THE THREE-LINE SNIPPET IN THE HANDOFF
#
# 1. `app.router.lifespan_context = mcp_app.lifespan` REPLACES Starlette's default
#    lifespan, and the default lifespan is what runs @app.on_event("startup")
#    handlers. _warm() was registered that way, so assigning lifespan_context
#    would have silently stopped it running: NAMES_FTS_COLS would stay 0, which
#    disables priority-2 (parties) search entirely and drops priority 1's bm25
#    tie-break. Verified: a bare FastAPI app reports _DefaultLifespan with 1
#    on_startup handler, and swapping the context bypasses it. So _warm() is now
#    called explicitly from a combined lifespan instead of via a decorator.
#
# 2. The import is guarded. fastmcp lives in requirements-mcp.txt, NOT in the
#    requirements.txt that builds the Cloud Run image, and it is absent from the
#    local .venv. An unguarded `from mcp_server import asgi_app` would stop the
#    whole REST API from starting anywhere fastmcp is not installed.
#
# 3. JICL_API_BASE defaults to loopback here. mcp_server talks to the REST API
#    over HTTP, and its own default is the PUBLIC Cloud Run URL — which, mounted
#    in-process, would send every tool call out to the internet and back into the
#    same container. setdefault keeps an explicit override working (and leaves
#    stdio usage, where there is no local server, untouched).
# ---------------------------------------------------------------------------
_mcp_app = None
try:
    os.environ.setdefault("JICL_API_BASE",
                          f"http://127.0.0.1:{os.environ.get('PORT', '8080')}")
    from mcp_server import asgi_app          # noqa: E402  (deliberately late)

    _mcp_app = asgi_app()
    app.mount("/mcp", _mcp_app)
except ImportError as e:                                    # pragma: no cover
    print(f"note: /mcp not mounted ({e}). `pip install -r requirements-mcp.txt` "
          "to enable the MCP endpoint; the REST API is unaffected.")


@asynccontextmanager
async def _lifespan(_app):
    """Warm the process, then hand off to FastMCP's own lifespan if mounted.

    FastMCP starts its session manager in its lifespan, so mounting alone is not
    enough — without entering it, every MCP request fails as soon as a session is
    needed. Mounting attaches routes; it does not run the sub-app's startup.
    """
    _warm()
    if _mcp_app is None:
        yield
    else:
        async with _mcp_app.lifespan(_app):
            yield


app.router.lifespan_context = _lifespan


# ---------------------------------------------------------------------------
# Query building
# ---------------------------------------------------------------------------
# Lexer: a "quoted phrase", a single parenthesis, or a run of anything else.
# Splitting parens onto their own tokens lets `(religious` and `jewish)` lex
# cleanly without a space around the bracket.
_LEX_RE = re.compile(r'"[^"]*"|[()]|[^\s()]+')

# The ONLY tokens allowed through to FTS5 as real syntax. They must be typed in
# uppercase, exactly like FTS5's own convention — lowercase and/or/not stay
# ordinary search words, so historical queries keep their meaning.
_BOOL_OPS = {"AND", "OR", "NOT", "XOR"}


def _expand_run(toks: list[str], expand: bool) -> tuple[str | None, list[str]]:
    """One run of bare words -> (FTS5 sub-expression, keyword_ids it matched).

    Same hybrid expansion as before: vocab phrases become OR-rings, leftover
    words become quoted single-term phrases, the pieces are ANDed. A multi-piece
    run is wrapped in parens so the whole run acts as one boolean operand.
    Returns (None, []) if the run holds nothing searchable.
    """
    groups: list[str] = []
    matched_ids: list[str] = []
    seen: set[str] = set()

    def add(group: str) -> None:
        """Append a sub-expression, dropping one identical to an earlier one.

        Everything in a run is ANDed, and `x AND x` is just `x`, so this cannot
        change any result -- it only stops the pathological case where the same
        common term is repeated. 200 copies of "charter" took 31 seconds and
        collapse to a single operand costing 0.1s.

        DEDUPE HAPPENS HERE, ON FINISHED GROUPS, NOT ON THE TOKEN LIST. Deduping
        tokens first would be wrong: VOCAB.match consumes them positionally to
        find multi-word phrases, so dropping the second "freedom" out of
        "freedom of religion freedom of expression" would destroy the second
        phrase before it could ever match.
        """
        if group not in seen:
            seen.add(group)
            groups.append(group)
            # The cap has to be enforced HERE as well as on emitted operands. A
            # bare run of words ("a b c d ...") is a SINGLE operand no matter how
            # long it is -- all of it becomes one parenthesised AND -- so counting
            # only operands would let an unbounded run straight through.
            if len(groups) > MAX_OPERANDS:
                raise ValueError(
                    f"query has more than {MAX_OPERANDS} distinct search terms; "
                    f"please simplify it"
                )

    if expand:
        matched, leftover = VOCAB.match(toks)
        for kid, typed in matched:
            if kid not in matched_ids:          # same term twice adds no boost
                matched_ids.append(kid)
            add("(" + " OR ".join(phrase(v.split()) for v in VOCAB.useful_ring(kid, typed)) + ")")
    else:
        leftover = toks
    for t in leftover:
        add(phrase([t]))
    if not groups:
        return None, []
    if len(groups) == 1:
        return groups[0], matched_ids
    return "(" + " AND ".join(groups) + ")", matched_ids


# XOR is NOT an FTS5 operator, and FTS5 does not reject it -- it lexes it as an
# ordinary search word, so `alpha XOR beta` quietly becomes `alpha AND xor AND beta`
# and matches nothing. A silent zero-result is the worst possible failure here, so
# XOR is rewritten before any expression reaches SQLite:
#
#     A XOR B  ->  ((A) OR (B)) NOT ((A) AND (B))
#
# Chained XOR folds left, which gives the usual parity meaning: A XOR B XOR C
# matches rows containing an ODD number of A, B, C. Verified against FTS5.
#
# The fold roughly DOUBLES the expression per additional operand, so the number of
# XOR-separated parts is capped. Four parts is already a 15-term expression.
MAX_XOR_PARTS = 4


def split_top_level(q: str, op: str) -> list[str]:
    """Split on `op` at paren depth 0, keeping each side's own syntax intact.

    An operator nested inside parentheses belongs to that sub-expression and is left
    for FTS5; only one the user wrote at the outermost level splits the query.
    """
    parts, cur, depth = [], [], 0
    for lex in _LEX_RE.findall(q):
        if lex == "(":
            depth += 1
        elif lex == ")":
            depth -= 1
        if lex == op and depth == 0:
            parts.append(" ".join(cur))
            cur = []
        else:
            cur.append(lex)
    parts.append(" ".join(cur))
    return [p.strip() for p in parts if p.strip()]


def leading_not_hint(q: str) -> str | None:
    """A user-facing message for a query whose NOT has nothing on its left.

    FTS5's NOT is BINARY: it subtracts one result set from another, so it needs a
    starting set. `zundel NOT keegstra` is fine; `NOT keegstra` alone is a syntax
    error, because there is nothing to subtract FROM.

    Rather than surface FTS5's raw 'syntax error near "NOT"', this reads the user's
    own terms back and, when they typed something positive elsewhere, hands them the
    corrected query verbatim -- the common cause is simply typing the clauses in the
    wrong order.

        NOT keegstra zundel   ->  suggests: zundel NOT keegstra
        NOT keegstra          ->  nothing positive to search; explain the shape

    Returns None when the query does not start with a NOT, so callers can treat a
    non-None result as "reject this query and show the message".
    """
    lexes = [l for l in _LEX_RE.findall(q) if l.strip()]
    if not lexes or lexes[0] != "NOT":
        return None

    # Split into what the user wants kept vs. excluded. A term is excluded when the
    # nearest preceding operator was NOT; any other operator returns to keeping.
    keep, drop, negating = [], [], False
    for lex in lexes:
        if lex == "NOT":
            negating = True
        elif lex in _BOOL_OPS or lex in "()":
            negating = False
        else:
            (drop if negating else keep).append(lex)
            negating = False

    if keep:
        fixed = " ".join(keep) + "".join(f" NOT {d}" for d in drop)
        return (f"NOT needs a search term before it. Did you mean: {fixed}")
    # No positive term anywhere, so there is nothing to reconstruct. Show the shape
    # using the user's own excluded terms rather than a canned example, and do NOT
    # borrow one of them as the thing to search for -- "zundel NOT zundel" reads as
    # nonsense to anyone who typed zundel.
    excluded = " and ".join(drop) if drop else "that term"
    tail = "".join(f" NOT {d}" for d in drop) or " NOT keegstra"
    return ("NOT needs a search term before it -- it removes results from a search "
            f"rather than starting one. Search for something, then exclude "
            f"{excluded}, for example:  <your search>{tail}")


def build_query(q: str, expand: bool = True) -> tuple[str | None, list[str]]:
    """User text -> (FTS5 MATCH expression, keyword_ids the query matched).

    Boolean grammar: the uppercase operators AND / OR / NOT and round
    parentheses pass through to FTS5 as real operators. Two operands with no
    operator between them keep the implicit-AND default, so `a b` still means
    `a AND b` (the historical behaviour). Everything else stays SAFE — every
    search term is re-emitted as a quoted phrase, so a stray `*`, `"` or lone
    `(` can never reach FTS5 as syntax, and lowercase and/or/not are just words.

    "quoted phrases" are honoured verbatim and never expanded; bare terms are
    expanded through the synonym rings when `expand` is on.

    Keyword tag-boost ids are collected only from operands that are NOT under a
    NOT: an excluded term must never pull a case in or boost it. Returns
    (None, []) when there is no searchable operand, so the caller browses.
    """
    # ---- XOR first: it has no FTS5 equivalent and must be rewritten, not passed
    # through. Each side is built by recursing, so a side may itself contain
    # AND/OR/NOT/parens and is handled by the ordinary path below.
    xor_parts = split_top_level(q, "XOR")
    if len(xor_parts) > 1:
        if len(xor_parts) > MAX_XOR_PARTS:
            raise ValueError(
                f"query chains more than {MAX_XOR_PARTS} XOR terms; please simplify it")
        built = [build_query(part, expand) for part in xor_parts]
        if any(e is None for e, _ in built):
            return None, []
        acc, ids = built[0][0], list(built[0][1])
        for expr, kids in built[1:]:
            acc = f"(({acc}) OR ({expr})) NOT (({acc}) AND ({expr}))"
            for k in kids:
                if k not in ids:
                    ids.append(k)
        return acc, ids

    out: list[str] = []
    matched_ids: list[str] = []
    n_operands = 0

    buf: list[str] = []            # raw bare-word chunks awaiting a flush
    pending_not = False            # does the next operand sit under a NOT?
    neg_stack: list[bool] = []     # negation state carried by each open paren
    prev = "start"                 # start | operand | op | open — for implicit AND

    def negated() -> bool:
        return pending_not or (neg_stack[-1] if neg_stack else False)

    def emit_operand(frag: str | None, kids: list[str]) -> None:
        nonlocal prev, pending_not, n_operands
        neg = negated()
        pending_not = False        # the NOT (if any) is now consumed
        if frag is None:
            return
        if prev == "operand":      # two operands touching -> implicit AND
            out.append("AND")
        out.append(frag)
        if not neg:                # never let a negated term boost/pull cases
            for kid in kids:
                if kid not in matched_ids:
                    matched_ids.append(kid)
        n_operands += 1
        # Dedupe collapses repeats within a run, but explicit operators can still
        # stack unbounded operands ("a AND b AND c AND ..."), and each one that
        # matches a large slice of the corpus costs another posting-list
        # intersection. Refuse rather than spend a minute of CPU on it.
        if n_operands > MAX_OPERANDS:
            raise ValueError(
                f"query has more than {MAX_OPERANDS} distinct search terms; "
                f"please simplify it"
            )
        prev = "operand"

    def flush() -> None:
        if not buf:
            return
        toks = tokens(" ".join(buf))
        buf.clear()
        if toks:
            emit_operand(*_expand_run(toks, expand))

    lexes = _LEX_RE.findall(q)
    i = 0
    while i < len(lexes):
        lex = lexes[i]
        if lex == "(":
            # RECURSE into the group rather than passing the parens through. The
            # group is built by build_query, so anything legal at the top level is
            # legal inside it -- including XOR, which has to be rewritten and would
            # otherwise leak to FTS5 as a literal word and silently match nothing.
            flush()
            depth, j = 1, i + 1
            while j < len(lexes) and depth:
                if lexes[j] == "(":
                    depth += 1
                elif lexes[j] == ")":
                    depth -= 1
                j += 1
            inner = " ".join(lexes[i + 1:j - 1] if depth == 0 else lexes[i + 1:j])
            sub, sub_ids = build_query(inner, expand)
            if sub:
                emit_operand(f"({sub})", sub_ids)
            i = j
            continue
        elif lex == ")":
            flush()
            if neg_stack:          # ignore an unbalanced ) rather than emit junk
                neg_stack.pop()
                out.append(")")
                prev = "operand"   # a closed group is itself a complete operand
        elif lex in _BOOL_OPS:
            flush()
            if lex == "NOT":
                pending_not = True
                # FTS5 spells exclusion `a NOT b`; fold a redundant `AND NOT`.
                if out and out[-1] == "AND":
                    out[-1] = "NOT"
                else:
                    out.append("NOT")
            else:
                out.append(lex)
            prev = "op"
        elif len(lex) >= 2 and lex[0] == '"' and lex[-1] == '"':
            flush()
            toks = tokens(lex[1:-1])
            if toks:
                emit_operand(phrase(toks), [])
        else:
            buf.append(lex)
        i += 1
    flush()

    # A trailing operator (`religious freedom AND`, typed mid-thought) would be a
    # syntax error; drop it so the query still runs on what came before.
    #
    # An unbalanced `(` is the same class of typo and needs the same treatment. A
    # stray `)` is already discarded where it is lexed (see the neg_stack check
    # above), but an unclosed `(` used to survive into the expression and make the
    # whole thing invalid — `religious AND (jewish` returned nothing at all, rather
    # than the `religious AND (jewish)` the user obviously meant. So: drop trailing
    # empty groups, then close whatever is still open. Only STANDALONE parens are
    # counted; a group emitted by emit_operand is one already-balanced string.
    while out and (out[-1] in _BOOL_OPS or out[-1] == "("):
        out.pop()
    out.extend([")"] * (out.count("(") - out.count(")")))

    if n_operands == 0:
        return None, []
    return " ".join(out), matched_ids


# ---------------------------------------------------------------------------
# Filters — every value is bound as a parameter; only column names are literal.
# ---------------------------------------------------------------------------
def build_filters(
    courts: list[str], provinces: list[str], practice_areas: list[str],
    keywords: list[str], keyword_mode: str, language: str | None,
    level: str | None, date_from: str | None, date_to: str | None,
    keyword_groups: list[str] | None = None,
    name_q: str = "",
) -> tuple[list[str], list]:
    where: list[str] = []
    params: list = []

    def any_of(col: str, values: list[str]):
        if values:
            where.append(f"{col} IN ({','.join('?' * len(values))})")
            params.extend(values)

    any_of("c.court", courts)
    any_of("m.province", provinces)
    any_of("m.practice_area", practice_areas)

    if keywords:
        marks = ",".join("?" * len(keywords))
        if keyword_mode == "and":
            # every selected keyword must be present on the case
            where.append(
                f"(SELECT COUNT(DISTINCT j.value) FROM json_each(m.keyword_ids) j "
                f"WHERE j.value IN ({marks})) = ?"
            )
            params.extend(keywords)
            params.append(len(set(keywords)))
        else:
            where.append(
                f"EXISTS (SELECT 1 FROM json_each(m.keyword_ids) j "
                f"WHERE j.value IN ({marks}))"
            )
            params.extend(keywords)

    # Grouped keywords: OR *within* each group, AND *across* groups. One EXISTS
    # per group. This is what a user means by ticking two filter sections — "a
    # hate-speech case that is also a family-law case" — which the flat
    # `keyword` list above cannot express: pooling both areas into one list
    # makes `and` demand every id at once, which nothing satisfies.
    for group in (keyword_groups or []):
        ids = [k for k in (s.strip() for s in group.split(",")) if k]
        if not ids:
            continue
        marks = ",".join("?" * len(ids))
        where.append(
            f"EXISTS (SELECT 1 FROM json_each(m.keyword_ids) j "
            f"WHERE j.value IN ({marks}))"
        )
        params.extend(ids)

    # Case name / citation lookup. Deliberately NOT an FTS match: `citation` is
    # not in the index at all, and citations ("2025 ONCJ 587") are looked up by
    # fragment rather than by word. Every token must appear somewhere in
    # name+citation, so "elkhodary 2025" and "oncj 587" both land. 1,588 short
    # rows, so the scan is immaterial.
    for tok in tokens(name_q):
        where.append(
            "fold(COALESCE(c.case_name,'') || ' ' || COALESCE(c.citation,'')) LIKE ?"
        )
        params.append(f"%{tok}%")

    if language:
        where.append("c.language = ?")
        params.append(language)
    if level in ("UC", "LC"):
        where.append("c.case_id LIKE ?")
        params.append(f"{level}%")
    if date_from:
        where.append("c.date >= ?")
        params.append(date_from)
    if date_to:
        where.append("c.date <= ?")
        params.append(date_to)

    return where, params


SELECT_COLS = """
    c.case_id, c.case_id AS id, c.citation, c.case_name, c.court, c.date,
    c.language, c.url, c.source,
    m.city, m.province, m.practice_area, m.summary, m.resume,
    m.keyword_ids
"""

SORTS = {
    "relevance": "relevance DESC, c.date DESC",
    "date_desc": "c.date DESC",
    "date_asc":  "c.date ASC",
    "name":      "c.case_name COLLATE NOCASE ASC",
}


def resolve_keywords(conn: sqlite3.Connection, ids_json: str | None) -> list[dict]:
    if not ids_json:
        return []
    try:
        ids = json.loads(ids_json)
    except (TypeError, json.JSONDecodeError):
        return []
    out = []
    for kid in ids:
        t = VOCAB.terms.get(kid)
        if t:
            out.append({"keyword_id": kid, "en": t["canonical_en"],
                        "fr": t["canonical_fr"], "tier": t["tier"]})
    return out


def shape(row: sqlite3.Row, rank: int, conn: sqlite3.Connection) -> dict:
    d = dict(row)
    kw = resolve_keywords(conn, d.pop("keyword_ids", None))
    excerpt = d.pop("excerpt", None)
    # Browse mode has no FTS snippet — fall back to the head of the summary.
    # Track the snippet budget (~7 chars/token) so browse cards fill the same
    # five lines as search cards instead of stopping short at half the height.
    if not excerpt:
        s = d.get("summary") or ""
        cap = SNIPPET_TOKENS * 7
        excerpt = (s[:cap] + "…") if len(s) > cap else s
    d["snippet"] = excerpt
    d["excerpt"] = excerpt
    d["rank"] = rank          # positional; the current frontend keys results on it
    d["level"] = "upper" if str(d["case_id"]).startswith("UC") else "lower"
    d["keywords"] = [k["en"] for k in kw]
    d["mots_cles"] = [k["fr"] for k in kw if k["fr"]]
    d["keyword_ids"] = [k["keyword_id"] for k in kw]
    d["relevance"] = round(d["relevance"], 4) if d.get("relevance") is not None else None

    # WHERE the query matched, as a plain label. Without this a family-promoted
    # case — one returned because a sibling record matched, with none of the query
    # terms in its own text — reads as a false positive on the result card.
    #
    # Derived from the band rather than exposed as a raw number, so the client
    # never has to know the band constants. `relevance - band` is the case's own
    # score: zero in the body band means it was promoted, not matched.
    band = d.pop("band", None)
    if band is None or d.get("relevance") is None:
        d["matched"] = None
    elif band >= BAND_NAME:
        d["matched"] = "case_name"
    elif band >= BAND_PARTIES:
        d["matched"] = "parties"
    else:
        d["matched"] = "text" if d["relevance"] - band > 0 else "family"
    return d



# Band offsets. Each priority occupies its own contiguous score range, and the
# ranges are spaced far enough apart that a match in a higher priority outranks
# ANY match in a lower one no matter how well the lower one scored. Within a band,
# the tier's own score only breaks ties. All three are built.
BAND_NAME = 3_000_000.0     # 1. matched the case name
BAND_PARTIES = 2_000_000.0  # 2. matched the parties text
BAND_BODY = 1_000_000.0     # 3. matched the body of the text

# Ordering INSIDE the name and parties bands: the spec's three match levels.
#
#   1  the whole phrase, in order        "snyder v montreal gazette ltd"
#   2  all terms, any order              "snyder gazette"
#   3  at least one term                 "gazette keegstra"
#
# The levels nest — a phrase match is also an all-terms match — so the CASE that
# assigns them is ordered strongest-first and stops at the first hit.
#
# Level 3 is the one that changes behaviour most: before it existed, a query had
# to match EVERY term or the case did not appear in this band at all. "gazette
# keegstra" returned nothing from the name band despite naming two real cases.
L_PHRASE = 30_000.0
L_ALL = 20_000.0
L_ANY = 10_000.0

# Refinements WITHIN level 1, kept from the previous implementation because they
# are measurably right: "R. v. Keegstra" typed in full should beat a case that
# merely contains that run. Both are smaller than the gap between levels, so they
# can never lift a level-2 match above a level-1 one.
N_EXACT = 5_000.0    # the whole style of cause was typed, exactly
N_PREFIX = 2_500.0   # the name STARTS with the query

# Ordering INSIDE the body band: a judgment containing the words the user actually
# typed outranks one reached only by expanding a synonym ring. Both are real hits —
# the expansion is what finds the French judgment from an English query, and the
# case that argues the point in different words — but the literal match is the
# stronger evidence, so it is a separate sub-band rather than a tweak to bm25.
B_EXACT = 5_000.0

# Stop words — used for ONE job only: deciding whether a query is entirely noise.
#
# THEY ARE NOT STRIPPED FROM MATCHING, and that distinction is the whole design.
# "R. v. Keegstra" needs its `r` and `v`: they fire the exact-name bonus (3,060,009
# vs 3,010,007 for "keegstra" alone) and they correctly exclude Canadian
# Broadcasting Corporation v. Keegstra, which has no word starting with "r".
# Removing them would make ranking worse, not better. What they are good for is
# recognising that "R. v." on its own asks for nothing — 345 arbitrary criminal
# cases — and saying so, the way Westlaw does.
#
# Standard English list (NLTK's) plus the legal separators and abbreviations that
# behave the same way in a style of cause. Deliberately NOT derived from document
# frequency: measured on this corpus only "v" (75.1%) is real noise, while the next
# most common tokens are "canada" (13.4%), "children" (6.1%), "immigration" (6.1%)
# — common because Canadian public law is full of them, and exactly what people
# search for. A DF cutoff cannot tell structural noise from a frequent real party.
#
# "re" is deliberately EXCLUDED: it is a legal term of art (Re Zundel, Moore Estate
# (Re)), and including it made LC417 "A. S., Re" — whose name is nothing but
# a, s, re — impossible to search for. Verified: with the list as it stands, zero
# of the 1,587 case names consist solely of stop words.
STOP_WORDS = frozenset("""
i me my myself we our ours ourselves you your yours yourself yourselves he him his
himself she her hers herself it its itself they them their theirs themselves what
which who whom this that these those am is are was were be been being have has had
having do does did doing a an the and but if or because as until while of at by for
with about against between into through during before after above below to from up
down in out on off over under again further then once here there when where why how
all any both each few more most other some such no nor not only own same so than too
very s t can will just don should now
v c r et al ex rel
""".split())


# Court hierarchy λ, ascending = more authoritative. Within a band, results sort by
# this BEFORE how exactly they matched: given several cases of the same name, the
# researcher wants the highest court first — searching "Keegstra" should lead with
# the SCC, not with whichever record happens to score best on bm25.
#
# This is the table from the search-ordering spec, verified to cover ALL 57 court
# codes present in the corpus — no code falls through to the ELSE.
#
#   1 Supreme Court of Canada
#   2 Court of Appeal — provincial courts of appeal, FCA, Divisional/Appeal Divisions
#   3 Superior / Trial — s.96 superior courts AND provincial/inferior trial courts
#   4 Federal Court — FC, TCC
#   5 Tribunal — RPD, RAD, CHRT, FPSLREB, SST, and anything unrecognised
#
# TWO DELIBERATE DIFFERENCES from the hierarchy this replaced, both from the spec:
#
#   Superior and provincial trial courts are ONE band. Previously ONSC (s.96
#   superior) outranked ONCJ (provincial). They now tie and fall through to the
#   next sort key.
#
#   Federal Court and the Tax Court sit at 4, BELOW provincial trial courts, where
#   they were previously 2 (level with the superior courts). This is the spec's
#   call and it is the one worth re-reading before trusting the output: FC is a
#   s.101 superior court, so ranking it under ONCJ is a statement about this
#   corpus's subject matter — most FC records here are immigration judicial
#   reviews — rather than about judicial hierarchy generally.
COURT_RANK = """CASE
    WHEN c.court = 'SCC' THEN 1
    WHEN c.court IN ('ONCA','BCCA','QCCA','ABCA','SKCA','MBCA','FCA','NBCA',
                     'NLCA','NSCA','ONSCDC','ONSCAD','NWTCA','ONCTGDDC',
                     'PESCAD','QCQBA') THEN 2
    WHEN c.court IN ('ONSC','BCSC','QCCS','ONCJ','QCCQ','ABQB','MBQB','SKQB',
                     'ONHCJ','ABPC','NBQB','ONCTGD','BCPC','YKSC','ABKB','NSSC',
                     'MBKB','QCCM','ABCJ','MBPC','ONPROVCT','SKPC','NLPC',
                     'ONSCSM','PESC','ABSCTD','NBKB','NBSC','NLSC','ONCTPD',
                     'PESCTD','SKKB','SKSC') THEN 3
    WHEN c.court IN ('FC','TCC') THEN 4
    ELSE 5
END"""


# name + citation, normalized, as one comparable string. Citations live only on
# `cases` and are in NO fts index, so anything citation-shaped has to be reachable
# this way rather than through MATCH.
NAME_CIT = "norm(COALESCE(c.case_name,'') || ' ' || COALESCE(c.citation,''))"


def has_grammar(q: str) -> bool:
    """True when the user typed explicit query syntax: a quoted phrase, a paren, or
    an uppercase AND / OR / NOT.

    Priorities 1 and 2 normally work from tokens() — a flat word list, every word
    required, each prefix-matched — which is what makes partial typing ("keegs")
    find Keegstra. That model cannot express OR or NOT, and worse, it used to
    silently CORRUPT such queries: "keegstra OR zundel" tokenised to
    ['keegstra','or','zundel'] and demanded a case name containing the literal word
    "or", so the name band matched nothing and the whole prioritisation collapsed to
    body hits.

    So when grammar IS present, those priorities route through build_query()
    instead, pinned to their own column. The cost is prefix matching: build_query
    emits exact quoted phrases, so within a boolean query "keegs" no longer finds
    Keegstra. That trade only applies to queries that asked for grammar; a plain
    query keeps the prefix behaviour untouched.
    """
    return any(lex in _BOOL_OPS or lex in "()"
               or (len(lex) >= 2 and lex[0] == '"' and lex[-1] == '"')
               for lex in _LEX_RE.findall(q))


class SqlReturn(NamedTuple):
    """One priority's contribution to the single search query.

    Returned rather than accumulated into shared state, so each priority is a pure
    function of the query tokens and can be tested on its own:

        >>> match_case_name(["keegstra"], "keegstra").select
        'SELECT c.case_id, ? AS band, ...'

    `select` MUST yield exactly four columns, in this order:
        case_id, band, score, excerpt
    `excerpt` is NULL for priorities with nothing to quote — only the body
    priority can point at the passage that matched.
    A priority that cannot contribute returns None instead of an empty SqlReturn —
    that is what "no matches here" means, and it keeps an empty branch out of the
    UNION rather than adding a select that matches nothing.
    """
    ctes: list[str]
    cte_params: list
    select: str
    select_params: list


# ====================================================================== 1 ====
def or_operands(q: str) -> list[str]:
    """Split a query on TOP-LEVEL uppercase OR, keeping each side's own syntax.

        "keegstra OR zundel"              -> ["keegstra", "zundel"]
        "religious AND (jewish OR muslim)" -> ["religious AND (jewish OR muslim)"]

    The second case is the point of "top-level": an OR nested inside parentheses is
    part of one operand and is left for FTS5 to evaluate. Only OR the user wrote at
    the outermost level splits the query.

    Position in this list is the term's RANK, and rank beats court hierarchy in the
    sort: for "keegstra OR zundel" every Keegstra comes before every Zundel, each
    group ordered by court. Sequence is meaningful — the user put Keegstra first.

    A query with no top-level OR returns a single operand, which is why the ordinary
    case needs no special handling: rank is 0 for every row.
    """
    parts, cur, depth = [], [], 0
    for lex in _LEX_RE.findall(q):
        if lex == "(":
            depth += 1
            cur.append(lex)
        elif lex == ")":
            depth = max(0, depth - 1)
            cur.append(lex)
        elif lex == "OR" and depth == 0:
            parts.append(" ".join(cur))
            cur = []
        else:
            cur.append(lex)
    parts.append(" ".join(cur))
    return [p for p in (x.strip() for x in parts) if p]


def or_rank(hits: list[str]) -> str:
    """SQL for a row's OR rank. LOWER sorts first.

    Inclusive OR: a case matching MORE of the operands outranks one matching fewer,
    and among equals the earliest operand in the query wins. For "keegstra OR
    zundel" that is exactly:

        rank    0  matched both
             1000  matched keegstra only   (operand 0)
             1001  matched zundel only     (operand 1)

        (n - matched_count) * 1000 + index_of_first_match

    SQLite yields 1/0 for a boolean, so summing the IS NOT NULL tests counts the
    matches. The 1000 multiplier just has to exceed the operand count, which
    MAX_OPERANDS caps well below it.
    """
    n = len(hits)
    count = " + ".join(f"({h})" for h in hits)
    first = " ".join(f"WHEN {h} THEN {i}" for i, h in enumerate(hits))
    return f"(({n} - ({count})) * 1000 + CASE {first} END)"


def _ranked(prefix: str, col: str, score: str, exprs: list[str]) -> tuple:
    """CTEs + SQL pieces for one column matched against each OR operand in turn.

    One MATERIALIZED CTE per operand (bm25 must be evaluated inside the CTE that
    queries the fts table — see the note in match_case_name). `term_rank` is a CASE
    over them in order, so the FIRST operand a case matches is the one it is filed
    under: earliest term wins, which is what makes rank order follow query order.
    """
    ctes = [f"""{prefix}{i} AS MATERIALIZED (
        SELECT rowid AS rid, {score} AS s
        FROM names_fts WHERE names_fts MATCH ?
    )""" if col != "text" else f"""{prefix}{i} AS MATERIALIZED (
        SELECT rowid AS rid, {score} AS s
        FROM cases_fts WHERE cases_fts MATCH ?
    )""" for i in range(len(exprs))]
    cte_params = [f"{{{col}}} : ({e})" for e in exprs]
    n = len(exprs)
    hit = [f"{prefix}{i}.rid IS NOT NULL" for i in range(n)]
    joins = "\n        ".join(
        f"LEFT JOIN {prefix}{i} ON {prefix}{i}.rid = c.rowid" for i in range(n))
    score_x = ", ".join(f"{prefix}{i}.s" for i in range(n))
    return (ctes, cte_params, joins, or_rank(hit), f"COALESCE({score_x}, 0)",
            " OR ".join(hit))


def with_family(prefix: str, band: float, direct: str,
                direct_params: list) -> SqlReturn:
    """Wrap one priority's direct-match SELECT so WHOLE FAMILIES come back.

    `direct` must emit exactly: case_id, term_rank, lvl, sub, score — no band,
    which this adds. Cases sharing a name_key are one family (the same
    litigation at different court levels); if any member matches, every member
    is returned and the family sorts as one block on the best member's keys.

    A promoted member keeps score 0, which is what lets shape() label it
    "family" rather than pretending it matched.

    Applied to all three priorities. It is indispensable at priority 3, where
    the text differs completely between court levels — a search for "pleadings"
    hits only the trial record of Snyder and pulls its appeal and Supreme Court
    records up with it. At priorities 1 and 2 it is usually redundant, because
    family members share a caption and so match together anyway, but not
    always: measured on this corpus 17 of 82 families have differing captions
    and 45 of 82 have differing party lists, and without this those return
    partial families.

    name_key NULL (the 122 anonymized RAD decisions) means "no family": such a
    case is returned only on its own match and never promotes anything.
    """
    ctes = [
        f"""{prefix}m AS MATERIALIZED (
        SELECT d.case_id AS case_id, d.term_rank AS term_rank, d.lvl AS lvl,
               d.sub AS sub, d.score AS score, c2.name_key AS name_key
        FROM ({direct}) d
        JOIN cases c2 ON c2.case_id = d.case_id
    )""",
        f"""{prefix}f AS MATERIALIZED (
        SELECT name_key, MAX(lvl) AS lvl, MIN(term_rank) AS term_rank,
               MAX(sub) AS sub
        FROM {prefix}m WHERE name_key IS NOT NULL GROUP BY name_key
    )""",
    ]
    select = f"""
        SELECT c.case_id, ? AS band,
               COALESCE(f.term_rank, m.term_rank) AS term_rank,
               COALESCE(f.lvl, m.lvl) AS lvl,
               COALESCE(f.sub, m.sub) AS sub,
               COALESCE(m.score, 0) AS score,
               NULL AS excerpt
        FROM cases c
        LEFT JOIN {prefix}m m ON m.case_id = c.case_id
        LEFT JOIN {prefix}f f ON f.name_key = c.name_key
        WHERE m.case_id IS NOT NULL OR f.name_key IS NOT NULL"""
    return SqlReturn(ctes, direct_params, select, [band])


def match_case_name(q: str, toks: list[str], nq: str) -> SqlReturn | None:
    """1. The query matches the CASE NAME (or the citation).

    Two ways a case qualifies, ORed in the WHERE:

      FTS   every token prefix-matched against names_fts, pinned to the case_name
            column. The pin is load-bearing: MATCH otherwise spans the party column
            too, and a party-only hit would land in this band scoring 0 —
            priority-2 material ranked as priority 1. Measured: "tremaine" matches
            5 rows unpinned, 3 pinned.
      LIKE  every token as a substring of name+citation. Catches what FTS cannot —
            citations are in NO fts index, and mid-word fragments.

    STOP WORDS ARE KEPT here, unlike priority 2: in a style of cause the "v" is
    structural, and it is what makes an exact-name match exact.
    """
    if not toks:
        return None

    # ---- explicit grammar: hand the whole expression to FTS, pinned to the
    # case_name column. No LIKE branch and no exactness bonuses here — LIKE cannot
    # express OR/NOT, and "did the user type the whole name" is not a question a
    # boolean query is asking. Consequence worth knowing: in a grammar query the
    # citation half of `2018 bcca 479 OR keegstra` is unreachable, because citations
    # live only in the LIKE branch (they are in no fts index).
    if has_grammar(q):
        if not NAMES_FTS_COLS:
            return None                 # no name index; nothing to run this against
        exprs = [e for e in (build_query(o, expand=False)[0] for o in or_operands(q)) if e]
        if not exprs:
            return None
        ctes, cps, joins, rank, score, where = _ranked(
            "n", "case_name", name_score_expr(), exprs)
        return SqlReturn(ctes, cps, f"""
        SELECT c.case_id, ? AS band, {rank} AS term_rank,
               -- A boolean query states its own conditions; there is no "how well
               -- did it match" to grade, so every grammar hit sits at one level
               -- and ordering falls through to term_rank, then the court
               -- hierarchy, then score.
               ? AS lvl, 0 AS sub, {score} AS score,
               NULL AS excerpt
        FROM cases c
        {joins}
        WHERE {where}""", [BAND_NAME, L_ALL])

    ctes: list[str] = []
    cte_params: list = []

    # NO bm25 HERE, deliberately. It was scoring -bm25(names_fts, 1.0, 0.0), but
    # FTS5 normalises by the WHOLE ROW's length and names_fts rows are
    # (case_name, parties) -- so weighting parties 0.0 removes its score
    # contribution but NOT its length contribution. Measured on "keegstra": five
    # records with the identical caption "R. v. Keegstra" scored 7.601 vs 6.736
    # purely on how many parties each listed, and the SCC record scored 2.655
    # against the trial court's 7.601 because it carries 379 characters of
    # interveners. That is noise, not ranking.
    #
    # Nothing is lost: by the time ORDER BY reaches the score, rows are already
    # tied on band, term_rank, lvl and sub, so every query term matched at the
    # same level and bm25 has no signal left to add. Ties now fall through to
    # court hierarchy, then the exact/prefix bonuses, then date.
    join = ""

    # Each token must start a WORD, not merely appear somewhere. A bare '%tok%' let
    # the token "r" in "R. v. Keegstra" match the r inside "Corporation", pulling in
    # cases on the strength of a single letter. NAME_CIT is normalized to
    # alphanumerics and single spaces, so a word starts at position 1 or after a
    # space. This also lines the LIKE branch up with the FTS branch, which is
    # prefix-matching too.
    tok_hit = f"({NAME_CIT} LIKE ? OR {NAME_CIT} LIKE ?)"
    hits_sum = " + ".join([f"CASE WHEN {tok_hit} THEN 1 ELSE 0 END"] * len(toks))

    # Level 3 admits a case on ONE matching term, which makes the stop words this
    # priority deliberately keeps (see the STOP_WORDS note) dangerous here: "v"
    # alone is in 75% of captions, so `snyder v montreal gazette ltd` matched 1,233
    # cases on the strength of its "v". Ranking still put Snyder first, but the
    # result count was meaningless.
    #
    # So stop words count toward the LEVEL and the tie-break, but cannot by
    # themselves admit a case. A case qualifies when it matched every term (levels
    # 1-2, where a structural "v" is real evidence) or matched at least one
    # CONTENT term (level 3).
    content = [t for t in toks if t not in STOP_WORDS]
    chits_sum = (" + ".join([f"CASE WHEN {tok_hit} THEN 1 ELSE 0 END"] * len(content))
                 if content else "0")

    # Which query term matched FIRST, by the order they were typed. "Keegstra
    # Zundel" then returns every Keegstra case (ordered by court) before every
    # Zundel case, rather than interleaving the two by court level.
    #
    # Built over CONTENT tokens only. Including stop words would collapse it:
    # in "R. v. Keegstra Zundel" every case matches the leading "r", so every
    # case would rank at term 0 and the grouping would vanish.
    trank = (" ".join(f"WHEN {tok_hit} THEN {i}" for i in range(len(content)))
             if content else "")
    trank_expr = f"CASE {trank} ELSE {len(content)} END" if content else "0"

    # The per-token hit count is needed three times over (to pick the level, to
    # break ties inside level 3, and to filter), so it is computed ONCE in an
    # inner select and referenced by name. Repeating the expression instead would
    # triple the bind parameters and the chance of getting their order wrong.
    inner = f"""
            SELECT c.case_id AS cid,
                   ({hits_sum}) AS hits,
                   ({chits_sum}) AS chits,
                   ({trank_expr}) AS trank,
                   CASE WHEN {NAME_CIT} LIKE ? THEN 1 ELSE 0 END AS run,
                   CASE WHEN norm(c.case_name) = ? THEN 1 ELSE 0 END AS exact,
                   CASE WHEN {NAME_CIT} LIKE ? THEN 1 ELSE 0 END AS pref
            FROM cases c
            {join}"""

    # `lvl` and `sub` are emitted as their own columns rather than folded into the
    # score, because ORDER BY has to apply them BEFORE the court hierarchy: the
    # spec ranks a level-2 SCC record below a level-1 provincial one. `sub` carries
    # the hit count, but only at level 3 — levels 1 and 2 go straight to court
    # order, so their sub is 0 and cannot disturb it.
    #
    # The exact/prefix bonuses stay inside `score` alone, which sorts AFTER the
    # court hierarchy. They therefore refine ties without overriding the spec's
    # "λ ascending within a level".
    select = f"""
        SELECT case_id, band, term_rank, lvl, sub,
               lvl + sub
               + CASE WHEN exact = 1 THEN ? ELSE 0 END
               + CASE WHEN pref = 1 THEN ? ELSE 0 END AS score,
               NULL AS excerpt
        FROM (
            SELECT cid AS case_id, ? AS band, 0 AS term_rank, exact, pref,
                   CASE WHEN run = 1 THEN ? WHEN hits = ? THEN ? ELSE ? END AS lvl,
                   CASE WHEN run = 1 OR hits = ? THEN 0 ELSE hits END AS sub
            FROM ({inner})
            WHERE hits = ? OR chits > 0
        )"""

    # Bind in the order the `?` appear in the SQL TEXT: the outermost SELECT's
    # bonuses, then the middle SELECT's band/level constants, then the innermost
    # select's (all-token LIKEs, content-token LIKEs, run/exact/pref), then the
    # middle WHERE.
    select_params = (
        [N_EXACT, N_PREFIX,
         BAND_NAME, L_PHRASE, len(toks), L_ALL, L_ANY, len(toks)]
        + [p for t in toks for p in (f"{t}%", f"% {t}%")]        # hits_sum
        + [p for t in content for p in (f"{t}%", f"% {t}%")]     # chits_sum
        + [p for t in content for p in (f"{t}%", f"% {t}%")]     # trank_expr
        + [f"%{nq}%", nq, f"{nq}%"]
        + [len(toks)]
    )
    return SqlReturn(ctes, cte_params, select, select_params)


# ====================================================================== 2 ====
def match_parties(q: str, toks: list[str]) -> SqlReturn | None:
    """2. The query matches the PARTIES text.

    This is what makes the ~923 cases whose parties are NOT in the style of cause
    findable: searching "tremaine" reaches Warman v. Canada (Human Rights
    Commission), where Tremaine is a party the caption never names.

    STOP WORDS ARE EXCLUDED HERE, unlike priority 1. In a flat list of party names
    the "v" is pure noise: no one is called "v", so requiring it would just delete
    every result.

    FTS only, no LIKE branch. Everything in `parties` is already indexed, so unlike
    the case-name priority there is nothing (no citation) that MATCH cannot reach —
    and going through the index sidesteps the fact that older databases still hold
    this column as raw JSON, where a LIKE would happily match the words "name" and
    "role" out of the JSON keys.
    """
    pt = [t for t in toks if t not in STOP_WORDS]
    if not pt or not NAMES_FTS_COLS:
        return None

    # Explicit grammar: same routing as priority 1, pinned to the party column(s).
    # strip_stop_words first, so the exclusion this priority applies to plain
    # queries also applies inside a boolean one.
    if has_grammar(q):
        exprs = [e for e in (build_query(strip_stop_words(o), expand=False)[0]
                             for o in or_operands(q)) if e]
        if not exprs:
            return None
        ctes, cps, joins, rank, score, where = _ranked(
            "p", party_cols(), party_score_expr(), exprs)
        return SqlReturn(ctes, cps, f"""
        SELECT c.case_id, ? AS band, {rank} AS term_rank,
               -- A boolean query states its own conditions; there is no "how well
               -- did it match" to grade, so every grammar hit sits at one level
               -- and ordering falls through to term_rank, then the court
               -- hierarchy, then score.
               ? AS lvl, 0 AS sub, {score} AS score,
               NULL AS excerpt
        FROM cases c
        {joins}
        WHERE {where}""", [BAND_PARTIES, L_ALL])

    # Two levels, mirroring priority 1 minus the phrase level: a flat list of party
    # names has no "style of cause" to match in order, so the spec gives this
    # priority only all-terms and any-term.
    #
    # One CTE per token rather than one ANDed MATCH, because the level and the
    # any-term tie-break both need to know HOW MANY tokens matched, not just that
    # the conjunction held.
    ctes, cte_params, joins, hit_flags = [], [], [], []
    for i, t in enumerate(pt):
        ctes.append(f"""pm{i} AS MATERIALIZED (
        SELECT rowid AS rid
        FROM names_fts WHERE names_fts MATCH ?
    )""")
        cte_params.append(f'{{{party_cols()}}} : "{t}"*')
        joins.append(f"LEFT JOIN pm{i} ON pm{i}.rid = c.rowid")
        hit_flags.append(f"CASE WHEN pm{i}.rid IS NOT NULL THEN 1 ELSE 0 END")

    hits_sum = " + ".join(hit_flags)

    # NO bm25 HERE, for the same reason it is gone from priority 1. bm25 normalises
    # by the WHOLE ROW's length and names_fts rows are (case_name, parties), so
    # weighting case_name 0.0 drops its score contribution but not its length
    # contribution -- a case with a long caption is penalised on a query that never
    # looked at the caption. Measured on "keegstra majesty": the SCC R. v. Keegstra
    # scored 2.655 against 6.736 for the two ABCA records of the same litigation,
    # purely because it lists 379 characters of interveners.
    #
    # The CTEs above stay: they are what detect a hit (pm{i}.rid IS NOT NULL) and
    # feed `hits`. Only the score is dropped.
    inner = f"""
            SELECT c.case_id AS cid,
                   ({hits_sum}) AS hits
            FROM cases c
            {chr(10).join('            ' + j for j in joins).lstrip()}"""

    select = f"""
        SELECT case_id, band, term_rank, lvl, sub, lvl + sub AS score,
               NULL AS excerpt
        FROM (
            SELECT cid AS case_id, ? AS band, 0 AS term_rank,
                   CASE WHEN hits = ? THEN ? ELSE ? END AS lvl,
                   CASE WHEN hits = ? THEN 0 ELSE hits END AS sub
            FROM ({inner})
            WHERE hits > 0
        )"""
    return SqlReturn(ctes, cte_params, select,
                     [BAND_PARTIES, len(pt), L_ALL, L_ANY, len(pt)])


# ====================================================================== 3 ====
def body_excerpts(conn, q: str, case_ids: list[str]) -> dict[str, str]:
    """The matching passage for each of `case_ids`, for the CURRENT PAGE only.

    Split out of match_body's CTEs on measurement: snippet() over all 251 matches of
    "religious freedom" costs 150 ms, the same call over ten rows costs 6 ms, and the
    CTE version paid it twice because the count query shares the CTE.

    Both expressions are tried because neither is a superset of the other — for
    "religious freedom" the literal ("religious" AND "freedom") matches 391 documents
    while the synonym ring matches 251, and each finds documents the other misses. The
    literal is tried first so a case that matched literally is quoted on the words the
    user actually typed.
    """
    if not case_ids:
        return {}
    out: dict[str, str] = {}
    snip = (f"snippet(cases_fts, 1, '<mark>', '</mark>', '\u2026', {SNIPPET_TOKENS})")
    stripped = strip_stop_words(q)
    for expand in (False, True):
        want = [c for c in case_ids if c not in out]
        if not want:
            break
        expr, _ = build_query(stripped, expand)
        if not expr:
            continue
        marks = ",".join("?" * len(want))
        try:
            for cid, ex in conn.execute(
                    f"""SELECT c.case_id, {snip}
                        FROM cases_fts
                        JOIN cases c ON c.rowid = cases_fts.rowid
                        WHERE cases_fts MATCH ? AND c.case_id IN ({marks})""",
                    [f"{{text}} : ({expr})"] + want):
                if ex:
                    out[cid] = ex
        except sqlite3.OperationalError:
            continue          # a malformed expression must not break the page
    return out


# ====================================================================== 3 ====
def strip_stop_words(q: str) -> str:
    """Drop stop words from a query, leaving quoted phrases and operators intact.

    Priority 3 searches the judgment body, where "the", "of" and "and" appear in
    essentially every document: ANDing them in narrows nothing and costs a full
    posting-list intersection each. Priority 1 keeps them (see match_case_name)
    because in a style of cause they carry structure.

    Lexed with build_query's own lexer so a quoted phrase survives whole — "freedom
    of religion" typed with quotes keeps its "of", because there the user asked for
    that exact phrase.
    """
    out = []
    for lex in _LEX_RE.findall(q):
        if lex in _BOOL_OPS or lex in "()" or lex.startswith('"'):
            out.append(lex)
        elif norm(lex) not in STOP_WORDS:
            out.append(lex)
    return " ".join(out)


def match_body(q: str) -> SqlReturn | None:
    """3. The query matches the BODY of the judgment — exact, or via synonyms.

    This is the priority that uses the controlled vocabulary. build_query() resolves
    the query against the synonym rings in keyword-vocab.csv, so an English query
    reaches a French judgment (the index is built with `remove_diacritics 2` and the
    rings carry both languages) and a case arguing the point in different words is
    still found.

    TWO sub-bands, because they are different strengths of evidence:
      exact    build_query(expand=False) — the words the user actually typed.
      synonym  build_query(expand=True)  — the ring. Only ever ADDS candidates.
    A case in both takes the exact bonus (`best` picks its highest-scoring row), so
    the ring can never demote a literal match.

    Both are pinned to cases_fts's `text` column. Without the pin, MATCH also spans
    case_name and every priority-1 hit would re-enter here — harmless to ranking
    since band 1 outranks band 3 anyway, but it would mean a case whose TEXT does not
    match still produced a body-band row, and "no matches on text -> no results here"
    would stop being true.

    This is also the only priority that can quote itself: snippet() returns the
    matching passage with <mark> around the hit, which is what the result card shows
    instead of falling back to the AI summary.
    """
    score = "-bm25(cases_fts, 0.0, 1.0)"
    operands = or_operands(q)

    # Per OR operand, TWO branches: the literal words (x<i>) and the synonym ring
    # (s<i>). The ring is only built where expansion actually changed that operand —
    # for a plain surname it does not, and a duplicate CTE is pure cost.
    #
    # snippet() is NOT computed here. Measured on this corpus it costs 150 ms over
    # every match against 6 ms for ten rows, and these CTEs feed both the page query
    # AND the count query. body_excerpts() fetches the page's passages afterwards.
    ctes, cte_params, joins, per_operand, scores, exact_hits = [], [], [], [], [], []
    for i, operand in enumerate(operands):
        stripped = strip_stop_words(operand)
        ex, _ = build_query(stripped, expand=False)
        if not ex:
            continue
        sy, _ = build_query(stripped, expand=True)
        ctes.append(f"""x{i} AS MATERIALIZED (
        SELECT rowid AS rid, {score} AS s FROM cases_fts WHERE cases_fts MATCH ?
    )""")
        cte_params.append(f"{{text}} : ({ex})")
        joins.append(f"LEFT JOIN x{i} ON x{i}.rid = c.rowid")
        hit, sc = [f"x{i}.rid IS NOT NULL"], [f"x{i}.s"]
        exact_hits.append(f"x{i}.rid IS NOT NULL")
        if sy and sy != ex:
            ctes.append(f"""s{i} AS MATERIALIZED (
        SELECT rowid AS rid, {score} AS s FROM cases_fts WHERE cases_fts MATCH ?
    )""")
            cte_params.append(f"{{text}} : ({sy})")
            joins.append(f"LEFT JOIN s{i} ON s{i}.rid = c.rowid")
            hit.append(f"s{i}.rid IS NOT NULL")
            sc.append(f"s{i}.s")
        # One operand counts as matched if EITHER of its branches hit.
        per_operand.append("(" + " OR ".join(hit) + ")")
        scores.append(", ".join(sc))
    if not ctes:
        return None

    # B_EXACT rides on the literal branches: a case reached only through a synonym
    # ring stays below one that used the user's own words, within the same rank.
    #
    # ---- FAMILY PROMOTION ---------------------------------------------------
    # The direct hits go into `bmatch`; `bfam` reduces them to the best score per
    # name_key. The final select then joins CASES back to `bfam`, so every member
    # of a family with any hit is returned — including members that matched
    # nothing at all.
    #
    # This is the rule that surfaces a Supreme Court affirmation containing none of
    # the query terms because its trial-level sibling scored: searching
    # "pleadings" hits only the QCCS record of Snyder, and the QCCA and SCC records
    # come with it, ordered above it because they are the higher courts.
    #
    # `lvl` is the FAMILY's best score, not the case's own, so an entire family
    # sorts as one block; `score` keeps the case's own β for display. A case whose
    # name_key is NULL (the 122 anonymized RAD decisions) is its own family of one
    # via the COALESCE, so it is never promoted and never promotes anything.
    ctes.append(f"""bmatch AS MATERIALIZED (
        SELECT c.case_id AS case_id, c.name_key AS name_key,
               COALESCE({', '.join(scores)}, 0)
               + CASE WHEN {' OR '.join(exact_hits)} THEN ? ELSE 0 END AS s,
               {or_rank(per_operand)} AS tr
        FROM cases c
        {chr(10).join('        ' + j for j in joins).lstrip()}
        WHERE {' OR '.join(per_operand)}
    )""")
    cte_params.append(B_EXACT)
    ctes.append("""bfam AS MATERIALIZED (
        SELECT name_key, MAX(s) AS fs, MIN(tr) AS tr
        FROM bmatch WHERE name_key IS NOT NULL GROUP BY name_key
    )""")

    select = """
        SELECT c.case_id, ? AS band,
               COALESCE(f.tr, m.tr) AS term_rank,
               COALESCE(f.fs, m.s) AS lvl,
               0 AS sub,
               COALESCE(m.s, 0) AS score,
               NULL AS excerpt
        FROM cases c
        LEFT JOIN bmatch m ON m.case_id = c.case_id
        LEFT JOIN bfam   f ON f.name_key = c.name_key
        WHERE m.case_id IS NOT NULL OR f.name_key IS NOT NULL"""
    return SqlReturn(ctes, cte_params, select, [BAND_BODY])


@app.get("/search")
def search(
    q: str = Query("", max_length=MAX_Q_CHARS,
                   description="Free text, matched against the case name and "
                               "citation, the parties, and the judgment text."),
    name_q: str = Query("", description="Case name / citation filter, ANDed with "
                                        "everything else."),
    in_name: bool = Query(True, description="Search the case name and citation "
                                            "(priority 1)."),
    in_parties: bool = Query(True, description="Search the party names "
                                               "(priority 2)."),
    in_text: bool = Query(True, description="Search the judgment text "
                                            "(priority 3)."),
    limit: int = Query(50, ge=1, le=MAX_LIMIT),
    k: int | None = Query(None, ge=1, le=MAX_LIMIT, description="Alias for limit."),
    offset: int = Query(0, ge=0),
    court: list[str] = Query([]),
    province: list[str] = Query([]),
    practice_area: list[str] = Query([]),
    keyword: list[str] = Query([], description="keyword_id, e.g. K051. Repeatable."),
    keyword_mode: str = Query("or", pattern="^(and|or)$"),
    keyword_group: list[str] = Query([]),
    language: str | None = Query(None, pattern="^(en|fr)$"),
    level: str | None = Query(None, pattern="^(UC|LC)$"),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    sort: str = Query("relevance", pattern="^(relevance|date_desc|date_asc|name)$"),
    include_total: bool = Query(True, description="Compute `total`."),
):
    """Search, ranked by WHERE the query matched.

        1. the query matches the CASE NAME
        2. the query matches the PARTIES text
        3. the query matches the BODY text

    Each can be switched off independently with in_name / in_parties / in_text,
    which is what the three checkboxes on the search page drive. Turning one off
    removes its fragment from the union entirely — it does not merely hide the
    results, so a case reachable ONLY through that priority disappears. All three
    off is rejected rather than silently returning everything.

    ONE query. Each priority is a helper below returning SQL — a list of CTEs and
    a single `SELECT case_id, band, score` — and the helpers' selects are UNIONed
    into one `hits` CTE. Nothing is merged in Python and no priority runs its own
    round trip; adding priority 2 means appending one more helper to the list.

    A case matching in several priorities collapses to its BEST hit (MAX over the
    union), so matching somewhere weak never adds to a strong match.
    """
    conn = db()
    limit = k or limit
    toks = tokens(q)[:MAX_OPERANDS]
    nq = norm(q)

    # All three off asks for nothing. Rejected explicitly rather than falling
    # through to an empty union, which would return the whole corpus unfiltered
    # and look like the toggles had done the opposite of what was asked.
    if not (in_name or in_parties or in_text):
        return {
            "query": q,
            "mode": "no_scope",
            "expanded_to": [],
            "total": 0,
            "limit": limit,
            "offset": offset,
            "results": [],
            "warning": "Select at least one of case name, parties, or text to "
                       "search in.",
        }

    # Caught HERE rather than left to FTS5, which reports 'syntax error near "NOT"'
    # -- accurate but useless to a researcher. leading_not_hint() reads the user's
    # own terms back and, where it can, hands them the corrected query.
    hint = leading_not_hint(q)
    if hint:
        return {
            "query": q,
            "mode": "bad_query",
            "expanded_to": [],
            "total": 0,
            "limit": limit,
            "offset": offset,
            "results": [],
            "warning": hint,
        }

    # `expanded_to` is part of the response CONTRACT, not a nicety: the frontend
    # does `data.expanded_to.map(...)` unconditionally (api.ts) and renders the
    # result as "we also searched for" chips (Search.tsx). Omitting it — as the
    # first version of this rewrite did — throws "Cannot read properties of
    # undefined (reading 'map')" and the page reports the service as unreachable.
    # So it must be present on EVERY return path below, including the guards.
    #
    # The ids come from the same synonym expansion priority 3 runs, so what is
    # reported is exactly what was searched.
    # Same ceilings apply here -- this call runs BEFORE the priorities are built, so
    # without its own guard an over-long query 500s before reaching the handler below.
    try:
        _, matched_ids = build_query(strip_stop_words(q), expand=True) if q else (None, [])
    except ValueError as e:
        return {
            "query": q,
            "mode": "bad_query",
            "expanded_to": [],
            "total": 0,
            "limit": limit,
            "offset": offset,
            "results": [],
            "warning": str(e),
        }
    expanded_to = [{"keyword_id": kid,
                    "en": VOCAB.terms[kid]["canonical_en"],
                    "fr": VOCAB.terms[kid]["canonical_fr"]}
                   for kid in matched_ids if kid in VOCAB.terms]

    # ---- stop-word guard ---------------------------------------------------
    # Sits above the priority helpers so it covers all three: a query that is
    # nothing but noise asks the same empty question of names, parties and body.
    # Returning 200 rather than 422 follows the existing convention for a query
    # that cannot be answered (see the malformed-FTS handler below), so the
    # frontend renders one "no results" state instead of branching on status.
    if toks and all(t in STOP_WORDS for t in toks):
        return {
            "query": q,
            "mode": "stopwords",
            "expanded_to": expanded_to,
            "total": 0,
            "limit": limit,
            "offset": offset,
            "results": [],
            "warning": "Your search contains only common words "
                       f"({', '.join(dict.fromkeys(toks))}) and cannot be "
                       "narrowed. Add a party name, a citation, or a keyword.",
        }

    # Which priorities this request actually searched — echoed back so the client
    # can show what was in scope without re-deriving it from the three flags.
    scoped = ([n for n, on in (("case_name", in_name), ("parties", in_parties),
                               ("body", in_text)) if on])

    mode = "browse" if not toks else "search"
    where, fparams = build_filters(court, province, practice_area, keyword,
                                   keyword_mode, language, level, date_from, date_to,
                                   keyword_group, name_q)
    filt = "WHERE " + " AND ".join(where) if where else ""

    if not toks:
        # Nothing to be relevant to, so "relevance" degrades to newest-first.
        order = "c.date DESC" if sort == "relevance" else SORTS[sort]
        base = f"""
            SELECT {SELECT_COLS}, NULL AS excerpt, NULL AS relevance
            FROM cases c
            LEFT JOIN case_metadata m ON m.case_id = c.case_id
            {filt}"""
        params = list(fparams)
    else:
        # Each priority is a module-level pure function returning a SqlReturn, or
        # None when it has nothing to contribute. Order matters: params bind in the
        # order the `?` appear in the assembled SQL TEXT, which is every CTE first
        # (in fragment order) and then every select (in the same order).
        # build_query raises ValueError on the query-cost ceilings (too many distinct
        # terms, too many chained XORs). Those are user input errors, not server
        # faults: without this they surface as a 500, which tells the researcher
        # nothing and looks like an outage.
        try:
            frags = [f for f in (match_case_name(q, toks, nq) if in_name else None,
                                 match_parties(q, toks) if in_parties else None,
                                 match_body(q) if in_text else None) if f]
        except ValueError as e:
            return {
                "query": q,
                "mode": "bad_query",
                "priorities_built": scoped,
                "expanded_to": [],
                "total": 0,
                "limit": limit,
                "offset": offset,
                "results": [],
                "warning": str(e),
            }
        if not frags:
            return {"query": q, "mode": mode,
                    "priorities_built": scoped,
                    "expanded_to": expanded_to,
                    "total": 0, "limit": limit, "offset": offset, "results": []}
        ctes = [c for f in frags for c in f.ctes]
        selects = [f.select for f in frags]
        cte_params = [p for f in frags for p in f.cte_params]
        select_params = [p for f in frags for p in f.select_params]
        # `best` collapses a case to its single strongest hit. MAX(band) and
        # MAX(band + score) always agree on which row wins, because the bands are
        # spaced 1,000,000 apart and no in-band score approaches that.
        # The spec's ordering, one key list for every band because each priority
        # supplies its own `lvl` and `sub`:
        #
        #   band       which priority the case is placed at (1 beats 2 beats 3)
        #   term_rank  which OR operand matched first — "keegstra OR zundel" puts
        #              every keegstra hit above every zundel hit. Always 0 for a
        #              plain query, so it is a no-op unless grammar was used.
        #   lvl        priorities 1-2: match level (phrase > all terms > any term)
        #              priority 3:     the FAMILY's best bm25, so a family sorts
        #                              as one block
        #   sub        priorities 1-2: hit count, but only at the any-term level
        #              priority 3:     always 0
        #   λ          court hierarchy, most authoritative first
        #   relevance / date  final tie-breaks (the exact-name bonus lives here)
        #
        # λ sitting AFTER lvl is the point: a level-2 SCC record ranks below a
        # level-1 provincial one, because how well the query matched decides the
        # block and the court hierarchy only orders within it.
        order = (f"best.band DESC, best.term_rank ASC, best.lvl DESC, "
                 f"best.sub DESC, {COURT_RANK} ASC, best.relevance DESC, "
                 f"c.date DESC"
                 if sort == "relevance" else SORTS[sort])
        base = f"""
            WITH {", ".join(ctes) + "," if ctes else ""}
            hits(case_id, band, term_rank, lvl, sub, score, excerpt) AS (
                {" UNION ALL ".join(selects)}
            ),
            best AS (
                -- One row per case: its single strongest hit, with THAT row's
                -- excerpt. A plain GROUP BY could give MAX(band+score) from one row
                -- and an excerpt from another, so the winner is picked by
                -- ROW_NUMBER instead of aggregated.
                SELECT case_id, band, term_rank, lvl, sub, relevance, excerpt FROM (
                    SELECT case_id, band, term_rank, lvl, sub,
                           band + score AS relevance, excerpt,
                           ROW_NUMBER() OVER (PARTITION BY case_id
                                              ORDER BY band DESC, term_rank ASC,
                                                       lvl DESC, sub DESC,
                                                       score DESC) AS rn
                    FROM hits
                ) WHERE rn = 1
            )
            SELECT {SELECT_COLS}, best.excerpt AS excerpt, best.relevance AS relevance,
                   best.band AS band
            FROM best
            JOIN cases c ON c.case_id = best.case_id
            LEFT JOIN case_metadata m ON m.case_id = c.case_id
            {filt}"""
        params = cte_params + select_params + list(fparams)
    try:
        rows = conn.execute(f"{base} ORDER BY {order} LIMIT ? OFFSET ?",
                            params + [limit, offset]).fetchall()
        total = (conn.execute(f"SELECT COUNT(*) FROM ({base})", params).fetchone()[0]
                 if include_total else None)
    except sqlite3.OperationalError as e:
        return JSONResponse(
            {"query": q, "mode": mode, "expanded_to": expanded_to,
             "total": 0, "limit": limit, "offset": offset, "results": [],
             "warning": f"unsearchable query: {e}"},
            status_code=200,
        )

    shaped = [shape(r, offset + i + 1, conn) for i, r in enumerate(rows)]
    # Only rows whose best hit was the body band have a passage to quote; the others
    # keep shape()'s summary fallback.
    if toks:
        body = [d["case_id"] for d in shaped
                if d.get("relevance") and d["relevance"] < BAND_PARTIES]
        for cid, ex in body_excerpts(conn, q, body).items():
            for d in shaped:
                if d["case_id"] == cid:
                    d["excerpt"] = d["snippet"] = ex

    return {
        "query": q,
        "mode": mode,
        "priorities_built": scoped,
        "expanded_to": expanded_to,
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": shaped,
    }

@app.get("/case/{case_id}")
def case(case_id: str, include_text: bool = True, include_firac: bool = True):
    conn = db()
    row = conn.execute(f"""
        SELECT {SELECT_COLS}, m.registry, m.defining_issues, m.parties
        FROM cases c LEFT JOIN case_metadata m ON m.case_id = c.case_id
        WHERE c.case_id = ?""", (case_id,)).fetchone()
    if row is None:
        raise HTTPException(404, f"no such case: {case_id}")

    d = dict(row)
    kw = resolve_keywords(conn, d.pop("keyword_ids", None))
    d["keywords"] = kw
    d["level"] = "upper" if case_id.startswith("UC") else "lower"
    try:
        d["defining_issues"] = json.loads(d.get("defining_issues") or "[]")
    except json.JSONDecodeError:
        d["defining_issues"] = []
    # NULL parties means "not extracted" (anonymisation guard or an unreadable
    # caption — 128 cases), which is NOT the same as a case with no parties. Keep
    # null distinct from [] here too, so the frontend can say "not recorded"
    # rather than rendering an empty list as fact. See schema.sql.
    try:
        d["parties"] = (json.loads(d["parties"])
                        if d.get("parties") is not None else None)
    except (TypeError, json.JSONDecodeError):
        d["parties"] = None

    if include_text:
        d["text"] = conn.execute(
            "SELECT text FROM cases WHERE case_id = ?", (case_id,)).fetchone()[0]
    if include_firac:
        d["firac"] = [dict(r) for r in conn.execute("""
            SELECT seq, issue, facts, rule, application, conclusion
            FROM case_firac WHERE case_id = ? ORDER BY seq""", (case_id,))]

    notes_row = conn.execute(
        "SELECT notes FROM case_notes WHERE case_id = ?", (case_id,)).fetchone()
    d["generation_notes"] = (
        json.loads(notes_row[0]) if notes_row and notes_row[0] else None)
    return d


@app.get("/keywords")
def keywords():
    """The controlled vocabulary, with per-term case counts — for filter UIs."""
    conn = db()
    counts = dict(conn.execute("""
        SELECT j.value, COUNT(*) FROM case_metadata m, json_each(m.keyword_ids) j
        GROUP BY j.value""").fetchall())
    return [
        {**t, "count": counts.get(kid, 0), "synonyms": VOCAB.rings.get(kid, [])}
        for kid, t in VOCAB.terms.items()
    ]


@lru_cache(maxsize=1)
def _facets() -> dict:
    conn = db()

    def group(sql: str) -> list[dict]:
        return [{"value": v, "count": n} for v, n in conn.execute(sql) if v is not None]

    years = conn.execute(
        "SELECT MIN(substr(date,1,4)), MAX(substr(date,1,4)) FROM cases "
        "WHERE date IS NOT NULL").fetchone()
    return {
        "courts": group("SELECT court, COUNT(*) n FROM cases GROUP BY 1 ORDER BY n DESC"),
        "provinces": group("SELECT province, COUNT(*) n FROM case_metadata GROUP BY 1 ORDER BY n DESC"),
        "practice_areas": group("SELECT practice_area, COUNT(*) n FROM case_metadata GROUP BY 1 ORDER BY n DESC"),
        "languages": group("SELECT language, COUNT(*) n FROM cases GROUP BY 1 ORDER BY n DESC"),
        "levels": [
            {"value": "upper", "count": conn.execute("SELECT COUNT(*) FROM cases WHERE case_id LIKE 'UC%'").fetchone()[0]},
            {"value": "lower", "count": conn.execute("SELECT COUNT(*) FROM cases WHERE case_id LIKE 'LC%'").fetchone()[0]},
        ],
        "year_min": years[0], "year_max": years[1],
    }


@app.get("/facets")
def facets():
    """Filter options with counts. Static for a given cases.db, so cached."""
    return _facets()


@app.get("/health")
def health():
    conn = db()
    return {
        "ok": True,
        "db": DB_PATH,
        "vocab": VOCAB_PATH,
        "cases": conn.execute("SELECT COUNT(*) FROM cases").fetchone()[0],
        "keywords": len(VOCAB.terms),
        # deploy.sh curls this: false means the staged cases.db predates names_fts
        # and party-name ranking is silently off. Rebuild and redeploy.
        "names_fts": HAS_NAMES_FTS,
    }
