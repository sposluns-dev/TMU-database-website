import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
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
                                <Route path="/feedback" element={<Feedback />} />
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
