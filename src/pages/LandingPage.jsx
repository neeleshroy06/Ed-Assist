import ThemeToggle from '../components/shared/ThemeToggle'

const FEATURES = [
  {
    title: 'Live lecture capture',
    body: 'Record audio, stream captions, and transcribe with one stop when class ends.',
  },
  {
    title: 'Slide-aware PDF',
    body: 'Upload your deck during the session, annotate with pen and highlighter, then publish.',
  },
  {
    title: 'Student workspace',
    body: 'Learners see the same pages, ask by voice or sign, and get answers tied to the document.',
  },
  {
    title: 'Built for access',
    body: 'Clear typography, contrast, and controls that work well with assistive setups.',
  },
]

export default function LandingPage({ onGetStarted, onViewDemo }) {
  const scrollToFeatures = () => {
    document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div className="landing-root">
      <header className="landing-nav">
        <div className="landing-nav__brand landing-nav__cell landing-nav__cell--left">
          <span className="landing-brand-text">Lecture Studio</span>
        </div>
        <nav className="landing-nav__cell landing-nav__cell--center" aria-label="Primary">
          <button type="button" onClick={scrollToFeatures} className="landing-nav-link">
            Features
          </button>
        </nav>
        <div className="landing-nav__cell landing-nav__cell--right">
          <ThemeToggle />
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-hero" aria-label="Hero">
          <div className="landing-hero__inner">
            <p className="landing-hero__eyebrow">Live · Accessible · Grounded</p>
            <h1 className="landing-hero__title">
              Teach once. Every student follows in real time—with voice, captions, and your slides.
            </h1>
            <p className="landing-hero__lede">
              Start a session as the professor, share your PDF, and publish. Students open the same deck and ask questions grounded in what you said and marked on the page.
            </p>
            <div className="landing-hero__actions">
              <button type="button" className="btn-primary landing-hero__btn-primary" onClick={onGetStarted}>
                Get Started
              </button>
              <button type="button" className="btn-secondary landing-hero__btn-secondary" onClick={onViewDemo}>
                View demo
              </button>
            </div>
          </div>
        </section>

        <section id="features" className="landing-features" aria-labelledby="features-heading">
          <h2 id="features-heading" className="landing-features__heading">
            Features
          </h2>
          <p className="landing-features__sub">Everything in one flow</p>
          <ul className="landing-feature-grid">
            {FEATURES.map((item) => (
              <li key={item.title} className="glass-card landing-feature-card">
                <div className="landing-feature-card__title">{item.title}</div>
                <p className="landing-feature-card__body">{item.body}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="landing-footer">© {new Date().getFullYear()} Lecture Studio</footer>
    </div>
  )
}
