// CSV export of the current result set — the browser equivalent of rag.py's
// to_csv, plus a trigger that downloads the file. No backend involved.

import type { SearchResult } from "./types";

const FIELDS: (keyof SearchResult)[] = [
  "rank",
  "citation",
  "case_name",
  "court",
  "date",
  "distance",
];

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(results: SearchResult[]): string {
  const header = FIELDS.join(",");
  const rows = results.map((r) => FIELDS.map((f) => escapeCsv(r[f])).join(","));
  return [header, ...rows].join("\n");
}

export function downloadCsv(
  results: SearchResult[],
  filename = "tmu_cases.csv",
): void {
  const csv = toCsv(results);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
