// Live dataset stats, derived from the search backend's /facets endpoint so the
// figures shown on the Home and Dataset pages track the actual case count and
// update automatically as the database changes. If the API is unreachable the
// fallback below keeps the pages populated with the last-known figures.

import { useEffect, useState } from "react";
import { apiFacets } from "./api";

export interface DbStats {
  total: number; // total cases in the database
  courtCount: number; // distinct courts / tribunals
  jurisdictionCount: number; // distinct provinces / jurisdictions
  yearMin: string;
  yearMax: string;
}

// Shown before /facets resolves, and if the request fails.
const FALLBACK: DbStats = {
  total: 1599,
  courtCount: 58,
  jurisdictionCount: 10,
  yearMin: "1879",
  yearMax: "2026",
};

export async function loadStats(): Promise<DbStats> {
  const f = await apiFacets();
  const total = f.courts.reduce((sum, c) => sum + c.count, 0);
  return {
    total: total || FALLBACK.total,
    courtCount: f.courts.length || FALLBACK.courtCount,
    jurisdictionCount: f.provinces.length || FALLBACK.jurisdictionCount,
    yearMin: f.year_min ?? FALLBACK.yearMin,
    yearMax: f.year_max ?? FALLBACK.yearMax,
  };
}

/** Dataset stats, live from the backend. Returns the fallback until loaded. */
export function useStats(): DbStats {
  const [stats, setStats] = useState<DbStats>(FALLBACK);
  useEffect(() => {
    let alive = true;
    loadStats()
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch(() => {
        /* keep fallback figures */
      });
    return () => {
      alive = false;
    };
  }, []);
  return stats;
}
