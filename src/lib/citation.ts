// McGill Guide citation formatter (Canadian Guide to Uniform Legal Citation,
// § E-3 "Jurisprudence").
//
// Which sections of E-3 apply to this corpus, which don't, and why, is written
// up in "McGill Citation/Applicable-Rules-for-Database.md" at the repo root.
// Read that before changing the rules here — the counts in the comments below
// come from it (n = 1,588 case records).
//
// SOURCE OF TRUTH: § 3.15.2 follows Can-Cite (© 2023), which supersedes the
// print 9th ed. on three points — the URL is the body's bare host rather than a
// deep link, `[archived URL]` is a new component, and dates are day-month-year.
// §§ 3.8/3.9 here still derive from the print 9th ed. and want re-checking
// against Can-Cite, which is likely to have moved to the same URL convention.
//
// DELIBERATE OMISSIONS — not oversights:
//  • § 3.3 normalization is MECHANICAL only (punctuation, `et al`, leading
//    articles, separator). § 3.3.8 (The Queen → R, 15 records) and § 3.3.9
//    (Attorney General → AG, 61 records) are NOT applied. Enabling them needs
//    a guard for LC172 "Regina (City) v Kivela", where Regina is the city.
//  • § 3.3.1's "omit given names and first initials" is not mechanised —
//    surname vs given name is not decidable from the stored string (LC722
//    "John C Chaplin" survives as-is).
//  • §§ 3.6 (pinpoint), 3.10 (judge), 3.11 (history) are unimplementable: the
//    schema stores no pinpoint, judge or appeal-history field.
//  • § 3.15.2's `[archived URL]` (perma.cc) component is dropped — we have none,
//    and inventing one would be worse than omitting it.

import type { CaseMeta } from "./types";

/** A run of citation text, flagged for italics (§ 3.3: parties and the v/c). */
export interface CitationSegment {
  text: string;
  italic: boolean;
}

export type CitationForm =
  | "neutral" // § 3.5      — 1,182 records
  | "canlii" // § 3.8.1    —   257 records
  | "reporter" // § 3.7      —    29 records (SCR only)
  | "tribunal-online" // § 3.15.2   —   120 records (IRB docket numbers)
  | "unknown"; //            — should be 0; warns if hit

export interface McGillCitation {
  /** Plain text — for clipboard, CSV export, anywhere markup can't go. */
  text: string;
  /** The same citation split for rendering, so § 3.3 italics survive. */
  segments: CitationSegment[];
  form: CitationForm;
  /** Data problems noticed while formatting. Empty on a clean record. */
  warnings: string[];
}

// ── § 3.9 Jurisdiction and court ───────────────────────────────────────────
// Needed only where there is no neutral citation (the neutral citation already
// encodes jurisdiction and court level, per § 3.5) and the court is not evident
// from the reporter (so SCR records get nothing). That is exactly the 257
// CanLII-identifier records, spanning the 36 codes below.
//
// § 3.9 defers to Appendices A-1 and B, which are NOT in Jurisprudence.pdf.
// Entries marked ✓ are lifted from worked examples inside § 3.8/§ 3.9/§ 3.12
// itself; the rest are derived from those patterns and are listed in
// UNVERIFIED_COURT_ABBREVS below. Spacing rule (§ 3.9): no space inside an
// all-caps abbreviation (BCCA), space where case is mixed (Ont Div Ct, Alta QB).
const MCGILL_COURT: Record<string, string> = {
  // ── Ontario ──
  ONCA: "Ont CA", // ✓ § 3.11.2 example
  ONSC: "Ont Sup Ct J",
  ONSCDC: "Ont Div Ct", // ✓ § 3.9 text
  ONSCSM: "Ont Sm Cl Ct",
  ONCTGD: "Ont Ct J (Gen Div)", // ✓ §§ 3.8, 3.11.1, 3.11.2 examples
  ONCTGDDC: "Ont Ct J (Gen Div) (Div Ct)",
  ONCTPD: "Ont Ct J (Prov Div)",
  ONHCJ: "Ont H Ct J",
  ONPROVCT: "Ont Prov Ct", // ✓ § 3.12 example
  ONSCAD: "Ont SC (AD)",

  // ── Québec ──
  QCCS: "Qc Sup Ct", // ✓ § 3.8 example
  QCCA: "Qc CA", // ✓ § 3.8 example
  QCCQ: "CQ", // ✓ § 3.13 example
  QCQBA: "Qc QB (App Side)",

  // ── British Columbia ──
  BCSC: "BCSC", // ✓ § 3.6.2 example
  BCCA: "BCCA", // ✓ § 3.9 text
  BCPC: "BC Prov Ct",

  // ── Prairies ──
  ABQB: "Alta QB", // ✓ § 3.9 text
  ABKB: "Alta KB",
  ABCA: "Alta CA",
  ABPC: "Alta Prov Ct",
  ABCJ: "Alta Ct J",
  ABSCTD: "Alta SC (TD)",
  MBQB: "Man QB",
  MBKB: "Man KB",
  MBCA: "Man CA",
  MBPC: "Man Prov Ct",
  SKQB: "Sask QB",
  SKKB: "Sask KB",
  SKCA: "Sask CA",
  SKPC: "Sask Prov Ct",
  SKSC: "Sask SC",

  // ── Atlantic ──
  NBQB: "NB QB",
  NBKB: "NB KB",
  NBCA: "NB CA",
  NBSC: "NB SC",
  NSSC: "NSSC",
  NSCA: "NSCA", // ✓ § 3.4 example
  NSPC: "NS Prov Ct",
  NLSC: "Nfld & Lab SC",
  NLCA: "Nfld & Lab CA",
  NLPC: "Nfld & Lab Prov Ct",
  PESC: "PEISC",
  PESCTD: "PEISC (TD)", // ✓ § 3.9 example (fragment)
  PESCAD: "PEISC (AD)", // ✓ § 3.9 example

  // ── Territories ──
  YKSC: "Y SC",
  NWTCA: "NWTCA",
};

/**
 * Codes whose abbreviation is derived rather than taken from a worked example.
 * Check these against Appendix B when it's to hand; every one of them is a
 * historical or less common court, so the blast radius is small (the four
 * highest-volume non-neutral courts — ONSC, QCCS, ONCA, BCSC — are either
 * verified or trivially patterned).
 */
export const UNVERIFIED_COURT_ABBREVS: ReadonlySet<string> = new Set([
  "ONSC", "ONSCSM", "ONCTGDDC", "ONCTPD", "ONHCJ", "ONSCAD", "QCQBA",
  "BCPC", "ABKB", "ABCA", "ABPC", "ABCJ", "ABSCTD", "MBQB", "MBKB", "MBCA",
  "MBPC", "SKQB", "SKKB", "SKCA", "SKPC", "SKSC", "NBQB", "NBKB", "NBCA",
  "NBSC", "NSSC", "NSPC", "NLSC", "NLCA", "NLPC", "PESC", "YKSC", "NWTCA",
]);

/** IRB divisions get their own § 3.15.2 host; nothing else needs one yet. */
const TRIBUNAL_HOST: Record<string, string> = {
  RPD: "irb-cisr.gc.ca",
  RAD: "irb-cisr.gc.ca",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** ISO date → "5 June 2012" (§ 3.15.2 examples: day month year, no ordinal). */
function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return iso ?? "";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * § 3.3 style of cause, mechanical pass. Order matters: periods come off before
 * the separator is picked, so the separator match can work on bare letters.
 */
export function styleOfCause(
  caseName: string,
  language?: string,
): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const raw = (caseName ?? "").trim();
  if (!raw) return { text: "", warnings: ["no case_name"] };

  // § 3.3: the v/c separator states the language of the DECISION. 96 Quebec
  // records carry `c.` in the name but language:"en" — the name came from the
  // decision itself, so it wins over the tag.
  const nameUsesC = /\s+c\.?\s+/.test(raw);
  if (nameUsesC && language === "en") {
    warnings.push('name uses "c" but language is "en" (§ 3.3 language mismatch)');
  }
  const sep = nameUsesC || language === "fr" ? "c" : "v";

  let s = raw;

  // § 3.3.1: drop `et al` — cite the first party on each side only.
  s = s.replace(/,?\s+et\s+al\.?/gi, "");

  // Periods: initials first (A.C. → AC, matching § 3.3.14's "EP v Winnipeg"),
  // then trailing abbreviation periods (R. → R, Inc. → Inc, No. → No).
  s = s
    .replace(/\b(?:[A-Z]\.){2,}/g, (m) => m.replace(/\./g, ""))
    .replace(/([A-Za-z0-9])\.(?=\s|,|\)|$)/g, "$1");

  // § 3.3.1: no leading The/Le/La/Les/L' — even inside a company name. (The
  // in-rem exception for ships doesn't arise: 0 in-rem records.)
  s = s.replace(/^(?:The|Le|La|Les)\s+/, "").replace(/^L'\s*/, "");

  // Separator, first occurrence only. Uppercase `C` is excluded because a lone
  // capital C is an initial (LC722 "John C Chaplin"), whereas the French
  // separator is always lowercase. Uppercase V *is* accepted — LC826 and LC202
  // are typos in the source data, not a citation variant.
  // No match is normal, not an error: 207 records are non-adversarial
  // ("Mahjoub (Re)", "Droit de la famille — 212670") and have no separator.
  s = s.replace(/\s+([vVc])\s+/, ` ${sep} `);

  return { text: s.replace(/\s{2,}/g, " ").trim(), warnings };
}

const NEUTRAL = /^(\d{4})\s+([A-Z]{2,8})\s+(\d+)$/;
// Tolerates the 14 records missing the space before "(" — "1978 CanLII 2184(QC CS)".
const CANLII = /^(\d{4})\s+CanLII\s+(\d+)\s*\(([^)]*)\)$/;
// "[1985] 1 SCR 295" / "[1963] SCR 651" — year-organised reporter (§ 3.7.1).
const REPORTER_YEAR = /^\[(\d{4})\]\s+(?:(\d+)\s+)?([A-Z]+)\s+(\d+)$/;
// "(1912) 46 SCR 132" — the 1877–1923 volume-numbered SCR era (§ 3.7.1).
const REPORTER_VOL = /^\((\d{4})\)\s+(\d+)\s+([A-Z]+)\s+(\d+)$/;
// "TB1-17205 (RPD)" — IRB docket number, no neutral citation, no reporter.
const IRB_DOCKET = /^([A-Z]{2}\d-\d+)\s+\((RPD|RAD)\)$/;

/** § 3.9 abbreviation for a court code, falling back to the bare code. */
export function mcgillCourt(code: string | undefined): string {
  if (!code) return "";
  return MCGILL_COURT[code] ?? code;
}

/**
 * Format one case as a McGill citation.
 *
 * Takes only the five fields it needs, so it works on a SearchResult, a
 * CaseMeta or a hand-built object. Never throws: an unrecognised citation is
 * passed through with a warning rather than dropped.
 */
export function mcgillCitation(
  c: Pick<CaseMeta, "citation" | "case_name" | "court" | "date"> &
    Partial<Pick<CaseMeta, "language">>,
): McGillCitation {
  const raw = (c.citation ?? "").trim();
  const { text: style, warnings } = styleOfCause(c.case_name, c.language);
  const dateYear = (c.date ?? "").slice(0, 4);

  // ── § 3.15.2 Administrative bodies and tribunals, online decisions ──
  // 120 records. All 120 are "[no public name]", so § 3.15.1's "where there is
  // no style of cause, use the decision number instead" applies and the docket
  // number stands in for the style of cause — unitalicised, since it is not a
  // party name. The decision-number slot is then not repeated.
  const irb = IRB_DOCKET.exec(raw);
  if (irb) {
    const [, docket, division] = irb;
    const host = TRIBUNAL_HOST[division];
    const named = Boolean(style) && style !== "[no public name]";
    const head = named ? style : docket;
    const tail =
      `(${longDate(c.date)}), ` +
      (named ? `${docket}, ` : "") +
      `online: ${division}` +
      (host ? ` <${host}>` : "");
    if (!host) warnings.push(`no § 3.15.2 host known for ${division}`);
    return {
      text: `${head} ${tail}`,
      segments: [
        { text: `${head} `, italic: named },
        { text: tail, italic: false },
      ],
      form: "tribunal-online",
      warnings,
    };
  }

  // Everything below is: style of cause, [year of decision,] main citation,
  // [jurisdiction and court].
  let year = ""; // § 3.4 — only when the main citation doesn't carry it
  let main = raw;
  let court = ""; // § 3.9 — only when there is no neutral citation
  let form: CitationForm = "unknown";

  const neutral = NEUTRAL.exec(raw);
  const canlii = CANLII.exec(raw);
  const repYear = REPORTER_YEAR.exec(raw);
  const repVol = REPORTER_VOL.exec(raw);

  if (neutral) {
    // § 3.5. Jurisdiction and court are already encoded, so § 3.9 adds nothing
    // and the `court` column must NOT be appended.
    form = "neutral";
    main = `${neutral[1]} ${neutral[2]} ${neutral[3]}`;
  } else if (canlii) {
    // § 3.8.1. The stored parenthetical is CanLII's own suffix ("ON CTGD"), not
    // a McGill abbreviation — discard it and derive § 3.9 from `court`.
    form = "canlii";
    main = `${canlii[1]} CanLII ${canlii[2]}`;
    court = mcgillCourt(c.court);
    if (!/\s\(/.test(raw)) warnings.push("malformed CanLII identifier (missing space before parenthesis)");
    if (UNVERIFIED_COURT_ABBREVS.has(c.court ?? "")) {
      warnings.push(`§ 3.9 abbreviation for ${c.court} is unverified against Appendix B`);
    }
  } else if (repYear) {
    // § 3.7.1 year-organised reporter; § 3.7.2.1 official (SCR). No court
    // parenthetical — it is evident from the reporter (§ 3.9).
    form = "reporter";
    main = raw;
  } else if (repVol) {
    // § 3.7.1 volume-numbered era: the year belongs after the style of cause
    // (§ 3.4), not inside the citation. UC479 "(1912) 46 SCR 132".
    form = "reporter";
    year = repVol[1];
    main = `${repVol[2]} ${repVol[3]} ${repVol[4]}`;
  } else {
    warnings.push(`unrecognised citation form: ${raw || "(empty)"}`);
    court = mcgillCourt(c.court);
  }

  // § 3.4: give the year of decision when the main citation has no year, or
  // when the two differ. 27 records differ — several look like `date` bugs
  // rather than genuine year splits, hence the warning.
  const citedYear = neutral?.[1] ?? canlii?.[1] ?? repYear?.[1] ?? repVol?.[1] ?? "";
  if (!citedYear && dateYear) {
    year = dateYear;
  } else if (citedYear && dateYear && citedYear !== dateYear) {
    year = dateYear;
    warnings.push(`citation year ${citedYear} ≠ decision year ${dateYear} (§ 3.4)`);
  }

  const head = year ? `${style} (${year}), ` : `${style}, `;
  const tail = court ? `${main} (${court})` : main;

  return {
    text: `${head}${tail}`,
    segments: [
      { text: style, italic: true },
      { text: year ? ` (${year}), ` : ", ", italic: false },
      { text: tail, italic: false },
    ],
    form,
    warnings,
  };
}
