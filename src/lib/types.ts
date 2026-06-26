// Shared types for the in-browser search layer.

export interface CaseMeta {
  rank: number;
  citation: string;
  case_name: string;
  court: string;
  date: string; // YYYY-MM-DD
  snippet: string;
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

export interface EmbeddingsMeta {
  dims: number;
  count: number;
  scale: number;
  dtype: "int8";
  ranks: number[]; // ranks[i] = case rank for embedding row i
}

export interface Filters {
  court?: string;
  province?: string;
  subjects?: string[]; // match cases tagged with ANY of these
  courtType?: string;
  legalArea?: string;
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
