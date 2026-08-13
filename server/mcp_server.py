#!/usr/bin/env python3
"""
MCP server for the JICL case database
=====================================

Exposes the Cloud Run search service (server/app.py) as MCP tools, so a Claude
client can search and read the collection directly.

This is a THIN WRAPPER over the HTTP API — it holds no data, no database
handle, and no ranking logic of its own. Every tool is one call to an endpoint
that already exists. That is deliberate: the ranking rules in app.py are
non-trivial (three priorities, boolean grammar, synonym expansion, court
hierarchy) and must not be reimplemented here where they would drift.

It supersedes the old scripts-workspace/mcp_server.py, which talked to a Chroma
vector store that no longer exists.

Run it two ways — the tools are identical, only the transport differs:

    # Local, for Claude Desktop / Claude Code (the usual case)
    python3 mcp_server.py

    # Remote, for a URL-based connector
    python3 mcp_server.py --transport http --port 8001

Claude Desktop config (stdio):

    {
      "mcpServers": {
        "jicl-database": {
          "command": "python3",
          "args": ["/absolute/path/to/JICL-database/server/mcp_server.py"]
        }
      }
    }

Install:  pip install -r requirements-mcp.txt
Point it elsewhere:  export JICL_API_BASE=http://localhost:8080
"""
from __future__ import annotations

import os
import sys
from typing import Any, Literal

import httpx
from fastmcp import FastMCP

# The deployed service. Deterministic hostname (service + project + region), so
# it survives deleting and recreating the Cloud Run service — same URL the
# frontend uses in .env.production.
API_BASE = os.getenv(
    "JICL_API_BASE",
    "https://tmu-case-db-777191320769.northamerica-northeast2.run.app",
).rstrip("/")

TIMEOUT_SECONDS = 45.0          # Cloud Run cold starts can take a few seconds

# Ceilings exist because every byte returned lands in a context window. The API
# itself allows limit=1000 and returns whole judgments; neither is survivable
# here. The largest decision in the corpus is 1.5M characters (~384k tokens).
MAX_RESULTS = 25
MAX_TEXT_CHARS = 40_000

CORPUS = (
    "1,587 curated Canadian court and tribunal decisions (1879-2026, 57 courts) on "
    "Jewish identity, Judaism, and antisemitism in Canadian law"
)

mcp = FastMCP(
    "JICL Database",
    instructions=(
        "Jewish Identity in Canadian Law (JICL) — a CURATED database of "
        f"{CORPUS}.\n\n"
        "This is NOT a general Canadian caselaw service. It holds only decisions "
        "selected for their bearing on Jewish identity, religious freedom, "
        "antisemitism, hate speech, Jewish family and religious law, and related "
        "questions. If a question is about Canadian law generally, say that this "
        "collection may not cover it rather than stretching a near-miss result.\n\n"
        "Typical workflow: call list_keywords once to learn the controlled "
        "vocabulary, then search_cases (optionally filtered by those keyword_ids), "
        "then get_case for the full text of anything you intend to rely on. "
        "Search returns snippets only — never quote a judgment from a snippet "
        "alone."
    ),
)


async def _get(endpoint: str, params: dict[str, Any] | None = None) -> Any:
    """One GET against the API. Errors come back as data, never as exceptions —
    an MCP tool that raises gives the model nothing to reason about."""
    # Drop only *absent* values. `False` must survive: the API defaults
    # include_text to True, so silently dropping include_text=False returns a
    # whole judgment — 322k characters for LC1, 1.5M for LC66.
    clean = {k: v for k, v in (params or {}).items()
             if v is not None and v != "" and v != []}
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            r = await client.get(f"{API_BASE}{endpoint}", params=clean)
            r.raise_for_status()
            return r.json()
    except httpx.HTTPStatusError as e:
        detail = e.response.text[:400]
        return {"error": f"HTTP {e.response.status_code} from {endpoint}", "detail": detail}
    except httpx.TimeoutException:
        return {"error": f"timed out after {TIMEOUT_SECONDS}s calling {endpoint}",
                "hint": "Cloud Run may be cold-starting; retrying once usually works."}
    except Exception as e:                                   # pragma: no cover
        return {"error": f"{type(e).__name__}: {e}"}


SUMMARY_CHARS = 500     # per hit; the full curated summary is on get_case


def _trim_hit(r: dict[str, Any], concise: bool = False) -> dict[str, Any]:
    """Keep the fields worth spending context on.

    Always drops `excerpt` (byte-identical to `snippet`), the French `resume`,
    and the `mots_cles` mirror of `keywords` — measured, that alone cuts a
    10-result response from ~16.9k tokens to ~4.8k. `concise` drops the snippet
    and summary too, taking the same response to ~0.6k.
    """
    head = {
        "case_id": r.get("case_id"),
        "case_name": r.get("case_name"),
        "citation": r.get("citation"),
        "court": r.get("court"),
        "date": r.get("date"),
        "level": r.get("level"),
    }
    if concise:
        return head
    return {
        **head,
        "province": r.get("province"),
        "practice_area": r.get("practice_area"),
        "keywords": r.get("keywords"),
        "keyword_ids": r.get("keyword_ids"),
        "snippet": r.get("snippet"),
        "summary": (r.get("summary") or "")[:SUMMARY_CHARS] or None,
        "relevance": r.get("relevance"),
    }


@mcp.tool()
async def search_cases(
    query: str = "",
    name_or_citation: str = "",
    keyword_ids: str = "",
    court: str = "",
    province: str = "",
    practice_area: str = "",
    level: Literal["", "UC", "LC"] = "",
    language: Literal["", "en", "fr"] = "",
    date_from: str = "",
    date_to: str = "",
    sort: Literal["relevance", "date_desc", "date_asc", "name"] = "relevance",
    limit: int = 10,
    offset: int = 0,
    concise: bool = False,
) -> dict[str, Any]:
    """
    Search the JICL collection of Canadian decisions on Jewish identity in Canadian law.

    Results are METADATA AND SNIPPETS ONLY. To read a decision, or to quote it,
    call get_case with the case_id — never quote from a snippet.

    RANKING is by WHERE the query matched, in bands that do not blend: a case
    whose NAME matches always outranks one matched only on PARTIES, which always
    outranks one matched only in the BODY text. Within a band, higher courts sort
    first (SCC > appellate > superior trial > provincial > tribunal). So a search
    for a case name returns that case first, ahead of the hundreds that cite it.

    QUERY GRAMMAR (in `query`): uppercase AND / OR / NOT, "quoted phrases", and
    parentheses all work — `religious AND (jewish OR muslim)`, `hate speech NOT
    immigration`. Adjacent words are implicitly ANDed. Lowercase and/or/not are
    ordinary search words. Bare terms are also expanded through a curated synonym
    ring, so "religious freedom" reaches cases phrased "freedom of religion" and
    the French "liberte de religion".

    A query that is entirely stop words (`v`, `R. v.`, `the`) is refused rather
    than returning arbitrary results; you will get mode "stopwords" and a warning.

    RETURNS {query, mode, total, returned, offset, expanded_to, results[]}.
    `total` is the full match count and usually exceeds `returned` — page with
    `offset` rather than assuming you have seen everything. `expanded_to` names
    the controlled terms the query was understood as.

    COST, measured: ~4.8k tokens at limit=10, ~11.8k at limit=25; with
    concise=True, ~0.6k and ~1.4k. Prefer a narrower query over a bigger limit —
    the best match is ranked first, so limit=10 is usually plenty.

    Args:
        query: Free-text search over case name, parties, and full judgment text.
            Leave empty to browse by filters alone.
        name_or_citation: Restrict to cases whose name or citation contains every
            token given. Use for known-item lookup: "elkhodary 2025", "oncj 587".
            Citations are matched by fragment, not as words. ANDed with `query`.
        keyword_ids: Comma-separated controlled-vocabulary ids, e.g. "K058,K093".
            Call list_keywords first — do not guess ids. Cases matching ANY of
            them are returned.
        court: Comma-separated court codes, e.g. "SCC,ONCA". See dataset_coverage.
        province: Comma-separated province codes, e.g. "ON,QC".
        practice_area: Comma-separated areas, e.g. "Family law,Human rights".
        level: "UC" for upper-court decisions, "LC" for lower court, "" for both.
        language: "en" or "fr" to restrict by judgment language.
        date_from: Earliest decision date, YYYY-MM-DD.
        date_to: Latest decision date, YYYY-MM-DD.
        sort: "relevance" (default), "date_desc", "date_asc", or "name".
        limit: Results to return, 1-25 (default 10).
        offset: Skip this many results, for paging through `total`.
        concise: Return only case_id, name, citation, court, date, level —
            no snippets, summaries, or keywords. Roughly a tenth of the size.
            Use it when scanning many results or checking whether something
            exists; follow up with get_case for anything that looks relevant.

    Returns:
        {query, mode, total, returned, offset, expanded_to, results[]}.
        `total` is the whole match count, which usually exceeds `returned` —
        page with `offset` rather than assuming you have seen everything.
        `expanded_to` names the controlled terms the query was understood as.

    Response size, measured: ~4.8k tokens at limit=10, ~11.8k at limit=25.
    With concise=True, ~0.6k and ~1.4k. Prefer a narrow query over a large
    limit; the ranking puts the best match first, so limit=10 is usually plenty.
    """
    def csv(s: str) -> list[str]:
        return [x.strip() for x in s.split(",") if x.strip()]

    params: dict[str, Any] = {
        "q": query,
        "name_q": name_or_citation,
        "limit": max(1, min(limit, MAX_RESULTS)),
        "offset": max(0, offset),
        "sort": sort,
        "court": csv(court),
        "province": csv(province),
        "practice_area": csv(practice_area),
        "keyword": csv(keyword_ids),
        "level": level or None,
        "language": language or None,
        "date_from": date_from or None,
        "date_to": date_to or None,
    }
    data = await _get("/search", params)
    if isinstance(data, dict) and "error" in data:
        return data

    results = data.get("results") or []
    out = {
        "query": data.get("query"),
        "mode": data.get("mode"),
        "total": data.get("total"),
        "returned": len(results),
        "offset": data.get("offset", 0),
        "expanded_to": [e.get("en") for e in (data.get("expanded_to") or [])],
        "results": [_trim_hit(r, concise) for r in results],
    }
    if data.get("warning"):
        out["warning"] = data["warning"]
    if data.get("total") and len(results) < data["total"]:
        out["note"] = (
            f"Showing {len(results)} of {data['total']} matches. "
            f"Use offset={data.get('offset', 0) + len(results)} for the next page."
        )
    return out


@mcp.tool()
async def get_case(
    case_id: str,
    include_text: bool = False,
    start_char: int = 0,
    max_chars: int = 12_000,
    include_firac: bool = True,
) -> dict[str, Any]:
    """
    Retrieve one decision by case_id (e.g. "UC16", "LC1"), with metadata, parties,
    curated summary, and structured FIRAC analysis.

    FULL TEXT IS OFF BY DEFAULT and windowed when on. These are real judgments —
    the longest in the collection is 1.5 million characters, far beyond any
    context window. Ask for text only when you actually need to read or quote the
    reasons, and page through it with start_char rather than requesting it whole.

    The curated `summary` and `firac` fields are usually enough to understand what
    a case decided, and cost a fraction of the tokens. Try them first.

    When include_text is True the response adds `text` (the window),
    `text_total_chars`, `text_start_char`, `text_end_char` and `text_truncated`.
    If `text_truncated` is True you are holding a FRAGMENT — do not conclude the
    judgment fails to mention something on that basis; page on with
    `text_next_start_char`.

    COST, measured: ~3.6k tokens for metadata + summary + FIRAC with no text.
    Text adds max_chars/4 on top — ~3k at the 12,000 default, ~10k at the 40,000
    ceiling. For scale, LC1's full judgment is 322k characters (~81k tokens) and
    LC66 is 1.5M (~384k), so never ask for a whole one.

    Args:
        case_id: Identifier from search_cases, e.g. "UC16" (upper court) or
            "LC1" (lower court). Not a citation — use search_cases with
            name_or_citation to turn a citation into a case_id.
        include_text: Return a window of the judgment text. Default False.
        start_char: Character offset to start the text window at. Use with
            `text_total_chars` in the response to page through a long judgment.
        max_chars: Size of the text window, capped at 40,000.
        include_firac: Include the structured Facts/Issue/Rule/Application/
            Conclusion breakdown. Default True — it is compact and high value.

    Returns:
        The case record. When include_text is True, adds `text` (the window),
        `text_total_chars`, `text_start_char`, `text_end_char`, and
        `text_truncated` — if `text_truncated` is True you are holding a FRAGMENT,
        so do not conclude the judgment does not mention something on that basis.

    Response size, measured: ~3.6k tokens with metadata, summary and FIRAC and no
    text. Text adds max_chars/4 on top — ~3k at the 12,000 default, ~10k at the
    40,000 ceiling. For reference, LC1's full judgment is 322k characters (~81k
    tokens) and Dieleman is not even the longest; LC66 is 1.5M (~384k).
    """
    data = await _get(
        f"/case/{case_id}",
        {"include_text": include_text, "include_firac": include_firac},
    )
    if isinstance(data, dict) and "error" in data:
        return data

    data.pop("generation_notes", None)      # provenance for curators, not for reasoning

    if not include_text:
        # Belt and braces: never let a judgment through unwindowed just because
        # the API decided to include one.
        data.pop("text", None)
    if include_text:
        full = data.get("text") or ""
        total = len(full)
        window = max(1, min(max_chars, MAX_TEXT_CHARS))
        start = max(0, min(start_char, total))
        end = min(start + window, total)
        data["text"] = full[start:end]
        data["text_total_chars"] = total
        data["text_start_char"] = start
        data["text_end_char"] = end
        data["text_truncated"] = end < total
        if end < total:
            data["text_next_start_char"] = end
    return data


@mcp.tool()
async def list_keywords(area: str = "", min_cases: int = 0) -> dict[str, Any]:
    """
    The controlled vocabulary used to tag every case — 122 curated terms with
    English and French forms, a tier, a subject area, and a case count.

    Call this BEFORE filtering search_cases by keyword_ids. The ids are opaque
    ("K058" is antisemitism) and cannot be guessed; passing an invented id
    silently matches nothing.

    Tiers: 1 = broad practice area, 2 = topic or doctrine, 3 = named entity
    (a group, statute, or institution).

    RETURNS {count, keywords[]}, each with keyword_id, en, fr, tier, area, count.
    `synonyms` is omitted — query expansion happens automatically in search_cases.

    COST, measured: ~4.2k tokens for all 122 terms. Filter by `area` when you only
    need one subject, and call this once per session, not once per search.

    Args:
        area: Case-insensitive substring filter on the subject area, e.g.
            "Family", "Hate speech", "Human rights". Empty returns all.
        min_cases: Only return terms applied to at least this many cases.

    Returns:
        {count, keywords[]} — each with keyword_id, en, fr, tier, area, count.
        `synonyms` is omitted; query expansion is automatic in search_cases.

    Response size, measured: ~4.2k tokens for all 122 terms. Filter by `area`
    when you only need one subject, and call it once per session, not per search.
    """
    data = await _get("/keywords")
    if isinstance(data, dict) and "error" in data:
        return data

    terms = [
        {
            "keyword_id": t.get("keyword_id"),
            "en": t.get("canonical_en"),
            "fr": t.get("canonical_fr"),
            "tier": t.get("tier"),
            "area": t.get("area"),
            "count": t.get("count", 0),
        }
        for t in data
        if (not area or area.lower() in (t.get("area") or "").lower())
        and t.get("count", 0) >= min_cases
    ]
    terms.sort(key=lambda t: (t["area"] or "", -t["count"]))
    return {"count": len(terms), "keywords": terms}


@mcp.tool()
async def dataset_coverage() -> dict[str, Any]:
    """
    What the collection contains: total cases, date range, and the valid values
    for the court, province, and practice_area filters, each with a case count.

    Use this to check scope before answering a question the collection may not
    cover, and to get exact filter values for search_cases — the court codes are
    abbreviations ("ONCA", "QCCS") that must match exactly.

    Returns:
        {description, total_cases, year_min, year_max, courts[], provinces[],
         practice_areas[], languages[], levels[]}
    """
    data = await _get("/facets")
    if isinstance(data, dict) and "error" in data:
        return data
    total = sum(c.get("count", 0) for c in (data.get("courts") or []))
    return {"description": f"JICL — {CORPUS}.", "total_cases": total, **data}


def asgi_app(path: str = "/"):
    """ASGI app for mounting into the existing FastAPI service.

    Lets the MCP server ride the Cloud Run deployment already in place instead of
    becoming a second service. In app.py:

        from mcp_server import asgi_app
        mcp_app = asgi_app()
        app.mount("/mcp", mcp_app)
        app.router.lifespan_context = mcp_app.lifespan   # REQUIRED, see below

    `path="/"` matters: http_app() defaults to serving at "/mcp" *inside* itself,
    so mounting that at "/mcp" yields "/mcp/mcp". Serving at the sub-app root
    puts the endpoint exactly where the mount says.

    The lifespan line is not optional. Mounting attaches routes but does not run
    the sub-app's startup, and FastMCP's session manager is started there — without
    it every request fails once a session is needed.

    The accessor was renamed across FastMCP versions, hence the fallback chain.
    """
    factory = getattr(mcp, "http_app", None)
    if callable(factory):
        return factory(path=path)
    for attr in ("streamable_http_app", "sse_app"):       # older majors
        factory = getattr(mcp, attr, None)
        if callable(factory):
            return factory()
    raise RuntimeError(
        "No ASGI factory on this FastMCP build — checked http_app, "
        "streamable_http_app, sse_app. Check `pip show fastmcp`."
    )


def main() -> None:
    argv = sys.argv[1:]
    transport = "stdio"
    port = 8001
    if "--transport" in argv:
        transport = argv[argv.index("--transport") + 1]
    if "--port" in argv:
        port = int(argv[argv.index("--port") + 1])

    if transport == "stdio":
        # stdout is the MCP channel — anything printed there corrupts the
        # protocol. Diagnostics go to stderr.
        print(f"JICL MCP server (stdio) -> {API_BASE}", file=sys.stderr)
        mcp.run()
    else:
        print(f"JICL MCP server (http) on port {port} -> {API_BASE}", file=sys.stderr)
        mcp.run(transport="http", host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
