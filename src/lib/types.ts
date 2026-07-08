// Shared types for the in-browser search layer.

export interface CaseMeta {
  rank: number;
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
  cases: CaseMeta[];
  facets: {
    courts: string[];
    year_min: string;
    year_max: string;
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
  courtTypes?: string[];
  courtTypesMode?: MatchMode;
  legalAreas?: string[];
  legalAreasMode?: MatchMode;
  dateFrom?: string; // YYYY-MM-DD
  dateTo?: string;
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
