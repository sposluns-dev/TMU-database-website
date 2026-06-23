import { Link, useLocation } from "react-router-dom";

// Renders the same markup/classes as the static pages (scc.html), styled by the
// shared public/site.css. One navbar definition across every page — the way
// a2aj.ca keeps its nav identical site-wide.
export const Navbar = () => {
    const location = useLocation();
    const base = import.meta.env.BASE_URL;
    const isHome = location.pathname === "/" || location.pathname === base;

    return (
        <nav className="site-nav">
            <div className="site-nav-container">
                <Link to="/" className="site-nav-logo">
                    TMU database website
                </Link>
                <ul className="site-nav-links">
                    <li>
                        <Link
                            to="/"
                            className={`site-nav-link${isHome ? " active" : ""}`}
                        >
                            Home
                        </Link>
                    </li>
                    <li>
                        <a href={`${base}scc.html`} className="site-nav-link">
                            SCC Rulings
                        </a>
                    </li>
                </ul>
            </div>
        </nav>
    );
};
