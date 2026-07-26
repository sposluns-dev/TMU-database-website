// Two-level keyword filter: areas that unfold into their individual terms.
//
// Replaces the single-select area dropdown. The dropdown could only express
// "any keyword in this area", so picking Places meant cemetery OR Gaza OR
// Israel OR Palestine OR synagogue OR West Bank with no way to narrow. Here
// each term carries its own checkbox, so a search can be pinned to one term.
//
// Selection is a flat list of keyword_ids — the same shape the dropdown
// produced, so the query semantics downstream are unchanged (still OR'd).
import { useState } from "react";

export interface TreeTerm {
  id: string;
  label: string;
  count: number;
}

export function KeywordTree({
  label,
  areas,
  termsByArea,
  selected,
  onChange,
  on,
  onToggleOn,
  stripPrefix,
}: {
  label: string;
  areas: string[];
  termsByArea: Record<string, TreeTerm[]>;
  selected: string[];
  onChange: (ids: string[]) => void;
  on: boolean;
  onToggleOn: (on: boolean) => void;
  /** Dropped from the displayed area name, e.g. "Entities — ". */
  stripPrefix?: string;
}) {
  const [openAreas, setOpenAreas] = useState<string[]>([]);
  const sel = new Set(selected);

  const unfold = (area: string) =>
    setOpenAreas((a) =>
      a.includes(area) ? a.filter((x) => x !== area) : [...a, area],
    );

  const toggleTerm = (id: string) =>
    onChange(sel.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  // Area checkbox selects or clears every term beneath it.
  const toggleArea = (area: string, all: boolean) => {
    const ids = (termsByArea[area] ?? []).map((t) => t.id);
    onChange(
      all
        ? selected.filter((x) => !ids.includes(x))
        : [...selected, ...ids.filter((x) => !sel.has(x))],
    );
  };

  return (
    <div className="filter-group">
      <div className="filter-head">
        <input
          type="checkbox"
          className="filter-toggle"
          checked={on}
          onChange={(e) => onToggleOn(e.target.checked)}
          aria-label={`Apply the ${label} filter`}
        />
        <span className="filter-label">
          {label}
          {selected.length ? ` (${selected.length})` : ""}
        </span>
        {selected.length > 0 && on && (
          <button type="button" className="tree-clear" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>

      {/* The header checkbox hides the box outright rather than greying it
          out, but selections survive so a filter can be parked and restored. */}
      {on && (
        <div className="tree-box">
          {areas.length === 0 && <p className="filter-hint">Loading…</p>}
          {areas.map((area) => {
            const terms = termsByArea[area] ?? [];
            const chosen = terms.filter((t) => sel.has(t.id)).length;
            const all = chosen > 0 && chosen === terms.length;
            const open = openAreas.includes(area);
            const name = stripPrefix ? area.replace(stripPrefix, "") : area;

            return (
              <div className="tree-area" key={area}>
                <div className="tree-area-head">
                  <input
                    type="checkbox"
                    checked={all}
                    // Partial selection reads as neither on nor off.
                    ref={(el) => {
                      if (el) el.indeterminate = chosen > 0 && !all;
                    }}
                    onChange={() => toggleArea(area, all)}
                    aria-label={`Select every term in ${name}`}
                  />
                  <button
                    type="button"
                    className="tree-area-toggle"
                    aria-expanded={open}
                    onClick={() => unfold(area)}
                  >
                    <span className="tree-chevron">{open ? "▾" : "▸"}</span>
                    <span className="tree-area-name">{name}</span>
                    <span className="tree-area-count">
                      {chosen ? `${chosen}/${terms.length}` : terms.length}
                    </span>
                  </button>
                </div>

                {open && (
                  <div className="tree-terms">
                    {terms.map((t) => (
                      <label className="tree-term" key={t.id}>
                        <input
                          type="checkbox"
                          checked={sel.has(t.id)}
                          onChange={() => toggleTerm(t.id)}
                        />
                        <span className="tree-term-name">{t.label}</span>
                        <span className="tree-term-count">{t.count}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
