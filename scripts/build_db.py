#!/usr/bin/env python3
"""
Build db/cases.db from scratch, from the JSON/JSONL sources.

cases.db is a BUILD ARTIFACT — everything in it comes from files under
cases-JSON/ and keyword-vocab.csv, so this script never has to preserve
anything already in the database. It builds into a temp file and then
atomically replaces cases.db, so an interrupted or failed build leaves the
existing database untouched.

Load order matters (foreign keys):

    keyword-vocab.csv -> keywords.jsonl  ->  keywords        (no parents)
    cases-JSON/lower-JSON/LC*.json       ->  cases           (no parents)
    cases-JSON/upper-JSON/UC*.json       ->  cases
    cases-JSON/case_metadata.jsonl       ->  case_metadata   (FK -> cases)
    cases-JSON/case_firac.jsonl          ->  case_firac      (FK -> cases)

cases_fts is populated by the AFTER INSERT trigger in schema.sql — no separate
indexing pass. names_fts is NOT: it indexes case_metadata.parties, which
do not exist until load_metadata has run, so it is rebuilt explicitly after all
loaders (see the names_fts note in schema.sql).

Values that would violate a CHECK constraint are set to NULL and reported at
the end rather than aborting the build (the scrapers emit the string "None"
and a handful of unparseable dates). Rows whose case_id has no parent in
`cases` are skipped and reported.

The build also warns when a court code in the data is absent from the
hand-maintained tables in the website's taxonomy.ts (see check_taxonomy).
That is a warning, not an integrity failure — the database is fine, the
website is stale — so it never discards the build.

Usage:
    python scripts/build_db.py            # full rebuild
    python scripts/build_db.py --keep-going   # don't exit 1 on integrity failures
"""
import csv
import json
import os
import re
import sqlite3
import sys
import unicodedata
from datetime import datetime

ROOT     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB       = os.path.join(ROOT, "db", "cases.db")
SCHEMA   = os.path.join(ROOT, "db", "schema.sql")
VOCAB    = os.path.join(ROOT, "server", "keyword-vocab.csv")
JSON_DIR = os.path.join(ROOT, "cases-JSON")
LOWER    = os.path.join(JSON_DIR, "lower-JSON")
UPPER    = os.path.join(JSON_DIR, "upper-JSON")
KEYWORDS = os.path.join(JSON_DIR, "keywords.jsonl")
METADATA = os.path.join(JSON_DIR, "case_metadata.jsonl")
# Parties live in their own file, not in case_metadata.jsonl: extraction and role
# resolution are a separate pipeline (extract_parties.py -> resolve_roles.py ->
# set_parties_text.py). Read here only to cross-check the flattened text column.
PARTIES  = os.path.join(JSON_DIR, "case_metadata_parties.jsonl")
FIRAC    = os.path.join(JSON_DIR, "case_firac.jsonl")
NOTES    = os.path.join(JSON_DIR, "case_metadata_generation_notes.jsonl")
# Front-end court vocabulary, cross-checked against the data (see check_taxonomy).
# Optional input: absent in a server-only checkout, in which case the check is skipped.
TAXONOMY = os.path.join(ROOT, "TMU-database-website", "src", "lib", "taxonomy.ts")

# ---------------------------------------------------------------------------
# DELIBERATELY REMOVED CASES
#
# Removing a duplicate case deletes its cases-JSON/*.json file, but its rows in
# case_metadata / case_firac / generation-notes remain. Those rows then have no
# parent in `cases`, so the loaders skip them — correctly, but indistinguishably
# from a case that went missing by accident.
#
# So removals are RECORDED, two ways, and both count as "expected":
#   1. the case file was moved to cases-JSON/_removed-duplicates/, or
#   2. the case_id is listed in cases-JSON/_removed-cases.txt
#      (one id per line; "# reason" comments and blank lines ignored).
#
# An orphan that is recorded is reported as a quiet one-line summary. An orphan
# that is NOT recorded is a real problem and is reported loudly, because it means
# a case vanished without anyone saying so.
# ---------------------------------------------------------------------------
REMOVED_DIR      = os.path.join(JSON_DIR, "_removed-duplicates")
REMOVED_MANIFEST = os.path.join(JSON_DIR, "_removed-cases.txt")

# Which generation-notes fields to keep in case_notes.notes. The bulky `firac`
# and `defining_issues` are omitted — they already live in their own tables.
NOTE_FIELDS = (
    "name_verification", "keywords_rationale", "location_rationale",
    "registry_rationale", "collisions", "warnings",
    "completion_note", "duplicate_note", "model",
)

# ---------------------------------------------------------------------------
# PARTIES — one plain text column, no roles, no buckets.
#
# case_metadata.parties arrives ALREADY FLATTENED in case_metadata.jsonl: the party
# names for a case, space-joined in style-of-cause order, written there by
# scripts/set_parties_text.py from case_metadata_parties.jsonl. This loader copies
# the string through and does not parse it.
#
# WHAT USED TO BE HERE. Roles were resolved against a closed 36-term vocabulary and
# used to split the names into two weighted FTS columns — p_princ (contesting
# parties) and p_other (interveners and the like) — so a named respondent would
# outrank an intervener on the same surname. That is GONE, along with the schema
# columns it fed. Measured on this corpus it moved very little: only 12% of cases
# have any non-contesting party at all, and it did nothing for individual surnames.
# See the "WHY THE ROLES WERE DROPPED" paragraph in schema.sql.
#
# The roles themselves are NOT lost — cases-JSON/case_metadata_parties.jsonl remains
# the structured source of truth, one {"name","role"} object per party. The database
# deliberately does not carry them; read the side file if you need to know who was
# the appellant.
#
# The side file is still loaded here, but only to CROSS-CHECK the flattened column
# (see load_metadata): a case with extracted parties whose text came through empty
# means set_parties_text.py was never run, or was run before the parties file was
# last corrected, and every one of that case's party names is unsearchable.
# ---------------------------------------------------------------------------

anomalies = []   # (case_id, column, offending value) — value was NULLed
skipped   = []   # (table, case_id, why) — row was dropped


def load_removed() -> dict:
    """case_id -> why it is known to be gone. See the REMOVED_* note above."""
    removed = {}
    if os.path.isdir(REMOVED_DIR):
        for fn in os.listdir(REMOVED_DIR):
            if fn.endswith(".json"):
                removed[fn[:-5]] = "in _removed-duplicates/"
    if os.path.exists(REMOVED_MANIFEST):
        with open(REMOVED_MANIFEST, encoding="utf-8") as fh:
            for line in fh:
                line = line.split("#", 1)[0].strip()
                if line:
                    removed.setdefault(line, "listed in _removed-cases.txt")
    return removed


REMOVED = load_removed()


# ---------------------------------------------------------------------------
# normalizers — every value must satisfy the CHECK constraints in schema.sql
# ---------------------------------------------------------------------------

def clean(v):
    """Trim; '' and the scrapers' literal string 'None' -> None."""
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        return None if v in ("", "None") else v
    return v


def norm_date(v, cid):
    """Strict YYYY-MM-DD, calendar-validated (mirrors valid_date)."""
    v = clean(v)
    if v is None:
        return None
    try:
        datetime.strptime(v, "%Y-%m-%d")
        return v
    except ValueError:
        anomalies.append((cid, "date", v))
        return None


def norm_language(v, cid):
    v = clean(v)
    if v is None:
        return None
    lo = v.lower()
    if lo in ("en", "fr"):
        return lo
    anomalies.append((cid, "language", v))
    return None


def norm_source(v, cid):
    v = clean(v)
    if v is None or v in ("CanLII", "A2AJ"):
        return v
    anomalies.append((cid, "source", v))
    return None


def norm_url(v, cid):
    """http(s)://host.tld shaped only (mirrors valid_url)."""
    v = clean(v)
    if v is None:
        return None
    lo = v.lower()
    if (lo.startswith("http://") or lo.startswith("https://")) and "." in v.split("://", 1)[1]:
        return v
    anomalies.append((cid, "url", v))
    return None


def as_json_array(v, cid, field):
    """Store list-valued fields as a JSON array TEXT (queried with json_each)."""
    if v is None:
        return None
    if isinstance(v, str):          # already serialized upstream
        v = clean(v)
        if v is None:
            return None
        try:
            v = json.loads(v)
        except json.JSONDecodeError:
            anomalies.append((cid, field, v[:60]))
            return None
    if not isinstance(v, list):
        anomalies.append((cid, field, repr(v)[:60]))
        return None
    return json.dumps(v, ensure_ascii=False)


# ---------------------------------------------------------------------------
# readers
# ---------------------------------------------------------------------------

def read_jsonl(path):
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as e:
                sys.exit(f"{path}:{i}: invalid JSON: {e}")


def read_case_dir(path, prefix):
    for fn in sorted(os.listdir(path)):
        if fn.startswith(prefix) and fn.endswith(".json"):
            with open(os.path.join(path, fn), encoding="utf-8") as fh:
                try:
                    yield json.load(fh)
                except json.JSONDecodeError as e:
                    sys.exit(f"{os.path.join(path, fn)}: invalid JSON: {e}")


def read_keywords():
    """keywords.jsonl if present, else derive it straight from keyword-vocab.csv."""
    if os.path.exists(KEYWORDS):
        for r in read_jsonl(KEYWORDS):
            yield r
        return
    with open(VOCAB, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            if not clean(row.get("id")):
                continue
            tier = clean(row.get("tier"))
            yield {
                "keyword_id":   clean(row["id"]),
                "canonical_en": clean(row["canonical"]),
                "canonical_fr": clean(row.get("canonical_fr")),
                "tier":         int(tier) if tier in ("1", "2", "3") else None,
                "area":         clean(row.get("area")),
            }


# ---------------------------------------------------------------------------
# loaders
# ---------------------------------------------------------------------------

def load_keywords(conn):
    rows = [(r["keyword_id"], r["canonical_en"], r.get("canonical_fr"),
             r.get("tier"), r.get("area")) for r in read_keywords()]
    conn.executemany(
        "INSERT INTO keywords (keyword_id, canonical_en, canonical_fr, tier, area) "
        "VALUES (?,?,?,?,?)", rows)
    return len(rows)


# Abbreviations expanded so the same litigation keys identically however the
# reporter wrote it. Only forms actually present in this corpus, and only ones
# with a single unambiguous expansion -- "S.C." could be Supreme Court or Superior
# Court, so it is deliberately absent.
NAME_ABBREV = {
    "ltd": "limited", "ltee": "limited", "inc": "incorporated",
    "co": "company", "cie": "company", "corp": "corporation",
    "assn": "association", "soc": "society", "dist": "district",
    "bd": "board", "dept": "department",
}

# Captions that identify no litigation. The 122 anonymized RAD decisions all
# share "[no public name]", which without this would be ONE 122-member family --
# a single text hit anywhere in it would promote all 122 into the results.
NAME_PLACEHOLDERS = ("no public name",)


def name_key(case_name):
    """Normalized caption, shared by every record of the same litigation.

    "Snyder v. Montreal Gazette Ltd." at QCCS, QCCA and SCC -> the same key, so
    priority 3 can promote the whole family when any member matches.

    Deliberately drops the separator (`v`, `vs`, `c`) rather than unifying it.
    That is what merges the French and English records of one Quebec case:
    verified on this corpus it correctly joins "Syndicat Northcrest c. Amselem"
    (QCCS) to "Syndicat Northcrest v. Amselem" (SCC), plus the Joseph/Concordia
    and Bou Malhab pairs.

    Returns None where no family should be formed -- the caller stores NULL.

    Best-effort by nature: the corpus has no docket number, so the caption is all
    there is. Measured on 1,587 cases this yields 1,272 singletons and 80
    families, the largest being 6 (R. v. Keegstra across ABQB/ABCA/SCC).
    """
    if not case_name:
        return None
    s = unicodedata.normalize("NFKD", case_name)
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).lower()
    if any(p in s for p in NAME_PLACEHOLDERS):
        return None
    s = re.sub(r"\(\s*no\.?\s*\d+\s*\)", " ", s)     # drop "(No. 1)"
    s = re.sub(r"\bet\s+al\b", " ", s)               # drop "et al"
    s = re.sub(r"[^a-z0-9]+", " ", s)                # fold punctuation
    toks = [NAME_ABBREV.get(t, t) for t in s.split() if t not in ("v", "vs", "c")]
    return " ".join(toks) or None


def load_cases(conn):
    n = 0
    for path, prefix in ((LOWER, "LC"), (UPPER, "UC")):
        rows = []
        for d in read_case_dir(path, prefix):
            cid = clean(d.get("id")) or clean(d.get("case_id"))
            if cid is None:
                skipped.append(("cases", f"<{path}>", "no id"))
                continue
            nm = clean(d.get("case_name"))
            rows.append((
                cid,
                clean(d.get("citation")),
                nm,
                clean(d.get("court")),
                norm_date(d.get("date"), cid),
                norm_language(d.get("language"), cid),
                norm_url(d.get("url"), cid),
                norm_source(d.get("source"), cid),
                clean(d.get("text")),
                name_key(nm),
            ))
        conn.executemany(
            "INSERT INTO cases (case_id, citation, case_name, court, date, "
            "language, url, source, text, name_key) VALUES (?,?,?,?,?,?,?,?,?,?)",
            rows)
        n += len(rows)
    return n


def load_metadata(conn):
    known = {r[0] for r in conn.execute("SELECT case_id FROM cases")}

    # The side file is NOT the source of the `parties` column any more — the
    # flattened text in case_metadata.jsonl is. It is read only to answer "did this
    # case have parties extracted at all", so a case whose text is missing while its
    # parties are known can be reported rather than silently losing every name.
    extracted = {}
    for d in read_jsonl(PARTIES):
        pid = clean(d.get("case_id"))
        if pid:
            p = d.get("parties")
            extracted[pid] = len(p) if isinstance(p, list) else 0

    rows, missing_text = [], []
    for d in read_jsonl(METADATA):
        cid = clean(d.get("case_id"))
        if cid not in known:
            skipped.append(("case_metadata", cid, "no such case"))
            continue
        # Plain text, passed through. NULL vs '' is a real distinction the schema
        # relies on: NULL means no parties were extracted (anonymisation guard, or a
        # caption the parser could not read), NOT that the case had none. clean()
        # already maps '' to None, so '' is never written.
        parties = clean(d.get("parties"))
        if parties is None and extracted.get(cid):
            missing_text.append(cid)
        rows.append((
            cid,
            clean(d.get("city")),
            clean(d.get("province")),
            clean(d.get("registry")),
            as_json_array(d.get("keyword_ids"), cid, "keyword_ids"),
            parties,
            clean(d.get("summary")),
            clean(d.get("resume")),
            as_json_array(d.get("defining_issues"), cid, "defining_issues"),
            clean(d.get("practice_area")),
        ))
    conn.executemany(
        "INSERT INTO case_metadata (case_id, city, province, registry, keyword_ids, "
        "parties, summary, resume, defining_issues, practice_area) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)", rows)

    if missing_text:
        skipped.append(("parties text", f"{len(missing_text)} case(s) e.g. "
                        f"{', '.join(missing_text[:5])}",
                        "parties extracted but `parties` text is NULL — "
                        "run scripts/set_parties_text.py"))

    # Parties for a case_id that never made it into case_metadata are silently lost
    # otherwise -- surface them the same way other orphans are reported.
    for pid in extracted.keys() - known:
        skipped.append(("case_parties", pid, "no such case"))
    return len(rows)


def load_firac(conn):
    known = {r[0] for r in conn.execute("SELECT case_id FROM cases")}
    rows, seen = [], set()
    for d in read_jsonl(FIRAC):
        cid = clean(d.get("case_id"))
        seq = d.get("seq")
        if cid not in known:
            skipped.append(("case_firac", cid, "no such case"))
            continue
        if not isinstance(seq, int) or seq < 1:
            skipped.append(("case_firac", cid, f"bad seq {seq!r}"))
            continue
        if (cid, seq) in seen:
            skipped.append(("case_firac", cid, f"duplicate seq {seq}"))
            continue
        seen.add((cid, seq))
        issue = clean(d.get("issue"))
        if issue is None:                      # issue is NOT NULL
            skipped.append(("case_firac", cid, f"seq {seq} has no issue"))
            continue
        rows.append((cid, seq, issue, clean(d.get("facts")), clean(d.get("rule")),
                     clean(d.get("application")), clean(d.get("conclusion"))))
    conn.executemany(
        "INSERT INTO case_firac (case_id, seq, issue, facts, rule, application, "
        "conclusion) VALUES (?,?,?,?,?,?,?)", rows)
    return len(rows)


def load_notes(conn):
    """Generation-provenance JSON, one row per case (NOTE_FIELDS only)."""
    known = {r[0] for r in conn.execute("SELECT case_id FROM cases")}
    rows = []
    for d in read_jsonl(NOTES):
        cid = clean(d.get("case_id"))
        if cid not in known:
            skipped.append(("case_notes", cid, "no such case"))
            continue
        # Keep only the rationale fields, dropping empties so the blob stays lean.
        notes = {k: d[k] for k in NOTE_FIELDS if d.get(k) not in (None, "", [], {})}
        rows.append((cid, json.dumps(notes, ensure_ascii=False) if notes else None))
    conn.executemany("INSERT INTO case_notes (case_id, notes) VALUES (?,?)", rows)
    return len(rows)


# ---------------------------------------------------------------------------
# post-build verification — the checks documented at the bottom of schema.sql
# ---------------------------------------------------------------------------

def verify(conn):
    problems = []

    orphans = conn.execute("""
        SELECT m.case_id, j.value
        FROM case_metadata m, json_each(m.keyword_ids) j
        LEFT JOIN keywords k ON k.keyword_id = j.value
        WHERE k.keyword_id IS NULL""").fetchall()
    if orphans:
        problems.append(f"{len(orphans)} keyword_ids reference a missing keyword "
                        f"(e.g. {orphans[0][0]} -> {orphans[0][1]})")

    bad_area = conn.execute("""
        SELECT case_id, practice_area FROM case_metadata
        WHERE practice_area IS NOT NULL
          AND practice_area NOT IN (SELECT canonical_en FROM keywords WHERE tier = 1)
        """).fetchall()
    if bad_area:
        problems.append(f"{len(bad_area)} practice_area values are not tier-1 canonicals "
                        f"(e.g. {bad_area[0][0]} -> {bad_area[0][1]!r})")

    fk = conn.execute("PRAGMA foreign_key_check").fetchall()
    if fk:
        problems.append(f"{len(fk)} foreign key violations")

    n_cases = conn.execute("SELECT COUNT(*) FROM cases").fetchone()[0]
    n_fts   = conn.execute("SELECT COUNT(*) FROM cases_fts").fetchone()[0]
    if n_cases != n_fts:
        problems.append(f"cases_fts out of sync: {n_fts} rows vs {n_cases} cases")

    # names_fts is rebuilt explicitly rather than by trigger, so a silent miss is
    # possible in a way it is not for cases_fts.
    n_names = conn.execute("SELECT COUNT(*) FROM names_fts").fetchone()[0]
    if n_cases != n_names:
        problems.append(f"names_fts out of sync: {n_names} rows vs {n_cases} cases")
    # 'integrity-check' compares the index against its content view and raises
    # SQLITE_CORRUPT on a mismatch — the one way to catch case_metadata.parties
    # having changed after the rebuild.
    try:
        conn.execute("INSERT INTO names_fts(names_fts) VALUES('integrity-check')")
    except sqlite3.DatabaseError as e:
        problems.append(f"names_fts integrity-check failed: {e}")

    # `parties` must be plain text, never the JSON array it used to be. A database
    # built by an older revision of this script would load and index without
    # complaint, but every search would be matching against JSON punctuation and
    # the words "name" and "role", so fail loudly instead.
    json_parties = conn.execute("""
        SELECT case_id FROM case_metadata
        WHERE parties IS NOT NULL AND parties LIKE '[%"name"%'""").fetchall()
    if json_parties:
        problems.append(
            f"{len(json_parties)} case(s) have `parties` as a JSON array rather than "
            f"plain text (e.g. {json_parties[0][0]}) — case_metadata.jsonl predates "
            "scripts/set_parties_text.py; re-run it and rebuild")

    gaps = conn.execute("""
        SELECT case_id FROM case_firac GROUP BY case_id
        HAVING MAX(seq) != COUNT(*) OR MIN(seq) != 1""").fetchall()
    if gaps:
        problems.append(f"{len(gaps)} cases have non-dense FIRAC seq "
                        f"(e.g. {gaps[0][0]})")

    return problems


# ---------------------------------------------------------------------------
# taxonomy cross-check — court codes in the data vs. the website's lookup tables
# ---------------------------------------------------------------------------

def _ts_object_keys(src, const_name):
    """Keys of an `export const <const_name> = {...}` literal, or None if absent.

    Good enough for taxonomy.ts, whose court tables are flat `CODE: "..."`
    pairs with `//` comments and no nesting.
    """
    parts = src.split(f"export const {const_name}")
    if len(parts) < 2:
        return None
    body = re.sub(r"//.*", "", parts[1].split("};")[0])   # drop trailing comments
    return set(re.findall(r"(\w+)\s*:\s*[\"']", body))


def check_taxonomy(conn):
    """Court codes present in the data but missing from taxonomy.ts.

    court_type is derived client-side: the court-type filter asks only for the
    codes listed in COURT_TYPE_MAP, so a code missing there is unreachable from
    that filter — its cases load and search normally, and simply never match a
    checkbox. Nothing logs or throws, so the gap is invisible without this
    check. A code missing from COURT_NAMES is milder: the court filter falls
    back to showing the bare code.

    Returns None (no taxonomy.ts to check), "unparseable", or a dict of
    {"unmapped": [...], "unnamed": [...]} of (code, case_count), commonest first.
    """
    if not os.path.exists(TAXONOMY):
        return None
    with open(TAXONOMY, encoding="utf-8") as fh:
        src = fh.read()
    mapped = _ts_object_keys(src, "COURT_TYPE_MAP")
    named  = _ts_object_keys(src, "COURT_NAMES")
    if mapped is None or named is None:
        return "unparseable"

    counts = dict(conn.execute(
        "SELECT court, COUNT(*) FROM cases "
        "WHERE court IS NOT NULL AND court != '' GROUP BY court"))
    missing = lambda known: sorted(                                  # noqa: E731
        ((c, n) for c, n in counts.items() if c not in known), key=lambda t: -t[1])
    return {"unmapped": missing(mapped), "unnamed": missing(named)}


def report_taxonomy(taxonomy):
    """Print check_taxonomy's findings. Warnings only — never fails the build."""
    rel = os.path.relpath(TAXONOMY, ROOT)
    if taxonomy is None:
        return
    if taxonomy == "unparseable":
        print(f"\nWARNING: could not find COURT_TYPE_MAP/COURT_NAMES in {rel} — "
              "court-code coverage was NOT checked")
        return

    if taxonomy["unmapped"]:
        hidden = sum(n for _, n in taxonomy["unmapped"])
        print(f"\nWARNING: {len(taxonomy['unmapped'])} court code(s) missing from "
              f"COURT_TYPE_MAP in {rel}.")
        print(f"  {hidden} case(s) are invisible to the court-type filter:")
        for code, n in taxonomy["unmapped"]:
            print(f"    {code:<10} {n:>5} case(s)")
        print("  fix: map each code to a CourtType in COURT_TYPE_MAP.")

    if taxonomy["unnamed"]:
        listed = ", ".join(f"{c} ({n})" for c, n in taxonomy["unnamed"])
        print(f"\nWARNING: {len(taxonomy['unnamed'])} court code(s) missing from "
              f"COURT_NAMES in {rel} — the court filter will show the bare "
              f"code: {listed}")


def main():
    keep_going = "--keep-going" in sys.argv[1:]
    for p in (SCHEMA, VOCAB, METADATA, FIRAC, NOTES, LOWER, UPPER):
        if not os.path.exists(p):
            sys.exit(f"missing input: {p}")

    tmp = DB + ".building"
    if os.path.exists(tmp):
        os.remove(tmp)

    conn = sqlite3.connect(tmp)
    conn.execute("PRAGMA journal_mode = OFF")     # nothing to recover: we rebuild
    conn.execute("PRAGMA synchronous = OFF")
    with open(SCHEMA, encoding="utf-8") as fh:
        conn.executescript(fh.read())
    conn.execute("PRAGMA foreign_keys = ON")      # per-connection; set after executescript

    try:
        n_kw    = load_keywords(conn)
        n_cases = load_cases(conn)
        n_meta  = load_metadata(conn)
        n_firac = load_firac(conn)
        n_notes = load_notes(conn)
        # names_fts has NO sync triggers, deliberately: it reads
        # case_metadata.parties, which only exists once load_metadata has run.
        # Index it here, after both loaders. See the names_fts note in schema.sql.
        conn.execute("INSERT INTO names_fts(names_fts) VALUES('rebuild')")
        n_names = conn.execute("SELECT COUNT(*) FROM names_fts").fetchone()[0]
        conn.commit()
        conn.execute("ANALYZE")
        conn.commit()
        problems = verify(conn)
        taxonomy = check_taxonomy(conn)      # needs conn: must run before close()
    except Exception:
        conn.close()
        os.remove(tmp)
        raise
    conn.close()

    print(f"keywords       {n_kw:>6}")
    print(f"cases          {n_cases:>6}")
    print(f"case_metadata  {n_meta:>6}")
    print(f"case_firac     {n_firac:>6}")
    print(f"case_notes     {n_notes:>6}")
    print(f"names_fts      {n_names:>6}   (case_name + party names)")

    if anomalies:
        print(f"\nvalues NULLed to satisfy CHECK constraints: {len(anomalies)}")
        by_col = {}
        for cid, col, val in anomalies:
            by_col.setdefault(col, []).append((cid, val))
        for col, items in sorted(by_col.items()):
            sample = ", ".join(f"{c}={v!r}" for c, v in items[:3])
            more = f" ... +{len(items) - 3}" if len(items) > 3 else ""
            print(f"  {col}: {len(items)}  ({sample}{more})")

    # Split the skips: enrichment rows orphaned by a case we KNOW was removed are
    # expected bookkeeping; everything else needs a human to look at it.
    expected = [s for s in skipped if s[2] == "no such case" and s[1] in REMOVED]
    unexpected = [s for s in skipped if s not in expected]

    if expected:
        cases = sorted({cid for _, cid, _ in expected})
        print(f"\nskipped {len(expected)} enrichment rows for {len(cases)} "
              f"deliberately removed case(s):")
        print(f"  {', '.join(cases)}")

    if unexpected:
        print(f"\nrows skipped UNEXPECTEDLY: {len(unexpected)}")
        for table, cid, why in unexpected[:10]:
            print(f"  {table}: {cid} — {why}")
        if len(unexpected) > 10:
            print(f"  ... and {len(unexpected) - 10} more")
        orphan_cases = sorted({cid for t, cid, why in unexpected if why == "no such case"})
        if orphan_cases:
            print("  ^ these case_ids have enrichment but no case file, and are not")
            print("    recorded as removed. If the removal was intentional, add them")
            print(f"    to {os.path.relpath(REMOVED_MANIFEST, ROOT)}; otherwise the")
            print("    case file is missing by accident.")

    report_taxonomy(taxonomy)

    if problems:
        print("\nINTEGRITY CHECKS FAILED:")
        for p in problems:
            print(f"  - {p}")
        if not keep_going:
            os.remove(tmp)
            sys.exit("\ndatabase discarded; existing cases.db left untouched "
                     "(re-run with --keep-going to write it anyway)")

    os.replace(tmp, DB)
    size = os.path.getsize(DB) / 1e6
    print(f"\nwrote {os.path.relpath(DB, ROOT)} ({size:.0f} MB) — integrity checks passed"
          if not problems else f"\nwrote {os.path.relpath(DB, ROOT)} ({size:.0f} MB) WITH PROBLEMS")


if __name__ == "__main__":
    main()
