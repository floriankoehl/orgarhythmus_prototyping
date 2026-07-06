import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import Header from './components/Header'
import ClassificationPage from './components/ClassificationPage'
import SchedulePage from './components/SchedulePage'
import NotesPage from './components/NotesPage'
import NotePopup from './components/NotePopup'
import ProjectsPage from './components/ProjectsPage'
import ProjectDashboard from './components/ProjectDashboard'
import AuthPage from './components/AuthPage'
import PeoplePage from './components/PeoplePage'
import InheritancePage from './components/InheritancePage'
import CalendarPage from './components/CalendarPage'
import { api, authApi, hasAuthSession, setProjectId } from './api'
import { mergeSelectionsWithHashtags } from './categoryHashtags'
import styles from './App.module.css'

const NONE_PERSPECTIVE_ID = '__none__'
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
  const [workspaceRootNoteId, setWorkspaceRootNoteId] = useState(null)
  const [appScreen, setAppScreen]     = useState('home') // 'home' | 'workspace'
  const [notes, setNotes]             = useState([])
  const [refreshKey, setRefreshKey]   = useState(0)
  const [noteDataVersion, setNoteDataVersion] = useState(0)
  const [dimVersion, setDimVersion]   = useState(0)
  const [peopleVersion, setPeopleVersion] = useState(0)
  const [calendarResolveRequest, setCalendarResolveRequest] = useState(null)
  const [calendarRestoreRequest, setCalendarRestoreRequest] = useState(null)
  const [contextDefaults, setContextDefaults] = useState({})
  const [activeContextId, setActiveContextId] = useState('')
  const [activeContextState, setActiveContextState] = useState({})
  const [popupNoteId, setPopupNoteId] = useState(null)
  const [popupEditTitle, setPopupEditTitle] = useState(false)
  const [toast, setToast]             = useState(null)

  const activeWorkspaceRootId = workspaceRootNoteId || activeProject?.rootNoteId || null
  const activeWorkspaceRoot = useMemo(
    () => notes.find(note => note.id === activeWorkspaceRootId) || null,
    [notes, activeWorkspaceRootId],
  )
  const visibleNotes = useMemo(() => {
    if (!activeWorkspaceRootId) return notes
    const childrenByParent = new Map()
    notes.forEach(note => {
      const parentId = note.parentNoteId || ''
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, [])
      childrenByParent.get(parentId).push(note)
    })
    const visibleIds = new Set()
    const stack = [...(childrenByParent.get(activeWorkspaceRootId) || [])]
    while (stack.length) {
      const note = stack.shift()
      if (!note || visibleIds.has(note.id)) continue
      visibleIds.add(note.id)
      stack.push(...(childrenByParent.get(note.id) || []))
    }
    return notes.filter(note => visibleIds.has(note.id))
  }, [notes, activeWorkspaceRootId])
  const workspacePath = useMemo(() => {
    if (!activeWorkspaceRootId) return []
    const notesById = new Map(notes.map(note => [note.id, note]))
    const path = []
    const seen = new Set()
    let current = notesById.get(activeWorkspaceRootId)
    while (current && !seen.has(current.id)) {
      path.unshift(current)
      seen.add(current.id)
      current = current.parentNoteId ? notesById.get(current.parentNoteId) : null
    }
    return path
  }, [activeWorkspaceRootId, notes])

  const openScheduleResolverFromCalendar = request => {
    setCalendarResolveRequest({ ...request, id: request?.id || crypto.randomUUID() })
    setView(3)
  }

  const returnToCalendarFromResolver = () => {
    if (calendarResolveRequest?.calendarState) {
      setCalendarRestoreRequest({
        id: crypto.randomUUID(),
        state: calendarResolveRequest.calendarState,
      })
    }
    setCalendarResolveRequest(null)
    setView(6)
  }

  const applyProjectContext = contextOrState => {
    const state = contextOrState?.state || contextOrState || {}
    if (contextOrState?.id) setActiveContextId(contextOrState.id)
    setActiveContextState(state)
    const defaults = {
      classification: state?.classificationPerspectiveId || NONE_PERSPECTIVE_ID,
      schedule: state?.schedulePerspectiveId || NONE_PERSPECTIVE_ID,
      calendar: state?.calendarPerspectiveId || NONE_PERSPECTIVE_ID,
    }
    setContextDefaults({ ...defaults, token: crypto.randomUUID() })
  }

  const setContextDefaultPerspective = async (page, perspectiveId) => {
    if (!activeContextId) throw new Error('No active context')
    const stateKey = `${page}PerspectiveId`
    const nextState = { ...activeContextState, [stateKey]: perspectiveId || NONE_PERSPECTIVE_ID }
    const saved = await api.updateProjectContext(activeContextId, { state: nextState })
    setActiveContextState(saved.state || nextState)
    setContextDefaults(previous => ({ ...previous, [page]: nextState[stateKey] }))
    return saved
  }

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
    setWorkspaceRootNoteId(null)
    setNotes([])
    setToast(null)
    setPopupNoteId(null)
    setView(0)
    setRefreshKey(0)
    setNoteDataVersion(0)
    setCalendarResolveRequest(null)
    setCalendarRestoreRequest(null)
    setContextDefaults({})
    setActiveContextId('')
    setActiveContextState({})
    setAppScreen('home')
    setAuthState('authenticated')
  }

  const handleLogout = () => {
    authApi.logout()
    setCurrentUser(null)
    setActiveProject(null)
    setWorkspaceRootNoteId(null)
    setNotes([])
    setToast(null)
    setPopupNoteId(null)
    setView(0)
    setRefreshKey(0)
    setNoteDataVersion(0)
    setCalendarResolveRequest(null)
    setCalendarRestoreRequest(null)
    setContextDefaults({})
    setActiveContextId('')
    setActiveContextState({})
    setAppScreen('home')
    setAuthState('anonymous')
  }

  const openProject = (project) => {
    setProjectId(project.id)
    setActiveProject(project)
    setWorkspaceRootNoteId(project.rootNoteId || null)
    setNotes([])
    setToast(null)
    setPopupNoteId(null)
    setView(0)
    setRefreshKey(0)
    setNoteDataVersion(0)
    setCalendarResolveRequest(null)
    setCalendarRestoreRequest(null)
    setContextDefaults({})
    setActiveContextId('')
    setActiveContextState({})
    setAppScreen('workspace')
  }

  const handleProjectUpdate = (updated) => setActiveProject(updated)

  const backToHome = () => {
    setActiveProject(null)
    setWorkspaceRootNoteId(null)
    setNotes([])
    setToast(null)
    setPopupNoteId(null)
    setNoteDataVersion(0)
    setCalendarResolveRequest(null)
    setCalendarRestoreRequest(null)
    setContextDefaults({})
    setActiveContextId('')
    setActiveContextState({})
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
    const newNote = { id: crypto.randomUUID(), html, title, collapsed: false, parentNoteId: activeWorkspaceRootId }
    try {
      const cats = text.includes('#') ? await api.getAllCategories().catch(() => []) : []
      const selections = mergeSelectionsWithHashtags(categorySelections, text, cats)
      const savedNote = await api.createNote(newNote)
      await assignNoteCategories(newNote.id, selections)
      setNotes(prev => [savedNote, ...prev.filter(g => g.id !== savedNote.id)])
      setNoteDataVersion(v => v + 1)
      setRefreshKey(k => k + 1)
      setToast({ noteId: newNote.id, title })
    } catch (e) {
      console.error('Quick add failed', e)
    }
  }

  const openNotePopup  = (noteId, options = {}) => {
    setPopupEditTitle(Boolean(options?.editTitle))
    setPopupNoteId(noteId)
  }
  const closeNotePopup = () => {
    setPopupNoteId(null)
    setPopupEditTitle(false)
  }

  const openNoteAsWorkspace = (noteId, options = {}) => {
    setWorkspaceRootNoteId(noteId)
    setPopupNoteId(null)
    setToast(null)
    setView(options?.view ?? 0)
  }

  const handleNoteUpdated = (noteId, patch) => {
    setNotes(prev => prev.map(g => g.id === noteId ? { ...g, ...patch } : g))
  }

  const handleNoteAssignmentsChanged = () => {
    setNoteDataVersion(v => v + 1)
  }

  const handleNoteDeleted = (noteId) => {
    setNotes(prev => prev.filter(g => g.id !== noteId))
    setRefreshKey(k => k + 1)
  }

  const handleNoteCreated = (newNote) => {
    setNotes(prev => [newNote, ...prev.filter(g => g.id !== newNote.id)])
    setNoteDataVersion(v => v + 1)
    setRefreshKey(k => k + 1)
    setToast({ noteId: newNote.id, title: newNote.title })
  }

  const handleNotesChanged = async () => {
    const data = await api.getNotes({ includeRoot: true })
    setNotes(data)
    setNoteDataVersion(v => v + 1)
    setRefreshKey(k => k + 1)
  }

  useEffect(() => {
    if (!activeProject || appScreen !== 'workspace') return
    api.getNotes({ includeRoot: true }).then(setNotes).catch(console.error)
  }, [activeProject?.id, appScreen]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!refreshKey || !activeProject) return
    api.getNotes({ includeRoot: true }).then(data => { if (data.length > 0) setNotes(data) }).catch(console.error)
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
        projectName={activeWorkspaceRoot?.title || activeProject.name} onBack={backToHome}
        notes={visibleNotes} onNoteOpen={openNotePopup}
        activeContextId={activeContextId}
        activeContextState={activeContextState}
        onApplyContext={applyProjectContext}
      />

      {workspacePath.length > 0 && (
        <nav className={styles.workspaceTrail} aria-label="Current project path">
          <span className={styles.workspacePathLabel}>Path</span>
          <div className={styles.workspaceBreadcrumbs}>
            {workspacePath.map((note, index) => {
              const isCurrent = index === workspacePath.length - 1
              const title = note.id === activeProject.rootNoteId
                ? activeProject.name
                : note.title || 'Untitled'
              return (
                <span key={note.id} className={styles.workspaceBreadcrumbSegment}>
                  {index > 0 && <span className={styles.workspaceBreadcrumbSeparator} aria-hidden="true">›</span>}
                  <button
                    type="button"
                    className={`${styles.workspaceBreadcrumb} ${isCurrent ? styles.workspaceBreadcrumbCurrent : ''}`}
                    aria-current={isCurrent ? 'page' : undefined}
                    disabled={isCurrent}
                    onClick={() => openNoteAsWorkspace(note.id, { view })}>
                    {title}
                  </button>
                </span>
              )
            })}
          </div>
        </nav>
      )}

      <div className={styles.views}>
        <div className={styles.view} style={{ display: view === 0 ? 'flex' : 'none' }}>
          <ProjectDashboard
            project={activeProject}
            notes={notes}
            workspaceRootNote={activeWorkspaceRoot}
            workspaceNote={activeWorkspaceRootId !== activeProject.rootNoteId ? activeWorkspaceRoot : null}
            onUpdate={handleProjectUpdate}
            onWorkspaceNoteUpdated={handleNoteUpdated}
            onWorkspaceOpen={openNoteAsWorkspace}
            onNoteOpen={openNotePopup}
            onNotesChanged={handleNotesChanged}
            onProjectDeleted={backToHome}
            isActive={view === 0}
          />
        </div>
        <div className={styles.view} style={{ display: view === 1 ? 'flex' : 'none' }}>
          <NotesPage
            notes={visibleNotes}
            onNoteCreated={handleNoteCreated}
            onNoteOpen={openNotePopup}
            onNoteUpdated={handleNoteUpdated}
            onRefresh={() => setRefreshKey(k => k + 1)}
            refreshKey={noteDataVersion}
            dimRefreshKey={dimVersion}
            peopleRefreshKey={peopleVersion}
            onDimChanged={() => setDimVersion(v => v + 1)}
            workspaceRootNoteId={activeWorkspaceRootId}
          />
        </div>
        <div className={styles.view} style={{ display: view === 2 ? 'flex' : 'none' }}>
          <ClassificationPage
            notes={visibleNotes}
            workspaceRootNoteId={activeWorkspaceRootId}
            isActive={view === 2}
            onNoteOpen={openNotePopup}
            refreshKey={noteDataVersion}
            dimRefreshKey={dimVersion}
            peopleRefreshKey={peopleVersion}
            onDimChanged={() => setDimVersion(v => v + 1)}
            onPeopleChanged={() => setPeopleVersion(v => v + 1)}
            contextDefaultPerspectiveId={contextDefaults.classification}
            contextApplyToken={contextDefaults.token}
            activeContextId={activeContextId}
            archivedDimensionIds={activeContextState.archivedDimensionIds || []}
            onSetContextDefaultPerspective={setContextDefaultPerspective}
          />
        </div>
        <div className={styles.view} style={{ display: view === 3 ? 'flex' : 'none' }}>
          <SchedulePage
            notes={visibleNotes}
            allNotes={notes}
            project={activeProject}
            isActive={view === 3}
            onNoteOpen={openNotePopup}
            onProjectUpdate={handleProjectUpdate}
            onNoteCreated={handleNoteCreated}
            onNotesChanged={handleNotesChanged}
            refreshKey={noteDataVersion}
            dimRefreshKey={dimVersion}
            peopleRefreshKey={peopleVersion}
            onDimChanged={() => setDimVersion(v => v + 1)}
            onPeopleChanged={() => setPeopleVersion(v => v + 1)}
            externalResolveRequest={calendarResolveRequest}
            onExternalResolveReturn={returnToCalendarFromResolver}
            contextDefaultPerspectiveId={contextDefaults.schedule}
            contextApplyToken={contextDefaults.token}
            activeContextId={activeContextId}
            archivedDimensionIds={activeContextState.archivedDimensionIds || []}
            onSetContextDefaultPerspective={setContextDefaultPerspective}
            workspaceRootNoteId={activeWorkspaceRootId}
            workspaceRootNote={activeWorkspaceRoot}
            onWorkspaceOpen={noteId => openNoteAsWorkspace(noteId, { view: 3 })}
          />
        </div>
        <div className={styles.view} style={{ display: view === 4 ? 'flex' : 'none' }}>
          <InheritancePage notes={visibleNotes} isActive={view === 4} onNoteOpen={openNotePopup} />
        </div>
        <div className={styles.view} style={{ display: view === 5 ? 'flex' : 'none' }}>
          <PeoplePage
            peopleRefreshKey={peopleVersion}
            onNoteOpen={openNotePopup}
            onPeopleChanged={() => setPeopleVersion(v => v + 1)}
          />
        </div>
        <div className={styles.view} style={{ display: view === 6 ? 'flex' : 'none' }}>
          <CalendarPage
            notes={visibleNotes}
            project={activeProject}
            isActive={view === 6}
            onNoteOpen={openNotePopup}
            onNoteCreated={handleNoteCreated}
            onNoteUpdated={handleNoteUpdated}
            refreshKey={refreshKey}
            peopleRefreshKey={peopleVersion}
            onPeopleChanged={() => setPeopleVersion(v => v + 1)}
            restoreRequest={calendarRestoreRequest}
            onRestoreConsumed={() => setCalendarRestoreRequest(null)}
            onRequestScheduleResolve={openScheduleResolverFromCalendar}
            contextDefaultPerspectiveId={contextDefaults.calendar}
            contextApplyToken={contextDefaults.token}
            activeContextId={activeContextId}
            archivedDimensionIds={activeContextState.archivedDimensionIds || []}
            onSetContextDefaultPerspective={setContextDefaultPerspective}
            workspaceRootNoteId={activeWorkspaceRootId}
          />
        </div>
      </div>

      {popupNote && (
        <NotePopup
          note={popupNote}
          notes={notes}
          initiallyEditTitle={popupEditTitle}
          isProjectRootNote={popupNote.id === activeProject?.rootNoteId}
          onClose={closeNotePopup}
          onNoteUpdated={handleNoteUpdated}
          onAssignmentsChanged={handleNoteAssignmentsChanged}
          onPeopleChanged={() => setPeopleVersion(v => v + 1)}
          onNoteDeleted={handleNoteDeleted}
          onNoteOpen={openNotePopup}
          onOpenAsWorkspace={openNoteAsWorkspace}
          onNotesChanged={handleNotesChanged}
        />
      )}

      {toast && (
        <Toast toast={toast} onOpen={openNotePopup} onDismiss={() => setToast(null)} />
      )}
    </div>
  )
}
