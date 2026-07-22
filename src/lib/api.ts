// Client for the Cloud Run search service (server/app.py).
//
// The whole point of this module is that `search()` in search.ts keeps its
// signature and return shape, so Search.tsx — filters, sorting, CSV export, map,
// visualizations — is untouched by the move off the in-browser index.
//
// Base URL: VITE_API_BASE. Empty in development, where vite.config.ts proxies
// /api to the local uvicorn; set to the Cloud Run URL for the Pages build.

import { COURT_TYPE_MAP } from "./taxonomy";
import type { CaseMeta, Filters, SearchResult } from "./types";

export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

// Dev goes through the Vite proxy at /api; production hits Cloud Run directly.
const ROOT = API_BASE ? API_BASE.replace(/\/$/, "") : "/api";

// The API is the search backend unless explicitly disabled. Set
// VITE_USE_API=false to fall back to the legacy in-browser index.
export const USE_API: boolean = import.meta.env.VITE_USE_API !== "false";

/** Shape of one row from GET /search. */
export interface ApiCase {
  case_id: string;
  id: string;
  rank: number;
  citation: string | null;
  case_name: string | null;
  court: string | null;
  date: string | null;
  language: string | null;
  url: string | null;
  source: string | null;
  city: string | null;
  province: string | null;
  practice_area: string | null;
  summary: string | null;
  resume: string | null;
  snippet: string;
  excerpt: string;
  level: "upper" | "lower";
  keywords: string[];
  mots_cles: string[];
  keyword_ids: string[];
  relevance: number | null;
}

export interface ApiSearchResponse {
  query: string;
  mode: "browse" | "keyword";
  expanded_to: { keyword_id: string; en: string; fr: string | null }[];
  total: number;
  limit: number;
  offset: number;
  results: ApiCase[];
  warning?: string;
}

export interface ApiFacets {
  courts: { value: string; count: number }[];
  provinces: { value: string; count: number }[];
  practice_areas: { value: string; count: number }[];
  languages: { value: string; count: number }[];
  levels: { value: string; count: number }[];
  year_min: string | null;
  year_max: string | null;
}

export interface ApiKeyword {
  keyword_id: string;
  canonical_en: string;
  canonical_fr: string | null;
  tier: number | null;
  area: string | null;
  count: number;
  synonyms: string[];
}

export interface ApiFirac {
  seq: number;
  issue: string;
  facts: string | null;
  rule: string | null;
  application: string | null;
  conclusion: string | null;
}

export interface ApiCaseDetail extends ApiCase {
  registry: string | null;
  defining_issues: string[];
  text?: string;
  firac: ApiFirac[];
  keywords: never[]; // detail returns objects, not strings — see caseDetail()
}

async function get<T>(path: string, params?: URLSearchParams): Promise<T> {
  const url = `${ROOT}${path}${params && [...params].length ? `?${params}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json() as Promise<T>;
}

// ── Filters → query params ───────────────────────────────────────────────────

// Single-valued fields (court, province, area) keep the old semantics: "any"
// means the value is among those selected; "all" means every selected value
// equals it — which, for a field holding one value, can only be satisfied when
// exactly one is selected. More than one under "all" is unsatisfiable.
function singleValued(
  selected: string[] | undefined,
  mode: Filters["courtsMode"],
): string[] | null | "impossible" {
  if (!selected || !selected.length) return null; // no constraint
  if (mode === "and" && selected.length > 1) return "impossible";
  return selected;
}

/** Court codes belonging to any of the selected court types. */
function codesForCourtTypes(types: string[]): string[] {
  const wanted = new Set(types);
  return Object.entries(COURT_TYPE_MAP)
    .filter(([, t]) => wanted.has(t))
    .map(([code]) => code);
}

/**
 * Build the query string for GET /search.
 *
 * Returns null when the filter combination cannot match anything, so the caller
 * can skip the round trip entirely.
 *
 * court_type has no server-side equivalent (it is a pure function of the court
 * code, defined in taxonomy.ts), so it is resolved here into the set of court
 * codes it covers and intersected with any explicit court selection.
 */
export function filtersToParams(
  query: string,
  filters: Filters,
  opts: { k?: number; offset?: number } = {},
): URLSearchParams | null {
  const p = new URLSearchParams();
  const trimmed = query.trim();
  if (trimmed) p.set("q", trimmed);
  p.set("limit", String(Math.min(opts.k ?? 1000, 1000)));
  if (opts.offset) p.set("offset", String(opts.offset));

  const courts = singleValued(filters.courts, filters.courtsMode);
  const types = singleValued(filters.courtTypes, filters.courtTypesMode);
  if (courts === "impossible" || types === "impossible") return null;

  let allowed: string[] | null = courts;
  if (types) {
    const fromTypes = codesForCourtTypes(types);
    allowed = allowed ? allowed.filter((c) => fromTypes.includes(c)) : fromTypes;
    if (!allowed.length) return null; // e.g. "SCC" ∩ "Tribunal"
  }
  allowed?.forEach((c) => p.append("court", c));

  const provinces = singleValued(filters.provinces, filters.provincesMode);
  if (provinces === "impossible") return null;
  provinces?.forEach((v) => p.append("province", v));

  const areas = singleValued(filters.legalAreas, filters.legalAreasMode);
  if (areas === "impossible") return null;
  areas?.forEach((v) => p.append("practice_area", v));

  // Subjects are the controlled vocabulary: keyword_ids, genuinely multi-valued.
  if (filters.subjects?.length) {
    filters.subjects.forEach((v) => p.append("keyword", v));
    p.set("keyword_mode", filters.subjectsMode === "and" ? "and" : "or");
  }

  if (filters.dateFrom) p.set("date_from", filters.dateFrom);
  if (filters.dateTo) p.set("date_to", filters.dateTo);

  return p;
}

// ── Response → the shape Search.tsx already renders ──────────────────────────

function toResult(r: ApiCase): SearchResult {
  const meta: CaseMeta = {
    rank: r.rank,
    case_id: r.case_id,
    citation: r.citation ?? "",
    case_name: r.case_name ?? "(untitled)",
    court: r.court ?? "",
    date: r.date ?? "",
    snippet: r.snippet ?? "",
    url: r.url ?? undefined,
    city: r.city ?? undefined,
    province: r.province ?? undefined,
    // court_type stays a client-side derivation (taxonomy.ts owns the mapping).
    court_type: COURT_TYPE_MAP[r.court ?? ""],
    legal_area: r.practice_area ?? undefined,
    subjects: r.keywords,
    // Metadata the in-browser index never had:
    practice_area: r.practice_area ?? undefined,
    keywords: r.keywords,
    mots_cles: r.mots_cles,
    keyword_ids: r.keyword_ids,
    summary: r.summary ?? undefined,
    resume: r.resume ?? undefined,
    language: r.language ?? undefined,
    level: r.level,
    relevance: r.relevance ?? undefined,
  };
  return { ...meta, distance: null };
}

// ── Calls ────────────────────────────────────────────────────────────────────

export async function apiSearch(
  query: string,
  filters: Filters = {},
  opts: { k?: number; offset?: number } = {},
): Promise<{ results: SearchResult[]; total: number; expandedTo: string[] }> {
  const params = filtersToParams(query, filters, opts);
  if (!params) return { results: [], total: 0, expandedTo: [] };

  const data = await get<ApiSearchResponse>("/search", params);
  return {
    results: data.results.map(toResult),
    total: data.total,
    expandedTo: data.expanded_to.map((e) => e.en),
  };
}

export function apiFacets(): Promise<ApiFacets> {
  return get<ApiFacets>("/facets");
}

export function apiKeywords(): Promise<ApiKeyword[]> {
  return get<ApiKeyword[]>("/keywords");
}

export async function apiCase(
  caseId: string,
  opts: { includeText?: boolean } = {},
): Promise<ApiCaseDetail> {
  const p = new URLSearchParams();
  if (opts.includeText === false) p.set("include_text", "false");
  return get<ApiCaseDetail>(`/case/${encodeURIComponent(caseId)}`, p);
}
