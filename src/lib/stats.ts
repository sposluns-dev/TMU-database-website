// Live dataset stats, derived from the search backend's /facets endpoint so the
// figures shown on the Home and Dataset pages track the actual case count and
// update automatically as the database changes. Nothing is shown until the count
// is calculated: useStats() returns null while the request is in flight (and if
// it fails), so callers render a placeholder rather than a possibly-wrong number.

import { useEffect, useState } from "react";
import { apiFacets } from "./api";

export interface DbStats {
  total: number; // total cases in the database
  courtCount: number; // distinct courts / tribunals
  jurisdictionCount: number; // distinct provinces / jurisdictions
  yearMin: string;
  yearMax: string;
}

export async function loadStats(): Promise<DbStats> {
  const f = await apiFacets();
  const total = f.courts.reduce((sum, c) => sum + c.count, 0);
  return {
    total,
    courtCount: f.courts.length,
    jurisdictionCount: f.provinces.length,
    yearMin: f.year_min ?? "",
    yearMax: f.year_max ?? "",
  };
}

/** Dataset stats, live from the backend. Returns null until calculated. */
export function useStats(): DbStats | null {
  const [stats, setStats] = useState<DbStats | null>(null);
  useEffect(() => {
    let alive = true;
    loadStats()
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch(() => {
        /* leave null — callers show a placeholder */
      });
    return () => {
      alive = false;
    };
  }, []);
  return stats;
}
