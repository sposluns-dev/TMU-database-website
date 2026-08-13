#!/usr/bin/env python3
"""Extract party names + roles from the head of each judgment.

The "rich" version of party extraction: reads the structured party block that
most judgments carry near the top (BETWEEN: ... PLAINTIFF ... DEFENDANT) rather
than splitting the style of cause. 76% of the corpus has such a block; the rest
falls back to splitting `case_name` on the v/c separator.

Writes cases-JSON/case_metadata_parties.jsonl with two fields per row:
    {"case_id": "LC1", "parties": [{"name": ..., "role": ...}, ...]}
`parties` is null where nothing could be extracted (no block, no separator —
e.g. the 122 "[no public name]" IRB records and the Quebec numbered files).

Usage:
    python3 scripts/extract_parties.py            # first 100 rows
    python3 scripts/extract_parties.py --all
"""
import argparse
import glob
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = os.path.join(ROOT, "cases-JSON")
OUT = os.path.join(CASES, "case_metadata_parties.jsonl")
REVIEW = os.path.join(CASES, "parties-anonymisation-review.txt")

HEAD_CHARS = 6000          # party blocks sit at the very top; beyond this is reasons

# Role labels as they appear on their own line, singular or plural. Order matters
# only for display; matching is by regex below.
#
# CLOSED VOCABULARY. Every value is a term a court itself uses, and each block
# names its authority:
#   * rules of civil procedure — Ont. rr. 13, 14.01, 14.05, 37; BC SCCR Part 16
#   * insolvency — BIA / CCAA statutory language
#   * Claimant — the BC Small Claims Rules, where the party bringing the claim is
#     the claimant, not the plaintiff (see LC387, BCPC). Note this is NOT a
#     translation of Quebec's "demandeur": unofficial English translations of
#     QCCS judgments render that as "Claimant" too, and it must map to Plaintiff
#     (LC189 was corrected for exactly this).
#   * Child — child-protection statutes, where the child has standing distinct
#     from the parties: Quebec's LPJ designates l'enfant, and Ontario's CYFSA
#     gives a child 12+ party status. There is no equivalent in the civil rules.
# Anything outside VALID_ROLES is a bug; see the assertion in main().
#
# NOTE on spelling: Canadian courts and the SCC write "intervener". "Intervenor"
# appears in older Ontario reports (e.g. LC145) and is matched, never emitted.
# The label emitted follows the LANGUAGE OF THE SOURCE: an English party block
# yields the common-law term, a French one yields the Code de procédure civile
# term. Translating "défendeur" to "Defendant" asserts an equivalence between two
# procedural systems that is not always exact, so the source term is preserved.
# Order matters — ROLE_OF returns the first match, and the English/French pairs
# are deliberately distinguishable (APPELLANT vs APPELANT, INTERVENER vs
# INTERVENANT).
ROLES = [
    # ── common law, rules of civil procedure ──
    ("Plaintiff",        r"PLAINTIFFS?"),
    ("Defendant",        r"DEFENDANTS?"),
    ("Appellant",        r"APPELLANTS?"),
    ("Respondent",       r"RESPONDENTS?"),
    ("Applicant",        r"APPLICANTS?"),
    ("Petitioner",       r"PETITIONERS?"),
    ("Moving party",     r"MOVING PART(?:Y|IES)"),
    ("Responding party", r"RESPONDING PART(?:Y|IES)"),
    # Impleaded by an existing party rather than named by the plaintiff/applicant
    # (Ont. r. 29, BC SCCR Part 3 Div. 5) — a distinct rules-based role, not a
    # synonym for Mis en cause/Intervener (LC1012).
    ("Third party",      r"THIRD PART(?:Y|IES)"),
    ("Intervener",       r"INTERVEN[EO]RS?|IMPLEADED PARTIES"),
    ("Accused",          r"ACCUSED"),
    # The prosecuting party. "Accused" already comes from the Criminal Code; this
    # is its counterpart, and is what courts themselves say ("the Crown"). It
    # describes WHO the party is, so it is used at first instance — on appeal the
    # Crown takes the Appellant/Respondent posture like any other party.
    ("Crown",            r"CROWN|HER\s+MAJESTY|HIS\s+MAJESTY|THE\s+QUEEN|THE\s+KING|REGINA|REX"),
    # Provincial offences (e.g. Workplace Safety and Insurance Act, Electricity
    # Act prosecutions) use "prosecutor" for the Crown/regulator bringing the
    # charge — the regulatory-offence equivalent of Crown, not a synonym for it
    # (LC46, LC116, LC800-802).
    ("Prosecutor",       r"PROSECUTOR"),
    # Human rights regime: the person who filed the complaint is the complainant,
    # distinct from the Commission that may also be a party in its own right
    # (LC10, LC34, LC172, LC985).
    ("Complainant",      r"COMPLAINANTS?"),
    # Federal public-sector labour adjudication (FPSLREB and predecessor PSLRB)
    # styles cases "grievor" v. "employer", not applicant/respondent (UC3).
    ("Grievor",          r"GRIEVOR"),
    ("Employer",         r"EMPLOYER"),
    # The statutory Commission itself, where it appears as a named party
    # alongside — not instead of — the complainant (LC10, board-of-inquiry
    # style headings label this role literally "Commission").
    ("Commission",       r"COMMISSION"),
    # ── Quebec, Code de procédure civile ──
    ("Demandeur",        r"DEMANDERESSES?|DEMANDEURS?"),
    ("Défendeur",        r"DÉFENDERESSES?|DEFENDERESSES?|DÉFENDEURS?|DEFENDEURS?"),
    ("Appelant",         r"APPELANTE?S?"),
    ("Intimé",           r"INTIMÉE?S?|INTIMEE?S?"),
    ("Requérant",        r"REQUÉRANTE?S?|REQUERANTE?S?"),
    ("Intervenant",      r"INTERVENANTE?S?"),
    ("Mis en cause",     r"MISE?S?\s+EN\s+CAUSE"),
    # Quebec authorization-of-care applications (Sir Mortimer B. Davis JGH v. …
    # is a recurring litigant here) name a close relative as "Interested
    # person" — notified and heard, but not a full party. Distinct from Mis en
    # cause, which the same judgments use for a different kind of third party
    # in the identical proceeding (compare LC1023/LC1027 to LC1021/LC1022/1025/1026).
    # The Canadian Human Rights Tribunal uses the plural "interested parties" for
    # the same non-party-but-participating concept (UC7) — same label, either noun.
    ("Interested person", r"INTERESTED\s+PERSONS?|INTERESTED\s+PART(?:Y|IES)"),
    ("Accusé",           r"ACCUSÉE?S?"),
    ("Ministère public", r"MINIST[ÈE]RE\s+PUBLIC|POURSUIVANTE?|SA\s+MAJEST[ÉE]|LA\s+REINE|LE\s+ROI"),
    # ── insolvency (BIA / CCAA) ──
    ("Bankrupt",         r"BANKRUPTS?|FAILLIE?S?"),
    ("Debtor",           r"DEBTORS?|DÉBITEURS?|DEBITEURS?"),
    ("Creditor",         r"(?:PETITIONING\s+)?CREDITORS?|CRÉANCIERS?|CREANCIERS?"),
    ("Trustee",          r"TRUSTEES?|SYNDICS?"),
    ("Monitor",          r"MONITOR|CONTRÔLEUR|CONTROLEUR"),
    # ── tribunal (BC Small Claims Rules) ──
    ("Claimant",         r"CLAIMANTS?"),
    # ── subject of the proceeding, not a party. Kept in English in both
    #    languages by explicit decision: "Child" is a cross-jurisdictional
    #    concept (LPJ, CYFSA), not a CPC party role. ──
    ("Child",            r"CHILDREN|CHILD|ENFANTS?"),
]
VALID_ROLES = {label for label, _ in ROLES}

# Quebec is a civil-law jurisdiction with its own official party terminology in
# the Code de procédure civile. These are accepted as role values but are NOT
# emitted by the extractor, which still maps French labels to their English
# equivalents above. They exist for records entered by hand where the source is
# an unofficial English translation and asserting an English role would be a
# guess — LC189 is the case that prompted this.
#
# OPEN QUESTION: this leaves "Plaintiff" and "Demandeur" both in the data meaning
# the same thing. Either the extractor should preserve French for the 117
# French-language judgments, or these hand-entered records should be normalised
# to English. Decide before the corpus grows.
QUEBEC_ROLES = {
    "Demandeur", "Défendeur", "Requérant", "Intimé", "Appelant",
    "Mis en cause", "Intervenant",
}
VALID_ROLES |= QUEBEC_ROLES
# Accepted as stored values but not emitted by the extractor:
#   "Poursuivant" — Quebec penal/regulatory prosecutions name the prosecuting
#   municipality or the Crown "poursuivant(e)" (LC128, LC801-802, LC891-892,
#   LC894, LC1083). Not "Ministère public": a ville poursuivante is not the
#   state prosecution service.
#   "Party" — board-of-inquiry captions that designate participants simply as
#   parties, with no procedural side (LC10).
VALID_ROLES |= {"Poursuivant", "Party"}
# A role line may carry a qualifier: "APPELLANTS – Intervenors", "RESPONDENT/Defendant".
ROLE_LINE = re.compile(
    r"^\W*(?:" + "|".join(p for _, p in ROLES) + r")\b[\s\-–—/,]*(?:\(?[A-Za-z\s\-–—/]{0,40}\)?)?\W*$",
    re.I,
)
ROLE_OF = [(label, re.compile(r"^\W*(?:" + pat + r")\b", re.I)) for label, pat in ROLES]

# Lines that are never party names. Note CANADA/ONTARIO are deliberately NOT here
# — they are common components of party names ("WORLD SIKH ORGANIZATION OF CANADA")
# and blacklisting them truncates the block mid-name.
NOISE = re.compile(
    r"^\s*(?:CITATION|DATE|COURT\s+FILE|DOCKET|REGISTRY|CORAM|BEFORE|HEARD|RELEASED"
    r"|BETWEEN|ENTRE|VS?|No[s]?\.?|Nos|PROVINCE|IN\s+THE|SUPERIOR|SUPREME|DIVISIONAL"
    r"|REASONS|JUDGMENT|ENDORSEMENT|PUBLICATION|RESTRICTION|PUBLICATION\s+BAN"
    r"|THE\s+HONOURABLE|MR\.|MS\.|MRS\.|JUSTICE|COUNSEL|SOLICITORS?|FILE\s+No)\b",
    re.I,
)
SEPARATOR = re.compile(r"^\W*(?:-+\s*and\s*-+|and|et|v\.?|vs\.?|c\.?|BETWEEN|ENTRE|AND)\W*$", re.I)
DATEISH = re.compile(r"^\W*\d[\d\s\-–—/·,:.]*\W*$")

# A line ending in a judicial suffix is a member of the panel, not a party. The
# CORAM block in Quebec Court of Appeal judgments sits directly above the party
# block in the same upper case, so without this the walk climbs straight through
# it and records the judges as appellants (LC42 recorded Hilton, Dutil and Bich).
# "CORAM:"/"THE HONOURABLE" are already in NOISE, but the judge NAME lines are not.
JUDGE_LINE = re.compile(
    r",?\s*(?:JJ?\.?\s?[ACQS]?\.?|C\.?J\.?[ACQS]?\.?|J\.?C\.?[ASQ]\.?|J\.?S\.?C\.?)\s*$")

# A caps line ending in a connector is a wrapped party name, not a whole one.
CONTINUES = re.compile(r"\b(?:OF|AND|FOR|THE|DU|DE|DES|LA|LE|ET|POUR|&|,)\s*$", re.I)
# Where a BETWEEN: block stops.
BLOCK_END = re.compile(
    r"^\W*(?:BEFORE|HEARD|COUNSEL|REASONS|JUDGMENT|ENDORSEMENT|ON\s+APPEAL"
    r"|THE\s+HONOURABLE|MR\.|MS\.|MRS\.|JUSTICE|Charge|Date\s+of)\b", re.I)


def upperish(line: str) -> bool:
    """Party blocks are set in caps; use that to separate them from prose."""
    letters = [c for c in line if c.isalpha()]
    if len(letters) < 2:
        return False
    return sum(c.isupper() for c in letters) / len(letters) >= 0.6


def split_names(chunk: str) -> list[str]:
    """'A, B and C' -> ['A', 'B', 'C'], leaving single names untouched."""
    parts = re.split(r",\s*|\s+and\s+|\s+et\s+|\s*&\s*", chunk)
    return [p.strip(" ,;.") for p in parts if len(p.strip(" ,;.")) >= 3]


def clean(name: str) -> str:
    name = re.sub(r"\s+", " ", name).strip(" ,;.-–—")
    name = re.sub(r"\bet\s+al\b\.?", "", name, flags=re.I).strip(" ,;.-")
    return name


def from_judgment(text: str) -> list[dict]:
    """Walk the head, attributing the caps block above each role label to it."""
    head = re.sub(r"[ \t]+", " ", text[:HEAD_CHARS])
    lines = [l.strip() for l in head.split("\n")]
    lines = [l for l in lines if l]

    out, seen = [], set()
    for i, line in enumerate(lines):
        if not ROLE_LINE.match(line):
            continue
        role = next((lab for lab, rx in ROLE_OF if rx.match(line)), None)
        if role is None:
            continue
        # Collect the caps block immediately above this label.
        block, j = [], i - 1
        while j >= 0 and len(block) < 6:
            prev = lines[j]
            if (ROLE_LINE.match(prev) or NOISE.match(prev) or DATEISH.match(prev)
                    or JUDGE_LINE.search(prev)):
                break
            if SEPARATOR.match(prev):
                if block:
                    break          # separator between two party groups
                j -= 1
                continue           # separator directly above the label
            if not upperish(prev):
                break
            block.insert(0, prev)
            j -= 1
        if not block:
            continue
        for nm in split_names(clean(join_wrapped(block))):
            key = (nm.lower(), role)
            if nm and key not in seen:
                seen.add(key)
                out.append({"name": nm, "role": role})
    return out


def join_wrapped(block: list[str]) -> str:
    """Flatten a party block to one string for split_names().

    Line breaks inside a block are NOT a reliable party boundary: judgments wrap
    long names mid-phrase ("JOHN" / "DOE"), so treating each line as a party
    shatters them. Only the explicit separators — commas and "and" — are trusted,
    which is why blocks are space-joined here. The cost is that genuinely separate
    parties listed on their own lines with no punctuation merge into one string;
    LC2's interveners are the example. See the note in the module docstring.
    """
    return " ".join(block)


def from_between_block(text: str) -> list[dict]:
    """Parties from a BETWEEN: block that carries no role labels.

    Criminal matters are the common case — "BETWEEN: / HER MAJESTY THE QUEEN /
    — AND — / JAMES SEARS and LEROY ST. GERMAINE" — where the separator does all
    the work and no PLAINTIFF/DEFENDANT line ever appears. Roles stay null.
    """
    head = re.sub(r"[ \t]+", " ", text[:HEAD_CHARS])
    lines = [l.strip() for l in head.split("\n") if l.strip()]
    try:
        start = next(i for i, l in enumerate(lines) if re.match(r"^\W*(?:BETWEEN|ENTRE)\b", l, re.I))
    except StopIteration:
        return []

    groups, cur = [], []
    for line in lines[start + 1: start + 26]:
        if BLOCK_END.match(line) or ROLE_LINE.match(line):
            break
        if SEPARATOR.match(line):
            if cur:
                groups.append(cur)
                cur = []
            continue
        if (NOISE.match(line) or DATEISH.match(line) or JUDGE_LINE.search(line)
                or not upperish(line)):
            if cur:
                break                      # block finished at prose
            continue
        cur.append(line)
    if cur:
        groups.append(cur)
    if len(groups) < 2:                    # need at least two sides to be a real block
        return []

    out, seen = [], set()
    for g in groups:
        for nm in split_names(clean(join_wrapped(g))):
            if nm and nm.lower() not in seen:
                seen.add(nm.lower())
                out.append({"name": nm, "role": None})
    return out


# ── Anonymisation guard ───────────────────────────────────────────────────
# Where a court has withheld identities — by statute or by publication ban —
# the judgment body is NOT a safe source of party names: it may carry names the
# style of cause deliberately omits (see LC92, where a s. 126.2 identification
# ban applies and the body still names the judge, witnesses and third parties).
# These cases fall back to the style of cause, which is already anonymised, and
# are written to the review file for a human pass.
ANON_NAME = re.compile(r"^\[no public name\]$|Droit de la famille|Protection de la jeunesse", re.I)
INITIALS_PARTY = re.compile(r"^\W*(?:[A-Z]\.?){1,4}(?:[-\s][A-Z]\.?){0,2}\W*$")
# Initialisms that are institutions, not withheld identities. Without this, "R"
# (the Crown) matches INITIALS_PARTY and every "R v ..." prosecution is wrongly
# treated as anonymised — including publicly named accused such as Keegstra.
NOT_A_WITHHELD_NAME = {
    "R", "AG", "PG", "MNR", "CBC", "SRC", "STM", "RCMP", "GRC", "SQ", "CIC",
    "IRB", "CHRC", "OSC", "TTC", "UBC", "CRTC", "CRA", "CSIS", "LSO", "LSUC",
}
BAN_MARKERS = [
    ("publication ban",          re.compile(r"publication\s+ban", re.I)),
    ("restriction on publication", re.compile(r"restriction\s+on\s+publication", re.I)),
    ("identification ban",       re.compile(r"identification\s+ban", re.I)),
    ("non-publication (FR)",     re.compile(r"(?:ordonnance de )?non[-\s]publication|interdiction de publication", re.I)),
    ("Cr.C. s. 486.4/486.5",     re.compile(r"\b486\.[45]\b")),
    ("YCJA s. 110/111",          re.compile(r"Youth Criminal Justice Act.{0,60}\b11[01]\b", re.I | re.S)),
    ("CYFEA s. 126.2",           re.compile(r"\b126\.2\b")),
    ("may not be published",     re.compile(r"(?:shall|may|must)\s+not\s+(?:be\s+)?publish", re.I)),
]


def anonymisation_flags(case_name: str, text: str) -> list[str]:
    """Reasons this case should be treated as identity-protected. Empty if none."""
    flags = []
    if ANON_NAME.search(case_name or ""):
        flags.append("anonymised style of cause")
    sides = re.split(r"\s+[vVc]\.?\s+", case_name or "", maxsplit=1)
    if len(sides) == 2 and any(
        INITIALS_PARTY.match(s.strip())
        and s.strip().replace(".", "").replace("-", "").replace(" ", "").upper()
            not in NOT_A_WITHHELD_NAME
        for s in sides
    ):
        flags.append("initials-only party")
    head = (text or "")[:3000]
    for label, rx in BAN_MARKERS:
        if rx.search(head):
            flags.append(label)
    return flags


def from_style_of_cause(case_name: str) -> list[dict]:
    """Fallback: split the style of cause, roles unknown."""
    m = re.split(r"\s+[vVc]\.?\s+", case_name, maxsplit=1)
    if len(m) != 2:
        return []
    return [{"name": clean(s), "role": None} for s in m if clean(s)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="process every case (default: first 100)")
    ap.add_argument("--start", type=int, default=0, help="0-based index to start at")
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--only", default="", help="comma-separated case ids; ignores --start/--limit")
    args = ap.parse_args()

    paths = {}
    for p in glob.glob(os.path.join(CASES, "upper-JSON", "*.json")) + \
             glob.glob(os.path.join(CASES, "lower-JSON", "*.json")):
        paths[os.path.basename(p)[:-5]] = p
    ids = sorted(paths, key=lambda s: (0 if s.startswith("LC") else 1, int(re.sub(r"\D", "", s))))
    todo = ({i.strip() for i in args.only.split(',') if i.strip()} if args.only
            else set(ids if args.all else ids[args.start: args.start + args.limit]))

    # Existing rows are preserved so a windowed run tops up the file rather than
    # wiping the work already done (including the hand-written entries).
    existing = {}
    if os.path.exists(OUT):
        for line in open(OUT, encoding="utf-8"):
            if line.strip():
                r = json.loads(line)
                existing[r["case_id"]] = r.get("parties")

    review = open(REVIEW, "a", encoding="utf-8")
    if os.path.getsize(REVIEW) == 0 if os.path.exists(REVIEW) else True:
        review.write(
            "CASES REQUIRING ANONYMISATION REVIEW\n"
            "Party names were NOT read from the judgment body for these cases; the\n"
            "already-anonymised style of cause was used instead. Each needs a human\n"
            "pass to confirm nothing identifying was recorded (cf. LC92).\n"
            + "=" * 78 + "\n\n")
        review.flush()

    rows, stats = [], {"judgment": 0, "style_of_cause": 0, "none": 0, "guarded": 0}
    for cid in ids:
        if cid not in todo:
            rows.append({"case_id": cid, "parties": existing.get(cid)})
            continue
        d = json.load(open(paths[cid], encoding="utf-8"))
        text, name = d.get("text") or "", d.get("case_name") or ""

        flags = anonymisation_flags(name, text)
        if flags:
            stats["guarded"] += 1
            parties = from_style_of_cause(name)
            stats["style_of_cause" if parties else "none"] += 1
            review.write(
                f"{cid:7} {d.get('citation',''):28} {name[:44]}\n"
                f"        flags : {', '.join(flags)}\n"
                f"        action: style of cause only"
                f"{' — NO PARTIES, needs manual entry' if not parties else ''}\n\n")
            review.flush()          # written as we go, so a long run is watchable
        else:
            parties = from_judgment(text) or from_between_block(text)
            if parties:
                stats["judgment"] += 1
            else:
                parties = from_style_of_cause(name)
                stats["style_of_cause" if parties else "none"] += 1

        rows.append({"case_id": cid, "parties": parties or None})

    review.close()

    # The vocabulary is closed: an unrecognised role means the extractor invented
    # one, so fail loudly here rather than let a 25th value quietly appear.
    off = {p["role"] for r in rows for p in (r["parties"] or [])
           if p["role"] is not None and p["role"] not in VALID_ROLES}
    if off:
        raise SystemExit(f"off-vocabulary roles produced: {sorted(off)}")

    with open(OUT, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    n = max(len(todo), 1)
    print(f"wrote {OUT}  ({len(rows)} rows, {sum(1 for r in rows if r['parties'])} populated overall)")
    print(f"processed this run: {len(todo)}")
    print(f"  from judgment body : {stats['judgment']:4}  ({stats['judgment']/n*100:.0f}%)")
    print(f"  from style of cause: {stats['style_of_cause']:4}  ({stats['style_of_cause']/n*100:.0f}%)")
    print(f"  nothing extracted  : {stats['none']:4}  ({stats['none']/n*100:.0f}%)")
    print(f"  anonymisation-guarded (logged to review file): {stats['guarded']}")
    print(f"review file: {REVIEW}")


if __name__ == "__main__":
    main()
