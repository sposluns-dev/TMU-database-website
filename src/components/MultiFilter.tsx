// Collapsible multi-select filter with an Any(OR) / All(AND) match toggle.
// Shared by the Court, Province, Court type, Area of law, and Subjects filters.
import { useState } from "react";

export interface Option {
  value: string;
  label: string;
}

export function MultiFilter({
  label,
  options,
  selected,
  onToggle,
  mode,
  onMode,
}: {
  label: string;
  options: Option[];
  selected: string[];
  onToggle: (value: string) => void;
  mode: "or" | "and";
  onMode: (m: "or" | "and") => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="filter-group">
      <button
        type="button"
        className="subject-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="filter-label" style={{ margin: 0 }}>
          {label}
          {selected.length ? ` (${selected.length})` : ""}
        </span>
        <span className="subject-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="subject-list">
          <div
            className="subject-mode"
            role="group"
            aria-label={`${label} match mode`}
            style={{ display: "flex", gap: 4, marginBottom: 8 }}
          >
            <span style={{ fontSize: ".8rem", color: "var(--muted,#666)", alignSelf: "center" }}>
              Match:
            </span>
            {(["or", "and"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onMode(m)}
                aria-pressed={mode === m}
                style={{
                  padding: "2px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  border: "1px solid #ccc",
                  background: mode === m ? "#339999" : "#fff",
                  color: mode === m ? "#fff" : "#333",
                  fontSize: ".8rem",
                }}
              >
                {m === "or" ? "Any (OR)" : "All (AND)"}
              </button>
            ))}
          </div>
          {options.map((o) => (
            <label key={o.value} className="subject-check">
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => onToggle(o.value)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
