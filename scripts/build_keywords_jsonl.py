#!/usr/bin/env python3
"""
Builder — keyword-vocab.csv  ->  cases-JSON/keywords.jsonl

One line per controlled-vocabulary term, with fields named exactly like the
`keywords` table columns in db/schema.sql, so the importer is a
straight field->column loop:

    keyword_id, canonical_en, canonical_fr, tier, area

The CSV's `synonyms` column is deliberately DROPPED. Synonyms are a search-time
query-expansion concern (see Keyword-Search-Design.md), not a stored relation —
the schema has no synonym table and none is created here.

Usage:
    python scripts/build_keywords_jsonl.py
"""
import csv
import json
import os
import sys

ROOT  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV   = os.path.join(ROOT, "server", "keyword-vocab.csv")
JSONL = os.path.join(ROOT, "cases-JSON", "keywords.jsonl")

# CSV header -> JSONL key (schema column name). `synonyms` is intentionally absent.
FIELDS = {
    "id":           "keyword_id",
    "canonical":    "canonical_en",
    "canonical_fr": "canonical_fr",
    "tier":         "tier",
    "area":         "area",
}


def clean(v):
    """Trim; empty string -> None."""
    if v is None:
        return None
    v = v.strip()
    return v or None


def main():
    if not os.path.exists(CSV):
        sys.exit(f"vocab not found: {CSV}")

    rows, seen = [], set()
    with open(CSV, encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        missing = [c for c in FIELDS if c not in reader.fieldnames]
        if missing:
            sys.exit(f"{CSV}: missing column(s): {', '.join(missing)}")

        for i, row in enumerate(reader, 2):  # line 2 = first data row
            kid = clean(row["id"])
            if kid is None:
                continue  # blank trailing line
            if kid in seen:
                sys.exit(f"{CSV}:{i}: duplicate keyword_id {kid}")
            seen.add(kid)

            if clean(row["canonical"]) is None:
                sys.exit(f"{CSV}:{i}: {kid} has no canonical (NOT NULL in schema)")

            tier = clean(row["tier"])
            if tier is not None:
                if tier not in ("1", "2", "3"):
                    sys.exit(f"{CSV}:{i}: {kid} tier {tier!r} violates valid_tier CHECK")
                tier = int(tier)

            rows.append({
                "keyword_id":   kid,
                "canonical_en": clean(row["canonical"]),
                "canonical_fr": clean(row["canonical_fr"]),
                "tier":         tier,
                "area":         clean(row["area"]),
            })

    with open(JSONL, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    tiers = {t: sum(1 for r in rows if r["tier"] == t) for t in (1, 2, 3)}
    print(f"wrote {len(rows)} keywords -> {os.path.relpath(JSONL, ROOT)}")
    print(f"  tier 1 (practice area): {tiers[1]}")
    print(f"  tier 2 (topic):         {tiers[2]}")
    print(f"  tier 3 (entity):        {tiers[3]}")


if __name__ == "__main__":
    main()
