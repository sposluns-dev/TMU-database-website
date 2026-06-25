export function About() {
    return (
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 20px 4rem" }}>
            <h1 style={{ fontFamily: "var(--font-heading)" }}>About</h1>

            <p>
                This database collects 481 Canadian court and tribunal decisions
                relating to antisemitism, religious freedom, and hate speech,
                curated from the A2AJ Canadian Legal Data project and CanLII.
            </p>

            <h2 style={{ fontFamily: "var(--font-heading)" }}>Search</h2>
            <p>
                The Search page runs entirely in your browser — no server. It
                offers keyword and semantic (meaning-based) search, filtering by
                court and year, CSV export, and visualizations including a Canada
                map of cases by province.
            </p>

            <h2 style={{ fontFamily: "var(--font-heading)" }}>Data &amp; caveats</h2>
            <p>
                Texts are unofficial copies gathered through automated processes
                and may contain inaccuracies. Always verify against official
                sources. Please respect publication bans and privacy; some
                tribunal decisions have no public name.
            </p>

            <h2 style={{ fontFamily: "var(--font-heading)" }}>Attribution</h2>
            <p>
                Case data: Sean Rehaag &amp; Simon Wallace, “A2AJ Canadian Legal
                Data” (2025). This project is not affiliated with the Government
                of Canada or any court or tribunal.
            </p>
        </div>
    );
}
