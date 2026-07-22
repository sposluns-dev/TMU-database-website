// In-browser keyword / full-text search, served entirely from GitHub Pages.
// Every query is matched against the inverted index (public/data/textindex.json);
// results are filtered by court/date and returned one per case. No embeddings,
// no model download — semantic search was intentionally removed.

import { parseQuery, booleanCandidates, tokenize, loadTextIndex } from "./textsearch";
import { courtType } from "./taxonomy";
import { USE_API, apiFacets, apiSearch } from "./api";
import type {
  CaseMeta,
  CasesIndex,
  CaseTags,
  Filters,
  SearchResult,
} from "./types";

const DATA_BASE = `${import.meta.env.BASE_URL}data`;

// ── Lazy-loaded singletons ────────────────────────────────────────────────────

let indexPromise: Promise<CasesIndex> | null = null;

export function loadIndex(): Promise<CasesIndex> {
  if (!indexPromise) {
    // API mode: the facets come from the server and NOTHING is held client-side.
    // `cases` stays empty — that is the whole point of moving off the 3.2 MB
    // in-browser index — so anything deriving options from it must read
    // `facets` instead.
    if (USE_API) {
      indexPromise = apiFacets().then((f) => ({
        cases: [],
        facets: {
          courts: f.courts.map((c) => c.value),
          provinces: f.provinces.map((p) => p.value),
          practiceAreas: f.practice_areas.map((a) => a.value),
          year_min: f.year_min ?? "",
          year_max: f.year_max ?? "",
          counts: Object.fromEntries(
            [...f.courts, ...f.provinces, ...f.practice_areas].map((x) => [
              x.value,
              x.count,
            ]),
          ),
          total: f.courts.reduce((n, c) => n + c.count, 0),
        },
      }));
      return indexPromise;
    }
    indexPromise = (async () => {
      const index: CasesIndex = await fetch(
        `${DATA_BASE}/cases_index.json`,
      ).then((r) => r.json());

      // court_type is a deterministic function of the court code (no tagging
      // needed) — derive it up front so the court-type filter works standalone.
      for (const c of index.cases) {
        c.court_type = courtType(c.court);
      }

      // Optionally merge tags from public/data/case_tags.json (may not exist).
      try {
        const res = await fetch(`${DATA_BASE}/case_tags.json`);
        if (res.ok) {
          const tags: CaseTags = await res.json();
          for (const c of index.cases) {
            const t = tags[String(c.rank)];
            if (t) {
              c.subjects = t.subjects;
              c.legal_area = t.legal_area;
              // court_type is code-derived above; tags don't override it.
            }
          }
        }
      } catch {
        /* no tags file yet — filters simply match nothing */
      }
      return index;
    })();
  }
  return indexPromise;
}

/** Preload the text index (call when the user focuses the search box). */
export function warmSearch() {
  if (USE_API) return; // nothing to warm — the index lives on the server
  loadTextIndex();
}

// ── Filtering ─────────────────────────────────────────────────────────────────

// Single-valued field (court, province, court type, area of law): the case has
// one value. OR = value is among the selected; AND = every selected equals it
// (so AND only matches when exactly that one value is selected).
function matchSingle(
  value: string | undefined,
  selected: string[] | undefined,
  mode: Filters["courtsMode"],
): boolean {
  if (!selected || !selected.length) return true;
  const v = value ?? "";
  return mode === "and" ? selected.every((s) => s === v) : selected.includes(v);
}

// Multi-valued field (subjects): the case has a list of tags.
function matchMulti(
  tags: string[] | undefined,
  selected: string[] | undefined,
  mode: Filters["subjectsMode"],
): boolean {
  if (!selected || !selected.length) return true;
  const t = tags ?? [];
  return mode === "and" ? selected.every((s) => t.includes(s)) : selected.some((s) => t.includes(s));
}

function matchesFilters(c: CaseMeta, f: Filters): boolean {
  if (!matchSingle(c.court, f.courts, f.courtsMode)) return false;
  if (!matchSingle(c.province, f.provinces, f.provincesMode)) return false;
  if (!matchSingle(c.court_type, f.courtTypes, f.courtTypesMode)) return false;
  if (!matchSingle(c.legal_area, f.legalAreas, f.legalAreasMode)) return false;
  if (!matchMulti(c.subjects, f.subjects, f.subjectsMode)) return false;
  if (f.dateFrom && c.date < f.dateFrom) return false;
  if (f.dateTo && c.date > f.dateTo) return false;
  return true;
}

// ── Keyword / filter-only search (no model, instant) ──────────────────────────

export async function keywordSearch(
  query: string,
  filters: Filters = {},
  k = 50,
): Promise<SearchResult[]> {
  const { cases } = await loadIndex();
  const q = query.trim().toLowerCase();
  const out: SearchResult[] = [];
  for (const c of cases) {
    if (!matchesFilters(c, filters)) continue;
    if (
      q &&
      !c.case_name.toLowerCase().includes(q) &&
      !c.citation.toLowerCase().includes(q) &&
      !c.snippet.toLowerCase().includes(q)
    ) {
      continue;
    }
    out.push({ ...c, distance: null });
  }
  return out.slice(0, k);
}

// ── Full-text keyword search (over the inverted index) ────────────────────────

/**
 * Ranks matching the query. A plain query requires every token (AND) over the
 * full decision text; operator queries (quotes / AND·OR·NOT / -exclude / *) use
 * the boolean parser. Returns the matching case ranks.
 */
async function fullTextCandidates(trimmed: string): Promise<Set<number>> {
  const parsed = parseQuery(trimmed);
  if (parsed.hasOperators) return booleanCandidates(parsed);

  // Plain query → treat each token as a required term (AND).
  const tokens = tokenize(trimmed);
  if (!tokens.length) {
    // Nothing indexable (e.g. all stopwords/1-char) → fall back to metadata match.
    return null as unknown as Set<number>;
  }
  return booleanCandidates({
    hasOperators: true,
    requiredGroups: tokens.map((t) => [{ kind: "term", value: t }]),
    excluded: [],
    freeText: trimmed,
    mode: "keyword",
  });
}

// ── Unified entry point ───────────────────────────────────────────────────────

export type SearchMode = "browse" | "keyword";

export interface SearchResponse {
  results: SearchResult[];
  mode: SearchMode;
  /** Matches in the whole corpus, which may exceed `results.length`. API only. */
  total?: number;
  /** Controlled terms the query was understood as, e.g. ["freedom of religion"]. */
  expandedTo?: string[];
  /** Set when the API could not be reached and the request returned nothing. */
  error?: string;
}

/**
 * Keyword-only search:
 *  - empty query → browse (filters only, ordered by curated rank)
 *  - any query   → full-text match over textindex.json, filtered, by curated rank
 */
export async function search(
  query: string,
  filters: Filters = {},
  opts: { k?: number } = {},
): Promise<SearchResponse> {
  const trimmed = query.trim();

  // ── API path ───────────────────────────────────────────────────────────────
  // Ranking is hybrid BM25 (case name + full judgment text) plus a controlled-tag
  // boost, with synonym expansion done server-side — see server/app.py. Results
  // arrive already ordered by relevance; Search.tsx re-sorts only when the user
  // picks a different sort key.
  if (USE_API) {
    try {
      const { results, total, expandedTo } = await apiSearch(query, filters, opts);
      return { results, mode: trimmed ? "keyword" : "browse", total, expandedTo };
    } catch (e) {
      // A cold Cloud Run instance or a network blip should surface as an empty
      // result with a message, not an unhandled rejection in the render tree.
      return {
        results: [],
        mode: trimmed ? "keyword" : "browse",
        total: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // ── Legacy in-browser path (VITE_USE_API=false) ────────────────────────────
  if (!trimmed) {
    const results = await keywordSearch("", filters, opts.k ?? 600);
    return { results, mode: "browse" };
  }

  const candidates = await fullTextCandidates(trimmed);

  // Unindexable query → fall back to substring match on name/citation/snippet.
  if (!candidates) {
    const results = await keywordSearch(trimmed, filters, opts.k ?? 600);
    return { results, mode: "keyword" };
  }

  const { cases } = await loadIndex();
  const results: SearchResult[] = cases
    .filter((c) => candidates.has(c.rank) && matchesFilters(c, filters))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, opts.k ?? 600)
    .map((c) => ({ ...c, distance: null }));
  return { results, mode: "keyword" };
}

// Full decisions are opened as prebuilt static pages (data/cases/<rank>.html),
// linked directly from the results — no per-case JSON fetch needed.
