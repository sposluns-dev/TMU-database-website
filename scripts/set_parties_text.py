#!/usr/bin/env python3
"""
Fill cases-JSON/case_metadata.jsonl's `parties` field with the party NAMES as one
plain text string, taken from cases-JSON/case_metadata_parties.jsonl.

    before:  "parties": null
    after:   "parties": "Ontario (Attorney General) | Dieleman | Torcan Women's ..."

ROLES ARE DROPPED. Only the `name` of each entry is kept. Names stay in
style-of-cause order (captions list appellants before respondents, and that order
carries meaning), so this is a concatenation, not a set.

WHY THE EDIT IS TEXTUAL, NOT A RE-SERIALISATION
Four lines in case_metadata.jsonl carry \\uXXXX escapes while every other line is
raw UTF-8. Round-tripping the file through json.dumps would silently rewrite that
encoding on those lines. Key order is fixed, so `parties` is always followed by
`summary`: this matches from one to the other and leaves every other byte alone.

A case with no extracted parties (128 of them -- the anonymisation-guarded ones)
stays null. NULL still means "not extracted", which is NOT the same as a case with
no parties, and '' would erase that distinction.

Usage:
    python3 scripts/set_parties_text.py --first 1          # test on one record
    python3 scripts/set_parties_text.py --first 1 --dry-run
    python3 scripts/set_parties_text.py                    # all records
    python3 scripts/set_parties_text.py --sep ' '          # different separator
    python3 scripts/set_parties_text.py --dedupe           # collapse repeated names
"""
import argparse
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_DIR = os.path.join(ROOT, "cases-JSON")
METADATA = os.path.join(JSON_DIR, "case_metadata.jsonl")
PARTIES = os.path.join(JSON_DIR, "case_metadata_parties.jsonl")

# `parties` is always followed by `summary` (fixed key order), so this brackets the
# value precisely without needing to balance brackets or quotes inside it.
PAT = re.compile(r'"parties": .*?, "summary": ')


def names_of(parties, dedupe: bool) -> list[str]:
    """The name of each entry, in order, blanks dropped."""
    out, seen = [], set()
    for p in parties or []:
        if not isinstance(p, dict):
            continue
        name = (p.get("name") or "").strip()
        if not name:
            continue
        if dedupe:
            key = name.casefold()
            if key in seen:
                continue
            seen.add(key)
        out.append(name)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--first", type=int, metavar="N",
                    help="only rewrite the first N records (test mode)")
    ap.add_argument("--sep", default=" | ", help="separator between names (default ' | ')")
    ap.add_argument("--dedupe", action="store_true",
                    help="drop a name already seen on the same case "
                         "(10 cases repeat a name; LC2 repeats 27)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would change, write nothing")
    args = ap.parse_args()

    for p in (METADATA, PARTIES):
        if not os.path.exists(p):
            sys.exit(f"missing input: {p}")

    parties_by_case = {}
    for line in open(PARTIES, encoding="utf-8"):
        if line.strip():
            d = json.loads(line)
            parties_by_case[d["case_id"]] = d.get("parties")

    out, filled, left_null, no_record, unmatched = [], 0, 0, [], []
    changed_preview = []

    for i, line in enumerate(open(METADATA, encoding="utf-8")):
        if not line.strip():
            out.append(line)
            continue
        if args.first is not None and filled + left_null >= args.first:
            out.append(line)                      # past the test window: untouched
            continue

        cid = json.loads(line)["case_id"]
        if cid not in parties_by_case:
            no_record.append(cid)
            out.append(line)
            continue

        names = names_of(parties_by_case[cid], args.dedupe)
        if not names:
            left_null += 1
            out.append(line)                      # stays null; see module docstring
            continue

        value = json.dumps(args.sep.join(names), ensure_ascii=False)
        new, n = PAT.subn(f'"parties": {value}, "summary": ', line, count=1)
        if n != 1:
            unmatched.append(i + 1)
            out.append(line)
            continue
        filled += 1
        if len(changed_preview) < 3:
            changed_preview.append((cid, json.loads(value)))
        out.append(new)

    if unmatched:
        sys.exit(f"ABORTED, nothing written — `parties` pattern did not match on "
                 f"lines {unmatched[:10]} ({len(unmatched)} total)")

    for cid, val in changed_preview:
        print(f"{cid}\n  parties = {val}\n")
    print(f"filled: {filled}   left null: {left_null}"
          + (f"   no parties record: {len(no_record)}" if no_record else ""))

    if args.dry_run:
        print("dry run — nothing written")
        return

    backup = METADATA + ".bak-parties-text"
    shutil.copyfile(METADATA, backup)
    with open(METADATA, "w", encoding="utf-8") as fh:
        fh.writelines(out)
    print(f"wrote {os.path.relpath(METADATA, ROOT)} "
          f"(backup: {os.path.relpath(backup, ROOT)})")


if __name__ == "__main__":
    main()
