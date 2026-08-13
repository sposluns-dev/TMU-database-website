-- TMU Database — SQLite schema
-- Source of truth for structure. Build the DB with:
--     sqlite3 db/cases.db < db/schema.sql
-- then run the importers to populate it. cases.db is a build artifact (gitignored).
--
-- Two tables, split by provenance:
--   cases          — SOURCE data scraped/imported from the judgments (stable).
--   case_metadata  — GENERATED metadata we add (location tags + AI enrichment).
-- Keeping them apart means the enrichment can be regenerated or wiped without
-- touching the source cases. 1:1 via case_metadata.case_id -> cases.case_id.

PRAGMA foreign_keys = ON;   -- (per-connection; importers set this too)

-- ===========================================================================
-- SOURCE DATA — one row per case. id is "LC1".."LC1119" / "UC1".."UC480".
-- Not WITHOUT ROWID, so the FTS5 external-content index can reference rowid.
-- SQLite has no DATE type (store ISO 8601 TEXT) and no CREATE FUNCTION, so the
-- validation logic lives in named table-level CHECK constraints at the bottom.

-- SOURCE will need to be changed later on (assuming permission is granted from CanLii)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS cases (
    case_id        TEXT PRIMARY KEY,   -- "LC1", "UC20"
    citation  TEXT,               -- e.g. "2015 NSCA 80"
    case_name TEXT,               -- e.g. "Bonitto v. Halifax Regional School Board"
    court     TEXT,               -- e.g. "NSCA"
    date      TEXT,               -- ISO 8601: "2015-01-13"  (validated below)
    language  TEXT,               -- 'en' | 'fr'             (validated below)
    url       TEXT,               -- CanLII http(s) link     (validated below)
    source    TEXT,               -- 'CanLII' | 'A2AJ'       (validated below)
    text      TEXT,               -- full judgment text

    -- Normalized case name, shared by every record of the same litigation:
    -- "Snyder v. Montreal Gazette Ltd." at QCCS, QCCA and SCC all key to
    -- 'snyder montreal gazette limited'. This is what priority 3 groups on so a
    -- strong hit on a trial judgment promotes its appellate and Supreme Court
    -- siblings, which are the ultimate finding even when they match nothing.
    --
    -- MATERIALIZED, not computed in SQL: the abbreviation expansion
    -- (Ltd. -> limited, Cie -> company) is a lookup table, and folding accents
    -- needs NFKD. Neither is practical in pure SQLite. scripts/build_db.py owns
    -- the definition -- see name_key() there, and change it in ONE place.
    --
    -- NULL means "no family": the case is never grouped and never promoted.
    -- Used for the 122 anonymized RAD decisions all captioned
    -- "[no public name]", which would otherwise form one 122-member family and
    -- drag every one of them in on a single text hit.
    name_key  TEXT,

    -- Validation rules (NULL always allowed; only non-NULL values are checked).
    CONSTRAINT valid_language CHECK (language IN ('en', 'fr')),
    CONSTRAINT valid_source   CHECK (source IN ('CanLII', 'A2AJ')),
    CONSTRAINT valid_url      CHECK (url LIKE 'http://%.%' OR url LIKE 'https://%.%'),
    CONSTRAINT valid_date     CHECK (
                                  date IS NULL OR (
                                      date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                      AND date(date) IS NOT NULL  -- rejects month 13, day 32
                                      AND date(date) = date       -- rejects Feb 30 rollovers
                                  )
                              )
);

CREATE INDEX IF NOT EXISTS idx_cases_citation ON cases (citation);

-- Priority 3 groups by name_key on every text search, so this is a hot path.
-- Partial: NULL means "no family" and is never grouped on, so indexing those
-- rows would only bloat the index.
CREATE INDEX IF NOT EXISTS idx_cases_name_key ON cases (name_key)
    WHERE name_key IS NOT NULL;

-- ===========================================================================
-- GENERATED METADATA — location tags + AI enrichment we add ourselves.
-- 1:1 with cases; case_id is both the primary key and the foreign key.
-- ON DELETE CASCADE: removing a case drops its metadata automatically.
-- ===========================================================================
-- Columns mirror cases-JSON/case_metadata.jsonl 1:1, in the same order, so the
-- importer is a straight field->column loop with no reshaping.
CREATE TABLE IF NOT EXISTS case_metadata (
    case_id         TEXT PRIMARY KEY
                        REFERENCES cases(case_id) ON DELETE CASCADE,
    city            TEXT,         -- best-guess location tag (originating action, not court seat)
    province        TEXT,
    registry        TEXT,         -- court registry/office as determined during generation
    keyword_ids     TEXT,         -- JSON array of keyword ids, e.g. ["K003","K025"] -> keywords.keyword_id
    parties         TEXT,         -- plain text: party names, space-joined (see note below)
    summary         TEXT,         -- AI-generated (English)
    resume          TEXT,         -- AI-generated (French summary)
    defining_issues TEXT,         -- AI-generated: JSON array of issue strings
    practice_area   TEXT          -- the single primary tier-1 area (see keywords.tier = 1)
);

-- NOTE: `keywords` and `mots_cles` TEXT columns were REMOVED. The English and French
-- keyword text is no longer duplicated on every case row; it is resolved by joining
-- keyword_ids -> keywords (canonical / canonical_fr). Editing a term now touches one
-- row instead of ~1,600. Resolve with:
--     SELECT m.case_id, k.canonical_en AS keyword, k.canonical_fr AS mot_cle
--     FROM case_metadata m, json_each(m.keyword_ids) j
--     JOIN keywords k ON k.keyword_id = j.value;
--
-- CAVEAT: keyword_ids is a JSON array, so SQLite cannot enforce a FOREIGN KEY on its
-- elements. The importer must validate every id against keywords.keyword_id (see the
-- orphan-check query at the bottom of this file).

-- ---------------------------------------------------------------------------
-- NOTE ON `parties` — who was before the court.
--
-- PLAIN TEXT: the party names for a case, space-joined, in style-of-cause order
-- (captions list appellants before respondents, and that order carries meaning).
--     "Ontario (Attorney General) Dieleman Torcan Women's Reproductive Health Clinic"
-- Not JSON. Query it like any other text column, with LIKE or through the FTS
-- index — there is nothing to json_each over.
--
-- ROLES ARE DELIBERATELY NOT STORED HERE. The extraction pipeline
-- (scripts/extract_parties.py -> resolve_roles.py) resolves a role for every party
-- against a closed 36-term vocabulary, and all of that is preserved in
-- cases-JSON/case_metadata_parties.jsonl, which remains the STRUCTURED source of
-- truth: one {"name","role"} object per party, 5,422 of them over 1,459 cases.
-- This column is the flattened, search-only projection of that file, written by
-- scripts/set_parties_text.py. If you need to know who was the appellant, read the
-- side file; the database deliberately does not carry it.
--
-- WHY THE ROLES WERE DROPPED FROM THE DATABASE
-- They were briefly split into two weighted FTS columns (p_princ for contesting
-- parties, p_other for interveners and the like) so a named respondent would
-- outrank an intervener on the same surname. Measured on this corpus, that
-- affected very little: only 12% of cases have any non-contesting party at all,
-- 12.1% of party objects, and 62 names appear in both buckets anywhere. It
-- reordered organisational searches (Canadian Jewish Congress, provincial human
-- rights commissions) correctly and did nothing at all for individual surnames.
-- The far larger win — the 923 cases whose party names appear nowhere in the style
-- of cause becoming findable at all — comes from indexing the names, not from
-- tiering them. So the names are indexed and the tiering is gone.
--
-- Names are DE-DUPLICATED case-insensitively within a case: the same body listed
-- twice under two roles ("Appellant" and "Intervener") would, with roles stripped,
-- appear as a meaningless repetition. 10 cases were affected; LC2 (the Bill 21
-- appeal) listed 57 entries that collapse to 30 distinct names.
--
-- NULL vs '' is a REAL distinction, do not normalise it away: NULL means no parties
-- were extracted (anonymisation guard, or a caption the parser could not read —
-- 128 cases), NOT that the case had no parties. '' would claim the extractor ran
-- and legitimately found none. The loader never writes ''.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- NOTE ON `defining_issues` (renamed on import)
--
-- In the source file cases-JSON/case_metadata_generation_notes.jsonl this column
-- is called **`confirmed_defining_issues`**. That file carries TWO issue lists,
-- produced by different steps of scripts/tag_cases.py:
--
--   `defining_issues`            step 3 — the INITIAL identification of the issues.
--   `confirmed_defining_issues`  step 5 — the issues RE-STATED after the FIRAC
--                                analysis, with issues merged, split or re-framed
--                                once the governing law had been worked through.
--
-- We import the **step-5 confirmed** list (the better legal work product) and store
-- it under the shorter name `defining_issues` here and in case_metadata.jsonl.
-- The step-3 list is kept only in the notes file, for provenance.
--
-- Stored as a JSON array of strings (mean ~3.2 issues/case, max 8). Query with
-- SQLite's JSON1 functions, e.g.
--     SELECT case_id, value AS issue
--     FROM case_metadata, json_each(case_metadata.defining_issues);
--
-- CAVEAT: this list does NOT align 1:1 with the FIRAC blocks — the counts differ on
-- ~9% of cases, because the FIRAC analysis was generated against the step-3 list.
-- Never pair defining_issues[i] with a FIRAC block by index/position.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_meta_location ON case_metadata (province, city);  -- map / filter

-- ===========================================================================
-- FIRAC ANALYSES — 1:1 with cases-JSON/case_firac.jsonl (generated by
-- scripts/export_case_firac.py from case_metadata_generation_notes.jsonl).
--
-- The ONE-TO-MANY table: a case has 1-8 FIRAC blocks (mean 3.3; 5,212 rows over
-- 1,597 cases), one per legal issue the court had to decide. This is why FIRAC
-- lives here and not as a column on case_metadata.
--
--   seq  1-based position of the block WITHIN its case; restarts at 1 for every
--        case, so it is unique only in combination with case_id. SQL rows have no
--        inherent order, so seq is what preserves the order the issues were
--        analysed in — always ORDER BY seq when reading a case back:
--            SELECT seq, issue, facts, rule, application, conclusion
--            FROM case_firac WHERE case_id = ? ORDER BY seq;
--        It is POSITIONAL, not a stable identifier: re-tagging a case may produce a
--        different number of issues, so (case_id, seq) is not a durable external ref.
--
-- WITHOUT ROWID: the primary key IS the natural key, so this avoids a redundant
-- rowid b-tree. The PK also serves lookups by case_id (leftmost-column rule), so
-- no extra index is needed.
--
-- NOTE: deliberately NOT added to cases_fts. The FIRAC text paraphrases the
-- judgment already indexed in cases.text; indexing both would double-count terms
-- and distort IDF/BM25 ranking.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS case_firac (
    case_id     TEXT    NOT NULL
                        REFERENCES cases(case_id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,   -- 1-based, dense within each case
    issue       TEXT    NOT NULL,   -- the legal question, phrased as a question
    facts       TEXT,               -- material facts relevant to THIS issue
    rule        TEXT,               -- governing rule/test/statute, with authorities
    application TEXT,               -- how the court applied the rule to the facts
    conclusion  TEXT,               -- the court's disposition on this issue

    CONSTRAINT valid_seq CHECK (seq >= 1),
    PRIMARY KEY (case_id, seq)
) WITHOUT ROWID;

-- ===========================================================================
-- GENERATION NOTES — provenance for the AI enrichment, 1:1 with cases.
-- Source: cases-JSON/case_metadata_generation_notes.jsonl (one record per case).
--
-- Stored as a single JSON object in `notes`, holding the *rationale* fields only
-- (name_verification, keywords_rationale, location_rationale, registry_rationale,
-- collisions, warnings, completion_note, duplicate_note, model). The bulky
-- `firac` and `defining_issues` from that file are deliberately NOT duplicated
-- here — they already live in case_firac / case_metadata. Read with JSON1, e.g.
--     SELECT json_extract(notes, '$.keywords_rationale') FROM case_notes WHERE case_id = ?;
-- ===========================================================================
CREATE TABLE IF NOT EXISTS case_notes (
    case_id TEXT PRIMARY KEY
                REFERENCES cases(case_id) ON DELETE CASCADE,
    notes   TEXT               -- JSON object of generation-provenance fields
) WITHOUT ROWID;

-- ===========================================================================
-- CONTROLLED VOCABULARY — the keyword list, 1:1 with keyword-vocab.csv.
-- One row per term (122). This is the single source of truth for keyword text:
-- English (canonical), French (canonical_fr), tier and grouping.
--   tier 1 = Practice Area (the 9 exact-match filter boxes)
--   tier 2 = Topic / doctrine
--   tier 3 = Entity (statutes, groups, places, symbols)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS keywords (
    keyword_id           TEXT PRIMARY KEY,   -- 'K001'  (referenced from case_metadata.keyword_ids)
    canonical_en    TEXT NOT NULL,      -- English keyword  — the one stored/displayed term
    canonical_fr TEXT,               -- French keyword (mot-clé) — display only, never stored on cases
    tier         INTEGER,            -- 1 | 2 | 3            (validated below)
    area         TEXT,               -- thematic grouping label (organizational only)

    CONSTRAINT valid_tier CHECK (tier IS NULL OR tier IN (1, 2, 3))
);

CREATE INDEX IF NOT EXISTS idx_keywords_tier ON keywords (tier);

-- ===========================================================================
-- FULL-TEXT SEARCH (FTS5), external-content over `cases`.
-- Indexes the source searchable columns: case_name + the full judgment text.
-- (keywords/summary live in case_metadata and are short — a plain LIKE over
-- ~1,600 rows is instant, so they don't need to be in the FTS index.)
-- Query with:  SELECT c.* FROM cases c JOIN cases_fts f ON c.rowid = f.rowid
--              WHERE cases_fts MATCH 'religious AND dismissal';
-- ===========================================================================
-- tokenize: `remove_diacritics 2` folds accents at INDEX and QUERY time, so an
-- unaccented English query reaches the French decisions ("societe" -> "société",
-- "controle judiciaire" -> "contrôle judiciaire"). Mode 2 (not 1) is the correct
-- one for French — mode 1 has a documented bug that skips combining marks after
-- certain codepoints. `unicode61` rather than `porter`: porter stems English only
-- and would mangle the French half of the corpus; stemming is approximated by the
-- synonym rings expanded at query time (see Keyword-Search-Design.md §4).
-- CHANGING THIS LINE REQUIRES A FULL REBUILD — the folding is baked into the index.
CREATE VIRTUAL TABLE IF NOT EXISTS cases_fts USING fts5(
    case_name,
    text,
    content='cases',
    content_rowid='rowid',
    tokenize = "unicode61 remove_diacritics 2"
);

-- Keep the FTS index in sync with `cases` automatically.
CREATE TRIGGER IF NOT EXISTS cases_ai AFTER INSERT ON cases BEGIN
    INSERT INTO cases_fts(rowid, case_name, text)
    VALUES (new.rowid, new.case_name, new.text);
END;

CREATE TRIGGER IF NOT EXISTS cases_ad AFTER DELETE ON cases BEGIN
    INSERT INTO cases_fts(cases_fts, rowid, case_name, text)
    VALUES ('delete', old.rowid, old.case_name, old.text);
END;

CREATE TRIGGER IF NOT EXISTS cases_au AFTER UPDATE ON cases BEGIN
    INSERT INTO cases_fts(cases_fts, rowid, case_name, text)
    VALUES ('delete', old.rowid, old.case_name, old.text);
    INSERT INTO cases_fts(rowid, case_name, text)
    VALUES (new.rowid, new.case_name, new.text);
END;

-- ===========================================================================
-- WHO-WAS-BEFORE-THE-COURT SEARCH (FTS5) — style of cause + party names.
--
-- WHY THIS IS A SECOND INDEX AND NOT THREE MORE COLUMNS ON cases_fts.
-- FTS5's bm25() computes the document length |D| per ROW, summed across every
-- column — there is no per-column normalisation. Put a 4-token party list in the
-- same row as a 50,000-token judgment and the party match is normalised against
-- 50,000: measured on LC1, a name match worth 5.86 on the IDF scores 3.00, a 76%
-- discount for the length of a judgment the name is not even in. Compensating with
-- a large column weight is a fudge factor for a distortion, and it fails for a
-- common surname in a long judgment.
--
-- Here avgdl is ~20 tokens, so length normalisation becomes *desirable*: a name
-- among 63 parties genuinely is weaker evidence than one of two parties, and that
-- is now what it scores. Plain bm25() suffices; no per-term df machinery.
--
--     cases_fts  avg ~12,900 tokens/row   <- the judgment
--     names_fts  avg ~20 tokens/row       <- who was before the court
--
-- TWO COLUMNS, NO ROLE TIERING. An earlier version split the party names into
-- p_princ (contesting parties) and p_other (interveners and the like) so the two
-- could carry different bm25 weights. That was removed — see the "WHY THE ROLES
-- WERE DROPPED" paragraph in the `parties` note above for the measurements. A lead
-- party still outranks an intervener in practice, because a lead party appears in
-- BOTH case_name and parties while an intervener appears only in parties:
--     f~ = 3.0*freq(case_name) + 1.0*freq(parties)
--
-- `parties` is a plain text column on case_metadata (space-joined names, written by
-- scripts/set_parties_text.py), so the view reads it directly. It has to be a plain
-- column rather than something the view computes: flattening the structured parties
-- file needs json_each(), and a table-valued function cannot appear inside an FTS5
-- content view — FTS5 re-prepares the content read schema-qualified and fails with
-- "no such table: main.json_each".
--
-- NO SYNC TRIGGERS, unlike cases_fts. `parties` lives on case_metadata, which loads
-- AFTER cases (load_cases runs before load_metadata), so insert-time triggers would
-- index every case with NULL parties. build_db.py instead issues
--     INSERT INTO names_fts(names_fts) VALUES('rebuild');
-- once both loaders are done. The served database is opened read-only
-- (SEARCH_IMMUTABLE=1), so there is nothing for triggers to keep in sync at
-- runtime. IF YOU EVER WRITE TO cases OR case_metadata, REBUILD THIS INDEX.
--
-- The 128 cases with parties = NULL score on case_name alone — the behaviour before
-- this index existed, so no regression.
-- ===========================================================================
CREATE VIEW IF NOT EXISTS names_search AS
SELECT c.rowid     AS rowid,
       c.case_name AS case_name,
       m.parties   AS parties
FROM cases c LEFT JOIN case_metadata m ON m.case_id = c.case_id;

-- content_rowid is cases.rowid, the same rowid space as cases_fts, so both
-- indexes join back to `cases` identically (... ON ft.rid = c.rowid).
CREATE VIRTUAL TABLE IF NOT EXISTS names_fts USING fts5(
    case_name,
    parties,
    content='names_search',
    content_rowid='rowid',
    tokenize = "unicode61 remove_diacritics 2"
);

-- ===========================================================================
-- INTEGRITY CHECKS — run after import (SQLite cannot FK into a JSON array).
-- All should return zero rows.
-- ===========================================================================
-- 1. keyword_ids referencing a keyword that doesn't exist:
--      SELECT m.case_id, j.value AS orphan_keyword_id
--      FROM case_metadata m, json_each(m.keyword_ids) j
--      LEFT JOIN keywords k ON k.keyword_id = j.value
--      WHERE k.keyword_id IS NULL;
--
-- 2. practice_area that isn't a tier-1 canonical:
--      SELECT case_id, practice_area FROM case_metadata
--      WHERE practice_area IS NOT NULL
--        AND practice_area NOT IN (SELECT canonical_en FROM keywords WHERE tier = 1);
--
-- 3. `parties` accidentally holding JSON rather than plain text — the column used to
--    be a JSON array of {"name","role"} objects, so a stale loader or an un-migrated
--    dump would still write one, and it would silently index braces and role words
--    as searchable tokens:
--      SELECT case_id, substr(parties, 1, 60) FROM case_metadata
--      WHERE parties LIKE '[%' OR parties LIKE '%"role"%' OR parties LIKE '%"name"%';
--
-- 4. an empty-string `parties` — NULL and '' mean different things here (see the
--    note above) and the loader must never write '':
--      SELECT case_id FROM case_metadata WHERE trim(parties) = '';
--
-- 5. `parties` out of step with the structured side file. cases-JSON/case_metadata_
--    parties.jsonl is the source of truth for who was before the court, and this
--    column is only its flattened projection; nothing in SQL can see that file, so
--    the check lives in scripts/verify_parties.py. Drift here is silent: the DB and
--    the side file would simply disagree, with no error anywhere.
--
-- 6. names_fts out of sync with cases (it has no triggers — see its note):
--      SELECT (SELECT COUNT(*) FROM cases) - (SELECT COUNT(*) FROM names_fts);
