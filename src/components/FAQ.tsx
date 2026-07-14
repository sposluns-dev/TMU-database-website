import { ReactNode } from "react";
import "../styles/components/faq.css";

// TODO: replace with the real feedback form URL once available.
const feedbackUrl = "https://example.com/feedback";

const FeedbackLink = ({ children }: { children: ReactNode }) => (
    <a href={feedbackUrl} target="_blank" rel="noopener noreferrer">
        {children}
    </a>
);

type QA = { q: string; a: ReactNode };
type Group = { heading: string; items: QA[] };

const groups: Group[] = [
    {
        heading: "About the Database",
        items: [
            {
                q: "What is the database?",
                a: "A searchable, downloadable database of Canadian caselaw on Jewish identity, Judaism as a lived experience, multiculturalism, and antisemitism.",
            },
            {
                q: "What kinds of decisions are included?",
                a: "Decisions from all levels of courts and tribunals are included in this database, such as the Supreme Court of Canada, the Federal Court of Canada, Superior Courts of Justice, Courts of Appeal, the Refugee Appeal Division, and the Canadian Human Rights Tribunal.",
            },
            {
                q: "What jurisdictions are included in this dataset?",
                a: "Caselaw from all 10 provinces and 3 territories was searched and is included in this dataset.",
            },
        ],
    },
    {
        heading: "Search and Filters",
        items: [
            {
                q: "How do I search the database?",
                a: "Users can search by keyword, case name, court/tribunal, province, court type, and/or year of decision.",
            },
        ],
    },
    {
        heading: "Coverage and Updates",
        items: [
            {
                q: "How do you decide which cases to include?",
                a: (
                    <>
                        Using carefully selected inclusion and exclusion criteria,
                        cases were included if they:
                        <ul className="faq-answer-list">
                            <li>Included key words a significant number of times.</li>
                            <li>
                                Had an overall issue that involved Jewish identity,
                                including antisemitism, discrimination, or accommodation
                                on account of Jewish faith.
                            </li>
                        </ul>
                    </>
                ),
            },
            {
                q: "How current is the database?",
                a: "Cases are included from 1879–2026.",
            },
        ],
    },
    {
        heading: "Using the Database",
        items: [
            {
                q: "Is this database a substitute for other legal resources, such as CanLII, WestLaw, or Nexis?",
                a: "No. It is best framed as a specialized research tool that complements broader legal databases.",
            },
            {
                q: "How do I know whether a case is good law?",
                a: "It is important to verify currency through the original decision, citators, or other authoritative sources.",
            },
            {
                q: "Can I suggest a case to add?",
                a: (
                    <>
                        Use this <FeedbackLink>feedback form</FeedbackLink> to suggest a
                        case to add.
                    </>
                ),
            },
            {
                q: "How do I report an error in the dataset?",
                a: (
                    <>
                        Use this <FeedbackLink>feedback form</FeedbackLink> to report an
                        error in the dataset.
                    </>
                ),
            },
        ],
    },
    {
        heading: "About the Project",
        items: [
            {
                q: "Who created and maintains the database?",
                a: "This database was created by Sari Graben in Toronto, Ontario. It is maintained by Noa Daniel, Research Assistant, and Simon Posluns, Technologist.",
            },
        ],
    },
];

export function FAQ() {
    return (
        <div className="faq">
            <h1 className="faq-page-title">Frequently Asked Questions</h1>

            {groups.map((group) => (
                <section key={group.heading} className="faq-section">
                    <h2 className="faq-section-title">{group.heading}</h2>
                    <dl className="faq-list">
                        {group.items.map((item) => (
                            <div key={item.q} className="faq-item">
                                <dt className="faq-question">{item.q}</dt>
                                <dd className="faq-answer">{item.a}</dd>
                            </div>
                        ))}
                    </dl>
                </section>
            ))}
        </div>
    );
}
