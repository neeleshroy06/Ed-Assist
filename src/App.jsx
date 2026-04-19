import { useEffect, useState } from 'react'
import { ThemeProvider } from './context/ThemeContext'
import NavBar from './components/shared/NavBar'
import LandingPage from './pages/LandingPage'
import ProfessorPage from './pages/ProfessorPage'
import StudentPage from './pages/StudentPage'

function AppShell() {
  const [view, setView] = useState('landing')
  const [activeTab, setActiveTab] = useState('professor')

  useEffect(() => {
    document.body.style.overflow = view === 'landing' ? 'auto' : 'hidden'
    return () => {
      document.body.style.overflow = 'hidden'
    }
  }, [view])

  return (
    <div
      style={{
        height: view === 'landing' ? 'auto' : '100%',
        minHeight: view === 'landing' ? '100%' : undefined,
        display: 'flex',
        flexDirection: 'column',
        overflow: view === 'landing' ? 'visible' : 'hidden',
      }}
    >
      {view === 'landing' ? (
        <LandingPage
          onGetStarted={() => {
            setActiveTab('professor')
            setView('app')
          }}
          onViewDemo={() => {
            setActiveTab('student')
            setView('app')
          }}
        />
      ) : (
        <>
          <NavBar activeTab={activeTab} onTabChange={setActiveTab} />
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
            <div
              aria-hidden={activeTab !== 'professor'}
              style={{
                height: '100%',
                display: activeTab === 'professor' ? 'block' : 'none',
              }}
            >
              <ProfessorPage />
            </div>
            <div
              aria-hidden={activeTab !== 'student'}
              style={{
                height: '100%',
                display: activeTab === 'student' ? 'block' : 'none',
              }}
            >
              <StudentPage />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  )
}
