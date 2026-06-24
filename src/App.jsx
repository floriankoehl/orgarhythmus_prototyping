import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import Header from './components/Header'
import Toolbar from './components/Toolbar'
import DocumentCanvas from './components/DocumentCanvas'
import ClassificationPage from './components/ClassificationPage'
import SchedulePage from './components/SchedulePage'
import BrainstormV2 from './components/BrainstormV2'
import GoalPopup from './components/GoalPopup'
import { api } from './api'
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
  const [view, setView] = useState(0)
  const [goals, setGoals] = useState([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [popupGoalId, setPopupGoalId] = useState(null)
  const [toast, setToast] = useState(null) // { goalId, title }

  const handleQuickAdd = async (text, customTitle = null) => {
    // Title: use explicit override if given, otherwise auto-derive from first 7 words
    const words = text.trim().split(/\s+/).filter(Boolean)
    const title = customTitle || words.slice(0, 7).join(' ') || 'Untitled'
    const html = text.replace(/\n/g, '<br>')
    const newGoal = { id: crypto.randomUUID(), html, title, collapsed: false }
    try {
      await api.createPage(newGoal)
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

  const handleGoalCreated = (newGoal) => {
    const orderedIds = [newGoal.id, ...goals.map(g => g.id)]
    api.reorderPages(orderedIds).catch(console.error)
    setGoals(prev => [newGoal, ...prev])
    setRefreshKey(k => k + 1)
    setToast({ goalId: newGoal.id, title: newGoal.title })
  }

  const popupGoal = goals.find(g => g.id === popupGoalId)

  return (
    <div className={styles.app}>
      <Header view={view} onNavigate={setView} onQuickAdd={handleQuickAdd} />
      <div className={styles.slider} style={{ transform: `translateX(${-view * 100}vw)` }}>

        {/* View 0 — Brainstorming */}
        <div className={styles.view}>
          <Toolbar />
          <DocumentCanvas onGoalsChange={setGoals} refreshKey={refreshKey} />
        </div>

        {/* View 1 — Classification */}
        <div className={styles.view}>
          <ClassificationPage goals={goals} onGoalOpen={openGoalPopup} />
        </div>

        {/* View 2 — Schedule */}
        <div className={styles.view}>
          <SchedulePage goals={goals} isActive={view === 2} onGoalOpen={openGoalPopup} />
        </div>

        {/* View 3 — Flow (BrainstormV2) */}
        <div className={styles.view}>
          <BrainstormV2 goals={goals} onGoalCreated={handleGoalCreated} />
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
