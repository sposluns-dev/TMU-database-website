import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { Navbar } from "./components/Navbar.tsx";
import { Footer } from "./components/Footer.tsx";
import { Background } from "./components/Background.tsx";
import { Hero } from "./components/Hero.tsx";
import { Partners } from "./components/Partners.tsx";
import { Search } from "./components/Search.tsx";
import { Dataset } from "./components/Dataset.tsx";
import { About } from "./components/About.tsx";
import { FAQ } from "./components/FAQ.tsx";
import { Feedback } from "./components/Feedback.tsx";
import { FEEDBACK_ENABLED } from "./lib/features.ts";

function HomePage() {
    return (
        <>
            <Hero />
            <Partners />
        </>
    );
}

function App() {
    return (
        <Router basename={import.meta.env.BASE_URL}>
            <div className="page-wrapper">
                <Background>
                    <Navbar />
                    <main className="main-content">
                        <div style={{ paddingTop: "80px" }}>
                            <Routes>
                                <Route path="/" element={<HomePage />} />
                                <Route path="/dataset" element={<Dataset />} />
                                <Route path="/search" element={<Search />} />
                                <Route path="/about" element={<About />} />
                                <Route path="/faq" element={<FAQ />} />
                                {/* Off in production (see lib/features.ts). The route
                                    still exists but redirects, so an old link or a
                                    bookmark lands on the home page rather than a blank
                                    one. */}
                                <Route
                                    path="/feedback"
                                    element={
                                        FEEDBACK_ENABLED ? <Feedback /> : <Navigate to="/" replace />
                                    }
                                />
                            </Routes>
                        </div>
                    </main>
                    <Footer />
                </Background>
            </div>
        </Router>
    );
}

export default App;
