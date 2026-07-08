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
  "Superior / First-instance Court",
  "Federal Court",
  "Tribunal",
] as const;

export const AREAS_OF_LAW = [
  "Constitutional",
  "Criminal",
  "Civil",
  "Administrative",
  "Human Rights",
  "Immigration / Refugee",
  "Labour / Employment",
  "Tax",
] as const;

export type Subject = (typeof SUBJECTS)[number];
export type CourtType = (typeof COURT_TYPES)[number];
export type AreaOfLaw = (typeof AREAS_OF_LAW)[number];

// Full court/tribunal names for disambiguating the court-code filter.
// Codes not listed here fall back to showing just the code.
export const COURT_NAMES: Record<string, string> = {
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
  BCCA: "British Columbia Court of Appeal",
  BCSC: "Supreme Court of British Columbia",
  ONCA: "Court of Appeal for Ontario",
  NSCA: "Nova Scotia Court of Appeal",
  NSSC: "Supreme Court of Nova Scotia",
  NSPC: "Provincial Court of Nova Scotia",
};

export function courtLabel(code: string): string {
  return COURT_NAMES[code] ? `${code} — ${COURT_NAMES[code]}` : code;
}
