// In-browser search: the TypeScript port of rag.py's retrieve + dedupe_by_case.
// Loads the static data files, runs cosine similarity over int8 vectors, applies
// court/date filters, and collapses chunk hits down to one result per case.

import { embedQuery } from "./embed";
import type {
  CaseMeta,
  CasesIndex,
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
    indexPromise = fetch(`${DATA_BASE}/cases_index.json`).then((r) => r.json());
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
  const allowed = new Set<number>();
  for (const c of cases) if (matchesFilters(c, filters)) allowed.add(c.rank);

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

// ── Unified entry point used by the UI ────────────────────────────────────────

export async function search(
  query: string,
  filters: Filters = {},
  opts: { semantic?: boolean; k?: number } = {},
): Promise<SearchResult[]> {
  const semantic = opts.semantic ?? Boolean(query.trim());
  if (semantic && query.trim()) {
    return semanticSearch(query, filters, opts.k ?? 12);
  }
  return keywordSearch(query, filters, opts.k ?? 50);
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
