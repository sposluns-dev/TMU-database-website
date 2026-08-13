#!/usr/bin/env python3
"""Second pass: fill role=null by reading the label beside the party in the text.

Roles come out null when the extractor fell back to splitting the style of cause
— which happens whenever the party block is set in title case or lower case, so
upperish() rejected it even though the labels are right there. This pass goes
back to each judgment, locates the party by name, and reads the role label
adjacent to it, at any capitalisation.

Rules kept deliberately tight, because a wrong role is worse than a null one:
  * the label must appear WITHIN `WINDOW` characters after the name, and no other
    party name may intervene;
  * the label must sit on its own line or be delimited — "Plaintiff" in running
    prose ("the plaintiff argues") is ignored;
  * language follows the label found, so a French block yields CPC roles;
  * anonymisation-guarded cases are skipped entirely — their roles must not be
    inferred from a body we have chosen not to read.

Usage:
    python3 scripts/resolve_roles.py --dry-run     # report only
    python3 scripts/resolve_roles.py               # write
"""
import argparse
import collections
import glob
import importlib.util
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = os.path.join(ROOT, "cases-JSON")
PARTIES = os.path.join(CASES, "case_metadata_parties.jsonl")

_spec = importlib.util.spec_from_file_location("ep", os.path.join(ROOT, "scripts", "extract_parties.py"))
ep = importlib.util.module_from_spec(_spec)
sys.argv = [sys.argv[0]]
_spec.loader.exec_module(ep)

HEAD = 9000
WINDOW = 160          # a role label further than this from the name is not its label

# Label -> canonical role. Ordered longest-first so "Responding party" wins over
# "Respondent" prefixes and "Mis en cause" is matched whole.
LABELS = [
    ("Responding party", r"responding part(?:y|ies)"),
    ("Moving party",     r"moving part(?:y|ies)"),
    ("Mis en cause",     r"mise?s?\s+en\s+cause"),
    ("Intervener",       r"interven[eo]rs?"),
    ("Intervenant",      r"intervenante?s?"),
    ("Petitioner",       r"petitioners?"),
    ("Appellant",        r"appellants?"),
    ("Appelant",         r"appelante?s?"),
    ("Respondent",       r"respondents?"),
    ("Intimé",           r"intim[ée]e?s?"),
    ("Applicant",        r"applicants?"),
    ("Requérant",        r"requ[ée]rante?s?"),
    ("Plaintiff",        r"plaintiffs?"),
    ("Demandeur",        r"demand(?:eur|eresse)s?"),
    ("Defendant",        r"defendants?"),
    ("Défendeur",        r"d[ée]fend(?:eur|eresse)s?"),
    ("Claimant",         r"claimants?"),
    ("Accused",          r"accused"),
    ("Accusé",           r"accus[ée]e?s?"),
    ("Bankrupt",         r"bankrupts?|faillie?s?"),
    ("Debtor",           r"debtors?|d[ée]biteurs?"),
    ("Creditor",         r"creditors?|cr[ée]anciers?"),
    ("Trustee",          r"trustees?|syndics?"),
    ("Child",            r"children|child|enfants?"),
]
# Anchored so the label is a standalone token, not a word inside a sentence.
LABEL_RX = [(role, re.compile(r"(?:^|[\n\r|)\-–—,:;\s])\s*" + pat + r"\s*(?:$|[\n\r|(\-–—,:;.])", re.I | re.M))
            for role, pat in LABELS]
PROSE = re.compile(r"\b(?:the|le|la|les|a|an|des|du)\s*$", re.I)


def find_role(head: str, name: str, others: list[str]) -> str | None:
    toks = [t for t in re.findall(r"[A-Za-zÀ-ÿ']{4,}", name)]
    if not toks:
        return None
    anchor = re.search(re.escape(toks[-1]), head, re.I)
    if not anchor:
        return None
    seg = head[anchor.end(): anchor.end() + WINDOW]
    # stop at the next party, so we never read a neighbour's label
    for o in others:
        ot = [t for t in re.findall(r"[A-Za-zÀ-ÿ']{4,}", o)]
        if ot:
            m = re.search(re.escape(ot[-1]), seg, re.I)
            if m:
                seg = seg[: m.start()]
    best = None
    for role, rx in LABEL_RX:
        m = rx.search(seg)
        if m and not PROSE.search(seg[: m.start()]):
            if best is None or m.start() < best[1]:
                best = (role, m.start())
    return best[0] if best else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    paths = {os.path.basename(p)[:-5]: p for p in glob.glob(os.path.join(CASES, "*-JSON", "*.json"))}
    rows = [json.loads(l) for l in open(PARTIES, encoding="utf-8") if l.strip()]

    resolved = collections.Counter()
    touched = skipped_guard = still_null = 0
    samples = []

    for r in rows:
        ps = r.get("parties")
        if not ps or all(p["role"] for p in ps):
            continue
        d = json.load(open(paths[r["case_id"]], encoding="utf-8"))
        name, text = d.get("case_name") or "", d.get("text") or ""
        if ep.anonymisation_flags(name, text):
            skipped_guard += 1
            continue
        head = re.sub(r"[ \t]+", " ", text[:HEAD])
        names = [p["name"] for p in ps]
        got = False
        for p in ps:
            if p["role"]:
                continue
            role = find_role(head, p["name"], [n for n in names if n != p["name"]])
            if role:
                p["role"] = role
                resolved[role] += 1
                got = True
                if len(samples) < 30:
                    samples.append((r["case_id"], p["name"][:34], role, name[:34]))
            else:
                still_null += 1
        if got:
            touched += 1

    if not args.dry_run:
        open(PARTIES, "w", encoding="utf-8").write(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))

    print(f"cases updated            : {touched}")
    print(f"roles resolved           : {sum(resolved.values())}")
    print(f"still null               : {still_null}")
    print(f"skipped (guarded)        : {skipped_guard}")
    print("\nby role:")
    for k, v in resolved.most_common():
        print(f"   {v:5}  {k}")
    print("\nsample:")
    for s in samples[:20]:
        print(f"   {s[0]:7} {s[1]:36} -> {s[2]:16} | {s[3]}")


if __name__ == "__main__":
    main()
