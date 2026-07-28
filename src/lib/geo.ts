// Bilingual labels for the geographic / registry metadata shown on a case.
//
// Only the *province* name and the "Registry" label are translated. City and
// registry VALUES are left alone on purpose:
//   • Canadian place names are not translated ("Whitehorse" is Whitehorse in
//     both languages), and the Québec ones are already stored in French
//     ("Montréal", "Beauharnois").
//   • `registry` holds 131 distinct values that are a mix of place names,
//     court divisions already in French ("Chambre de la jeunesse"), and bare
//     docket numbers ("A-68-14"). None of those have an English/French pair to
//     map between.

export type Lang = "en" | "fr";

/**
 * Province / territory names, English key → French. Keys are the exact strings
 * stored in `case_metadata.province`, which is why "Québec" is accented here —
 * matching the DB value, not the English spelling.
 *
 * All 13 provinces and territories are listed, not just the 12 present in the
 * corpus today, so a case from Nunavut renders correctly without a code change.
 */
export const PROVINCE_FR: Record<string, string> = {
  "Alberta": "Alberta",
  "British Columbia": "Colombie-Britannique",
  "Manitoba": "Manitoba",
  "New Brunswick": "Nouveau-Brunswick",
  "Newfoundland and Labrador": "Terre-Neuve-et-Labrador",
  "Northwest Territories": "Territoires du Nord-Ouest",
  "Nova Scotia": "Nouvelle-Écosse",
  "Nunavut": "Nunavut",
  "Ontario": "Ontario",
  "Prince Edward Island": "Île-du-Prince-Édouard",
  "Québec": "Québec",
  "Saskatchewan": "Saskatchewan",
  "Yukon": "Yukon",
};

/** Province name in the requested language; unknown values pass through. */
export function provinceLabel(
  province: string | null | undefined,
  lang: Lang,
): string {
  const p = (province ?? "").trim();
  if (!p) return "";
  return lang === "fr" ? PROVINCE_FR[p] ?? p : p;
}

/**
 * "City, Province" with the province localised. Either part may be missing.
 */
export function placeLabel(
  city: string | null | undefined,
  province: string | null | undefined,
  lang: Lang,
): string {
  return [(city ?? "").trim(), provinceLabel(province, lang)]
    .filter(Boolean)
    .join(", ");
}

/**
 * The "Registry" field label. French typography puts a narrow no-break space
 * before a colon; it is written as the explicit \u202f escape below so it is
 * visible in source rather than an invisible character someone later "fixes".
 */
export function registryLabel(lang: Lang): string {
  return lang === "fr" ? "Greffe\u202f:" : "Registry:";
}

/** Court level badge, which sits in the same header block. */
export function levelLabel(level: string | null | undefined, lang: Lang): string {
  if (lang === "fr") {
    return level === "upper" ? "Cour supérieure" : "Cour inférieure";
  }
  return level === "upper" ? "Upper court" : "Lower court";
}
