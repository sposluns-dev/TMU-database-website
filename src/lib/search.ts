// In-browser search: the TypeScript port of rag.py's retrieve + dedupe_by_case.
// Loads the static data files, runs cosine similarity over int8 vectors, applies
// court/date filters, and collapses chunk hits down to one result per case.

import { embedQuery } from "./embed";
import { courtToProvince } from "./viz";
import { parseQuery, booleanCandidates } from "./textsearch";
import type {
  CaseMeta,
  CasesIndex,
  CaseTags,
  EmbeddingsMeta,
  Filters,
  SearchResult,
} from "./types";

const DATA_BASE = `${import.meta.env.BASE_URL}data`;

// ── Lazy-loaded singletons ────────────────────────────────────────────────────

let indexPromise: Promise<CasesIndex> | null = null;
let vectorsPromise: Promise<{ meta: EmbeddingsMeta; q: Int8Array }> | null = null;

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

function loadVectors() {
  if (!vectorsPromise) {
    vectorsPromise = (async () => {
      const [meta, buf] = await Promise.all([
        fetch(`${DATA_BASE}/embeddings_meta.json`).then((r) => r.json()),
        fetch(`${DATA_BASE}/embeddings.bin`).then((r) => r.arrayBuffer()),
      ]);
      return { meta: meta as EmbeddingsMeta, q: new Int8Array(buf) };
    })();
  }
  return vectorsPromise;
}

/** Preload the heavy assets (call when the user focuses the search box). */
export function warmSemantic() {
  loadVectors();
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function matchesFilters(c: CaseMeta, f: Filters): boolean {
  if (f.court && c.court !== f.court) return false;
  if (f.province && (courtToProvince(c.court) ?? "Federal") !== f.province)
    return false;
  if (f.subject && !(c.subjects ?? []).includes(f.subject)) return false;
  if (f.courtType && c.court_type !== f.courtType) return false;
  if (f.legalArea && c.legal_area !== f.legalArea) return false;
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

// ── Semantic search (cosine over int8 vectors) ────────────────────────────────

export async function semanticSearch(
  query: string,
  filters: Filters = {},
  k = 12,
  allowedRanks?: Set<number>,
): Promise<SearchResult[]> {
  const [{ cases }, { meta, q }, qvec] = await Promise.all([
    loadIndex(),
    loadVectors(),
    embedQuery(query),
  ]);

  const { dims, count, scale, ranks } = meta;
  const byRank = new Map<number, CaseMeta>();
  for (const c of cases) byRank.set(c.rank, c);

  // Which ranks pass the filter? (skip scoring chunks of filtered-out cases)
  // If allowedRanks is given (boolean candidates), intersect with it.
  const allowed = new Set<number>();
  for (const c of cases) {
    if (!matchesFilters(c, filters)) continue;
    if (allowedRanks && !allowedRanks.has(c.rank)) continue;
    allowed.add(c.rank);
  }

  // Best (highest) similarity per case rank.
  const best = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const rank = ranks[i];
    if (!allowed.has(rank)) continue;
    const base = i * dims;
    let dot = 0;
    for (let d = 0; d < dims; d++) {
      dot += (q[base + d] * scale) * qvec[d];
    }
    const prev = best.get(rank);
    if (prev === undefined || dot > prev) best.set(rank, dot);
  }

  const results: SearchResult[] = [];
  for (const [rank, sim] of best) {
    const c = byRank.get(rank);
    if (!c) continue;
    results.push({ ...c, distance: 1 - sim }); // cosine distance
  }
  results.sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1));
  return results.slice(0, k);
}

// ── Unified entry point: auto-detect mode from the query ──────────────────────

export type SearchMode = "browse" | "semantic" | "hybrid" | "keyword";

export interface SearchResponse {
  results: SearchResult[];
  mode: SearchMode;
}

/**
 * Routes the query automatically:
 *  - empty query        → browse (filters only)
 *  - no operators       → semantic (RAG)
 *  - operators present  → boolean filter, then:
 *      · hybrid  — rank survivors by semantic similarity to the free text
 *      · keyword — (no free text) order survivors by curated rank
 */
export async function search(
  query: string,
  filters: Filters = {},
  opts: { k?: number } = {},
): Promise<SearchResponse> {
  const k = opts.k ?? 100;
  const trimmed = query.trim();

  if (!trimmed) {
    const results = await keywordSearch("", filters, opts.k ?? 600);
    return { results, mode: "browse" };
  }

  const parsed = parseQuery(trimmed);

  if (!parsed.hasOperators) {
    const results = await semanticSearch(trimmed, filters, k);
    return { results, mode: "semantic" };
  }

  // Operators present → boolean candidate set.
  const candidates = await booleanCandidates(parsed);

  if (parsed.mode === "hybrid" && parsed.freeText) {
    const results = await semanticSearch(parsed.freeText, filters, k, candidates);
    return { results, mode: "hybrid" };
  }

  // Pure keyword: build results from the index, ordered by curated rank.
  const { cases } = await loadIndex();
  const results: SearchResult[] = cases
    .filter((c) => candidates.has(c.rank) && matchesFilters(c, filters))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, opts.k ?? 600)
    .map((c) => ({ ...c, distance: null }));
  return { results, mode: "keyword" };
}

// ── Full-text loader (lazy, per case) ─────────────────────────────────────────

const caseCache = new Map<number, Promise<unknown>>();

export function getCase(rank: number) {
  if (!caseCache.has(rank)) {
    caseCache.set(
      rank,
      fetch(`${DATA_BASE}/cases/${rank}.json`).then((r) => r.json()),
    );
  }
  return caseCache.get(rank)!;
}
