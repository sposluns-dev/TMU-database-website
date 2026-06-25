// SATL/Uwazi-style faceted search page.
// Left sidebar: filters (Court, Year range) + search mode + sort.
// Main: search bar, result count, result cards, Export CSV, Visualize toggle.
//
// Data + search logic live in src/lib/*. Visualize is lazy-loaded so Observable
// Plot + d3 only download when the user opens the charts.

import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { search, loadIndex, warmSemantic } from "../lib/search";
import { downloadCsv } from "../lib/export";
import type { CasesIndex, Filters, SearchResult } from "../lib/types";
import "../styles/components/search.css";

const Visualize = lazy(() =>
  import("./Visualize").then((m) => ({ default: m.Visualize })),
);

type SortKey = "relevance" | "date_desc" | "date_asc";

export function Search() {
  const [index, setIndex] = useState<CasesIndex | null>(null);
  const [query, setQuery] = useState("");
  const [semantic, setSemantic] = useState(true);
  const [court, setCourt] = useState<string>("");
  const [yearFrom, setYearFrom] = useState<string>("");
  const [yearTo, setYearTo] = useState<string>("");
  const [sort, setSort] = useState<SortKey>("relevance");

  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [showViz, setShowViz] = useState(false);

  useEffect(() => {
    loadIndex().then(setIndex);
  }, []);

  const filters: Filters = useMemo(
    () => ({
      court: court || undefined,
      dateFrom: yearFrom ? `${yearFrom}-01-01` : undefined,
      dateTo: yearTo ? `${yearTo}-12-31` : undefined,
    }),
    [court, yearFrom, yearTo],
  );

  async function runSearch() {
    setLoading(true);
    try {
      const r = await search(query, filters, {
        semantic: semantic && Boolean(query.trim()),
        k: semantic && query.trim() ? 50 : 500,
      });
      setResults(r);
    } finally {
      setLoading(false);
    }
  }

  // Auto-run on filter change (browse) and initial load.
  useEffect(() => {
    if (index) runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, court, yearFrom, yearTo]);

  const sorted = useMemo(() => {
    const list = [...results];
    if (sort === "date_desc") list.sort((a, b) => b.date.localeCompare(a.date));
    else if (sort === "date_asc") list.sort((a, b) => a.date.localeCompare(b.date));
    // "relevance" keeps the order returned by search()
    return list;
  }, [results, sort]);

  const courts = index?.facets.courts ?? [];
  const yearMin = index?.facets.year_min ?? "";
  const yearMax = index?.facets.year_max ?? "";

  return (
    <div className="search-page">
      {/* ── Filter sidebar ─────────────────────────────────────────── */}
      <aside className="search-sidebar">
        <h2 className="filter-heading">Filters</h2>

        <div className="filter-group">
          <label className="filter-label">Court / Tribunal</label>
          <select value={court} onChange={(e) => setCourt(e.target.value)}>
            <option value="">All courts</option>
            {courts.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label className="filter-label">Year range</label>
          <div className="filter-row">
            <input
              type="number"
              placeholder={yearMin}
              min={yearMin}
              max={yearMax}
              value={yearFrom}
              onChange={(e) => setYearFrom(e.target.value)}
            />
            <span>–</span>
            <input
              type="number"
              placeholder={yearMax}
              min={yearMin}
              max={yearMax}
              value={yearTo}
              onChange={(e) => setYearTo(e.target.value)}
            />
          </div>
        </div>

        <div className="filter-group">
          <label className="filter-label">Search mode</label>
          <label className="filter-check">
            <input
              type="checkbox"
              checked={semantic}
              onChange={(e) => setSemantic(e.target.checked)}
            />
            Semantic (AI) search
          </label>
          <p className="filter-hint">
            {semantic
              ? "Meaning-based. Loads a small model on first use."
              : "Keyword match on name, citation, snippet."}
          </p>
        </div>

        <button
          className="filter-clear"
          onClick={() => {
            setCourt("");
            setYearFrom("");
            setYearTo("");
          }}
        >
          Clear filters
        </button>
      </aside>

      {/* ── Main column ────────────────────────────────────────────── */}
      <main className="search-main">
        <div className="search-bar">
          <input
            type="text"
            placeholder="Search cases (e.g. internet hate speech, religious freedom)…"
            value={query}
            onFocus={warmSemantic}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
          />
          <button onClick={runSearch} disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </div>

        <div className="search-toolbar">
          <span className="result-count">
            {loading ? "…" : `${sorted.length} result${sorted.length === 1 ? "" : "s"}`}
          </span>
          <div className="toolbar-actions">
            <label>
              Sort:{" "}
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                <option value="relevance">Relevance</option>
                <option value="date_desc">Newest</option>
                <option value="date_asc">Oldest</option>
              </select>
            </label>
            <button onClick={() => downloadCsv(sorted)} disabled={!sorted.length}>
              Export CSV
            </button>
            <button onClick={() => setShowViz((v) => !v)} disabled={!sorted.length}>
              {showViz ? "Hide charts" : "Visualize"}
            </button>
          </div>
        </div>

        {showViz && sorted.length > 0 && (
          <div className="search-viz">
            <Suspense fallback={<p>Loading charts…</p>}>
              <Visualize results={sorted} />
            </Suspense>
          </div>
        )}

        <ul className="result-list">
          {sorted.map((r) => (
            <li key={r.rank} className="result-card">
              <div className="result-head">
                <span className="result-citation">{r.citation}</span>
                <span className="result-court">{r.court}</span>
              </div>
              <h3 className="result-name">{r.case_name}</h3>
              <div className="result-meta">
                <span>{r.date}</span>
                {r.distance != null && (
                  <span className="result-score">
                    score {(1 - r.distance).toFixed(2)}
                  </span>
                )}
              </div>
              {r.snippet && <p className="result-snippet">{r.snippet}…</p>}
            </li>
          ))}
        </ul>

        {!loading && sorted.length === 0 && (
          <p className="no-results">No cases match your search and filters.</p>
        )}
      </main>
    </div>
  );
}
