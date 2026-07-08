// In-browser keyword / full-text search, served entirely from GitHub Pages.
// Every query is matched against the inverted index (public/data/textindex.json);
// results are filtered by court/date and returned one per case. No embeddings,
// no model download — semantic search was intentionally removed.

import { courtToProvince } from "./viz";
import { parseQuery, booleanCandidates, tokenize, loadTextIndex } from "./textsearch";
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
    indexPromise = (async () => {
      const index: CasesIndex = await fetch(
        `${DATA_BASE}/cases_index.json`,
      ).then((r) => r.json());

      // Optionally merge tags from public/data/case_tags.json (may not exist).
      try {
        const res = await fetch(`${DATA_BASE}/case_tags.json`);
        if (res.ok) {
          const tags: CaseTags = await res.json();
          for (const c of index.cases) {
            const t = tags[String(c.rank)];
            if (t) {
              c.subjects = t.subjects;
              c.court_type = t.court_type;
              c.legal_area = t.legal_area;
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
  if (!matchSingle(courtToProvince(c.court) ?? "Federal", f.provinces, f.provincesMode)) return false;
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
