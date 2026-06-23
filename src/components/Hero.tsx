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
                <motion.h1 className="hero-title">Header</motion.h1>

                <motion.div variants={itemVariants}>
                    <p>text</p>
                </motion.div>
            </motion.div>
        </header>
    );
};
