// CSV export of the current result set — the browser equivalent of rag.py's
// to_csv, plus a trigger that downloads the file. No backend involved.
//
// Two separate exports live here:
//   • toCsv / downloadCsv         — the full case record (metadata dump).
//   • citationsToCsv / …ToJson    — McGill-formatted citations only, for
//     pasting into a brief or footnote. See ./citation.ts.

import type { SearchResult } from "./types";
import { mcgillCitation } from "./citation";

const FIELDS: (keyof SearchResult)[] = [
  "case_id",
  "citation",
  "case_name",
  "court",
  "date",
  "city",
  "province",
  "practice_area",
  "keywords",
  "mots_cles",
  "summary",
  "url",
];

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return "";
  // keywords / mots_cles are arrays — flatten with the same separator the
  // source vocabulary CSV uses, so the export round-trips legibly.
  const s = Array.isArray(value) ? value.join(" | ") : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(results: SearchResult[]): string {
  const header = FIELDS.join(",");
  const rows = results.map((r) => FIELDS.map((f) => escapeCsv(r[f])).join(","));
  return [header, ...rows].join("\n");
}

function download(body: string, mime: string, filename: string): void {
  const blob = new Blob([body], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadCsv(
  results: SearchResult[],
  filename = "tmu_cases.csv",
): void {
  download(toCsv(results), "text/csv", filename);
}

// ── McGill citation export ─────────────────────────────────────────────────

export type CitationFormat = "csv" | "json";

/**
 * One row per case. `citation` is what the source gave us; `mcgill` is the
 * formatted citation. Both are kept so the export doubles as an audit trail —
 * `warnings` carries anything the formatter flagged (unverified court
 * abbreviation, year mismatch, language mismatch).
 */
export interface CitationRow {
  case_id: string;
  mcgill: string;
  case_name: string;
  citation: string;
  court: string;
  date: string;
  form: string;
  warnings: string;
}

export function toCitationRows(results: SearchResult[]): CitationRow[] {
  return results.map((r) => {
    const cite = mcgillCitation(r);
    return {
      case_id: r.case_id ?? String(r.rank),
      mcgill: cite.text,
      case_name: r.case_name,
      citation: r.citation,
      court: r.court,
      date: r.date,
      form: cite.form,
      warnings: cite.warnings.join(" | "),
    };
  });
}

const CITATION_FIELDS: (keyof CitationRow)[] = [
  "case_id", "mcgill", "case_name", "citation", "court", "date", "form", "warnings",
];

export function citationsToCsv(results: SearchResult[]): string {
  const rows = toCitationRows(results);
  return [
    CITATION_FIELDS.join(","),
    ...rows.map((row) => CITATION_FIELDS.map((f) => escapeCsv(row[f])).join(",")),
  ].join("\n");
}

export function citationsToJson(results: SearchResult[]): string {
  return JSON.stringify(toCitationRows(results), null, 2);
}

export function downloadCitations(
  results: SearchResult[],
  format: CitationFormat,
  filename = `tmu_citations.${format}`,
): void {
  const body = format === "json" ? citationsToJson(results) : citationsToCsv(results);
  download(body, format === "json" ? "application/json" : "text/csv", filename);
}

/**
 * Copy text to the clipboard, resolving false if it didn't happen so the caller
 * can avoid showing a "Copied" state that isn't true. The Clipboard API needs a
 * secure context, so the textarea path covers plain-http and older browsers.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
