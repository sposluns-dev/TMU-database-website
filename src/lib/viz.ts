// Aggregation for charts — browser equivalent of rag.py's aggregate(). Province
// and city geography come from each case's enriched `province` / `city` fields
// (see scripts/enrich_index.py), not from court codes.

import type { SearchResult } from "./types";

export interface VizDatum {
  name: string;
  count: number;
}

export interface CityDatum {
  name: string;
  lat: number;
  lon: number;
  count: number;
}

// ── City → coordinates ────────────────────────────────────────────────────────
// Approximate lat/lon for the cities that appear in the dataset, used to plot
// points on the Canada map. Country-scale placement — small offsets are fine.
// Keyed by the exact city string stored in the index.
const CITY_COORDS: Record<string, [number, number]> = {
  Toronto: [43.65, -79.38],
  Vancouver: [49.28, -123.12],
  Ottawa: [45.42, -75.7],
  Montreal: [45.5, -73.57],
  Halifax: [44.65, -63.58],
  Victoria: [48.43, -123.37],
  "North Vancouver": [49.32, -123.07],
  Winnipeg: [49.9, -97.14],
  Quesnel: [52.98, -122.49],
  Calgary: [51.05, -114.07],
  "Quebec City": [46.81, -71.21],
  Edmonton: [53.55, -113.49],
  Langley: [49.1, -122.66],
  Saskatoon: [52.13, -106.67],
  Summerland: [49.6, -119.67],
  Delta: [49.08, -123.06],
  "St. John's": [47.56, -52.71],
  Kingston: [44.23, -76.49],
  Nanaimo: [49.17, -123.94],
  "New Westminster": [49.21, -122.91],
  Surrey: [49.19, -122.85],
  Eckville: [52.35, -114.36],
  Moncton: [46.09, -64.78],
  Sechelt: [49.47, -123.76],
  "100 Mile House": [51.64, -121.3],
  Longueuil: [45.53, -73.52],
  Kelowna: [49.89, -119.5],
  Coquitlam: [49.28, -122.79],
  Warkworth: [44.19, -77.88],
  Wetaskiwin: [52.97, -113.37],
  "Port Alberni": [49.23, -124.8],
  Golden: [51.3, -116.96],
  Agassiz: [49.24, -121.77],
  "West Vancouver": [49.33, -123.16],
  "Cache Creek": [50.81, -121.32],
  Chilliwack: [49.16, -121.95],
  London: [42.98, -81.24],
  "Salmon Arm": [50.7, -119.27],
  "Burns Lake": [54.23, -125.76],
  Fernie: [49.5, -115.06],
  Hamilton: [43.26, -79.87],
  Chambly: [45.44, -73.28],
  Sarnia: [42.97, -82.4],
  Ajax: [43.85, -79.02],
  Campbellford: [44.3, -77.8],
  Vernon: [50.27, -119.27],
  Chase: [50.82, -119.68],
  Langford: [48.45, -123.51],
  Abbotsford: [49.05, -122.33],
  Malakwa: [50.93, -118.81],
  Kamloops: [50.68, -120.34],
  Nelson: [49.49, -117.29],
  Courtenay: [49.69, -124.99],
  Laval: [45.61, -73.71],
  Windsor: [42.3, -83.02],
  Regina: [50.45, -104.62],
};

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

/** Cities with known coordinates, for plotting points on the Canada map. */
export function byCityGeo(results: SearchResult[]): CityDatum[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    const city = (r.city ?? "").trim();
    if (!city || !(city in CITY_COORDS)) continue;
    counts.set(city, (counts.get(city) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => {
      const [lat, lon] = CITY_COORDS[name];
      return { name, lat, lon, count };
    })
    .sort((a, b) => b.count - a.count);
}

/** Province → count lookup for the Canada map (from each case's province field). */
export function provinceCounts(results: SearchResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of results) {
    const prov = (r.province ?? "").trim();
    if (prov) counts.set(prov, (counts.get(prov) ?? 0) + 1);
  }
  return counts;
}
