// SATL/Uwazi-style faceted search page.
// Sidebar filters: Court, Province, Subject, Court type, Area of law, Year range,
// search mode. Main: search bar + tips, toolbar (count, sort, per-page, export,
// view toggle), and Cards / Table / Map views.
//
// Subject / court-type / area-of-law options come from src/lib/taxonomy.ts and
// match against tags merged from public/data/case_tags.json (added later).

import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { search, loadIndex, warmSearch, type SearchMode } from "../lib/search";
import { downloadCsv } from "../lib/export";
import { COURT_TYPES, courtLabel } from "../lib/taxonomy";
import { USE_API, apiKeywords } from "../lib/api";
import { MultiFilter } from "./MultiFilter";
import { CaseDetail } from "./CaseDetail";
import type { CasesIndex, Filters, MatchMode, SearchResult } from "../lib/types";
import "../styles/components/search.css";

// Stable identity for a result. The API returns the real case_id ("UC13"); the
// legacy static index only has a positional rank, so fall back to it.
const idOf = (r: SearchResult) => r.case_id ?? String(r.rank);

// The API returns FTS snippets with <mark> around the matched terms. React
// escapes strings, so render the highlight explicitly rather than showing
// literal "<mark>" to the user. Only <mark> is honoured — everything else is
// escaped, so judgment text can never inject markup.
function Snippet({ html }: { html: string }) {
  const parts = html.split(/(<\/?mark>)/);
  let on = false;
  return (
    <p className="result-snippet">
      {parts.map((p, i) => {
        if (p === "<mark>") { on = true; return null; }
        if (p === "</mark>") { on = false; return null; }
        return on ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>;
      })}
    </p>
  );
}

const MODE_LABEL: Record<SearchMode, string> = {
  browse: "Browsing all cases",
  keyword: "Keyword search",
};

// Toggle a value in/out of a string[] (for the multi-select filters).
const toggle = (arr: string[], v: string) =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

const Visualize = lazy(() =>
  import("./Visualize").then((m) => ({ default: m.Visualize })),
);

type SortKey = "relevance" | "date_desc" | "date_asc" | "title";
type View = "cards" | "table";

export function Search() {
  const [index, setIndex] = useState<CasesIndex | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("browse");

  // Multi-select facet filters (selected values + Any/All match mode).
  const [courtSel, setCourtSel] = useState<string[]>([]);
  const [courtMode, setCourtMode] = useState<MatchMode>("or");
  const [provinceSel, setProvinceSel] = useState<string[]>([]);
  const [provinceMode, setProvinceMode] = useState<MatchMode>("or");
  const [courtTypeSel, setCourtTypeSel] = useState<string[]>([]);
  const [courtTypeMode, setCourtTypeMode] = useState<MatchMode>("or");
  // Topic / entity dropdowns: the keyword vocabulary grouped by its `area`.
  // Selecting an area filters to cases carrying any keyword in that area.
  const [kwAreas, setKwAreas] = useState<{
    topic: string[];
    entity: string[];
    byArea: Record<string, string[]>; // area -> keyword_ids
  }>({ topic: [], entity: [], byArea: {} });
  const [topicArea, setTopicArea] = useState("");
  const [entityArea, setEntityArea] = useState("");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  // Cases the user has ticked for export / visualization (by case id).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Case whose detail drawer is open, if any (with an optional section to focus).
  const [openCase, setOpenCase] = useState<{ id: string; focus?: "notes" } | null>(null);
  const openDetail = (id: string, focus?: "notes") => setOpenCase({ id, focus });

  const [sort, setSort] = useState<SortKey>("relevance");
  const [perPage, setPerPage] = useState(30);
  const [view, setView] = useState<View>("cards");
  const [showViz, setShowViz] = useState(false);
  const [showTips, setShowTips] = useState(false);

  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  // Matches in the whole corpus — may exceed results.length, which is capped.
  const [total, setTotal] = useState<number | null>(null);
  // Controlled terms the backend understood the query as.
  const [expandedTo, setExpandedTo] = useState<string[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    loadIndex().then(setIndex);
  }, []);

  // The controlled vocabulary, grouped by `area`, drives the two dropdowns.
  // Only available in API mode (/keywords); the legacy static index has none.
  useEffect(() => {
    if (!USE_API) return;
    apiKeywords()
      .then((ks) => {
        const byArea: Record<string, string[]> = {};
        for (const k of ks) {
          const a = (k.area ?? "").trim();
          if (!a || a === "Practice Area (Tier 1)") continue;
          (byArea[a] ??= []).push(k.keyword_id);
        }
        const areas = Object.keys(byArea);
        setKwAreas({
          topic: areas.filter((a) => !a.startsWith("Entities")).sort(),
          entity: areas.filter((a) => a.startsWith("Entities")).sort(),
          byArea,
        });
      })
      .catch(() => {/* dropdowns stay empty if /keywords is unreachable */});
  }, []);

  // Selected areas -> the keyword_ids they contain (the `subjects` filter, OR'd).
  const subjectIds = useMemo(() => [
    ...(topicArea ? kwAreas.byArea[topicArea] ?? [] : []),
    ...(entityArea ? kwAreas.byArea[entityArea] ?? [] : []),
  ], [topicArea, entityArea, kwAreas]);

  const filters: Filters = useMemo(
    () => ({
      courts: courtSel.length ? courtSel : undefined,
      courtsMode: courtSel.length ? courtMode : undefined,
      provinces: provinceSel.length ? provinceSel : undefined,
      provincesMode: provinceSel.length ? provinceMode : undefined,
      courtTypes: courtTypeSel.length ? courtTypeSel : undefined,
      courtTypesMode: courtTypeSel.length ? courtTypeMode : undefined,
      subjects: subjectIds.length ? subjectIds : undefined,
      subjectsMode: subjectIds.length ? "or" : undefined,
      dateFrom: yearFrom ? `${yearFrom}-01-01` : undefined,
      dateTo: yearTo ? `${yearTo}-12-31` : undefined,
    }),
    [courtSel, courtMode, provinceSel, provinceMode,
     courtTypeSel, courtTypeMode, subjectIds, yearFrom, yearTo],
  );

  async function runSearch() {
    setLoading(true);
    try {
      // Fetch all matches; the "Show" dropdown (perPage) controls how many display.
      const { results: r, mode: m, total: t, expandedTo: x, error } =
        await search(query, filters, { k: 1000 });
      setResults(r);
      setMode(m);
      setTotal(t ?? null);
      setExpandedTo(x ?? []);
      setSearchError(error ?? null);
    } finally {
      setLoading(false);
    }
  }

  // Re-run on any filter change (and initial load).
  useEffect(() => {
    if (index) runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, courtSel, courtMode, provinceSel, provinceMode,
      courtTypeSel, courtTypeMode, topicArea, entityArea, yearFrom, yearTo]);

  const sorted = useMemo(() => {
    const list = [...results];
    if (sort === "date_desc") list.sort((a, b) => b.date.localeCompare(a.date));
    else if (sort === "date_asc") list.sort((a, b) => a.date.localeCompare(b.date));
    else if (sort === "title") list.sort((a, b) => a.case_name.localeCompare(b.case_name));
    return list;
  }, [results, sort]);

  const shown = useMemo(() => sorted.slice(0, perPage), [sorted, perPage]);

  // Selection: export / visualize the ticked cases, or all results if none ticked.
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(idOf(r)));
  const toggleSelectShown = () =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (allShownSelected) shown.forEach((r) => n.delete(idOf(r)));
      else shown.forEach((r) => n.add(idOf(r)));
      return n;
    });
  const chosen = useMemo(
    () => (selected.size ? sorted.filter((r) => selected.has(idOf(r))) : sorted),
    [selected, sorted],
  );

  const courts = index?.facets.courts ?? [];
  const yearMin = index?.facets.year_min ?? "";
  const yearMax = index?.facets.year_max ?? "";

  // Provinces present in the dataset (from each case's province field).
  // API mode serves these from /facets; the legacy path derives them from the
  // downloaded index (where `cases` is populated).
  const provinces = useMemo(() => {
    if (index?.facets.provinces?.length) return index.facets.provinces;
    const set = new Set<string>();
    for (const c of index?.cases ?? []) {
      if (c.province) set.add(c.province);
    }
    return [...set].sort();
  }, [index]);

  function clearFilters() {
    setCourtSel([]); setCourtMode("or");
    setProvinceSel([]); setProvinceMode("or");
    setCourtTypeSel([]); setCourtTypeMode("or");
    setTopicArea(""); setEntityArea("");
    setYearFrom("");
    setYearTo("");
  }

  return (
    <div className="search-page">
      {/* ── Filter sidebar ─────────────────────────────────────────── */}
      <aside className="search-sidebar">
        <h2 className="filter-heading">Filters</h2>

        <MultiFilter
          label="Court / Tribunal"
          options={courts.map((c) => ({ value: c, label: courtLabel(c) }))}
          selected={courtSel}
          onToggle={(v) => setCourtSel((a) => toggle(a, v))}
          mode={courtMode}
          onMode={setCourtMode}
        />

        <MultiFilter
          label="Province"
          options={provinces.map((p) => ({ value: p, label: p }))}
          selected={provinceSel}
          onToggle={(v) => setProvinceSel((a) => toggle(a, v))}
          mode={provinceMode}
          onMode={setProvinceMode}
        />

        <MultiFilter
          label="Court type"
          options={COURT_TYPES.map((t) => ({ value: t, label: t }))}
          selected={courtTypeSel}
          onToggle={(v) => setCourtTypeSel((a) => toggle(a, v))}
          mode={courtTypeMode}
          onMode={setCourtTypeMode}
        />

        <div className="filter-group">
          <label className="filter-label" htmlFor="topic-select">Practice area / topic</label>
          <select
            id="topic-select"
            value={topicArea}
            onChange={(e) => setTopicArea(e.target.value)}
          >
            <option value="">All topics</option>
            {kwAreas.topic.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label className="filter-label" htmlFor="entity-select">Entities</label>
          <select
            id="entity-select"
            value={entityArea}
            onChange={(e) => setEntityArea(e.target.value)}
          >
            <option value="">All entities</option>
            {kwAreas.entity.map((a) => (
              <option key={a} value={a}>{a.replace(/^Entities — /, "")}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label className="filter-label">Year range</label>
          <div className="filter-row">
            <input
              type="number" placeholder={yearMin} min={yearMin} max={yearMax}
              value={yearFrom} onChange={(e) => setYearFrom(e.target.value)}
            />
            <span>–</span>
            <input
              type="number" placeholder={yearMax} min={yearMin} max={yearMax}
              value={yearTo} onChange={(e) => setYearTo(e.target.value)}
            />
          </div>
        </div>

        <button className="filter-clear" onClick={clearFilters}>
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
            onFocus={warmSearch}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
          />
          <button onClick={runSearch} disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </div>

        <div className="search-modebar">
          <button className="tips-toggle" onClick={() => setShowTips((v) => !v)}>
            {showTips ? "Hide search tips" : "Search tips"}
          </button>
          <span className={`mode-pill mode-${mode}`}>{MODE_LABEL[mode]}</span>
        </div>
        {showTips && (
          <div className="search-tips">
            <p>
              We run a <strong>keyword search</strong> over the full text of every
              decision. Plain terms must all appear; add operators to refine:
            </p>
            <ul>
              <li><code>"section 13"</code> — exact phrase (use quotes)</li>
              <li><code>internet AND hatred</code> — both terms must appear</li>
              <li><code>hate OR discrimination</code> — either term</li>
              <li><code>charter NOT immigration</code> or <code>charter -immigration</code> — exclude a term</li>
              <li><code>discriminat*</code> — wildcard (discriminate, discrimination…)</li>
              <li>Mix them: <code>"freedom of religion" school</code> — must contain the phrase and <em>school</em>.</li>
            </ul>
            <p>
              Combine with sidebar <strong>filters</strong>, open
              <strong> Visualizations</strong> for charts and a Canada map, or
              <strong> Open full case ↗</strong> to read a decision.
            </p>
          </div>
        )}

        {searchError && (
          <p className="search-error">
            Could not reach the search service — {searchError}
          </p>
        )}

        {/* Make the query expansion visible: the user typed "religious freedom"
            and the backend searched the whole "freedom of religion" ring. */}
        {expandedTo.length > 0 && (
          <p className="search-expanded">
            Understood as:{" "}
            {expandedTo.map((t) => (
              <span key={t} className="expanded-term">{t}</span>
            ))}
          </p>
        )}

        <div className="search-toolbar">
          <span className="result-count">
            {loading
              ? "…"
              : // `total` is the match count across the whole corpus; `sorted`
                // is capped at k, so say so rather than under-reporting.
                `${shown.length} shown of ${(total ?? sorted.length).toLocaleString()} result${
                  (total ?? sorted.length) === 1 ? "" : "s"
                }${total != null && total > sorted.length ? ` (top ${sorted.length} ranked)` : ""}`}
            {selected.size > 0 && ` · ${selected.size} selected`}
          </span>
          <div className="toolbar-actions">
            <label title="Tick the visible cases for export / visualization">
              <input type="checkbox" checked={allShownSelected} onChange={toggleSelectShown} />{" "}
              Select shown
            </label>
            {selected.size > 0 && (
              <button type="button" onClick={() => setSelected(new Set())}>
                Clear ({selected.size})
              </button>
            )}
            <label>
              Sort:{" "}
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                <option value="relevance">Relevance</option>
                <option value="title">Title (A–Z)</option>
                <option value="date_desc">Newest</option>
                <option value="date_asc">Oldest</option>
              </select>
            </label>
            <label>
              Show:{" "}
              <select value={perPage} onChange={(e) => setPerPage(Number(e.target.value))}>
                <option value={30}>30</option>
                <option value={100}>100</option>
                <option value={300}>300</option>
                <option value={9999}>All</option>
              </select>
            </label>
            <div className="view-toggle">
              {(["cards", "table"] as View[]).map((v) => (
                <button
                  key={v}
                  className={view === v ? "active" : ""}
                  onClick={() => setView(v)}
                >
                  {v[0].toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
            <button
              className={showViz ? "viz-btn active" : "viz-btn"}
              onClick={() => setShowViz((v) => !v)}
              disabled={!sorted.length}
            >
              {showViz
                ? "Hide visualizations"
                : `Visualize${selected.size ? ` (${selected.size})` : ""}`}
            </button>
            <button onClick={() => downloadCsv(chosen)} disabled={!chosen.length}>
              Export CSV{selected.size ? ` (${selected.size})` : ""}
            </button>
          </div>
        </div>

        {/* ── Visualizations panel (toggled, above results) ──────── */}
        {showViz && chosen.length > 0 && (
          <div className="search-viz">
            <Suspense fallback={<p>Loading charts…</p>}>
              <Visualize results={chosen} />
            </Suspense>
          </div>
        )}

        {/* ── Results ────────────────────────────────────────────── */}
        {view === "cards" && (
          <ul className="result-list">
            {shown.map((r) => {
              const id = idOf(r);
              // The practice area is also present in `keywords` (it is the
              // tier-1 term). Show it once, as its own pill.
              const topics = (r.keywords ?? r.subjects ?? []).filter(
                (k) => k !== r.practice_area,
              );
              const place = [r.city, r.province].filter(Boolean).join(", ");
              return (
              <li key={id} className={`result-card${selected.has(id) ? " selected" : ""}`}>
                <div className="result-head">
                  <label className="result-select" title="Select for export / visualization">
                    <input
                      type="checkbox"
                      checked={selected.has(id)}
                      onChange={() => toggleSelected(id)}
                    />
                  </label>
                  <span className="result-citation">{r.citation}</span>
                  <span className="result-court">{r.court}</span>
                </div>
                <h3 className="result-name">{r.case_name}</h3>
                <div className="result-meta">
                  <span>{r.date}</span>
                  {place && <span className="result-place">{place}</span>}
                  {r.level && (
                    <span className="result-level">
                      {r.level === "upper" ? "Upper court" : "Lower court"}
                    </span>
                  )}
                  {r.relevance != null && (
                    <span className="result-score" title="Hybrid BM25 + keyword-tag score">
                      score {r.relevance.toFixed(1)}
                    </span>
                  )}
                </div>
                {(topics.length > 0 || r.practice_area || r.legal_area) && (
                  <div className="result-tags">
                    {(r.practice_area ?? r.legal_area) && (
                      <span className="tag tag-area">
                        {r.practice_area ?? r.legal_area}
                      </span>
                    )}
                    {topics.map((s, i) => (
                      <span
                        key={s}
                        className="tag"
                        // The French term for the same concept, same index.
                        title={r.mots_cles?.[i]}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
                {r.snippet
                  ? <Snippet html={r.snippet} />
                  : r.summary
                  ? <p className="result-snippet result-snippet-plain">{r.summary}</p>
                  : null}
                <div className="result-links">
                  {r.case_id ? (
                    <button className="result-open" onClick={() => openDetail(r.case_id!)}>
                      Summary, issues &amp; FIRAC →
                    </button>
                  ) : (
                    <a
                      className="result-open"
                      href={`${import.meta.env.BASE_URL}data/cases/${r.rank}.html`}
                      target="_blank" rel="noopener noreferrer"
                    >
                      Open full case ↗
                    </a>
                  )}
                  {r.url && (
                    <a
                      className="result-canlii"
                      href={r.url}
                      target="_blank" rel="noopener noreferrer"
                    >
                      View on CanLII ↗
                    </a>
                  )}
                  {r.case_id && (
                    <button
                      className="result-notes"
                      onClick={() => openDetail(r.case_id!, "notes")}
                    >
                      View Generation Notes →
                    </button>
                  )}
                </div>
              </li>
              );
            })}
          </ul>
        )}

        {view === "table" && (
          <div className="result-table-wrap">
            <table className="result-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={allShownSelected}
                      onChange={toggleSelectShown}
                      title="Select all shown"
                    />
                  </th>
                  <th>ID</th><th>Citation</th><th>Case</th><th>Court</th>
                  <th>Date</th><th>Location</th><th>Area of law</th><th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const id = idOf(r);
                  return (
                  <tr key={id} className={selected.has(id) ? "selected" : ""}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(id)}
                        onChange={() => toggleSelected(id)}
                      />
                    </td>
                    <td className="mono">{r.case_id ?? r.rank}</td>
                    <td className="mono">{r.citation}</td>
                    <td>{r.case_name}</td>
                    <td>{r.court}</td>
                    <td>{r.date}</td>
                    <td>{[r.city, r.province].filter(Boolean).join(", ")}</td>
                    <td>{r.practice_area ?? r.legal_area ?? ""}</td>
                    <td>
                      {r.case_id ? (
                        <button className="link-button" onClick={() => openDetail(r.case_id!)}>
                          Detail →
                        </button>
                      ) : (
                        <a
                          href={`${import.meta.env.BASE_URL}data/cases/${r.rank}.html`}
                          target="_blank" rel="noopener noreferrer"
                        >
                          Open ↗
                        </a>
                      )}
                      {r.url && (
                        <>
                          {" · "}
                          <a href={r.url} target="_blank" rel="noopener noreferrer">
                            CanLII ↗
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && sorted.length === 0 && (
          <p className="no-results">No cases match your search and filters.</p>
        )}
      </main>

      {openCase && (
        <CaseDetail
          caseId={openCase.id}
          focus={openCase.focus}
          onClose={() => setOpenCase(null)}
        />
      )}
    </div>
  );
}
