// Partner / affiliation logos shown near the bottom of the home page.
import "../styles/components/partners.css";

const base = import.meta.env.BASE_URL;

export const Partners = () => {
    return (
        <section className="partners">
            <div className="partners-logos">
                <img
                    src={`${base}assets/tmu-law-logo.png`}
                    alt="Lincoln Alexander School of Law, Toronto Metropolitan University"
                />
                <img
                    src={`${base}assets/neca-secondary-logo-transparent-large.png`}
                    alt="NECA"
                />
            </div>
        </section>
    );
};
