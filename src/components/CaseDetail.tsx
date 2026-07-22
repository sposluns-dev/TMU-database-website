// Case detail drawer — two distinct views over one case, chosen by `view`:
//
//   "case"  → "Summary, issues & FIRAC": practice area, EN/FR toggle, and
//             show/hide checkboxes for Keywords, Summary, Defining issues,
//             FIRAC analysis, Full text.
//   "notes" → "Generation notes": the AI-enrichment provenance for the case
//             (name verification + the rationales), on its own.
//
// Both pull from GET /case/{case_id}; the judgment text is fetched only when the
// Full text section is shown. The EN/FR choice makes the case view UNILINGUAL:
// section titles switch language, and keywords show one language only. CONTENT is
// translated only where a French version exists (summary -> résumé); defining
// issues, FIRAC and full text keep their English content for now (titles still
// switch).

import { useEffect, useState } from "react";
import { apiCase, type ApiCaseDetail, type ApiFirac } from "../lib/api";
import "../styles/components/case-detail.css";

interface Props {
  caseId: string;
  onClose: () => void;
  /** Which view to render. Defaults to the case analysis. */
  view?: "case" | "notes";
}

// /case/{id} returns keywords as objects; the list shape in ApiCase is the
// search-result form. Narrow it here rather than widening the shared type.
type KeywordObj = { keyword_id: string; en: string; fr: string | null; tier: number | null };

type SectionKey = "keywords" | "summary" | "issues" | "firac" | "text";
type Lang = "en" | "fr";

// Section labels per language (titles + checkboxes switch with the EN/FR choice).
const SECTION_LABELS: Record<SectionKey, Record<Lang, string>> = {
  keywords: { en: "Keywords", fr: "Mots-clés" },
  summary: { en: "Summary", fr: "Résumé" },
  issues: { en: "Defining issues", fr: "Questions en litige" },
  firac: { en: "FIRAC analysis", fr: "Analyse FIRAC" },
  text: { en: "Full text", fr: "Texte intégral" },
};
const SECTION_ORDER: SectionKey[] = ["keywords", "summary", "issues", "firac", "text"];

export function CaseDetail({ caseId, onClose, view = "case" }: Props) {
  const [data, setData] = useState<ApiCaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [openBlocks, setOpenBlocks] = useState<Set<number>>(new Set([1]));
  const [lang, setLang] = useState<"en" | "fr">("en");
  const [visible, setVisible] = useState<Record<SectionKey, boolean>>({
    keywords: true,
    summary: true,
    issues: true,
    firac: true,
    text: false,
  });

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    setText(null);
    apiCase(caseId, { includeText: false })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [caseId]);

  // Esc closes the drawer, and the page behind it must not scroll with it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  async function loadText() {
    setLoadingText(true);
    try {
      const full = await apiCase(caseId);
      setText(full.text ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingText(false);
    }
  }

  const toggleBlock = (seq: number) =>
    setOpenBlocks((prev) => {
      const n = new Set(prev);
      n.has(seq) ? n.delete(seq) : n.add(seq);
      return n;
    });

  const toggleSection = (key: SectionKey) =>
    setVisible((prev) => ({ ...prev, [key]: !prev[key] }));

  const keywords = (data?.keywords ?? []) as unknown as KeywordObj[];
  const place = [data?.city, data?.province].filter(Boolean).join(", ");
  // The summary body follows the EN/FR toggle; résumé (FR) may be absent.
  const summaryText = lang === "en" ? data?.summary : data?.resume;
  const gn = data?.generation_notes ?? null;

  return (
    <div className="case-drawer-backdrop" onClick={onClose}>
      <aside
        className="case-drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={
          (data?.case_name ?? caseId) +
          (view === "notes" ? " — generation notes" : "")
        }
      >
        <button className="case-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        {error && <p className="case-error">Could not load {caseId}: {error}</p>}
        {!data && !error && <p className="case-loading">Loading {caseId}…</p>}

        {data && (
          <>
            <header className="case-header">
              {view === "notes" && (
                <p className="case-view-tag">Generation notes</p>
              )}
              <div className="case-idline">
                <span className="case-id">{data.case_id}</span>
                <span className="case-citation">{data.citation}</span>
                <span className={`case-level case-level-${data.level}`}>
                  {data.level === "upper" ? "Upper court" : "Lower court"}
                </span>
              </div>
              <h2>{data.case_name}</h2>
              <div className="case-facts">
                <span>{data.court}</span>
                <span>{data.date}</span>
                {place && <span>{place}</span>}
                {data.registry && <span>Registry: {data.registry}</span>}
              </div>
            </header>

            {/* ── Generation-notes view ─────────────────────────────── */}
            {view === "notes" && (
              <section className="case-section">
                {gn ? (
                  <div className="case-notes">
                    {gn.name_verification && (
                      <div className="case-note">
                        <h4>Name verification</h4>
                        <p className="case-prose">
                          {gn.name_verification.name_consistent
                            ? "✓ Consistent with the document"
                            : "⚠ Possible discrepancy"}
                          {gn.name_verification.name_in_document
                            ? ` — “${gn.name_verification.name_in_document}”`
                            : ""}
                        </p>
                        {gn.name_verification.discrepancy_note && (
                          <p className="case-prose case-muted">
                            {gn.name_verification.discrepancy_note}
                          </p>
                        )}
                      </div>
                    )}
                    {gn.keywords_rationale && (
                      <div className="case-note">
                        <h4>Keywords rationale</h4>
                        <p className="case-prose">{gn.keywords_rationale}</p>
                      </div>
                    )}
                    {gn.location_rationale && (
                      <div className="case-note">
                        <h4>Location rationale</h4>
                        <p className="case-prose">{gn.location_rationale}</p>
                      </div>
                    )}
                    {gn.registry_rationale && (
                      <div className="case-note">
                        <h4>Registry rationale</h4>
                        <p className="case-prose">{gn.registry_rationale}</p>
                      </div>
                    )}
                    {Array.isArray(gn.warnings) && gn.warnings.length > 0 && (
                      <div className="case-note">
                        <h4>Warnings</h4>
                        <ul className="case-issues">
                          {gn.warnings.map((w, i) => (
                            <li key={i}>{typeof w === "string" ? w : JSON.stringify(w)}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {Array.isArray(gn.collisions) && gn.collisions.length > 0 && (
                      <div className="case-note">
                        <h4>Collisions</h4>
                        <ul className="case-issues">
                          {gn.collisions.map((c, i) => (
                            <li key={i}>{typeof c === "string" ? c : JSON.stringify(c)}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {gn.model && (
                      <p className="case-prose case-muted">Generated by {gn.model}</p>
                    )}
                  </div>
                ) : (
                  <p className="case-prose case-muted">
                    No generation notes are recorded for this case.
                  </p>
                )}
              </section>
            )}

            {/* ── Case-analysis view ────────────────────────────────── */}
            {view === "case" && (
              <>
                <div className="case-controls">
                  <div className="case-topline">
                    <span className="case-area">
                      {lang === "fr" ? "Domaine de droit" : "Practice area"}:{" "}
                      {data.practice_area || "—"}
                    </span>
                    <div className="case-lang-toggle" role="group" aria-label="Language">
                      {(["en", "fr"] as const).map((l) => (
                        <button
                          key={l}
                          className={lang === l ? "active" : ""}
                          aria-pressed={lang === l}
                          onClick={() => setLang(l)}
                        >
                          {l.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="case-sections-toggle">
                    {SECTION_ORDER.map((key) => (
                      <label key={key} className="case-section-check">
                        <input
                          type="checkbox"
                          checked={visible[key]}
                          onChange={() => toggleSection(key)}
                        />
                        <span>{SECTION_LABELS[key][lang]}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {visible.keywords && keywords.length > 0 && (
                  <section className="case-section">
                    <h3>{SECTION_LABELS.keywords[lang]}</h3>
                    <ul className="case-keywords">
                      {keywords.map((k) => (
                        <li key={k.keyword_id} className={`kw kw-tier-${k.tier ?? 0}`}>
                          {/* Unilingual: one language only, per the EN/FR choice. */}
                          <span className="kw-en">{lang === "fr" ? k.fr ?? k.en : k.en}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {visible.summary && (
                  <section className="case-section">
                    <h3>{SECTION_LABELS.summary[lang]}</h3>
                    {summaryText ? (
                      <p className="case-prose" lang={lang}>{summaryText}</p>
                    ) : (
                      <p className="case-prose case-muted">
                        {lang === "fr"
                          ? "No French résumé is available for this case."
                          : "No English summary is available for this case."}
                      </p>
                    )}
                  </section>
                )}

                {visible.issues && (data.defining_issues?.length ?? 0) > 0 && (
                  <section className="case-section">
                    <h3>{SECTION_LABELS.issues[lang]}</h3>
                    <ol className="case-issues">
                      {data.defining_issues.map((issue, i) => (
                        <li key={i}>{issue}</li>
                      ))}
                    </ol>
                  </section>
                )}

                {visible.firac && (data.firac?.length ?? 0) > 0 && (
                  <section className="case-section">
                    <h3>
                      {SECTION_LABELS.firac[lang]}{" "}
                      <span className="case-count">
                        {data.firac.length}{" "}
                        {lang === "fr"
                          ? data.firac.length === 1 ? "question" : "questions"
                          : data.firac.length === 1 ? "issue" : "issues"}
                      </span>
                    </h3>
                    {/* Blocks are ordered by seq; that order is the only thing
                        preserving the sequence the issues were analysed in. */}
                    {data.firac.map((b: ApiFirac) => (
                      <article key={b.seq} className="firac">
                        <button
                          className="firac-issue"
                          onClick={() => toggleBlock(b.seq)}
                          aria-expanded={openBlocks.has(b.seq)}
                        >
                          <span className="firac-seq">{b.seq}</span>
                          {b.issue}
                        </button>
                        {openBlocks.has(b.seq) && (
                          <dl className="firac-body">
                            {b.facts && (<><dt>Facts</dt><dd>{b.facts}</dd></>)}
                            {b.rule && (<><dt>Rule</dt><dd>{b.rule}</dd></>)}
                            {b.application && (<><dt>Application</dt><dd>{b.application}</dd></>)}
                            {b.conclusion && (<><dt>Conclusion</dt><dd>{b.conclusion}</dd></>)}
                          </dl>
                        )}
                      </article>
                    ))}
                  </section>
                )}

                {visible.text && (
                  <section className="case-section">
                    <h3>{SECTION_LABELS.text[lang]}</h3>
                    {text === null ? (
                      <button className="case-loadtext" onClick={loadText} disabled={loadingText}>
                        {loadingText
                          ? (lang === "fr" ? "Chargement…" : "Loading…")
                          : (lang === "fr" ? "Charger le texte intégral" : "Load full text")}
                      </button>
                    ) : (
                      <pre className="case-text">{text}</pre>
                    )}
                  </section>
                )}
              </>
            )}

            {data.url && (
              <a
                className="case-canlii"
                href={data.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on CanLII ↗
              </a>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
