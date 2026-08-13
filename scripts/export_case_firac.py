#!/usr/bin/env python3
"""Extract the FIRAC analyses out of the generation notes into cases-JSON/case_firac.jsonl.

Reads : cases-JSON/case_metadata_generation_notes.jsonl  (fields: case_id, firac)
Writes: cases-JSON/case_firac.jsonl

OUTPUT SHAPE — flat, one record per FIRAC block, mirroring the `case_firac` table
1:1 so the importer is a straight field->column loop:

    {"case_id":"UC1","seq":1,"issue":"…","facts":"…","rule":"…",
     "application":"…","conclusion":"…"}

`seq` is the 1-based position of the block within its case (it restarts at 1 for
every case). SQL rows have no inherent order, so `seq` is what preserves the order
the issues were analysed in; always ORDER BY seq when reading them back.

Use --nested to emit one record per CASE instead ({"case_id":…, "firac":[…]}),
which is not what the table wants but is handy for inspection.

Usage:
    python3 scripts/export_case_firac.py --dry-run   # report only, write nothing
    python3 scripts/export_case_firac.py             # write case_firac.jsonl
    python3 scripts/export_case_firac.py --nested    # one record per case
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOTES = ROOT / "cases-JSON" / "case_metadata_generation_notes.jsonl"
OUT = ROOT / "cases-JSON" / "case_firac.jsonl"

# column order of the case_firac table
FIELDS = ("issue", "facts", "rule", "application", "conclusion")


def load_jsonl(path: Path) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--notes", type=Path, default=NOTES)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--nested", action="store_true",
                    help="emit one record per case ({case_id, firac:[...]}) instead of one per block")
    ap.add_argument("--dry-run", action="store_true", help="report only; write nothing")
    args = ap.parse_args()

    if not args.notes.exists():
        print(f"ERROR: {args.notes} not found", file=sys.stderr)
        return 1

    notes = load_jsonl(args.notes)
    records, no_firac, missing_field = [], [], Counter()

    for note in notes:
        cid = note.get("case_id")
        blocks = note.get("firac") or []
        if not blocks:
            no_firac.append(cid)
            continue
        if args.nested:
            records.append({"case_id": cid, "firac": blocks})
            continue
        for seq, b in enumerate(blocks, start=1):
            rec = {"case_id": cid, "seq": seq}
            for f in FIELDS:
                if f not in b or b.get(f) is None:
                    missing_field[f] += 1
                rec[f] = b.get(f)
            records.append(rec)

    # ---- report ----
    per_case = Counter()
    for note in notes:
        per_case[len(note.get("firac") or [])] += 1
    print(f"notes records        : {len(notes)}")
    print(f"cases with no firac  : {len(no_firac)}" + (f" -> {no_firac[:10]}" if no_firac else ""))
    print(f"output shape         : {'nested (1 per case)' if args.nested else 'flat (1 per FIRAC block)'}")
    print(f"records to write     : {len(records)}")
    if not args.nested:
        print(f"blocks per case      : " + "  ".join(f"{k}:{v}" for k, v in sorted(per_case.items()) if k))
        print(f"max seq              : {max((r['seq'] for r in records), default=0)}")
        if missing_field:
            print(f"NULL/missing fields  : {dict(missing_field)}")
        print(f"key order            : {list(records[0].keys()) if records else '-'}")

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return 0

    tmp = args.out.with_suffix(args.out.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    tmp.replace(args.out)
    print(f"\nwritten              : {args.out.relative_to(ROOT)}  "
          f"({args.out.stat().st_size / 1e6:.1f} MB)")

    # ---- verify round-trip ----
    back = load_jsonl(args.out)
    ok = len(back) == len(records)
    if not args.nested:
        # (case_id, seq) must be unique, and seq must be a dense 1..N run per case
        keys = Counter((r["case_id"], r["seq"]) for r in back)
        dupes = [k for k, v in keys.items() if v > 1]
        by_case: dict[str, list[int]] = {}
        for r in back:
            by_case.setdefault(r["case_id"], []).append(r["seq"])
        bad_seq = [c for c, s in by_case.items() if sorted(s) != list(range(1, len(s) + 1))]
        print(f"verify: records={len(back)}  unique (case_id,seq)={not dupes}  "
              f"dense seq per case={not bad_seq}  cases={len(by_case)}")
        if dupes:
            print(f"  DUPLICATE KEYS: {dupes[:5]}")
        if bad_seq:
            print(f"  NON-DENSE seq : {bad_seq[:5]}")
        ok = ok and not dupes and not bad_seq
    else:
        print(f"verify: records={len(back)}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
