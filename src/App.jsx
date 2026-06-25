import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import Header from './components/Header'
import ClassificationPage from './components/ClassificationPage'
import SchedulePage from './components/SchedulePage'
import BrainstormV2 from './components/BrainstormV2'
import NotePopup from './components/NotePopup'
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
      onClick={() => { onOpen(toast.noteId); onDismiss() }}
      title="Click to open note"
    >
      <div className={styles.toastIcon}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div className={styles.toastBody}>
        <span className={styles.toastTitle}>Note created</span>
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
  const [notes, setNotes]             = useState([])
  const [refreshKey, setRefreshKey]   = useState(0)
  const [noteDataVersion, setNoteDataVersion] = useState(0)
  const [popupNoteId, setPopupNoteId] = useState(null)
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
    setNotes([])
    setToast(null)
    setPopupNoteId(null)
    setView(0)
    setRefreshKey(0)
    setNoteDataVersion(0)
    setAppScreen('home')
    setAuthState('authenticated')
  }

  const handleLogout = () => {
    authApi.logout()
    setCurrentUser(null)
    setActiveProject(null)
    setNotes([])
    setToast(null)
    setPopupNoteId(null)
    setView(0)
    setRefreshKey(0)
    setNoteDataVersion(0)
    setAppScreen('home')
    setAuthState('anonymous')
  }

  const openProject = (project) => {
    setProjectId(project.id)
    setActiveProject(project)
    setNotes([])
    setToast(null)
    setPopupNoteId(null)
    setView(0)
    setRefreshKey(0)
    setNoteDataVersion(0)
    setAppScreen('workspace')
  }

  const handleProjectUpdate = (updated) => setActiveProject(updated)

  const backToHome = () => {
    setActiveProject(null)
    setNotes([])
    setToast(null)
    setPopupNoteId(null)
    setNoteDataVersion(0)
    setAppScreen('home')
  }

  const assignNoteCategories = async (noteId, selections = {}) => {
    await Promise.all(Object.entries(selections)
      .filter(([, catId]) => Boolean(catId))
      .map(([dimId, catId]) => api.assign(noteId, dimId, catId)))
  }

  const handleQuickAdd = async (text, customTitle = null, categorySelections = {}) => {
    const words = text.trim().split(/\s+/).filter(Boolean)
    const title = customTitle || words.slice(0, 7).join(' ') || 'Untitled'
    const html = text.replace(/\n/g, '<br>')
    const newNote = { id: crypto.randomUUID(), html, title, collapsed: false }
    try {
      const savedNote = await api.createNote(newNote)
      await assignNoteCategories(newNote.id, categorySelections)
      setNotes(prev => {
        const next = [savedNote, ...prev.filter(g => g.id !== savedNote.id)]
        api.reorderNotes(next.map(g => g.id)).catch(console.error)
        return next
      })
      setNoteDataVersion(v => v + 1)
      setRefreshKey(k => k + 1)
      setToast({ noteId: newNote.id, title })
    } catch (e) {
      console.error('Quick add failed', e)
    }
  }

  const openNotePopup  = (noteId) => setPopupNoteId(noteId)
  const closeNotePopup = () => setPopupNoteId(null)

  const handleNoteUpdated = (noteId, patch) => {
    setNotes(prev => prev.map(g => g.id === noteId ? { ...g, ...patch } : g))
  }

  const handleNoteDeleted = (noteId) => {
    setNotes(prev => prev.filter(g => g.id !== noteId))
    setRefreshKey(k => k + 1)
  }

  const handleNoteCreated = (newNote) => {
    setNotes(prev => {
      const next = [newNote, ...prev.filter(g => g.id !== newNote.id)]
      api.reorderNotes(next.map(g => g.id)).catch(console.error)
      return next
    })
    setNoteDataVersion(v => v + 1)
    setRefreshKey(k => k + 1)
    setToast({ noteId: newNote.id, title: newNote.title })
  }

  useEffect(() => {
    if (!activeProject || appScreen !== 'workspace') return
    api.getNotes().then(setNotes).catch(console.error)
  }, [activeProject?.id, appScreen]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!refreshKey || !activeProject) return
    api.getNotes().then(data => { if (data.length > 0) setNotes(data) }).catch(console.error)
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const popupNote = notes.find(g => g.id === popupNoteId)

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
        notes={notes} onNoteOpen={openNotePopup}
      />

      <div className={styles.views}>
        <div className={styles.view} style={{ display: view === 0 ? 'flex' : 'none' }}>
          <ProjectDashboard project={activeProject} onUpdate={handleProjectUpdate} isActive={view === 0} />
        </div>
        <div className={styles.view} style={{ display: view === 1 ? 'flex' : 'none' }}>
          <BrainstormV2 notes={notes} onNoteCreated={handleNoteCreated} onNoteOpen={openNotePopup} onRefresh={() => setRefreshKey(k => k + 1)} />
        </div>
        <div className={styles.view} style={{ display: view === 2 ? 'flex' : 'none' }}>
          <ClassificationPage notes={notes} isActive={view === 2} onNoteOpen={openNotePopup} refreshKey={noteDataVersion} />
        </div>
        <div className={styles.view} style={{ display: view === 3 ? 'flex' : 'none' }}>
          <SchedulePage
            notes={notes}
            isActive={view === 3}
            onNoteOpen={openNotePopup}
            defaultMetric={activeProject?.metric ?? 'days'}
            refreshKey={noteDataVersion}
          />
        </div>
      </div>

      {popupNote && (
        <NotePopup
          note={popupNote}
          onClose={closeNotePopup}
          onNoteUpdated={handleNoteUpdated}
          onNoteDeleted={handleNoteDeleted}
        />
      )}

      {toast && (
        <Toast toast={toast} onOpen={openNotePopup} onDismiss={() => setToast(null)} />
      )}
    </div>
  )
}
