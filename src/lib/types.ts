// Shared types for the in-browser search layer.

export interface CaseMeta {
  rank: number;
  citation: string;
  case_name: string;
  court: string;
  date: string; // YYYY-MM-DD
  snippet: string;
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
