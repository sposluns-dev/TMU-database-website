import "../styles/components/footer.css";

export const Footer = () => (
    <footer id="contact" className="footer">
        <div className="container">
            <p>Jewish Identity in Canadian Law: A Database</p>
            <p className="copyright">
                © {new Date().getFullYear()} JICL Database. Decision text sourced from{" "}
                <a href="https://a2aj.ca/" target="_blank" rel="noopener noreferrer">
                    A2AJ
                </a>{" "}
                and CanLII.
            </p>
        </div>
    </footer>
);
