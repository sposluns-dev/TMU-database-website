import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { Navbar } from "./components/Navbar.tsx";
import { Footer } from "./components/Footer.tsx";
import { Background } from "./components/Background.tsx";
import { Hero } from "./components/Hero.tsx";

function HomePage() {
    return (
        <>
            <Hero />
        </>
    );
}

function App() {
    return (
        <Router>
            <div className="page-wrapper">
                <Background>
                    <Navbar />
                    <main className="main-content">
                        <div style={{ paddingTop: "80px" }}>
                            <Routes>
                                <Route path="/" element={<HomePage />} />
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
