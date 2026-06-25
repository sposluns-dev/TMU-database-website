import { Link, useLocation } from "react-router-dom";

// Site-wide nav: Home · Search · About. Styled by public/site.css (.site-nav).
export const Navbar = () => {
    const location = useLocation();
    const base = import.meta.env.BASE_URL;
    const path = location.pathname.replace(base, "/").replace("//", "/");

    const linkClass = (to: string) =>
        `site-nav-link${path === to ? " active" : ""}`;

    return (
        <nav className="site-nav">
            <div className="site-nav-container">
                <Link to="/" className="site-nav-logo">
                    TMU database website
                </Link>
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
            </div>
        </nav>
    );
};
