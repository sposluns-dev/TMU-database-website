import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion, Variants } from "framer-motion";

export const Navbar = () => {
    const [scrolled, setScrolled] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const location = useLocation();

    useEffect(() => {
        const handleScroll = () => setScrolled(window.scrollY > 50);
        window.addEventListener("scroll", handleScroll);
        return () => window.removeEventListener("scroll", handleScroll);
    }, []);

    const navbarVariants: Variants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: {
                duration: 0.3,
                ease: "easeInOut",
            },
        },
    };

    const linkVariants: Variants = {
        hover: {
            scale: 1.05,
            color: "var(--color-accent)",
            transition: {
                duration: 0.2,
                ease: "easeInOut",
            },
        },
    };

    const logoVariants: Variants = {
        hover: {
            scale: 1.05,
            transition: {
                duration: 0.2,
                ease: "easeInOut",
            },
        },
    };

    const toggleMobileMenu = () => {
        setMobileMenuOpen(!mobileMenuOpen);
    };

    const handleHamburgerClick = () => {
        setMobileMenuOpen(false);
    };

    return (
        <motion.nav
            className={`navbar ${scrolled ? "scrolled" : ""}`}
            initial="hidden"
            animate="visible"
            variants={navbarVariants}
        >
            <div className="nav-container">
                <motion.div whileHover="hover" variants={logoVariants}>
                    <Link to="/" className="nav-logo">
                        TMU database website
                    </Link>
                </motion.div>

                <div className="mobile-menu-toggle" onClick={toggleMobileMenu}>
                    <motion.div
                        className={`hamburger ${mobileMenuOpen ? "open" : ""}`}
                        animate={{
                            rotate: mobileMenuOpen ? 45 : 0,
                        }}
                        transition={{ duration: 0.2 }}
                    >
                        <span></span>
                        <span></span>
                        <span></span>
                    </motion.div>
                </div>

                <motion.ul
                    className={`nav-menu ${mobileMenuOpen ? "active" : ""}`}
                    initial={{ top: "-700%" }}
                    animate={{
                        top: mobileMenuOpen ? "86px" : "-700%",
                    }}
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                >
                    <motion.li whileHover="hover" variants={linkVariants}>
                        <Link
                            to="/"
                            className={`nav-link ${
                                location.pathname === "/" ? "active" : ""
                            }`}
                            onClick={handleHamburgerClick}
                        >
                            Home
                        </Link>
                    </motion.li>
                    <motion.li whileHover="hover" variants={linkVariants}>
                        <a
                            href={`${import.meta.env.BASE_URL}scc.html`}
                            className="nav-link"
                            onClick={handleHamburgerClick}
                        >
                            SCC Rulings
                        </a>
                    </motion.li>
                </motion.ul>
            </div>
        </motion.nav>
    );
};
