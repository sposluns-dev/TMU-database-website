// Controlled vocabularies for the faceted filters. Subjects mirror the SATL
// taxonomy. Court type / area of law are standard Canadian categories.
// Cases are tagged via the optional public/data/case_tags.json (see search.ts);
// until tagged, these filters render but match nothing.

export const SUBJECTS = [
  "Freedom of Speech",
  "Actions against or dismissal of public servants",
  "Prohibition of Symbols, Parties & Associations",
  "Hate Speech and Incitement",
  "Freedom of Assembly",
  "Anti-constitutional activities",
  "Compensation",
  "Holocaust Denial & Trivialisation",
  "Pogroms and Violent Attacks on Persons",
  "Workplace and labour issues",
  "Artistic Freedom",
  "Attack on Jewish Places of Worship",
  "Discrimination",
  "Insult of State Officials",
  "Israel-related incident",
  "Restitution",
  "Other",
] as const;

export const COURT_TYPES = [
  "Supreme Court",
  "Court of Appeal",
  "Superior / Trial Court",
  "Federal Court",
  "Tribunal",
] as const;

export const AREAS_OF_LAW = [
  "Administrative law",
  "Civil litigation",
  "Constitutional law",
  "Criminal law",
  "Education law",
  "Family law",
  "Human rights",
  "Immigration law",
  "Labour and employment law",
] as const;

export type Subject = (typeof SUBJECTS)[number];
export type CourtType = (typeof COURT_TYPES)[number];
export type AreaOfLaw = (typeof AREAS_OF_LAW)[number];

// Full court/tribunal names for the court-code filter. Every code present in
// the corpus is listed; codes not listed fall back to showing just the code.
//
// Names verified against the CanLII court suffix carried in each case's own
// citation string (e.g. "1978 CanLII 699 (AB SCTD)") plus the date range of the
// cases filed under each code. Courts marked "†" are defunct or renamed — the
// Queen's/King's Bench alternation tracks the reigning monarch, so the same
// institution appears under two codes either side of 2022 (Elizabeth II's
// death) or 2023 for New Brunswick.
export const COURT_NAMES: Record<string, string> = {
  // ── Federal courts & tribunals ──
  SCC: "Supreme Court of Canada",
  FCA: "Federal Court of Appeal",
  FC: "Federal Court",
  TCC: "Tax Court of Canada",
  CHRT: "Canadian Human Rights Tribunal",
  FPSLREB: "Federal Public Sector Labour Relations & Employment Board",
  SST: "Social Security Tribunal of Canada",
  RAD: "Refugee Appeal Division (IRB)",
  RPD: "Refugee Protection Division (IRB)",
  RLLR: "Refugee Law Lab Reporter",

  // ── Ontario ──
  ONSC: "Ontario Superior Court of Justice",
  ONCJ: "Ontario Court of Justice",
  ONCA: "Court of Appeal for Ontario",
  ONSCDC: "Ontario Superior Court of Justice, Divisional Court",
  ONSCSM: "Ontario Superior Court of Justice, Small Claims Court",
  ONHCJ: "Ontario High Court of Justice †", // abolished 1990
  ONCTGD: "Ontario Court of Justice, General Division †", // 1990–99, became ONSC
  ONCTGDDC: "Ontario Court of Justice, General Division — Divisional Court †",
  ONCTPD: "Ontario Court of Justice, Provincial Division †", // 1990–99, became ONCJ
  ONPROVCT: "Ontario Provincial Court †", // pre-1990
  ONSCAD: "Supreme Court of Ontario, Appellate Division †", // 1913–1931

  // ── Québec ──
  QCCS: "Superior Court of Québec / Cour supérieure",
  QCCQ: "Court of Québec / Cour du Québec",
  QCCA: "Québec Court of Appeal / Cour d'appel",
  QCCM: "Municipal Court / Cour municipale",
  QCQBA: "Québec Court of Queen's Bench, Appeal Side †", // became QCCA in 1974

  // ── British Columbia ──
  BCSC: "Supreme Court of British Columbia",
  BCCA: "British Columbia Court of Appeal",
  BCPC: "Provincial Court of British Columbia",

  // ── Alberta ──
  ABQB: "Court of Queen's Bench of Alberta †", // renamed ABKB in 2022
  ABKB: "Court of King's Bench of Alberta",
  ABCA: "Court of Appeal of Alberta",
  ABPC: "Provincial Court of Alberta †", // renamed ABCJ in 2023
  ABCJ: "Alberta Court of Justice",
  ABSCTD: "Supreme Court of Alberta, Trial Division †", // became ABQB in 1979

  // ── Manitoba ──
  MBQB: "Manitoba Court of Queen's Bench †", // renamed MBKB in 2022
  MBKB: "Manitoba Court of King's Bench",
  MBCA: "Manitoba Court of Appeal",
  MBPC: "Provincial Court of Manitoba",

  // ── Saskatchewan ──
  SKQB: "Saskatchewan Court of Queen's Bench †", // renamed SKKB in 2022
  SKKB: "Saskatchewan Court of King's Bench",
  SKCA: "Court of Appeal for Saskatchewan",
  SKPC: "Provincial Court of Saskatchewan",
  SKSC: "Supreme Court of Saskatchewan †", // pre-1979, became SKQB

  // ── Atlantic ──
  NBQB: "Court of Queen's Bench of New Brunswick †", // renamed NBKB in 2023
  NBKB: "Court of King's Bench of New Brunswick",
  NBCA: "Court of Appeal of New Brunswick",
  NBSC: "New Brunswick Supreme Court †", // historical, became NBQB
  NSSC: "Supreme Court of Nova Scotia",
  NSCA: "Nova Scotia Court of Appeal",
  NSPC: "Provincial Court of Nova Scotia",
  NLSC: "Supreme Court of Newfoundland and Labrador",
  NLCA: "Court of Appeal of Newfoundland and Labrador",
  NLPC: "Provincial Court of Newfoundland and Labrador",
  PESC: "Supreme Court of Prince Edward Island",
  PESCTD: "PEI Supreme Court, Trial Division",
  PESCAD: "PEI Supreme Court, Appeal Division",

  // ── Territories ──
  YKSC: "Supreme Court of Yukon",
  NWTCA: "Court of Appeal for the Northwest Territories",
};

export function courtLabel(code: string): string {
  return COURT_NAMES[code] ? `${code} — ${COURT_NAMES[code]}` : code;
}

// Deterministic court-code → court-type mapping (drives the court-type checkboxes).
// court_type is a pure function of the court code, so it needs no LLM tagging.
// Classification rule = by LEVEL, not by system: appeal courts (incl. the Federal
// Court of Appeal) → "Court of Appeal"; only first-instance federal courts
// (FC, TCC) → "Federal Court". Provincial (s. 92) courts are folded into
// "Superior / Trial Court" for now — split them into their own bucket if
// the lower-court cases are indexed later.
export const COURT_TYPE_MAP: Record<string, CourtType> = {
  // Supreme
  SCC: "Supreme Court",
  // Appellate (provincial courts of appeal + Federal CA + divisional/appeal divisions)
  ONCA: "Court of Appeal", QCCA: "Court of Appeal", BCCA: "Court of Appeal",
  ABCA: "Court of Appeal", SKCA: "Court of Appeal", MBCA: "Court of Appeal",
  NBCA: "Court of Appeal", NLCA: "Court of Appeal", NSCA: "Court of Appeal",
  NWTCA: "Court of Appeal", FCA: "Court of Appeal", ONSCDC: "Court of Appeal",
  ONSCAD: "Court of Appeal", PESCAD: "Court of Appeal", QCQBA: "Court of Appeal",
  ONCTGDDC: "Court of Appeal",
  // Federal Court (first-instance federal)
  FC: "Federal Court", TCC: "Federal Court",
  // Tribunals
  CHRT: "Tribunal", RPD: "Tribunal", RAD: "Tribunal", FPSLREB: "Tribunal",
  SST: "Tribunal", RLLR: "Tribunal",
  // Superior / first-instance (s. 96 superior trial + s. 92 provincial, folded in)
  ONSC: "Superior / Trial Court", BCSC: "Superior / Trial Court",
  QCCS: "Superior / Trial Court", ABQB: "Superior / Trial Court",
  ABKB: "Superior / Trial Court", MBQB: "Superior / Trial Court",
  MBKB: "Superior / Trial Court", SKQB: "Superior / Trial Court",
  SKKB: "Superior / Trial Court", NBQB: "Superior / Trial Court",
  NBKB: "Superior / Trial Court", NBSC: "Superior / Trial Court",
  NSSC: "Superior / Trial Court", YKSC: "Superior / Trial Court",
  PESC: "Superior / Trial Court", PESCTD: "Superior / Trial Court",
  NLSC: "Superior / Trial Court", ONHCJ: "Superior / Trial Court",
  ABSCTD: "Superior / Trial Court", ONSCSM: "Superior / Trial Court",
  ONCTGD: "Superior / Trial Court", SKSC: "Superior / Trial Court",
  // Provincial Division was the first-instance criminal/family court that became
  // ONCJ in 1999 — not an appellate court.
  ONCTPD: "Superior / Trial Court",
  ONCJ: "Superior / Trial Court", QCCQ: "Superior / Trial Court",
  ABPC: "Superior / Trial Court", BCPC: "Superior / Trial Court",
  QCCM: "Superior / Trial Court", ONPROVCT: "Superior / Trial Court",
  ABCJ: "Superior / Trial Court", SKPC: "Superior / Trial Court",
  MBPC: "Superior / Trial Court", NLPC: "Superior / Trial Court",
  NSPC: "Superior / Trial Court",
};

/** Court type for a court code, or undefined if the code is unrecognized. */
export function courtType(code: string | undefined): CourtType | undefined {
  return code ? COURT_TYPE_MAP[code] : undefined;
}
