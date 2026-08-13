// Faceted search page.
// Sidebar filters: Court / Tribunal, Province, Court type, Practice area, Topic,
// Entities, Year range. Main: search bar + tips, toolbar (count, sort, per-page,
// export, view toggle), and Cards / Table / Map views.
//
// Where the filter options come from:
//   Court, Province, Practice area — the corpus itself, via GET /facets.
//   Topic, Entities               — the controlled vocabulary, via GET /keywords,
//                                   grouped by each keyword's `area`.
//   Court type                    — src/lib/taxonomy.ts (COURT_TYPE_MAP); it is
//                                   derived from the court code, not stored.

import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { search, loadIndex, warmSearch, type SearchMode } from "../lib/search";
import {
  downloadCsv,
  downloadCitations,
  citationsToText,
  copyText,
  type CitationFormat,
} from "../lib/export";
import { mcgillCitation } from "../lib/citation";
import { COURT_TYPES, courtLabel, courtType } from "../lib/taxonomy";
import { USE_API, apiKeywords } from "../lib/api";
import { MultiFilter } from "./MultiFilter";
import { KeywordTree, type TreeTerm } from "./KeywordTree";
import { CaseDetail } from "./CaseDetail";
import type { CasesIndex, Filters, MatchMode, SearchResult } from "../lib/types";
import "../styles/components/search.css";

// Stable identity for a result. The API returns the real case_id ("UC13"); the
// legacy static index only has a positional rank, so fall back to it.
const idOf = (r: SearchResult) => r.case_id ?? String(r.rank);

// Where the query matched. "Related decision" is the one that genuinely needs
// explaining: the case is in the results because ANOTHER record of the same
// litigation matched, so its own text contains none of the search terms and it
// would otherwise look like a false positive.
const MATCHED_LABEL: Record<string, string> = {
  case_name: "case name",
  parties: "parties",
  text: "full text",
  family: "related decision",
};
const MATCHED_HELP: Record<string, string> = {
  case_name: "The query matched this case's name or citation.",
  parties: "The query matched a party to this case.",
  text: "The query matched the text of this judgment.",
  family: "Included because another decision in the same case matched. "
        + "This record does not contain the search terms itself.",
};

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
// Header row for a single-control filter: a checkbox that switches the filter
// on/off, plus the label. The checkbox is deliberately NOT wrapped around the
// label -- the label keeps its `htmlFor` so clicking it still focuses the
// control, and the checkbox carries its own accessible name instead.
function FilterHead({
  label,
  htmlFor,
  on,
  onChange,
}: {
  label: string;
  htmlFor?: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="filter-head">
      <input
        type="checkbox"
        className="filter-toggle"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={`Apply the ${label} filter`}
      />
      <label className="filter-label" htmlFor={htmlFor}>{label}</label>
    </div>
  );
}

const toggle = (arr: string[], v: string) =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

const Visualize = lazy(() =>
  import("./Visualize").then((m) => ({ default: m.Visualize })),
);

type SortKey = "relevance" | "date_desc" | "date_asc" | "title";
type View = "cards" | "table";

// Sentinel for the toolbar's bulk-copy button, which shares the per-card
// "Copied ✓" state. No case id can collide with it.
const LIST_COPY_ID = "__citation_list__";

export function Search() {
  const [index, setIndex] = useState<CasesIndex | null>(null);
  // Two search boxes. `query`/`nameQuery` are what is *typed*; `appliedQuery`/
  // `appliedName` are what was last *submitted*. Nothing searches until a button
  // (or Enter) commits the typed value across — so changing a sidebar filter
  // re-runs the last submitted search rather than dragging half-typed text in.
  const [query, setQuery] = useState("");
  const [nameQuery, setNameQuery] = useState("");

  // Which of the three priorities the keyword query searches. All on by default,
  // which is the same thing the server assumes when the params are absent.
  const [inName, setInName] = useState(true);
  const [inParties, setInParties] = useState(true);
  const [inText, setInText] = useState(true);
  const noScope = !inName && !inParties && !inText;
  const [appliedQuery, setAppliedQuery] = useState("");
  const [appliedName, setAppliedName] = useState("");
  // When off, each button searches only its own box and clears the other, so
  // "Search by title" really does mean title only. When on, both boxes narrow
  // one search and either button submits the pair.
  const [combine, setCombine] = useState(false);
  const [mode, setMode] = useState<SearchMode>("browse");

  // Facet filters. None of these carry a match mode: court, province, court
  // type and practice area are each a single value on the case, so "All (AND)"
  // across two could never match. All are locked to Any (OR). Topic is the one
  // exception — keywords are genuinely multi-valued — and keeps its toggle.
  const [courtSel, setCourtSel] = useState<string[]>([]);
  const [provinceSel, setProvinceSel] = useState<string[]>([]);
  // Court type carries no match-mode state: it is derived from the court code,
  // so a case has exactly one and "All (AND)" across two could never match.
  // Locked to Any (OR), shown as plain text rather than a toggle.
  const [courtTypeSel, setCourtTypeSel] = useState<string[]>([]);
  // Topic / entity dropdowns: the keyword vocabulary grouped by its `area`.
  // Selecting an area filters to cases carrying any keyword in that area.
  const [kwAreas, setKwAreas] = useState<{
    topic: string[];
    entity: string[];
    byArea: Record<string, TreeTerm[]>; // area -> its terms
  }>({ topic: [], entity: [], byArea: {} });
  // Practice area is a checkbox list locked to Any (OR), for the same reason as
  // court type: practice_area is one column on the case, so "All (AND)" across
  // two values could never match. Nothing selected = no constraint, so it needs
  // no separate on/off control.
  const [practiceSel, setPracticeSel] = useState<string[]>([]);
  // Topic (keyword doctrine areas) is multi-select with an Any/All toggle.
  const [topicSel, setTopicSel] = useState<string[]>([]);
  const [topicMode, setTopicMode] = useState<MatchMode>("or");
  // Entities are picked term-by-term (KeywordTree), not a whole area at a time.
  const [entitySel, setEntitySel] = useState<string[]>([]);
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  // On/off switches for the sections that are a single control rather than a
  // checkbox list. Unchecking one drops it from the query but keeps whatever
  // was picked, so a filter can be parked and brought back.
  const [entityOn, setEntityOn] = useState(true);
  const [yearOn, setYearOn] = useState(true);
  // Cases the user has ticked for export / visualization (by case id).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // McGill citation export format, and the id of the card whose "Copy citation"
  // was just used (drives the transient "Copied" label).
  const [citeFormat, setCiteFormat] = useState<CitationFormat>("csv");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Case whose detail drawer is open, if any. "case" = summary/issues/FIRAC;
  // "notes" = the separate generation-notes view.
  const [openCase, setOpenCase] = useState<{ id: string; view: "case" | "notes" } | null>(null);
  const openDetail = (id: string, view: "case" | "notes" = "case") =>
    setOpenCase({ id, view });

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
        const byArea: Record<string, TreeTerm[]> = {};
        for (const k of ks) {
          const a = (k.area ?? "").trim();
          if (!a || a === "Practice Area (Tier 1)") continue;
          (byArea[a] ??= []).push({
            id: k.keyword_id,
            label: k.canonical_en,
            count: k.count,
          });
        }
        for (const terms of Object.values(byArea)) {
          terms.sort((x, y) => x.label.localeCompare(y.label));
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
  // Keyword filtering as groups: OR within a group, AND across groups.
  //   Topic "Any (OR)" — every selected area pooled into ONE group, so a case
  //                      matching any of them qualifies.
  //   Topic "All (AND)" — each area is its OWN group, so a case must touch
  //                      every area picked (not carry every keyword in them).
  //   Entities         — always its own group, so it intersects with Topic
  //                      rather than widening it.
  const subjectGroups = useMemo(() => {
    const topicIds = (a: string) => (kwAreas.byArea[a] ?? []).map((t) => t.id);
    const groups: string[][] =
      topicMode === "and"
        ? topicSel.map(topicIds).filter((g) => g.length)
        : [topicSel.flatMap(topicIds)].filter((g) => g.length);
    if (entityOn && entitySel.length) groups.push(entitySel);
    return groups;
  }, [topicSel, topicMode, entityOn, entitySel, kwAreas]);

  // Flat union, kept for the legacy in-browser index (no grouped equivalent).
  const subjectIds = useMemo(() => subjectGroups.flat(), [subjectGroups]);

  const filters: Filters = useMemo(
    () => ({
      courts: courtSel.length ? courtSel : undefined,
      courtsMode: courtSel.length ? "or" : undefined,
      provinces: provinceSel.length ? provinceSel : undefined,
      provincesMode: provinceSel.length ? "or" : undefined,
      courtTypes: courtTypeSel.length ? courtTypeSel : undefined,
      courtTypesMode: courtTypeSel.length ? "or" : undefined,
      legalAreas: practiceSel.length ? practiceSel : undefined,
      legalAreasMode: practiceSel.length ? "or" : undefined,
      subjects: subjectIds.length ? subjectIds : undefined,
      subjectsMode: subjectIds.length ? topicMode : undefined,
      subjectGroups: subjectGroups.length ? subjectGroups : undefined,
      dateFrom: yearOn && yearFrom ? `${yearFrom}-01-01` : undefined,
      dateTo: yearOn && yearTo ? `${yearTo}-12-31` : undefined,
      nameQuery: appliedName.trim() || undefined,
      inName,
      inParties,
      inText,
    }),
    [courtSel, provinceSel,
     courtTypeSel, practiceSel,
     subjectIds, subjectGroups, topicMode,
     yearOn, yearFrom, yearTo, appliedName,
     inName, inParties, inText],
  );

  // Submitting. With "combine" off, each button commits its own box and blanks
  // the other, so the button label is literally true. With it on, both buttons
  // commit the pair.
  const searchByText = () => {
    setAppliedQuery(query);
    setAppliedName(combine ? nameQuery : "");
  };
  const searchByTitle = () => {
    setAppliedName(nameQuery);
    setAppliedQuery(combine ? query : "");
  };

  async function runSearch() {
    setLoading(true);
    try {
      // Fetch all matches; the "Show" dropdown (perPage) controls how many display.
      const { results: r, mode: m, total: t, expandedTo: x, error } =
        await search(appliedQuery, filters, { k: 1000 });
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
  }, [index, courtSel, provinceSel,
      courtTypeSel, practiceSel, topicSel, topicMode,
      entityOn, entitySel, yearOn, yearFrom, yearTo,
      appliedQuery, appliedName]);

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

  // Copy the whole chosen set as plain text, one citation per line. Italics
  // can't survive the clipboard; the cards render `.segments` italicised.
  const flashCopied = (id: string) => {
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1600);
  };
  const copyCitationList = async (rs: SearchResult[]) => {
    if (await copyText(citationsToText(rs))) flashCopied(LIST_COPY_ID);
  };

  // Court filter ordered by court level: Supreme → Courts of Appeal →
  // Superior/first-instance → Federal → Tribunals (per COURT_TYPES), then
  // alphabetically within each level. Unclassified codes fall to the end.
  const courts = useMemo(() => {
    const raw = index?.facets.courts ?? [];
    const rank = (code: string) => {
      const t = courtType(code);
      const i = t ? COURT_TYPES.indexOf(t) : -1;
      return i === -1 ? COURT_TYPES.length : i;
    };
    return [...raw].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [index]);

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
    setCourtSel([]);
    setProvinceSel([]);
    setCourtTypeSel([]);
    setPracticeSel([]);
    setTopicSel([]); setTopicMode("or");
    setEntitySel([]);
    setYearFrom("");
    setYearTo("");
    // Back to the default state, which is every section switched on and empty --
    // otherwise "Clear filters" would leave sections greyed out with no value.
    setEntityOn(true); setYearOn(true);
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
          mode="or"
        />

        <MultiFilter
          label="Province"
          options={provinces.map((p) => ({ value: p, label: p }))}
          selected={provinceSel}
          onToggle={(v) => setProvinceSel((a) => toggle(a, v))}
          mode="or"
        />

        <MultiFilter
          label="Court type"
          options={COURT_TYPES.map((t) => ({ value: t, label: t }))}
          selected={courtTypeSel}
          onToggle={(v) => setCourtTypeSel((a) => toggle(a, v))}
          mode="or"
        />

        <MultiFilter
          label="Practice area"
          options={(index?.facets.practiceAreas ?? []).map((a) => ({ value: a, label: a }))}
          selected={practiceSel}
          onToggle={(v) => setPracticeSel((a) => toggle(a, v))}
          mode="or"
        />

        <MultiFilter
          label="Topic"
          options={kwAreas.topic.map((a) => ({ value: a, label: a }))}
          selected={topicSel}
          onToggle={(v) => setTopicSel((a) => toggle(a, v))}
          mode={topicMode}
          onMode={setTopicMode}
        />

        <KeywordTree
          label="Entities"
          areas={kwAreas.entity}
          termsByArea={kwAreas.byArea}
          selected={entitySel}
          onChange={setEntitySel}
          on={entityOn}
          onToggleOn={setEntityOn}
          stripPrefix="Entities — "
        />

        <div className="filter-group">
          <FilterHead
            label="Year range" htmlFor="year-from"
            on={yearOn} onChange={setYearOn}
          />
          <div className="filter-row">
            <input
              id="year-from"
              type="number" placeholder={yearMin} min={yearMin} max={yearMax}
              disabled={!yearOn}
              value={yearFrom} onChange={(e) => setYearFrom(e.target.value)}
            />
            <span>–</span>
            <input
              type="number" placeholder={yearMax} min={yearMin} max={yearMax}
              disabled={!yearOn}
              aria-label="Year range, to"
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
        {/* Two inputs, because they search different things: `query` runs the
            ranked full-text search over the judgment body, `nameQuery` is an
            exact-ish lookup over the short identifying fields. Filling both
            narrows — the name lookup applies as a filter on top of the text
            search. */}
        <div className="search-split">
          <div className="search-field">
            <label htmlFor="q-text">1. Keywords</label>
            <div className="search-bar">
              <input
                id="q-text"
                type="text"
                placeholder="Keywords, e.g. internet hate speech, religious freedom…"
                value={query}
                onFocus={warmSearch}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !noScope && searchByText()}
              />
              {!combine && (
                <button onClick={searchByText} disabled={loading || noScope}>
                  {loading ? "Searching…" : "Search by text"}
                </button>
              )}
            </div>
            {/* Scope, not filters: unticking one removes that priority from the
                query, so a case reachable only through it disappears rather than
                being hidden. All three off is not a search, hence the guard. */}
            <div className="search-scope">
              {([
                ["Case name", inName, setInName],
                ["Parties", inParties, setInParties],
                ["Full text", inText, setInText],
              ] as const).map(([label, on, set]) => (
                <label key={label} className="search-scope-item">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => set(e.target.checked)}
                  />
                  {label}
                </label>
              ))}
              {noScope && (
                <span className="search-scope-warning" role="alert">
                  Pick at least one place to search.
                </span>
              )}
            </div>
          </div>

          <div className="search-field">
            <label htmlFor="q-name">2. Citations</label>
            <div className="search-bar">
              <input
                id="q-name"
                type="text"
                placeholder="e.g. Elkhodary, or 2025 ONCJ 587…"
                value={nameQuery}
                onChange={(e) => setNameQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchByTitle()}
              />
              {!combine && (
                <button onClick={searchByTitle} disabled={loading}>
                  {loading ? "Searching…" : "Search by title"}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Combining collapses the two per-box buttons into one Search, because
            with both boxes applied there is only one search to run. */}
        <div className="search-combine-row">
          <label className="search-combine">
            <input
              type="checkbox"
              checked={combine}
              onChange={(e) => setCombine(e.target.checked)}
            />
            <span>Combine — narrow one search by keywords <em>and</em> citation</span>
          </label>
          {combine && (
            <button className="search-go" onClick={searchByText} disabled={loading}>
              {loading ? "Searching…" : "Search"}
            </button>
          )}
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
              Export CSV - Metadata{selected.size ? ` (${selected.size})` : ""}
            </button>
            {/* Citations only. The format toggle sits to the RIGHT of the button
                it governs, reading as "Export Citations … as CSV / JSON". */}
            <button
              onClick={() => downloadCitations(chosen, citeFormat)}
              disabled={!chosen.length}
              title={`Export McGill citations as ${citeFormat.toUpperCase()}`}
            >
              Export Citations{selected.size ? ` (${selected.size})` : ""}
            </button>
            <div className="view-toggle cite-format" role="group" aria-label="Citation export format">
              {(["csv", "json"] as CitationFormat[]).map((f) => (
                <button
                  key={f}
                  className={citeFormat === f ? "active" : ""}
                  onClick={() => setCiteFormat(f)}
                  aria-pressed={citeFormat === f}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
            <button
              onClick={() => copyCitationList(chosen)}
              disabled={!chosen.length}
              title="Copy every citation to the clipboard as plain text, one per line"
            >
              {copiedId === LIST_COPY_ID
                ? "Copied ✓"
                : `Copy Citations${selected.size ? ` (${selected.size})` : ""}`}
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
              const cite = mcgillCitation(r);
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
                  {r.matched && (
                    <span
                      className={`result-matched result-matched-${r.matched}`}
                      title={MATCHED_HELP[r.matched]}
                    >
                      {MATCHED_LABEL[r.matched]}
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
                      Case Summary, Issues →
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
                {/* The McGill citation, with § 3.3 italics. Selectable so it can
                    be dragged out by hand; bulk copying is the toolbar's job. */}
                <p className="result-cite-line">
                  {cite.segments.map((seg, i) =>
                    seg.italic ? <em key={i}>{seg.text}</em> : <span key={i}>{seg.text}</span>,
                  )}
                </p>
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
          view={openCase.view}
          onClose={() => setOpenCase(null)}
        />
      )}
    </div>
  );
}
