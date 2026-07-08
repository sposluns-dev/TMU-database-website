import { Link } from "react-router-dom";

// Dataset / data-access page, modelled on a2aj.ca/data: what the collection is,
// its coverage, and the ways to access it (search, Hugging Face, downloads, MCP).
// NOTE: confirm the Hugging Face URL and MCP endpoint below before publishing —
// they are placeholders until the dataset repo / MCP server are live.
const HF_DATASET = "https://huggingface.co/datasets/sposluns/tmu-canadian-caselaw";

const heading = { fontFamily: "var(--font-heading)" } as const;
const card = {
  border: "1px solid var(--border, #ddd)",
  borderRadius: 10,
  padding: "1rem 1.25rem",
  margin: "0.75rem 0",
} as const;

export function Dataset() {
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 20px 4rem" }}>
      <h1 style={heading}>Dataset</h1>

      <p>
        This project curates <strong>481 Canadian upper-court and tribunal
        decisions</strong> relating to antisemitism, religious freedom, and hate
        speech — drawn from the{" "}
        <a href="https://a2aj.ca/" target="_blank" rel="noopener noreferrer">
          A2AJ Canadian Legal Data
        </a>{" "}
        project and CanLII. The full decision text and metadata are free to
        search, download, and reuse.
      </p>

      <h2 style={heading}>Coverage</h2>
      <ul>
        <li>481 curated decisions (upper courts &amp; tribunals)</li>
        <li>
          Courts include the Supreme Court of Canada, Federal Court, provincial
          appellate and superior courts, and tribunals (CHRT, RPD/RAD)
        </li>
        <li>Decisions dating from 1912 to 2026</li>
      </ul>
      <p style={{ color: "var(--muted, #666)", fontSize: "0.9rem" }}>
        Lower-court decisions are being prepared and will be added later.
      </p>

      <h2 style={heading}>Access</h2>

      <div style={card}>
        <h3 style={heading}>Search on this site</h3>
        <p>
          Keyword / full-text search across every decision, with court and date
          filters — no download needed.{" "}
          <Link to="/search">Open the search page →</Link>
        </p>
      </div>

      <div style={card}>
        <h3 style={heading}>Hugging Face</h3>
        <p>
          The full collection is published as a Hugging Face dataset for
          machine-readable and bulk access.{" "}
          <a href={HF_DATASET} target="_blank" rel="noopener noreferrer">
            View the dataset →
          </a>
        </p>
        <pre style={{ overflowX: "auto", background: "var(--code-bg, #f5f5f5)", padding: "0.75rem", borderRadius: 8 }}>
{`from datasets import load_dataset
ds = load_dataset("sposluns/tmu-canadian-caselaw")`}
        </pre>
      </div>

      <div style={card}>
        <h3 style={heading}>Downloads</h3>
        <p>
          Direct files on Hugging Face: <code>cases.jsonl</code> (one row per
          decision — citation, case name, court, date, full text).{" "}
          <a href={`${HF_DATASET}/tree/main`} target="_blank" rel="noopener noreferrer">
            Browse files →
          </a>
        </p>
      </div>

      <div style={card}>
        <h3 style={heading}>AI assistant (MCP)</h3>
        <p>
          An MCP server lets you query the collection directly from Claude
          (keyword and semantic search over the cases), using your own Claude
          subscription. <em>Connector endpoint coming soon.</em>
        </p>
      </div>

      <h2 style={heading}>Sources &amp; licence</h2>
      <p style={{ color: "var(--muted, #666)", fontSize: "0.9rem" }}>
        Decision text is sourced from the A2AJ Canadian Legal Data project and
        CanLII; please consult those sources for their terms of use. Curation and
        metadata are provided for research and educational use.
      </p>
    </div>
  );
}
