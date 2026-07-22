// Case detail drawer — the "Summary, issues & FIRAC" view for one case.
//
// Content comes from GET /case/{case_id}, the only place the FIRAC analyses, the
// bilingual summaries and the resolved EN/FR keywords are available.
//
// A top control bar carries a Practice area line, an EN/FR language choice, and a
// row of checkboxes that show/hide each section (Keywords, Summary, Defining
// issues, FIRAC analysis, Full text, Generation notes). Section TITLES stay in
// English for now; only the CONTENT (summary/résumé, keyword wording) follows the
// EN/FR toggle.
//
// The judgment text is NOT fetched up front — some are hundreds of KB — so the
// drawer opens immediately and pulls the text only when the Full text section is
// shown.

import { useEffect, useRef, useState } from "react";
import { apiCase, type ApiCaseDetail, type ApiFirac } from "../lib/api";
import "../styles/components/case-detail.css";

interface Props {
  caseId: string;
  onClose: () => void;
  /** Open with a particular section revealed and scrolled into view. */
  focus?: "notes";
}

// /case/{id} returns keywords as objects; the list shape in ApiCase is the
// search-result form. Narrow it here rather than widening the shared type.
type KeywordObj = { keyword_id: string; en: string; fr: string | null; tier: number | null };

type SectionKey = "keywords" | "summary" | "issues" | "firac" | "text" | "notes";

// Section titles are English by design (see file header).
const SECTIONS: [SectionKey, string][] = [
  ["keywords", "Keywords"],
  ["summary", "Summary"],
  ["issues", "Defining issues"],
  ["firac", "FIRAC analysis"],
  ["text", "Full text"],
  ["notes", "Generation notes"],
];

export function CaseDetail({ caseId, onClose, focus }: Props) {
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
    notes: focus === "notes",
  });
  const notesRef = useRef<HTMLElement | null>(null);

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

  // Opening via "View Generation Notes" reveals that section and scrolls to it.
  useEffect(() => {
    if (focus === "notes") {
      setVisible((v) => ({ ...v, notes: true }));
    }
  }, [caseId, focus]);

  useEffect(() => {
    if (visible.notes && focus === "notes" && data) {
      notesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [visible.notes, focus, data]);

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

  return (
    <div className="case-drawer-backdrop" onClick={onClose}>
      <aside
        className="case-drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={data?.case_name ?? caseId}
      >
        <button className="case-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        {error && <p className="case-error">Could not load {caseId}: {error}</p>}
        {!data && !error && <p className="case-loading">Loading {caseId}…</p>}

        {data && (
          <>
            <header className="case-header">
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

            {/* Practice area + EN/FR choice + which sections to show. */}
            <div className="case-controls">
              <div className="case-topline">
                <span className="case-area">
                  Practice area: {data.practice_area || "—"}
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
                {SECTIONS.map(([key, label]) => (
                  <label key={key} className="case-section-check">
                    <input
                      type="checkbox"
                      checked={visible[key]}
                      onChange={() => toggleSection(key)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>

            {visible.keywords && keywords.length > 0 && (
              <section className="case-section">
                <h3>Keywords</h3>
                <ul className="case-keywords">
                  {keywords.map((k) => {
                    const primary = lang === "fr" ? k.fr ?? k.en : k.en;
                    const secondary = lang === "fr" ? k.en : k.fr;
                    return (
                      <li key={k.keyword_id} className={`kw kw-tier-${k.tier ?? 0}`}>
                        <span className="kw-en">{primary}</span>
                        {secondary && <span className="kw-fr">{secondary}</span>}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {visible.summary && (
              <section className="case-section">
                <h3>
                  Summary <span className="case-lang">{lang.toUpperCase()}</span>
                </h3>
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
                <h3>Defining issues</h3>
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
                  FIRAC analysis{" "}
                  <span className="case-count">
                    {data.firac.length} issue{data.firac.length === 1 ? "" : "s"}
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
                <h3>Full text</h3>
                {text === null ? (
                  <button className="case-loadtext" onClick={loadText} disabled={loadingText}>
                    {loadingText ? "Loading…" : "Load full text"}
                  </button>
                ) : (
                  <pre className="case-text">{text}</pre>
                )}
              </section>
            )}

            {visible.notes && (
              <section className="case-section" ref={notesRef}>
                <h3>Generation notes</h3>
                {data.generation_notes ? (
                  <div className="case-notes">
                    {data.generation_notes.name_verification && (
                      <div className="case-note">
                        <h4>Name verification</h4>
                        <p className="case-prose">
                          {data.generation_notes.name_verification.name_consistent
                            ? "✓ Consistent with the document"
                            : "⚠ Possible discrepancy"}
                          {data.generation_notes.name_verification.name_in_document
                            ? ` — “${data.generation_notes.name_verification.name_in_document}”`
                            : ""}
                        </p>
                        {data.generation_notes.name_verification.discrepancy_note && (
                          <p className="case-prose case-muted">
                            {data.generation_notes.name_verification.discrepancy_note}
                          </p>
                        )}
                      </div>
                    )}
                    {data.generation_notes.keywords_rationale && (
                      <div className="case-note">
                        <h4>Keywords rationale</h4>
                        <p className="case-prose">{data.generation_notes.keywords_rationale}</p>
                      </div>
                    )}
                    {data.generation_notes.location_rationale && (
                      <div className="case-note">
                        <h4>Location rationale</h4>
                        <p className="case-prose">{data.generation_notes.location_rationale}</p>
                      </div>
                    )}
                    {data.generation_notes.registry_rationale && (
                      <div className="case-note">
                        <h4>Registry rationale</h4>
                        <p className="case-prose">{data.generation_notes.registry_rationale}</p>
                      </div>
                    )}
                    {Array.isArray(data.generation_notes.warnings) &&
                      data.generation_notes.warnings.length > 0 && (
                        <div className="case-note">
                          <h4>Warnings</h4>
                          <ul className="case-issues">
                            {data.generation_notes.warnings.map((w, i) => (
                              <li key={i}>{typeof w === "string" ? w : JSON.stringify(w)}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    {Array.isArray(data.generation_notes.collisions) &&
                      data.generation_notes.collisions.length > 0 && (
                        <div className="case-note">
                          <h4>Collisions</h4>
                          <ul className="case-issues">
                            {data.generation_notes.collisions.map((c, i) => (
                              <li key={i}>{typeof c === "string" ? c : JSON.stringify(c)}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    {data.generation_notes.model && (
                      <p className="case-prose case-muted">
                        Generated by {data.generation_notes.model}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="case-prose case-muted">
                    No generation notes are recorded for this case.
                  </p>
                )}
              </section>
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
