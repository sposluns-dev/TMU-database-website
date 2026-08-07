import "../styles/components/footer.css";

export const Footer = () => (
    <footer id="contact" className="footer">
        <div className="container">
            <p>Jewish Identity in Canadian Law: A Database</p>
            <p className="copyright">
                © {new Date().getFullYear()} JICL Database
            </p>
        </div>
    </footer>
);
