// Case detail drawer — everything the database holds about one case.
//
// Replaces the old static `data/cases/<rank>.html` pages: the content now comes
// from GET /case/{case_id}, which is the only place the FIRAC analyses, the
// bilingual summaries and the resolved EN/FR keywords are available.
//
// The judgment text is NOT fetched up front — some are hundreds of KB — so the
// drawer opens immediately and pulls the text only when asked.

import { useEffect, useState } from "react";
import { apiCase, type ApiCaseDetail, type ApiFirac } from "../lib/api";
import "../styles/components/case-detail.css";

interface Props {
  caseId: string;
  onClose: () => void;
}

// /case/{id} returns keywords as objects; the list shape in ApiCase is the
// search-result form. Narrow it here rather than widening the shared type.
type KeywordObj = { keyword_id: string; en: string; fr: string | null; tier: number | null };

export function CaseDetail({ caseId, onClose }: Props) {
  const [data, setData] = useState<ApiCaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [openBlocks, setOpenBlocks] = useState<Set<number>>(new Set([1]));

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

  const keywords = (data?.keywords ?? []) as unknown as KeywordObj[];
  const place = [data?.city, data?.province].filter(Boolean).join(", ");

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
              {data.practice_area && (
                <div className="case-area">{data.practice_area}</div>
              )}
            </header>

            {keywords.length > 0 && (
              <section className="case-section">
                <h3>Keywords</h3>
                <ul className="case-keywords">
                  {keywords.map((k) => (
                    <li key={k.keyword_id} className={`kw kw-tier-${k.tier ?? 0}`}>
                      <span className="kw-en">{k.en}</span>
                      {k.fr && <span className="kw-fr">{k.fr}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.summary && (
              <section className="case-section">
                <h3>Summary</h3>
                <p className="case-prose">{data.summary}</p>
              </section>
            )}

            {data.resume && (
              <section className="case-section">
                <h3>Résumé <span className="case-lang">FR</span></h3>
                <p className="case-prose" lang="fr">{data.resume}</p>
              </section>
            )}

            {data.defining_issues?.length > 0 && (
              <section className="case-section">
                <h3>Defining issues</h3>
                <ol className="case-issues">
                  {data.defining_issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ol>
              </section>
            )}

            {data.firac?.length > 0 && (
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

            <section className="case-section">
              <h3>Full judgment</h3>
              {text === null ? (
                <button className="case-loadtext" onClick={loadText} disabled={loadingText}>
                  {loadingText ? "Loading…" : "Load full text"}
                </button>
              ) : (
                <pre className="case-text">{text}</pre>
              )}
            </section>

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
