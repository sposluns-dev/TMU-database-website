// Aggregation for charts — browser equivalent of rag.py's aggregate(), plus a
// court→province mapping so results can drive the Canada choropleth map.

import type { SearchResult } from "./types";

export interface VizDatum {
  name: string;
  count: number;
}

// ── Court code → province (for the Canada map) ────────────────────────────────
// Province names match the TopoJSON feature NAME property in canadaprovtopo.json.
// Federal / national bodies have no province (mapped to null → "Federal" bucket).

const COURT_PROVINCE: Record<string, string | null> = {
  // Provincial / territorial superior & appellate courts
  BCSC: "British Columbia",
  BCCA: "British Columbia",
  ONCA: "Ontario",
  ONSC: "Ontario",
  NSSC: "Nova Scotia",
  NSCA: "Nova Scotia",
  NSPC: "Nova Scotia",
  // Federal courts & tribunals (national)
  SCC: null,
  FC: null,
  FCA: null,
  FCT: null,
  TCC: null,
  CMAC: null,
  CHRT: null,
  FPSLREB: null,
  PSLRB: null,
  RAD: null,
  RPD: null,
  RLLR: null,
  SST: null,
};

export function courtToProvince(court: string): string | null {
  if (court in COURT_PROVINCE) return COURT_PROVINCE[court];
  return null; // unknown → treat as federal/national
}

// ── Generic aggregations ──────────────────────────────────────────────────────

export function byCourt(results: SearchResult[]): VizDatum[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    const key = r.court || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function byYear(results: SearchResult[]): VizDatum[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    const key = r.date && r.date.length >= 4 ? r.date.slice(0, 4) : "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Count by city (from the enriched index). Cases without a city are skipped. */
export function byCity(results: SearchResult[]): VizDatum[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    const city = (r.city ?? "").trim();
    if (!city) continue;
    counts.set(city, (counts.get(city) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** Count by province for the Canada map. Federal cases counted under "Federal". */
export function byProvince(results: SearchResult[]): VizDatum[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    const prov = courtToProvince(r.court) ?? "Federal";
    counts.set(prov, (counts.get(prov) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** Province → count lookup (only real provinces; excludes Federal). */
export function provinceCounts(results: SearchResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of results) {
    const prov = courtToProvince(r.court);
    if (prov) counts.set(prov, (counts.get(prov) ?? 0) + 1);
  }
  return counts;
}

export type VizDimension = "court" | "year" | "province";

export function aggregate(
  results: SearchResult[],
  dimension: VizDimension,
): VizDatum[] {
  if (dimension === "court") return byCourt(results);
  if (dimension === "year") return byYear(results);
  return byProvince(results);
}
