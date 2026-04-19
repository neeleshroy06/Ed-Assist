import ThemeToggle from './ThemeToggle'

export default function NavBar({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'professor', label: 'Professor' },
    { id: 'student', label: 'Student' },
  ]

  return (
    <nav
      className="glass-card app-nav"
      style={{
        height: 60,
        margin: 12,
        marginBottom: 0,
        padding: '0 16px',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
        alignItems: 'center',
        gap: 12,
        borderRadius: 18,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div
          aria-hidden="true"
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: 'linear-gradient(135deg, var(--primary), var(--accent))',
            display: 'grid',
            placeItems: 'center',
            fontSize: 15,
            fontWeight: 800,
            color: 'var(--nav-mark-text)',
            boxShadow: '0 0 22px var(--primary-glow)',
            flexShrink: 0,
          }}
        >
          LS
        </div>
        <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.03em', whiteSpace: 'nowrap' }}>Lecture Studio</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-label={`Open ${tab.id} tab`}
            className={`app-nav-tab ${activeTab === tab.id ? 'app-nav-tab--active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, minWidth: 0 }}>
        <ThemeToggle />
        <div className="app-nav-badge">ADA Compliant</div>
      </div>
    </nav>
  )
}
