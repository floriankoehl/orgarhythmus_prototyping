import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import Header from './components/Header'
import ClassificationPage from './components/ClassificationPage'
import SchedulePage from './components/SchedulePage'
import BrainstormV2 from './components/BrainstormV2'
import GoalPopup from './components/GoalPopup'
import ProjectsPage from './components/ProjectsPage'
import ProjectDashboard from './components/ProjectDashboard'
import AuthPage from './components/AuthPage'
import { api, authApi, hasAuthSession, setProjectId } from './api'
import styles from './App.module.css'

// ── Success toast ─────────────────────────────────────────────────────────────
function Toast({ toast, onOpen, onDismiss }) {
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const fade = setTimeout(() => setLeaving(true), 2600)
    const gone = setTimeout(() => onDismiss(), 3000)
    return () => { clearTimeout(fade); clearTimeout(gone) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div
      className={`${styles.toast} ${leaving ? styles.toastLeaving : ''}`}
      onClick={() => { onOpen(toast.goalId); onDismiss() }}
      title="Click to open goal"
    >
      <div className={styles.toastIcon}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div className={styles.toastBody}>
        <span className={styles.toastTitle}>Goal created</span>
        <span className={styles.toastSub}>"{toast.title}" · click to open</span>
      </div>
      <div className={styles.toastProgress} />
    </div>,
    document.body
  )
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [authState, setAuthState]     = useState(hasAuthSession() ? 'loading' : 'anonymous')
  const [currentUser, setCurrentUser] = useState(null)
  const [view, setView]               = useState(0)
  const [activeProject, setActiveProject] = useState(null)
  const [appScreen, setAppScreen]     = useState('home') // 'home' | 'workspace'
  const [goals, setGoals]             = useState([])
  const [refreshKey, setRefreshKey]   = useState(0)
  const [goalDataVersion, setGoalDataVersion] = useState(0)
  const [popupGoalId, setPopupGoalId] = useState(null)
  const [toast, setToast]             = useState(null)

  useEffect(() => {
    let alive = true
    if (!hasAuthSession()) {
      setAuthState('anonymous')
      return () => { alive = false }
    }
    authApi.me()
      .then(user => {
        if (!alive) return
        setCurrentUser(user)
        setAuthState('authenticated')
      })
      .catch(() => {
        authApi.logout()
        if (!alive) return
        setCurrentUser(null)
        setAuthState('anonymous')
      })
    return () => { alive = false }
  }, [])

  const handleAuthenticated = (user) => {
    setCurrentUser(user)
    setActiveProject(null)
    setGoals([])
    setToast(null)
    setPopupGoalId(null)
    setView(0)
    setRefreshKey(0)
    setGoalDataVersion(0)
    setAppScreen('home')
    setAuthState('authenticated')
  }

  const handleLogout = () => {
    authApi.logout()
    setCurrentUser(null)
    setActiveProject(null)
    setGoals([])
    setToast(null)
    setPopupGoalId(null)
    setView(0)
    setRefreshKey(0)
    setGoalDataVersion(0)
    setAppScreen('home')
    setAuthState('anonymous')
  }

  const openProject = (project) => {
    setProjectId(project.id)
    setActiveProject(project)
    setGoals([])
    setToast(null)
    setPopupGoalId(null)
    setView(0)
    setRefreshKey(0)
    setGoalDataVersion(0)
    setAppScreen('workspace')
  }

  const handleProjectUpdate = (updated) => setActiveProject(updated)

  const backToHome = () => {
    setActiveProject(null)
    setGoals([])
    setToast(null)
    setPopupGoalId(null)
    setGoalDataVersion(0)
    setAppScreen('home')
  }

  const assignGoalCategories = async (goalId, selections = {}) => {
    await Promise.all(Object.entries(selections)
      .filter(([, catId]) => Boolean(catId))
      .map(([dimId, catId]) => api.assign(goalId, dimId, catId)))
  }

  const handleQuickAdd = async (text, customTitle = null, categorySelections = {}) => {
    const words = text.trim().split(/\s+/).filter(Boolean)
    const title = customTitle || words.slice(0, 7).join(' ') || 'Untitled'
    const html = text.replace(/\n/g, '<br>')
    const newGoal = { id: crypto.randomUUID(), html, title, collapsed: false }
    try {
      const savedGoal = await api.createPage(newGoal)
      await assignGoalCategories(newGoal.id, categorySelections)
      setGoals(prev => {
        const next = [savedGoal, ...prev.filter(g => g.id !== savedGoal.id)]
        api.reorderPages(next.map(g => g.id)).catch(console.error)
        return next
      })
      setGoalDataVersion(v => v + 1)
      setRefreshKey(k => k + 1)
      setToast({ goalId: newGoal.id, title })
    } catch (e) {
      console.error('Quick add failed', e)
    }
  }

  const openGoalPopup  = (goalId) => setPopupGoalId(goalId)
  const closeGoalPopup = () => setPopupGoalId(null)

  const handleGoalUpdated = (goalId, patch) => {
    setGoals(prev => prev.map(g => g.id === goalId ? { ...g, ...patch } : g))
  }

  const handleGoalDeleted = (goalId) => {
    setGoals(prev => prev.filter(g => g.id !== goalId))
    setRefreshKey(k => k + 1)
  }

  const handleGoalCreated = (newGoal) => {
    setGoals(prev => {
      const next = [newGoal, ...prev.filter(g => g.id !== newGoal.id)]
      api.reorderPages(next.map(g => g.id)).catch(console.error)
      return next
    })
    setGoalDataVersion(v => v + 1)
    setRefreshKey(k => k + 1)
    setToast({ goalId: newGoal.id, title: newGoal.title })
  }

  useEffect(() => {
    if (!activeProject || appScreen !== 'workspace') return
    api.getPages().then(setGoals).catch(console.error)
  }, [activeProject?.id, appScreen]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!refreshKey || !activeProject) return
    api.getPages().then(data => { if (data.length > 0) setGoals(data) }).catch(console.error)
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const popupGoal = goals.find(g => g.id === popupGoalId)

  if (authState === 'loading') {
    return (
      <div className={styles.app}>
        <div className={styles.loading}>Loading...</div>
      </div>
    )
  }

  if (authState !== 'authenticated') {
    return (
      <div className={styles.app}>
        <AuthPage onAuthenticated={handleAuthenticated} />
      </div>
    )
  }

  if (appScreen === 'home') {
    return (
      <div className={styles.app}>
        <ProjectsPage onOpenProject={openProject} currentUser={currentUser} onLogout={handleLogout} />
      </div>
    )
  }

  // appScreen === 'workspace'
  return (
    <div className={styles.app}>
      <Header
        view={view} onNavigate={setView} onQuickAdd={handleQuickAdd}
        projectName={activeProject.name} onBack={backToHome}
      />

      <div className={styles.views}>
        <div className={styles.view} style={{ display: view === 0 ? 'flex' : 'none' }}>
          <ProjectDashboard project={activeProject} onUpdate={handleProjectUpdate} isActive={view === 0} />
        </div>
        <div className={styles.view} style={{ display: view === 1 ? 'flex' : 'none' }}>
          <BrainstormV2 goals={goals} onGoalCreated={handleGoalCreated} />
        </div>
        <div className={styles.view} style={{ display: view === 2 ? 'flex' : 'none' }}>
          <ClassificationPage goals={goals} isActive={view === 2} onGoalOpen={openGoalPopup} refreshKey={goalDataVersion} />
        </div>
        <div className={styles.view} style={{ display: view === 3 ? 'flex' : 'none' }}>
          <SchedulePage
            goals={goals}
            isActive={view === 3}
            onGoalOpen={openGoalPopup}
            defaultMetric={activeProject?.metric ?? 'days'}
            refreshKey={goalDataVersion}
          />
        </div>
      </div>

      {popupGoal && (
        <GoalPopup
          goal={popupGoal}
          onClose={closeGoalPopup}
          onGoalUpdated={handleGoalUpdated}
          onGoalDeleted={handleGoalDeleted}
        />
      )}

      {toast && (
        <Toast toast={toast} onOpen={openGoalPopup} onDismiss={() => setToast(null)} />
      )}
    </div>
  )
}
