import "../styles/components/about.css";

const researchQuestions = [
    "How does Canadian law see Jewish identity?",
    "How do Canadian courts recognize and analyze antisemitism as a form of harm across different legal contexts, and when do they describe it explicitly as antisemitism versus more general concepts such as bias or discrimination?",
    "How do Canadian courts define and evaluate harmful speech involving Jewish identity? Where do they draw the legal boundary between protected expression and antisemitic harm?",
    "How do Canadian courts articulate and balance constitutional and human rights values (such as equality, religious freedom, and accommodation) in cases involving Jewish identity, and what does this reveal about the relationship between individual and collective rights?",
    "How do Canadian courts construct, define, and recognize Jewish identity across different areas of law?",
];

const researchThemes = [
    "Antisemitism and discrimination",
    "Speech and conduct",
    "Defamation and reputation",
    "Employment and dismissal",
    "Exclusion",
    "Values and accommodation",
    "Multiculturalism",
    "Jewish identity",
    "Political expression",
];

const researchTerms = [
    "Antisemitism",
    "Bias",
    "Prejudice",
    "Discrimination",
    "Defamation",
    "Religious values",
    "Religious accommodation",
    "Jewish identity",
];

const a2ajCourts: [string, string][] = [
    ["Supreme Court of Canada", "1877–present"],
    ["Federal Court of Appeal", "2001–present"],
    ["Federal Court", "2001–present"],
    ["Tax Court of Canada", "2003–present"],
    ["Court Martial Appeal Court", "2001–present"],
    ["BC Court of Appeal", "1999–present"],
    ["BC Supreme Court", "2000–present"],
    ["Nova Scotia Court of Appeal", "1993–present"],
    ["Nova Scotia Supreme Court", "2001–present"],
    ["Nova Scotia Provincial Court", "2001–present"],
    ["Nova Scotia Family Court", "2001–2023"],
    ["Nova Scotia Small Claims Court", "2001–present"],
    ["Ontario Court of Appeal", "1998–present"],
    ["Yukon Court of Appeal", "2000–present"],
    ["Canada Industrial Relations Board (CIRB)", "1995–present"],
    ["Canadian Human Rights Tribunal (CHRT)", "2003–present"],
    ["Canadian International Trade Tribunal (CITT)", "1980–present"],
    ["Competition Tribunal (CT)", "2000–present"],
    ["Federal Public Sector Labour Relations and Employment Board (FPSLREB)", "2003–present"],
    ["Information Commissioner of Canada (OIC)", "2019–present"],
    ["Occupational Health and Safety Tribunal Canada (OHSTC)", "1992–present"],
    ["Public Service Disclosure Protection Tribunal (PSDPT)", "2011–present"],
    ["Refugee Appeal Division (RAD)", "2013–present"],
    ["Refugee Law Lab Reporter (RLLR)", "2019–2024"],
    ["Refugee Protection Division (RPD)", "2002–2020"],
    ["Social Security Tribunal (SST)", "2013–present"],
];

const canliiCourts: [string, string][] = [
    ["Provincial Court of British Columbia", "2000–present"],
    ["Court of Appeal of Alberta", "1970–present"],
    ["Court of King’s Bench of Alberta", "1971–present"],
    ["Alberta Court of Justice", "1998–present"],
    ["Court of Appeal for Saskatchewan", "1979–present"],
    ["Court of King’s Bench for Saskatchewan", "1981–present"],
    ["Provincial Court of Saskatchewan", "2001–present"],
    ["Court of Appeal of Manitoba", "1999–present"],
    ["Court of King’s Bench of Manitoba", "2001–present"],
    ["Provincial Court of Manitoba", "2000–present"],
    ["Ontario Superior Court of Justice", "2003–present"],
    ["Ontario Divisional Court", "2003–present"],
    ["Ontario Court of Justice", "2005–present"],
    ["Court of Appeal of Quebec", "1986–present"],
    ["Quebec Superior Court", "2002–present"],
    ["Court of Quebec", "2002–present"],
    ["Quebec Municipal Courts", "2000–present"],
    ["Court of King’s Bench of New Brunswick", "1990–present"],
    ["Provincial Court of New Brunswick", "2025–present"],
    ["Prince Edward Island Court of Appeal", "1993–present"],
    ["Supreme Court of Prince Edward Island", "1993–present"],
    ["Court of Appeal of Newfoundland and Labrador", "1985–present"],
    ["Supreme Court of Newfoundland and Labrador", "1987–present"],
    ["Provincial Court of Newfoundland and Labrador", "2002–present"],
    ["Court of Appeal of Yukon", "1996–present"],
    ["Supreme Court of Yukon", "2001–present"],
    ["Territorial Court of Yukon", "2001–present"],
    ["Small Claims Court of the Yukon", "2003–present"],
    ["Court of Appeal for the Northwest Territories", "1996–present"],
    ["Supreme Court of the Northwest Territories", "1996–present"],
    ["Territorial Court of the Northwest Territories", "2002–present"],
    ["Northwest Territories Youth Justice Court", "2000–present"],
    ["Court of Appeal of Nunavut", "2002–present"],
    ["Nunavut Court of Justice", "1999–present"],
    ["Youth Justice Court of Nunavut", "2012–present"],
];

const team: [string, string][] = [
    ["Sari Graben", "Principal Researcher"],
    ["Noa Daniel", "Legal Research Assistant"],
    ["Simon Posluns", "Technologist"],
];

function CourtList({ courts }: { courts: [string, string][] }) {
    return (
        <dl className="about-court-list">
            {courts.map(([name, years]) => (
                <div key={name} className="about-court-row">
                    <dt>{name}</dt>
                    <dd>{years}</dd>
                </div>
            ))}
        </dl>
    );
}

const A2ajLink = () => (
    <a href="https://a2aj.ca/" target="_blank" rel="noopener noreferrer">
        A2AJ
    </a>
);

export function About() {
    return (
        <div className="about">
            <h1 className="about-page-title">About</h1>
            <p className="about-lede">
                Project purpose, methodology, and focus on Jewish identity as a lived
                experience in Canadian law.
            </p>

            {/* PROJECT PURPOSE */}
            <section className="about-section">
                <h2 className="about-section-title">Project Purpose</h2>

                <h3>What is the database about?</h3>
                <p>
                    This database centers on Jewish identity in Canadian law. It brings
                    together cases that show both harms directed at Jewish individuals
                    and communities and positive legal recognition of Jewish identity
                    through accommodation, pluralism, and equality.
                </p>

                <h3>What is the database for?</h3>
                <p>
                    This database is designed to help users search, compare, and analyze
                    Canadian case law on Jewish identity across different courts, legal
                    issues, and time periods. It supports research into how Canadian law
                    understands Jewishness, responds to antisemitism, and engages with
                    themes such as speech, defamation, and employment.
                </p>

                <h3>How is the database built?</h3>
                <p>
                    The database is built from Canadian case law materials derived from
                    Access to Algorithmic Justice (<A2ajLink />), which collects
                    open-access decisions from Canadian courts and tribunals and
                    maintains them as a structured legal dataset. It fills in the gaps
                    from A2AJ through the use of CanLII for lower court decisions. This
                    project uses the foundation of these two resources, along with
                    curated inclusion and exclusion criteria, thematic tagging, and
                    case-level review, to assemble a focused research database on Jewish
                    identity and related legal questions.
                </p>
            </section>

            {/* METHODOLOGY */}
            <section className="about-section">
                <h2 className="about-section-title">Methodology</h2>
                <p className="about-note">This section is still in progress.</p>

                <h3>Core Research Questions</h3>
                <ol className="about-questions">
                    {researchQuestions.map((q) => (
                        <li key={q}>{q}</li>
                    ))}
                </ol>

                <h3>Core Research Themes</h3>
                <ul className="about-tags">
                    {researchThemes.map((t) => (
                        <li key={t}>{t}</li>
                    ))}
                </ul>

                <h3>Core Research Terms</h3>
                <ul className="about-tags">
                    {researchTerms.map((t) => (
                        <li key={t}>{t}</li>
                    ))}
                </ul>

                <h3>
                    Courts &amp; Years Researched — <A2ajLink />
                </h3>
                <CourtList courts={a2ajCourts} />

                <h3>Additional Courts &amp; Tribunals Researched — CanLII</h3>
                <CourtList courts={canliiCourts} />
            </section>

            {/* TEAM */}
            <section className="about-section">
                <h2 className="about-section-title">Team</h2>
                <ul className="about-team">
                    {team.map(([name, role]) => (
                        <li key={name}>
                            <span className="about-team-name">{name}</span>
                            <span className="about-team-role">{role}</span>
                        </li>
                    ))}
                </ul>
            </section>

            {/* LIMITATIONS & BIAS */}
            <section className="about-section">
                <h2 className="about-section-title">Limitations &amp; Bias</h2>

                <h3>Limitations of A2AJ &amp; CanLII as sources</h3>
                <p>
                    Parts of this database are built from case law materials derived
                    from A2AJ, while other parts stem from CanLII. Both sources provide
                    a strong foundation for identifying relevant Canadian decisions.
                    However, they may not capture every potentially relevant case, and
                    some decisions may be missing or grouped differently based on
                    specific search terms or themes used to conduct research. The
                    database is therefore best understood as a focused research tool
                    rather than a fully exhaustive record of all Canadian case law on
                    Jewish identity.
                </p>

                <h3>Limitations of the scope of the database</h3>
                <p>
                    This project focuses on Canadian court and tribunal decisions that
                    meaningfully engage Jewish identity, antisemitism, multiculturalism,
                    and related legal issues. The database is limited to the
                    jurisdictions, court levels, and years selected for inclusion based
                    on A2AJ &amp; CanLII availability, and its contents reflect the
                    research criteria used to build it.
                </p>

                <h3>Relevant bias</h3>
                <p>
                    The database reflects a selection process shaped by the research
                    questions and inclusion criteria of the project. As a result, cases
                    are included when they offer meaningful insight into Jewish identity
                    or related legal themes, and excluded when Jewish references are
                    merely incidental or not legally significant.
                </p>

                <h3>Limitations of viewing the Jewish experience through a legal lens</h3>
                <p>
                    This database examines the Jewish experience through a legal lens and
                    is therefore limited in scope. Jewish identity and experience can
                    also be understood through a range of other perspectives, including
                    social, cultural, historical, and religious frameworks. These
                    dimensions fall outside the scope of this project and are not
                    reflected in the materials presented here.
                </p>
            </section>
        </div>
    );
}
