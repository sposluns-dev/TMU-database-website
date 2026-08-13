#!/usr/bin/env python3
"""Generate database metadata for cases: name check, defining issues, FIRAC, keywords,
bilingual summaries, and location fields.

For each case the model:
  1. verifies the case is named/cited consistently with the decision text,
  2. extracts location fields (city, province, registry),
  3. identifies the defining legal issues,
  4. writes a FIRAC analysis for each issue,
  5. confirms (re-states, possibly revised) the defining issues in light of the FIRAC,
  6. selects 5-12 keywords from the controlled vocabulary, by keyword ID,
  7. writes an English summary and a French résumé in the house style
     (from Keyword-Summary-Generation-Reference[-FR].md).

Two output files are written:
  * cases-JSON/case_metadata.generated.jsonl        — DB fields, ready to merge into
      case_metadata.jsonl: {case_id, city, province, registry, keyword_ids,
      summary, resume, practice_area}
  * cases-JSON/case_metadata_generation_notes.jsonl — working notes:
      {case_id, name_verification, defining_issues, firac, confirmed_defining_issues,
       keyword_selection_note}

Usage:
    python3 scripts/tag_cases.py --limit 3            # sync test run on 3 cases (standard price)
    python3 scripts/tag_cases.py --ids UC1,UC2        # specific cases
    python3 scripts/tag_cases.py --court upper        # all upper-court cases
    python3 scripts/tag_cases.py --batch --court upper  # Batch API (50% cheaper, async)
    python3 scripts/tag_cases.py --batch              # everything via batch (resumes automatically)
    python3 scripts/tag_cases.py --effort medium ...  # trade quality for cost (default: high)
    python3 scripts/tag_cases.py --dry-run --ids UC1  # print the prompt, no API call

Sync mode returns per-case results in seconds (good for smoke tests); batch mode
submits everything as async jobs at 50% price but can take up to a few hours and
can't be inspected until each chunk finishes. Both write the same two output files
and skip cases already present, so either mode is resumable.

Requires ANTHROPIC_API_KEY in the environment (or an `ant auth login` profile).
Both output files are append-only and keyed by case_id; already-generated cases are skipped.
"""

import argparse
import csv
import json
import os
import sys
import time
from pathlib import Path

import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request
from pydantic import BaseModel, Field, TypeAdapter

# transform_schema turns a Pydantic JSON schema into the strict form the
# structured-outputs API requires (additionalProperties:false, all-required,
# hoisted $defs). messages.parse() uses it internally; the Batch API can't call
# .parse(), so we call it directly. Private import — pinned SDK 0.104.1.
from anthropic.lib._parse._transform import transform_schema

ROOT = Path(__file__).resolve().parent.parent
API_KEY_FILE = ROOT / "!anthropic-API-key.txt"
VOCAB_CSV = ROOT / "server" / "keyword-vocab.csv"
SUMMARY_REF_EN = ROOT / "Keyword-Summary-Generation-Reference.md"
SUMMARY_REF_FR = ROOT / "Keyword-Summary-Generation-Reference-FR.md"
UPPER_DIR = ROOT / "cases-JSON" / "upper-JSON"
LOWER_DIR = ROOT / "cases-JSON" / "lower-JSON"
META_EXISTING = ROOT / "cases-JSON" / "case_metadata.jsonl"        # authoritative prior data
META_OUT = ROOT / "cases-JSON" / "case_metadata.generated.jsonl"   # staging output (merge in when reviewed)
NOTES_OUT = ROOT / "cases-JSON" / "case_metadata_generation_notes.jsonl"

# Fields the model produces that also live in case_metadata.jsonl. Reconciled
# against the existing file: a non-empty prior value is preserved (wins), and any
# disagreement with the model's value is recorded in the notes for human review.
METADATA_FIELDS = ["city", "province", "registry", "keyword_ids", "summary", "resume", "practice_area"]

MODEL = "claude-opus-4-8"
MAX_TOKENS = 16000


# ---------------------------------------------------------------- vocabulary

def get_api_key() -> str | None:
    """Prefer ANTHROPIC_API_KEY from the environment; otherwise read the local
    key file. Returns None if neither is available (lets the SDK fall back to an
    `ant auth login` profile). The key itself is never printed."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return None  # let the SDK read it from the environment
    if API_KEY_FILE.exists():
        key = API_KEY_FILE.read_text(encoding="utf-8").strip()
        if key:
            return key
    return None


def load_vocab() -> list[dict]:
    """Load the keyword vocabulary from keyword-vocab.csv (READ-ONLY).

    IDs live in the `id` column of that file — the single source of truth. This
    function never writes: the vocabulary is hand-maintained input, so a missing
    ID is a data error to be fixed deliberately, not something to auto-assign on
    every run (silent reassignment could re-map IDs and corrupt already-tagged
    cases). If any row lacks an ID, we raise and name the offenders.

    Note: IDs are positional. Add new terms at the END of the file, giving each a
    fresh `K###` id, so existing IDs stay stable.
    """
    with open(VOCAB_CSV, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    missing = [r.get("canonical") or "(blank)"
               for r in rows if not (r.get("id") or "").strip()]
    if missing:
        raise ValueError(
            f"{VOCAB_CSV} has {len(missing)} row(s) with no `id`: "
            + ", ".join(missing[:10]) + ("..." if len(missing) > 10 else "")
            + ". Assign each a stable K### id (next free number, at the end of the "
            "file) before tagging. This script will not modify the vocabulary."
        )
    return rows


def vocab_block(rows: list[dict]) -> str:
    lines = []
    for r in rows:
        syn = (r.get("synonyms") or "").strip()
        line = f'{r["id"]} | {r["canonical"]} | tier {r["tier"]} | {r["area"]}'
        if r.get("canonical_fr"):
            line += f' | fr: {r["canonical_fr"]}'
        if syn:
            line += f" | synonyms: {syn}"
        lines.append(line)
    return "\n".join(lines)


def tier1_areas(rows: list[dict]) -> list[str]:
    return [r["canonical"] for r in rows if str(r.get("tier")).strip() == "1"]


# ------------------------------------------------------------- output schema
# Field order matters: it steers generation order to match the workflow
# (name check -> location -> issues -> FIRAC -> confirm -> keywords -> summaries).

class NameVerification(BaseModel):
    name_consistent: bool = Field(
        description="True if the case_name and citation supplied in the metadata match the style of cause and citation in the decision text"
    )
    name_in_document: str = Field(
        description="The style of cause (case name) exactly as it appears in the decision text"
    )
    citation_in_document: str = Field(
        description="The neutral/primary citation as it appears in the decision text, if present; else empty string"
    )
    discrepancy_note: str = Field(
        description="If name_consistent is false, describe the discrepancy (misspelling, wrong party order, wrong citation, wrong case entirely). Empty string if consistent."
    )


class FiracAnalysis(BaseModel):
    issue: str = Field(description="The legal issue this FIRAC addresses, phrased as a question")
    facts: str = Field(description="The material facts relevant to this issue")
    rule: str = Field(description="The legal rule(s), test(s), or statutory provisions governing the issue, with authorities where the judgment cites them")
    application: str = Field(description="How the court applied the rule to the facts of this case")
    conclusion: str = Field(description="The court's conclusion / disposition on this issue")


class CaseAnalysis(BaseModel):
    # --- consistency check ---
    name_verification: NameVerification

    # --- location extraction (null when not stated in the decision) ---
    city: str | None = Field(description="City where the ORIGINATING ACTION arose — the situs of the events giving rise to the dispute, or the location of the first-instance/originating proceeding being appealed — NOT where this court sits. Null if not determinable from the decision.")
    province: str | None = Field(description="Province or territory (full name) where the originating action arose, if determinable from the decision; else null")
    registry: str | None = Field(description="Court registry or office (court-side) where this proceeding was filed or heard, if stated (e.g. 'Toronto', 'Montréal'); else null. This is distinct from `city` — registry is about the court, city is about the underlying matter.")
    location_rationale: str = Field(
        description="Explain how city and province were determined — identify the originating action's location (the situs of the events, or the first-instance proceeding being appealed) and quote or point to the text relied on, or say why they were left null. Do NOT use the seat of the deciding court."
    )
    registry_rationale: str = Field(
        description="Explain how the registry was determined — quote or point to the text relied on, or say why it was left null"
    )

    # --- issue analysis ---
    defining_issues: list[str] = Field(
        description="Initial identification: the defining legal issues of the case, each phrased as a question"
    )
    firac: list[FiracAnalysis] = Field(
        description="One FIRAC analysis per defining issue, in the same order"
    )
    confirmed_defining_issues: list[str] = Field(
        description="After completing the FIRAC analyses, re-state the defining issues — revised, merged, or split if the analysis showed the initial framing was wrong"
    )

    # --- classification ---
    keyword_ids: list[str] = Field(
        description="5 to 12 keyword IDs chosen from the controlled vocabulary (e.g. 'K014'). IDs only — no keyword text."
    )
    keywords_rationale: str = Field(
        description="Explain the keyword choices — why each selected keyword applies, tied to the confirmed issues and FIRAC rules, and flag any borderline or weak picks"
    )
    practice_area: str = Field(
        description="The single primary tier-1 practice area (canonical English name from the vocabulary) that best classifies the case"
    )

    # --- summaries (house style; see reference few-shots in the system prompt) ---
    summary: str = Field(
        description="English summary of the decision in the house style: one paragraph, facts then the issue then 'Held: <disposition>.' then the reasoning. Original paraphrase — do not copy editorial headnote prose."
    )
    resume: str = Field(
        description="French-language résumé of the decision, same house style as the English summary (facts, question, 'Dispositif :', motifs). Original paraphrase."
    )


# ------------------------------------------------------- request construction

def json_output_format() -> dict:
    """The structured-output `format` object for CaseAnalysis (strict schema)."""
    schema = TypeAdapter(CaseAnalysis).json_schema()
    return {"type": "json_schema", "schema": transform_schema(schema)}


def parse_analysis(message) -> CaseAnalysis:
    """Validate the JSON in a message's first text block into a CaseAnalysis."""
    text = next((b.text for b in message.content if b.type == "text"), None)
    if not text:
        raise RuntimeError("no text block in response to parse")
    return CaseAnalysis.model_validate_json(text)


# ------------------------------------------------------------------- prompts

def build_system(vocab_text: str, area_list: list[str], ref_en: str, ref_fr: str) -> list[dict]:
    instructions = f"""\
You are a legal editor building searchable metadata for a database of Canadian court and tribunal decisions. Cases may be in English or French. Produce your issue analysis in English; write the English summary in English and the French résumé in French.

For the case you are given, work through these steps in order:

1. NAME CHECK — Compare the case_name and citation supplied in the metadata against the style of cause and citation printed in the decision text. Report whether they are consistent and, if not, describe the discrepancy (misspelling, reversed parties, wrong citation, or a mismatched decision).

2. LOCATION — Determine the city and province/territory where the ORIGINATING ACTION arose: the place of the events giving rise to the dispute, or the location of the first-instance proceeding being appealed — NOT where this court sits. For an appeal or judicial review, use the location of the underlying matter, not the seat of the appellate court or national tribunal (e.g. an Ontario Court of Appeal decision in a dispute over the Sudbury schools has city "Sudbury", not "Toronto"). Separately, extract the court registry/office (a court-side field) where stated. Use null for any field the decision does not let you determine.

3. DEFINING ISSUES — Identify the defining legal issues: the questions the court actually had to decide that determine the outcome. Phrase each as a question. Exclude procedural housekeeping unless it was genuinely contested and outcome-determinative.

4. FIRAC — For each defining issue, produce a FIRAC analysis (Facts, Issue, Rule, Application, Conclusion). Keep facts specific to that issue. State rules with their source (statute section, leading case) when the judgment identifies one.

5. CONFIRM — Having done the FIRAC work, re-state the defining issues. If the analysis revealed that an issue was mis-framed, should be merged, or that you missed one, correct it here. If the initial list holds, repeat it.

6. KEYWORDS — Select between 5 and 12 keywords from the controlled vocabulary below, returning their IDs only. Rules:
   - Choose only keywords genuinely engaged by the case — the confirmed issues and FIRAC rules are your guide, not passing mentions.
   - Include at least one tier-1 practice-area keyword.
   - Prefer the most specific applicable keyword; add its tier-1 parent area as well.
   - Use the synonyms column to match the wording in the judgment to the canonical keyword.
   - Never invent an ID. If fewer than 5 keywords truly apply, pick the 5 closest and flag the weak ones in the selection note.
   Then set practice_area to the single tier-1 area that best classifies the case, chosen from exactly this list: {", ".join(area_list)}.

7. SUMMARIES — Write an English `summary` and a French `resume` following the house style shown in the reference few-shot examples below. Both are original paraphrase: facts, citations, dates, and dispositions may be reused verbatim from the decision, but do NOT copy editorial/headnote prose. One paragraph each; lead with the facts, state the issue, give the disposition ("Held: ..." / "Dispositif : ..."), then the court's reasoning. The résumé is a genuine French summary, not a translation of your English wording.

Ground everything in the text of the decision itself. Do not import facts or law from outside the judgment."""

    return [
        {"type": "text", "text": instructions},
        {
            "type": "text",
            "text": "=== ENGLISH SUMMARY & KEYWORD STYLE REFERENCE ===\n\n" + ref_en
                    + "\n\n=== FRENCH SUMMARY & KEYWORD STYLE REFERENCE ===\n\n" + ref_fr,
        },
        {
            "type": "text",
            "text": "=== CONTROLLED KEYWORD VOCABULARY (id | canonical | tier | area | french | synonyms) ===\n" + vocab_text,
            # Instructions + reference + vocabulary are identical for every case: cache them.
            "cache_control": {"type": "ephemeral"},
        },
    ]


def case_user_message(case: dict) -> str:
    header = (
        f"Case ID: {case.get('id')}\n"
        f"Supplied name: {case.get('case_name')}\n"
        f"Supplied citation: {case.get('citation')}\n"
        f"Court: {case.get('court')}   Date: {case.get('date')}   Language: {case.get('language')}\n"
    )
    return header + "\nFULL TEXT OF THE DECISION:\n" + (case.get("text") or "")


# --------------------------------------------------------------------- cases

def iter_case_files(court: str) -> list[Path]:
    files = []
    if court in ("upper", "both"):
        files += sorted(UPPER_DIR.glob("UC*.json"), key=lambda p: int(p.stem[2:]))
    if court in ("lower", "both"):
        files += sorted(LOWER_DIR.glob("LC*.json"), key=lambda p: int(p.stem[2:]))
    return files


def load_done_ids() -> set[str]:
    if not META_OUT.exists():
        return set()
    done = set()
    with open(META_OUT, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                done.add(json.loads(line)["case_id"])
    return done


def load_existing_metadata() -> dict[str, dict]:
    """Load the authoritative case_metadata.jsonl, keyed by case_id (empty if absent)."""
    if not META_EXISTING.exists():
        return {}
    out = {}
    with open(META_EXISTING, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rec = json.loads(line)
                out[rec["case_id"]] = rec
    return out


def _is_empty(v) -> bool:
    return v is None or (isinstance(v, str) and not v.strip()) or (isinstance(v, list) and not v)


def _values_agree(field: str, a, b) -> bool:
    """Compare an existing value with a generated one. keyword_ids compares
    order-insensitively; other fields compare exactly."""
    if field == "keyword_ids":
        return set(a or []) == set(b or [])
    return a == b


def reconcile(existing: dict, generated: dict) -> tuple[dict, list[dict]]:
    """Merge generated metadata against an existing case_metadata.jsonl entry.

    Policy: an existing non-empty value WINS (is preserved). Empty existing fields
    are filled from the generated value. Any field where a non-empty existing value
    disagrees with the generated value is returned as a collision for the notes —
    nothing is silently overwritten.
    """
    final = {"case_id": generated["case_id"]}
    collisions = []
    for field in METADATA_FIELDS:
        gen_val = generated.get(field)
        exist_val = existing.get(field)
        if _is_empty(exist_val):
            final[field] = gen_val
        elif _values_agree(field, exist_val, gen_val):
            final[field] = exist_val
        else:
            final[field] = exist_val  # preserve prior data; flag the disagreement
            collisions.append({"field": field, "existing": exist_val, "generated": gen_val})
    return final, collisions


# ---------------------------------------------------------------------- main

def build_records(case: dict, existing: dict, r: CaseAnalysis, message) -> tuple[dict, dict]:
    """Turn a parsed CaseAnalysis (+ the raw message for model/usage) into the
    (metadata, notes) records, reconciled against the existing entry. Shared by
    the sync and batch paths."""
    generated_meta = {
        "case_id": case["id"],
        "city": r.city,
        "province": r.province,
        "registry": r.registry,
        "keyword_ids": r.keyword_ids,
        "summary": r.summary,
        "resume": r.resume,
        "practice_area": r.practice_area,
    }
    meta, collisions = reconcile(existing, generated_meta)

    notes = {
        "case_id": case["id"],
        "citation": case.get("citation"),
        "case_name": case.get("case_name"),
        "name_verification": r.name_verification.model_dump(),
        "defining_issues": r.defining_issues,
        "firac": [f.model_dump() for f in r.firac],
        "confirmed_defining_issues": r.confirmed_defining_issues,
        "keywords_rationale": r.keywords_rationale,
        "location_rationale": r.location_rationale,
        "registry_rationale": r.registry_rationale,
        "collisions": collisions,
        "model": message.model,
        "usage": {
            "input_tokens": message.usage.input_tokens,
            "cache_read_input_tokens": message.usage.cache_read_input_tokens,
            "cache_creation_input_tokens": message.usage.cache_creation_input_tokens,
            "output_tokens": message.usage.output_tokens,
        },
    }
    return meta, notes


def check_stop(stop_reason: str | None) -> None:
    if stop_reason == "refusal":
        raise RuntimeError("model refused the request")
    if stop_reason == "max_tokens":
        raise RuntimeError("output truncated at max_tokens — raise MAX_TOKENS and retry")


# ---------------------------------------------------------------------- main

def analyze_case(client: anthropic.Anthropic, system: list[dict], case: dict,
                 existing: dict, effort: str) -> tuple[dict, dict, CaseAnalysis]:
    """Synchronous path: one real-time call for one case (standard pricing)."""
    response = client.messages.parse(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        thinking={"type": "adaptive"},
        output_config={"effort": effort},
        system=system,
        messages=[{"role": "user", "content": case_user_message(case)}],
        output_format=CaseAnalysis,
    )
    check_stop(response.stop_reason)
    r: CaseAnalysis | None = response.parsed_output
    if r is None:
        raise RuntimeError(f"no structured output returned (stop_reason={response.stop_reason})")
    meta, notes = build_records(case, existing, r, response)
    return meta, notes, r


def compute_warnings(r: CaseAnalysis, notes: dict, valid_ids: set, areas: list[str]) -> list[str]:
    warnings = []
    bad = [k for k in r.keyword_ids if k not in valid_ids]
    if bad:
        warnings.append(f"invalid keyword IDs: {bad}")
    if not 5 <= len(r.keyword_ids) <= 12:
        warnings.append(f"keyword count {len(r.keyword_ids)} outside 5-12")
    if r.practice_area not in areas:
        warnings.append(f"practice_area '{r.practice_area}' not a tier-1 area")
    if not r.name_verification.name_consistent:
        warnings.append("NAME MISMATCH: " + r.name_verification.discrepancy_note)
    if notes["collisions"]:
        warnings.append("collisions with existing metadata: "
                        + ", ".join(c["field"] for c in notes["collisions"]))
    return warnings


def write_result(meta_out, notes_out, tag: str, r: CaseAnalysis, meta: dict, notes: dict,
                 valid_ids: set, areas: list[str]) -> None:
    warnings = compute_warnings(r, notes, valid_ids, areas)
    if warnings:
        notes["warnings"] = warnings
    meta_out.write(json.dumps(meta, ensure_ascii=False) + "\n")
    notes_out.write(json.dumps(notes, ensure_ascii=False) + "\n")
    meta_out.flush()
    notes_out.flush()
    u = notes["usage"]
    print(f"{tag} {meta['case_id']}  issues={len(r.confirmed_defining_issues)} "
          f"kw={len(r.keyword_ids)} area='{r.practice_area}'  in={u['input_tokens']} "
          f"cached={u['cache_read_input_tokens']} out={u['output_tokens']}"
          + ("  ⚠ " + "; ".join(warnings) if warnings else ""))


def run_batch(client, system, todo, existing_meta, valid_ids, areas, effort,
              chunk_size, poll_secs) -> list[str]:
    """Submit cases to the Batch API (50% pricing) in chunks, poll each chunk to
    completion, and write results as they arrive. Returns the list of failures."""
    fmt = json_output_format()
    cases = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in todo}
    order = [p.stem for p in todo]
    failures = []

    with open(META_OUT, "a", encoding="utf-8") as meta_out, \
         open(NOTES_OUT, "a", encoding="utf-8") as notes_out:
        for start in range(0, len(order), chunk_size):
            chunk = order[start:start + chunk_size]
            requests = [
                Request(
                    custom_id=cid,
                    params=MessageCreateParamsNonStreaming(
                        model=MODEL,
                        max_tokens=MAX_TOKENS,
                        thinking={"type": "adaptive"},
                        output_config={"format": fmt, "effort": effort},
                        system=system,
                        messages=[{"role": "user", "content": case_user_message(cases[cid])}],
                    ),
                )
                for cid in chunk
            ]
            batch = client.messages.batches.create(requests=requests)
            print(f"\nSubmitted batch {batch.id} — {len(chunk)} cases "
                  f"(chunk {start // chunk_size + 1}). Polling every {poll_secs}s…")

            while True:
                b = client.messages.batches.retrieve(batch.id)
                if b.processing_status == "ended":
                    break
                c = b.request_counts
                print(f"  {b.processing_status}: {c.processing} processing, "
                      f"{c.succeeded} ok, {c.errored} errored", flush=True)
                time.sleep(poll_secs)

            for res in client.messages.batches.results(batch.id):
                cid = res.custom_id
                case = cases[cid]
                try:
                    if res.result.type != "succeeded":
                        detail = getattr(getattr(res.result, "error", None), "type", res.result.type)
                        raise RuntimeError(f"batch result {res.result.type}: {detail}")
                    msg = res.result.message
                    check_stop(msg.stop_reason)
                    r = parse_analysis(msg)
                    meta, notes = build_records(case, existing_meta.get(cid, {}), r, msg)
                except Exception as e:
                    print(f"  {cid}  FAILED: {e}")
                    failures.append(cid)
                    continue
                write_result(meta_out, notes_out, "  ✓", r, meta, notes, valid_ids, areas)
    return failures


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--court", choices=["upper", "lower", "both"], default="both")
    ap.add_argument("--limit", type=int, default=None, help="stop after N cases (test runs)")
    ap.add_argument("--ids", default=None, help="comma-separated case IDs, e.g. UC1,UC2,LC10")
    ap.add_argument("--batch", action="store_true",
                    help="use the Batch API (50%% cheaper, async — results in up to a few hours)")
    ap.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"], default="high",
                    help="reasoning effort (default high; lowering trades quality for cost)")
    ap.add_argument("--batch-chunk", type=int, default=400,
                    help="cases per batch submission when --batch (keeps payload under limits)")
    ap.add_argument("--poll", type=int, default=30, help="batch polling interval in seconds")
    ap.add_argument("--dry-run", action="store_true", help="print the prompt for the first case and exit")
    args = ap.parse_args()

    vocab_rows = load_vocab()
    valid_ids = {r["id"] for r in vocab_rows}
    areas = tier1_areas(vocab_rows)
    ref_en = SUMMARY_REF_EN.read_text(encoding="utf-8")
    ref_fr = SUMMARY_REF_FR.read_text(encoding="utf-8")
    system = build_system(vocab_block(vocab_rows), areas, ref_en, ref_fr)

    existing_meta = load_existing_metadata()
    print(f"Loaded {len(existing_meta)} existing rows from {META_EXISTING.name} for reconciliation.")

    wanted = set(args.ids.split(",")) if args.ids else None
    files = [p for p in iter_case_files(args.court) if wanted is None or p.stem in wanted]
    done = load_done_ids()
    todo = [p for p in files if p.stem not in done]
    print(f"{len(files)} cases selected, {len(files) - len(todo)} already done, {len(todo)} to do.")
    if args.limit:
        todo = todo[: args.limit]

    if args.dry_run:
        sample = (todo or files)  # show a prompt even if everything's already done
        if not sample:
            print("No matching cases to show.")
            return 0
        case = json.loads(sample[0].read_text(encoding="utf-8"))
        print("\n===== SYSTEM (block sizes) =====")
        for i, block in enumerate(system):
            print(f"[block {i}] {len(block['text'])} chars"
                  + ("  (cached)" if block.get("cache_control") else ""))
        print("\n----- instructions block -----")
        print(system[0]["text"])
        print("\n===== USER (first 1500 chars) =====")
        print(case_user_message(case)[:1500])
        return 0

    api_key = get_api_key()
    client = anthropic.Anthropic(max_retries=4, **({"api_key": api_key} if api_key else {}))
    src = "env ANTHROPIC_API_KEY" if os.environ.get("ANTHROPIC_API_KEY") else \
          (API_KEY_FILE.name if api_key else "ant profile / default")
    print(f"Auth: using key from {src}   |   mode: {'BATCH (50% pricing)' if args.batch else 'sync'}"
          f"   effort: {args.effort}")

    if args.batch:
        failures = run_batch(client, system, todo, existing_meta, valid_ids, areas,
                             args.effort, args.batch_chunk, args.poll)
    else:
        failures = []
        with open(META_OUT, "a", encoding="utf-8") as meta_out, \
             open(NOTES_OUT, "a", encoding="utf-8") as notes_out:
            for i, path in enumerate(todo, 1):
                case = json.loads(path.read_text(encoding="utf-8"))
                try:
                    meta, notes, r = analyze_case(
                        client, system, case, existing_meta.get(path.stem, {}), args.effort)
                except Exception as e:  # log and keep going; rerun picks up failures
                    print(f"[{i}/{len(todo)}] {path.stem}  FAILED: {e}")
                    failures.append(path.stem)
                    continue
                write_result(meta_out, notes_out, f"[{i}/{len(todo)}]", r, meta, notes,
                             valid_ids, areas)

    if failures:
        print(f"\n{len(failures)} failures (rerun to retry): {', '.join(failures)}")
        return 1
    print(f"\nDone.\n  metadata -> {META_OUT}\n  notes    -> {NOTES_OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
