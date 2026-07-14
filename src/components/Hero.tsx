import { motion, Variants } from "framer-motion";

export const Hero = () => {
    // Animation variants
    const containerVariants: Variants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: {
                staggerChildren: 0.3,
                delayChildren: 0.2,
            },
        },
    };

    const itemVariants: Variants = {
        hidden: { opacity: 0, y: 20 },
        visible: {
            opacity: 1,
            y: 0,
            transition: {
                duration: 0.8,
                ease: [0.6, 0.05, -0.01, 0.9],
            },
        },
    };

    return (
        <header id="hero" className="hero">
            <motion.div
                className="container"
                variants={containerVariants}
                initial="visible"
                animate="visible"
            >
                <motion.h1 className="hero-title">Jewish Identity In Canadian Law: A Database</motion.h1>

                <motion.div variants={itemVariants}>
                    <p className="hero-subtitle">
                        A searchable, downloadable database of Canadian caselaw on Jewish
                        identity, Judaism as a lived experience, multiculturalism, and
                        antisemitism.
                    </p>
                </motion.div>

                <motion.div variants={itemVariants} className="dataset-highlights">
                    <h2 className="dataset-highlights-title">Dataset Highlights</h2>
                    <div className="dataset-highlights-grid">
                        <div className="highlight-stat">
                            <span className="highlight-number">1,599</span>
                            <span className="highlight-label">Total cases</span>
                        </div>
                        <div className="highlight-stat">
                            <span className="highlight-number">58</span>
                            <span className="highlight-label">
                                Courts across 10 jurisdictions
                            </span>
                        </div>
                        <div className="highlight-stat">
                            <span className="highlight-number">1879–2026</span>
                            <span className="highlight-label">Period covered</span>
                        </div>
                    </div>
                </motion.div>

                <motion.div variants={itemVariants} className="about-project">
                    <h3 className="about-project-title">About the Project</h3>
                    <p className="about-project-text">
                        This project brings together and analyzes Canadian case law
                        that engages Jewish identity, Jewish experience, and Jewish
                        community life. It examines both harms, such as antisemitism,
                        bias, defamation, exclusion, and wrongful dismissal, and
                        positive legal recognition through accommodation,
                        multiculturalism, and the values associated with Jewish
                        identity. This database was developed with support from case
                        law materials derived from Access to Algorithmic Justice (
                        <a
                            href="https://a2aj.ca/"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            A2AJ
                        </a>
                        ), which served as an important starting point for identifying
                        and organizing relevant Canadian decisions. It also uses case
                        law from CanLII for lower court decisions. The database builds
                        on the foundation of these two sources to bring together cases
                        that show how Canadian law has engaged with Jewish identity,
                        antisemitism, accommodation, and related themes.
                    </p>
                </motion.div>
            </motion.div>
        </header>
    );
};
