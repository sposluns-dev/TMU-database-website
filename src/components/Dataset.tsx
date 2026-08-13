import { Link } from "react-router-dom";
import { useStats } from "../lib/stats";
import { MCP_ENABLED } from "../lib/features.ts";

// Dataset / data-access page, modelled on a2aj.ca/data: what the collection is,
// its coverage, and the ways to access it (search, MCP).
//
// The Hugging Face card was removed once those datasets were deleted from
// sposluns-tmu — a card advertising a 404 is worse than no card.
//
// The MCP connector URL below is real but the endpoint is NOT live until
// mcp_server.asgi_app() is mounted in server/app.py and deployed, so the card is
// gated on MCP_ENABLED (lib/features.ts), off in production until then.
const MCP_URL =
  "https://tmu-case-db-777191320769.northamerica-northeast2.run.app/mcp/";

const heading = { fontFamily: "var(--font-heading)" } as const;
const card = {
  border: "1px solid var(--border, #ddd)",
  borderRadius: 10,
  padding: "1rem 1.25rem",
  margin: "0.75rem 0",
} as const;

export function Dataset() {
  const stats = useStats();
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 20px 4rem" }}>
      <h1 style={heading}>Dataset</h1>

      <p>
        This project curates <strong>{stats ? stats.total.toLocaleString() : "—"}{" "}
        Canadian court and tribunal decisions</strong> relating to antisemitism,
        religious freedom, and hate speech — drawn from the{" "}
        <a href="https://a2aj.ca/" target="_blank" rel="noopener noreferrer">
          A2AJ Canadian Legal Data
        </a>{" "}
        project and provided directly from provincial courts. Courts include the Supreme Court of Canada, Federal Court, provincial
          appellate, superior, and lower courts, and tribunals (CHRT, RPD/RAD). Decisions dating from {stats ? `${stats.yearMin} to ${stats.yearMax}` : "—"}.The full decision text and metadata are free to
        search, download, and reuse.
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

      {MCP_ENABLED && (
        <div style={card}>
          <h3 style={heading}>AI assistant (MCP)</h3>
          <p>
            The Model Context Protocol (MCP) lets an AI assistant such as Claude
            query this collection in plain language. Connect once, then ask
            questions about the cases directly in a chat — the assistant searches
            the collection and reads decisions for you, using your own Claude
            subscription.
          </p>
          <p>
            It searches case names, parties, and the full text of every decision,
            with the same curated keyword vocabulary used by the search page.
          </p>
          <p style={{ marginBottom: "0.4rem" }}>
            <strong>Setup for Claude</strong>{" "}
            <span style={{ color: "var(--muted, #666)" }}>
              (may require a paid Claude account)
            </span>
          </p>
          <ol style={{ margin: "0 0 0.75rem", paddingLeft: "1.2rem" }}>
            <li>
              In claude.ai, go to <strong>Settings → Connectors</strong>.
            </li>
            <li>
              Click <strong>Add Custom Connector</strong>.
            </li>
            <li>
              Enter the name <strong>JICL Database</strong> and the server URL
              below.
            </li>
            <li>Start a new chat and ask about the collection.</li>
          </ol>
          <p style={{ margin: 0 }}>
            <code
              style={{
                display: "block",
                overflowX: "auto",
                padding: "0.5rem 0.65rem",
                borderRadius: 6,
                background: "var(--code-bg, #f4f4f5)",
                fontSize: "0.85rem",
              }}
            >
              {MCP_URL}
            </code>
          </p>
        </div>
      )}

      <h2 style={heading}>Sources &amp; licence</h2>
      <p style={{ color: "var(--muted, #666)", fontSize: "0.9rem" }}>
        Decision text is sourced from the A2AJ Canadian Legal Data project; please consult those sources for their terms of use. Curation and
        metadata are provided for research and educational use.
      </p>
    </div>
  );
}
