import { Link, useLocation } from "react-router-dom";

// Browserbase-style floating capsule nav: logo left, links + filled CTA right.
// Styled by public/site.css (.site-nav).
export const Navbar = () => {
    const location = useLocation();
    const base = import.meta.env.BASE_URL;
    const path = location.pathname.replace(base, "/").replace("//", "/");

    const linkClass = (to: string) =>
        `site-nav-link${path === to ? " active" : ""}`;

    return (
        <div className="site-nav">
            <nav className="site-nav-container">
                <Link to="/" className="site-nav-logo">
                    TMU Database
                </Link>
                <div className="site-nav-right">
                    <ul className="site-nav-links">
                        <li>
                            <Link to="/" className={linkClass("/")}>
                                Home
                            </Link>
                        </li>
                        <li>
                            <Link to="/search" className={linkClass("/search")}>
                                Search
                            </Link>
                        </li>
                        <li>
                            <Link to="/about" className={linkClass("/about")}>
                                About
                            </Link>
                        </li>
                    </ul>
                    <Link to="/search" className="site-nav-cta">
                        Search cases →
                    </Link>
                </div>
            </nav>
        </div>
    );
};
