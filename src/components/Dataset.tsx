import { Link } from "react-router-dom";

// Dataset / data-access page, modelled on a2aj.ca/data: what the collection is,
// its coverage, and the ways to access it (search, Hugging Face, downloads, MCP).
// NOTE: the MCP connector endpoint is still a placeholder until the server is live.
const HF_DATASET = "https://huggingface.co/datasets/sposluns-tmu/tmu-canadian-caselaw";
const HF_REPO_ID = "sposluns-tmu/tmu-canadian-caselaw";

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
        This project curates <strong>1,599 Canadian court and tribunal
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
        <li>1,599 curated decisions across all court levels &amp; tribunals</li>
        <li>
          Courts include the Supreme Court of Canada, Federal Court, provincial
          appellate, superior, and lower courts, and tribunals (CHRT, RPD/RAD)
        </li>
        <li>Decisions dating from 1879 to 2026</li>
      </ul>

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
ds = load_dataset("${HF_REPO_ID}")`}
        </pre>
      </div>

      <div style={card}>
        <h3 style={heading}>REST API</h3>
        <p>
          Query the collection over Hugging Face's hosted datasets-server — free,
          no key, CORS-enabled. Full-text search and paginated rows:
        </p>
        <pre style={{ overflowX: "auto", background: "var(--code-bg, #f5f5f5)", padding: "0.75rem", borderRadius: 8 }}>
{`# Full-text search
GET https://datasets-server.huggingface.co/search
  ?dataset=${HF_REPO_ID}&config=cases&split=train&query=hate+speech

# Paginated rows
GET https://datasets-server.huggingface.co/rows
  ?dataset=${HF_REPO_ID}&config=cases&split=train&offset=0&length=100`}
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
