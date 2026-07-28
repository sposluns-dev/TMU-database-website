// Shared types for the in-browser search layer.

export interface CaseMeta {
  rank: number; // POSITIONAL when served by the API — use case_id as the key
  citation: string;
  case_name: string;
  court: string;
  date: string; // YYYY-MM-DD
  snippet: string;
  // Merged from cases/upper via scripts/enrich_index.py (where available):
  url?: string; // CanLII URL
  city?: string;
  province?: string;
  // Optional tags merged from public/data/case_tags.json (added later):
  subjects?: string[];
  court_type?: string;
  legal_area?: string;

  // ── Served by the API (server/app.py); absent on the legacy static index ──
  case_id?: string; // "UC13" / "LC1" — the real, stable identifier
  practice_area?: string; // the single primary tier-1 area
  keywords?: string[]; // controlled vocabulary, English canonical
  mots_cles?: string[]; // the same terms in French
  keyword_ids?: string[]; // ["K003","K025"] — what the keyword filter matches on
  summary?: string; // AI-generated (English)
  resume?: string; // AI-generated (French)
  language?: string; // 'en' | 'fr'
  level?: "upper" | "lower";
  relevance?: number; // hybrid BM25 + tag-boost score
}

// Shape of the optional public/data/case_tags.json file (rank → tags).
export interface CaseTags {
  [rank: string]: {
    subjects?: string[];
    court_type?: string;
    legal_area?: string;
  };
}

export interface CasesIndex {
  // Empty when the API backs the search — nothing is held client-side any more.
  cases: CaseMeta[];
  facets: {
    courts: string[];
    year_min: string;
    year_max: string;
    // Served by GET /facets; the legacy path derives provinces from `cases`.
    provinces?: string[];
    practiceAreas?: string[];
    counts?: Record<string, number>; // facet value -> number of cases
    total?: number;
  };
}

export type MatchMode = "and" | "or"; // require ALL vs ANY of the selected values

export interface Filters {
  courts?: string[];
  courtsMode?: MatchMode;
  provinces?: string[];
  provincesMode?: MatchMode;
  subjects?: string[];
  subjectsMode?: MatchMode;
  /**
   * Keyword groups: OR *within* each group, AND *across* groups — "a
   * hate-speech case that is also a family-law case". `subjects` above is a
   * single flat list and so can only express all-of or any-of; it stays
   * populated (as the union) for the legacy in-browser index, which has no
   * grouped equivalent. When this is set, the API path uses it instead.
   */
  subjectGroups?: string[][];
  courtTypes?: string[];
  courtTypesMode?: MatchMode;
  legalAreas?: string[];
  legalAreasMode?: MatchMode;
  dateFrom?: string; // YYYY-MM-DD
  dateTo?: string;
  /**
   * Case name / citation lookup, kept separate from the free-text query: it
   * searches the short identifying fields rather than the judgment body, and
   * `citation` is not in the FTS index at all. Every token must appear
   * somewhere in name+citation; matching is substring, case- and
   * accent-insensitive, so "quebec" finds "Québec".
   */
  nameQuery?: string;
}

export interface SearchResult extends CaseMeta {
  distance: number | null; // cosine distance (1 - sim); null for filter-only
}

export interface FullCase {
  rank: number;
  citation: string;
  case_name: string;
  court: string;
  date: string;
  text: string;
}

// One analysed legal issue. A case has 1–8, ordered by seq. Served by
// GET /case/{id}; never present on the legacy static index.
export interface Firac {
  seq: number;
  issue: string;
  facts: string | null;
  rule: string | null;
  application: string | null;
  conclusion: string | null;
}
