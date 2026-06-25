import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import Header from './components/Header'
import ClassificationPage from './components/ClassificationPage'
import SchedulePage from './components/SchedulePage'
import BrainstormV2 from './components/BrainstormV2'
import GoalPopup from './components/GoalPopup'
import ProjectsPage from './components/ProjectsPage'
import ProjectDashboard from './components/ProjectDashboard'
import { api, setProjectId } from './api'
import styles from './App.module.css'

const PAGE_COUNT = 4

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
  const [view, setView] = useState(0)
  const [navDragOffset, setNavDragOffset] = useState(0)
  const [navDragging, setNavDragging] = useState(false)
  const [activeProject, setActiveProject] = useState(null)
  const [appScreen, setAppScreen] = useState('home') // 'home' | 'workspace'
  const [goals, setGoals] = useState([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [popupGoalId, setPopupGoalId] = useState(null)
  const [toast, setToast] = useState(null) // { goalId, title }

  const openProject = (project) => {
    setProjectId(project.id)
    setActiveProject(project)
    setGoals([])
    setToast(null)
    setPopupGoalId(null)
    setView(0)
    setRefreshKey(0)
    setAppScreen('workspace')
  }

  const handleProjectUpdate = (updated) => {
    setActiveProject(updated)
  }

  const backToHome = () => {
    setActiveProject(null)
    setGoals([])
    setToast(null)
    setPopupGoalId(null)
    setAppScreen('home')
  }
  const navGestureRef = useRef({ active: false, startX: 0, startView: 0, offset: 0, suppressContextUntil: 0 })
  const viewRef = useRef(view)
  viewRef.current = view

  const assignGoalCategories = async (goalId, selections = {}) => {
    await Promise.all(Object.entries(selections)
      .filter(([, catId]) => Boolean(catId))
      .map(([dimId, catId]) => api.assign(goalId, dimId, catId)))
  }

  const handleQuickAdd = async (text, customTitle = null, categorySelections = {}) => {
    // Title: use explicit override if given, otherwise auto-derive from first 7 words
    const words = text.trim().split(/\s+/).filter(Boolean)
    const title = customTitle || words.slice(0, 7).join(' ') || 'Untitled'
    const html = text.replace(/\n/g, '<br>')
    const newGoal = { id: crypto.randomUUID(), html, title, collapsed: false }
    try {
      await api.createPage(newGoal)
      await assignGoalCategories(newGoal.id, categorySelections)
      // Put it at the front by reordering on the backend
      const orderedIds = [newGoal.id, ...goals.map(g => g.id)]
      api.reorderPages(orderedIds).catch(console.error)
      // Optimistically prepend so popup can open it immediately
      setGoals(prev => [newGoal, ...prev])
      // Also trigger DocumentCanvas re-fetch so brainstorming list updates
      setRefreshKey(k => k + 1)
      // Show success toast
      setToast({ goalId: newGoal.id, title })
    } catch (e) {
      console.error('Quick add failed', e)
    }
  }

  const openGoalPopup = (goalId) => setPopupGoalId(goalId)
  const closeGoalPopup = () => setPopupGoalId(null)

  const handleGoalUpdated = (goalId, patch) => {
    setGoals(prev => prev.map(g => g.id === goalId ? { ...g, ...patch } : g))
  }

  const handleGoalDeleted = (goalId) => {
    setGoals(prev => prev.filter(g => g.id !== goalId))
    setRefreshKey(k => k + 1)
  }

  // Load goals when entering the workspace for this project
  useEffect(() => {
    if (!activeProject || appScreen !== 'workspace') return
    api.getPages().then(setGoals).catch(console.error)
  }, [activeProject?.id, appScreen]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!refreshKey || !activeProject) return
    api.getPages().then(data => { if (data.length > 0) setGoals(data) }).catch(console.error)
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const swallowGestureEvent = e => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation?.()
    }

    const beginGesture = e => {
      const alreadyActive = navGestureRef.current.active
      navGestureRef.current = {
        active: true,
        startX: alreadyActive ? navGestureRef.current.startX : e.clientX,
        startView: alreadyActive ? navGestureRef.current.startView : viewRef.current,
        offset: alreadyActive ? navGestureRef.current.offset : 0,
        suppressContextUntil: Date.now() + 600,
      }
      if (!alreadyActive) {
        setNavDragging(true)
        setNavDragOffset(0)
      }
      document.body.style.userSelect = 'none'
    }

    const updateGesture = e => {
      const gesture = navGestureRef.current
      let dx = e.clientX - gesture.startX
      if (gesture.startView === 0) dx = Math.min(0, dx)
      if (gesture.startView === PAGE_COUNT - 1) dx = Math.max(0, dx)
      gesture.offset = dx
      gesture.suppressContextUntil = Date.now() + 600
      setNavDragOffset(dx)
    }

    const finishGesture = () => {
      const gesture = navGestureRef.current
      if (!gesture.active) return
      const threshold = window.innerWidth / 2
      let nextView = gesture.startView
      if (gesture.offset <= -threshold) nextView = Math.min(PAGE_COUNT - 1, gesture.startView + 1)
      if (gesture.offset >= threshold) nextView = Math.max(0, gesture.startView - 1)
      navGestureRef.current = { ...gesture, active: false, offset: 0, suppressContextUntil: Date.now() + 600 }
      setView(nextView)
      setNavDragging(false)
      setNavDragOffset(0)
      document.body.style.userSelect = ''
    }

    const isPageGesture = e => (e.buttons & 3) === 3

    const onMouseDown = e => {
      if (!isPageGesture(e)) return
      beginGesture(e)
      swallowGestureEvent(e)
    }

    const onMouseMove = e => {
      if (isPageGesture(e)) {
        if (!navGestureRef.current.active) beginGesture(e)
        updateGesture(e)
        swallowGestureEvent(e)
      } else if (navGestureRef.current.active) {
        swallowGestureEvent(e)
        finishGesture()
      }
    }

    const onMouseUp = e => {
      if (navGestureRef.current.active) swallowGestureEvent(e)
      finishGesture()
    }
    const onContextMenu = e => {
      if (navGestureRef.current.active || Date.now() < navGestureRef.current.suppressContextUntil) {
        swallowGestureEvent(e)
      }
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('mousemove', onMouseMove, true)
    document.addEventListener('mouseup', onMouseUp, true)
    document.addEventListener('contextmenu', onContextMenu, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('mousemove', onMouseMove, true)
      document.removeEventListener('mouseup', onMouseUp, true)
      document.removeEventListener('contextmenu', onContextMenu, true)
      document.body.style.userSelect = ''
    }
  }, [])

  const handleGoalCreated = (newGoal) => {
    const orderedIds = [newGoal.id, ...goals.map(g => g.id)]
    api.reorderPages(orderedIds).catch(console.error)
    setGoals(prev => [newGoal, ...prev])
    setRefreshKey(k => k + 1)
    setToast({ goalId: newGoal.id, title: newGoal.title })
  }

  const popupGoal = goals.find(g => g.id === popupGoalId)

  if (appScreen === 'home') {
    return (
      <div className={styles.app}>
        <ProjectsPage onOpenProject={openProject} />
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
      <div
        className={`${styles.slider} ${navDragging ? styles.sliderDragging : ''}`}
        style={{ transform: `translateX(calc(${-view * 100}vw + ${navDragOffset}px))` }}>

        {/* View 0 — Project Dashboard */}
        <div className={styles.view}>
          <ProjectDashboard
            project={activeProject}
            onUpdate={handleProjectUpdate}
            isActive={view === 0}
          />
        </div>

        {/* View 1 — Goals */}
        <div className={styles.view}>
          <BrainstormV2 goals={goals} onGoalCreated={handleGoalCreated} />
        </div>

        {/* View 2 — Classification */}
        <div className={styles.view}>
          <ClassificationPage goals={goals} isActive={view === 2} onGoalOpen={openGoalPopup} />
        </div>

        {/* View 3 — Schedule */}
        <div className={styles.view}>
          <SchedulePage
            goals={goals}
            isActive={view === 3}
            onGoalOpen={openGoalPopup}
            defaultMetric={activeProject?.metric ?? 'days'}
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
        <Toast
          toast={toast}
          onOpen={openGoalPopup}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  )
}
