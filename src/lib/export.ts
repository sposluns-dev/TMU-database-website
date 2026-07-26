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
 * The formatted citations, in result order. This export is citations and
 * nothing else — the case metadata (court, date, keywords, summary…) is what
 * toCsv/downloadCsv above is for. The formatter's `warnings` are deliberately
 * not carried here; call mcgillCitation() directly if you want the diagnostics.
 */
export function citationsFor(results: SearchResult[]): string[] {
  return results.map((r) => mcgillCitation(r).text);
}

/** Plain text, one citation per line — what "Copy Citations" puts on the clipboard. */
export function citationsToText(results: SearchResult[]): string {
  return citationsFor(results).join("\n");
}

/**
 * Two columns: the case id and the citation. The id is kept because a bare
 * column of citations can't be joined back to anything — drop it to a single
 * column if the spreadsheet is only ever a paste source.
 */
export function citationsToCsv(results: SearchResult[]): string {
  const rows = results.map((r) => [r.case_id ?? String(r.rank), mcgillCitation(r).text]);
  return [
    "case_id,citation",
    ...rows.map((cols) => cols.map(escapeCsv).join(",")),
  ].join("\n");
}

/** A flat list of citation strings. */
export function citationsToJson(results: SearchResult[]): string {
  return JSON.stringify(citationsFor(results), null, 2);
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
