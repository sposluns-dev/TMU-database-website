import { FormEvent, useState } from "react";
import "../styles/components/feedback.css";

// TODO: replace with the address that should receive feedback submissions.
const FEEDBACK_EMAIL = "feedback@example.com";

const reasons = ["Suggest a case", "Report an error", "Other comment"] as const;
type Reason = (typeof reasons)[number];

export function Feedback() {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [reason, setReason] = useState<Reason>(reasons[0]);
    const [message, setMessage] = useState("");

    function handleSubmit(e: FormEvent) {
        e.preventDefault();
        const subject = `[JICL Feedback] ${reason}`;
        const body = [
            `Name: ${name}`,
            `Email: ${email}`,
            `Reason: ${reason}`,
            "",
            message,
        ].join("\n");
        const mailto = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(
            subject
        )}&body=${encodeURIComponent(body)}`;
        window.location.href = mailto;
    }

    return (
        <div className="feedback">
            <h1 className="feedback-page-title">Feedback</h1>
            <p className="feedback-intro">
                Suggest a case, report an error, or share a comment. Submitting the
                form opens your email client with the details ready to send.
            </p>

            <form className="feedback-form" onSubmit={handleSubmit}>
                <div className="feedback-field">
                    <label htmlFor="fb-name">Name</label>
                    <input
                        id="fb-name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                    />
                </div>

                <div className="feedback-field">
                    <label htmlFor="fb-email">Email</label>
                    <input
                        id="fb-email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                    />
                </div>

                <div className="feedback-field">
                    <label htmlFor="fb-reason">Reason for feedback</label>
                    <select
                        id="fb-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value as Reason)}
                    >
                        {reasons.map((r) => (
                            <option key={r} value={r}>
                                {r}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="feedback-field">
                    <label htmlFor="fb-message">Message</label>
                    <textarea
                        id="fb-message"
                        rows={6}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        required
                    />
                </div>

                <button type="submit" className="feedback-submit">
                    Send feedback
                </button>
            </form>
        </div>
    );
}
