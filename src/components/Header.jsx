import { useState, useRef, useEffect } from 'react'
import styles from './Header.module.css'
import { api } from '../api'
import CategoryAssignmentPicker from './CategoryAssignmentPicker'
import CategoryHashtagSuggestions from './CategoryHashtagSuggestions'
import { mergeSelectionsWithHashtags } from '../categoryHashtags'
import { useProgressiveNoteSearch } from '../useProgressiveNoteSearch'
import { playSound } from '../sounds/sound_registry'

const PAGES = [
  { name: 'Notes', view: 1 },
  { name: 'Structure', view: 7 },
  { name: 'Classification', view: 2 },
  { name: 'Schedule', view: 3 },
  { name: 'Calendar', view: 6 },
  { name: 'Report', view: 8 },
  { name: 'People', view: 5 },
]

const NONE_PERSPECTIVE_ID = '__none__'
const CONTEXT_PAGES = [
  { id: 'classification', label: 'Classification' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'calendar', label: 'Calendar' },
]

function computeWordRects(el) {
  const base = el.getBoundingClientRect()
  const result = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const re = /\S+/g; let m
    while ((m = re.exec(node.textContent)) !== null) {
      const range = document.createRange()
      range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length)
      const r = range.getBoundingClientRect()
      if (r.width > 0 && r.height > 0)
        result.push({ word: m[0], top: r.top - base.top, left: r.left - base.left, width: r.width, height: r.height })
    }
  }
  return result
}

export default function Header({ view, onNavigate, onQuickAdd, projectName, onBack, notes = [], onNoteOpen, activeContextId = '', activeContextState = {}, onApplyContext }) {
  // quick-add state
  const [open, setOpen]               = useState(false)
  const [titleVal, setTitleVal]       = useState('')
  const [titleManual, setTitleManual] = useState(false)
  const [headlineMode, setHeadlineMode] = useState(false)
  const [wordRects, setWordRects]     = useState([])
  const [dimensions, setDimensions]   = useState([])
  const [categories, setCategories]   = useState([])
  const [categorySelections, setCategorySelections] = useState({})
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false)

  // search state
  const [searchOpen, setSearchOpen]   = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // context state
  const [contextOpen, setContextOpen] = useState(false)
  const [contexts, setContexts] = useState([])
  const [contextFormOpen, setContextFormOpen] = useState(false)
  const [editingContextId, setEditingContextId] = useState('')
  const [contextName, setContextName] = useState('')
  const [contextChoices, setContextChoices] = useState({
    classification: NONE_PERSPECTIVE_ID,
    schedule: NONE_PERSPECTIVE_ID,
    calendar: NONE_PERSPECTIVE_ID,
    archivedDimensionIds: [],
  })
  const [contextPerspectives, setContextPerspectives] = useState({
    classification: [],
    schedule: [],
    calendar: [],
  })
  const [contextDimensions, setContextDimensions] = useState([])

  const editorRef      = useRef(null)
  const titleInputRef  = useRef(null)
  const wrapRef        = useRef(null)
  const searchInputRef = useRef(null)
  const searchWrapRef  = useRef(null)
  const contextWrapRef = useRef(null)
  const contextWheelAtRef = useRef(0)

  useEffect(() => {
    if (open) setTimeout(() => editorRef.current?.focus(), 20)
  }, [open])

  useEffect(() => {
    if (searchOpen) setTimeout(() => searchInputRef.current?.focus(), 20)
    else setSearchQuery('')
  }, [searchOpen])

  useEffect(() => {
    if (projectName) ensureContextData()
  }, [projectName]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeContextId) return
    setContexts(previous => previous.map(context => context.id === activeContextId
      ? { ...context, state: activeContextState }
      : context))
  }, [activeContextId, activeContextState])

  const closePopup = () => {
    setOpen(false); setTitleVal(''); setTitleManual(false)
    setHeadlineMode(false); setWordRects([])
    setCategorySelections({})
    setCategoryPickerOpen(false)
    if (editorRef.current) editorRef.current.innerHTML = ''
  }

  const resetQuickAddDraft = () => {
    setTitleVal('')
    setTitleManual(false)
    setHeadlineMode(false)
    setWordRects([])
    if (editorRef.current) editorRef.current.innerHTML = ''
    window.setTimeout(() => editorRef.current?.focus(), 0)
  }

  const ensureCategoryData = () => {
    if (dimensions.length || categories.length) return
    Promise.all([api.getDimensions(), api.getAllCategories()])
      .then(([dims, cats]) => { setDimensions(dims); setCategories(cats) })
      .catch(console.error)
  }

  const handleDescInput = () => {
    const text = editorRef.current?.innerText || ''
    if (text.includes('#')) ensureCategoryData()
    if (!titleManual && editorRef.current) {
      const words = text.trim().split(/\s+/).filter(Boolean)
      setTitleVal(words.slice(0, 7).join(' '))
    }
    setCategorySelections(prev => mergeSelectionsWithHashtags(prev, text, categories))
    if (headlineMode) setWordRects(computeWordRects(editorRef.current))
  }

  const handleWordClick = word => {
    setTitleVal(prev => prev ? prev + ' ' + word : word)
    setTitleManual(true)
    titleInputRef.current?.focus()
  }

  const submit = () => {
    const desc = editorRef.current?.innerText?.trim() || ''
    if (!desc && !titleVal.trim()) return
    playSound('noteQuickAddSubmit')
    onQuickAdd?.(desc, titleVal.trim() || null, mergeSelectionsWithHashtags(categorySelections, desc, categories))
    resetQuickAddDraft()
  }

  useEffect(() => {
    if (!searchOpen) return
    const handler = e => {
      if (searchWrapRef.current?.contains(e.target)) return
      setSearchOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [searchOpen])

  useEffect(() => {
    if (!contextOpen) return
    const handler = e => {
      if (contextWrapRef.current?.contains(e.target)) return
      setContextOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextOpen])

  const ensureContextData = () => {
    Promise.all([
      api.getProjectContexts(),
      api.getClassificationPerspectives(activeContextId),
      api.getSchedulePerspectives(activeContextId),
      api.getCalendarPerspectives(activeContextId),
      api.getDimensions(),
    ])
      .then(([loadedContexts, classification, schedule, calendar, loadedDimensions]) => {
        setContexts(loadedContexts || [])
        setContextPerspectives({
          classification: classification || [],
          schedule: schedule || [],
          calendar: calendar || [],
        })
        setContextDimensions(loadedDimensions || [])
        if (!activeContextId && loadedContexts?.[0]) {
          onApplyContext?.(loadedContexts[0])
        }
      })
      .catch(console.error)
  }

  useEffect(() => {
    if (!projectName) return
    ensureContextData()
  }, [projectName]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleContextDimensionShown = dimId => {
    setContextChoices(prev => {
      const ids = new Set(prev.archivedDimensionIds || [])
      if (ids.has(dimId)) ids.delete(dimId)
      else ids.add(dimId)
      return { ...prev, archivedDimensionIds: [...ids] }
    })
  }

  const openContextMenu = () => {
    const next = !contextOpen
    setContextOpen(next)
    playSound(next ? 'perspectiveLoad' : 'collapseToggle')
    if (next) {
      setContextFormOpen(false)
      setContextChoices({
        classification: NONE_PERSPECTIVE_ID,
        schedule: NONE_PERSPECTIVE_ID,
        calendar: NONE_PERSPECTIVE_ID,
        archivedDimensionIds: [],
      })
      setEditingContextId('')
      setContextName('')
      ensureContextData()
    }
  }

  const contextStateFromChoices = () => ({
    classificationPerspectiveId: contextChoices.classification,
    schedulePerspectiveId: contextChoices.schedule,
    calendarPerspectiveId: contextChoices.calendar,
    archivedDimensionIds: contextChoices.archivedDimensionIds || [],
  })

  const applyContext = async (context, { refreshList = true } = {}) => {
    if (!context) return
    playSound('perspectiveLoad')
    let nextContext = context
    if (refreshList) {
      try {
        const loadedContexts = await api.getProjectContexts()
        if (Array.isArray(loadedContexts) && loadedContexts.length) {
          setContexts(loadedContexts)
          nextContext = loadedContexts.find(item => item.id === context.id) || context
        }
      } catch (err) {
        console.error('Failed to refresh contexts before apply', err)
      }
    }
    onApplyContext?.(nextContext)
    setContextOpen(false)
  }

  const selectAdjacentContext = async direction => {
    let sourceContexts = contexts
    try {
      const loadedContexts = await api.getProjectContexts()
      if (Array.isArray(loadedContexts) && loadedContexts.length) {
        sourceContexts = loadedContexts
        setContexts(loadedContexts)
      }
    } catch (err) {
      console.error('Failed to refresh contexts for cycling', err)
    }
    if (!sourceContexts.length) return
    const currentIndex = Math.max(0, sourceContexts.findIndex(context => context.id === activeContextId))
    const nextContext = sourceContexts[(currentIndex + direction + sourceContexts.length) % sourceContexts.length]
    if (nextContext) applyContext(nextContext, { refreshList: false })
  }

  const cycleContext = event => {
    if (!contexts.length) return
    event.preventDefault()
    const now = Date.now()
    if (now - contextWheelAtRef.current < 180) return
    contextWheelAtRef.current = now
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (delta === 0) return
    selectAdjacentContext(delta > 0 ? 1 : -1)
  }

  const createContext = async () => {
    const name = contextName.trim()
    if (!name) return
    try {
      const created = await api.createProjectContext({ name, state: contextStateFromChoices() })
      playSound('perspectiveSave')
      setContexts(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      setContextName('')
      setContextFormOpen(false)
    } catch (err) {
      console.error('Failed to create context', err)
    }
  }

  const editContext = async context => {
    playSound('select')
    setContextFormOpen(true)
    setEditingContextId(context.id)
    setContextName(context.name)
    setContextChoices({
      classification: context.state?.classificationPerspectiveId || NONE_PERSPECTIVE_ID,
      schedule: context.state?.schedulePerspectiveId || NONE_PERSPECTIVE_ID,
      calendar: context.state?.calendarPerspectiveId || NONE_PERSPECTIVE_ID,
      archivedDimensionIds: context.state?.archivedDimensionIds || [],
    })
    try {
      const [classification, schedule, calendar] = await Promise.all([
        api.getClassificationPerspectives(context.id),
        api.getSchedulePerspectives(context.id),
        api.getCalendarPerspectives(context.id),
      ])
      setContextPerspectives({
        classification: classification || [],
        schedule: schedule || [],
        calendar: calendar || [],
      })
    } catch (err) {
      console.error('Failed to load context perspectives', err)
    }
  }

  const cancelContextEdit = () => {
    setContextFormOpen(false)
    setEditingContextId('')
    setContextName('')
    setContextChoices({
      classification: NONE_PERSPECTIVE_ID,
      schedule: NONE_PERSPECTIVE_ID,
      calendar: NONE_PERSPECTIVE_ID,
      archivedDimensionIds: [],
    })
  }

  const saveContextEdit = async () => {
    if (!editingContextId) return createContext()
    const name = contextName.trim()
    if (!name) return
    try {
      const saved = await api.updateProjectContext(editingContextId, { name, state: contextStateFromChoices() })
      playSound('perspectiveUpdate')
      setContexts(prev => prev
        .map(context => context.id === saved.id ? saved : context)
        .sort((a, b) => a.name.localeCompare(b.name)))
      if (saved.id === activeContextId) onApplyContext?.(saved)
      setContextFormOpen(false)
      setEditingContextId('')
      setContextName('')
    } catch (err) {
      console.error('Failed to update context', err)
    }
  }

  const startContextCreate = () => {
    playSound('select')
    setContextFormOpen(true)
    setEditingContextId('')
    setContextName('')
    setContextChoices({
      classification: NONE_PERSPECTIVE_ID,
      schedule: NONE_PERSPECTIVE_ID,
      calendar: NONE_PERSPECTIVE_ID,
      archivedDimensionIds: [],
    })
  }

  const deleteContext = async context => {
    if (!window.confirm(`Delete context "${context.name}"?`)) return
    const deletedIndex = contexts.findIndex(item => item.id === context.id)
    try {
      await api.deleteProjectContext(context.id)
      playSound('perspectiveDelete')
      const loadedContexts = await api.getProjectContexts()
      setContexts(loadedContexts || [])
      if (editingContextId === context.id) cancelContextEdit()
      if (activeContextId === context.id && loadedContexts?.length) {
        const nextIndex = Math.min(Math.max(0, deletedIndex), loadedContexts.length - 1)
        onApplyContext?.(loadedContexts[nextIndex])
      }
    } catch (err) {
      console.error('Failed to delete context', err)
    }
  }

  const handleKey = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    if (e.key === 'Escape') closePopup()
  }

  const toggleHeadline = () => {
    const next = !headlineMode
    setHeadlineMode(next)
    if (next && editorRef.current) setWordRects(computeWordRects(editorRef.current))
  }

  // search logic
  const { results: searchResults, searchingDescriptions, validQuery } = useProgressiveNoteSearch(notes, searchQuery)
  const headlineSearchResults = searchResults.filter(result => result.matchType === 'strong')
  const descriptionSearchResults = searchResults.filter(result => result.matchType === 'weak')

  const openResult = (noteId) => {
    playSound('searchResultClick')
    setSearchOpen(false)
    onNoteOpen?.(noteId)
  }

  const activeContextName = contexts.find(context => context.id === activeContextId)?.name || 'Context'
  const quickAddCategoryDefaults = dimensions.flatMap(dimension => {
    const categoryId = categorySelections[dimension.id]
    const category = categories.find(item => item.id === categoryId)
    return category ? [{ dimension, category }] : []
  })

  return (
    <header className={styles.header}>
      {onBack && (
        <button className={styles.backBtn} onClick={onBack} title="See all projects" aria-label="See all projects">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8A1.5 1.5 0 0 0 13 12.5V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M9 2h5v5M14 2 8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}
      {projectName && (
        <div className={styles.projectCenter}>
          <button
            className={`${styles.projectNameBtn} ${view === 0 ? styles.projectNameBtnActive : ''}`}
            onClick={() => { playSound('viewChange'); onNavigate(0) }}
            title="Open project overview">
            {projectName}
          </button>
        </div>
      )}

      <nav className={styles.nav}>
        {PAGES.map(note => (
          <button key={note.view}
            className={`${styles.navItem} ${view === note.view ? styles.active : ''}`}
            onClick={() => { playSound('viewChange'); onNavigate(note.view) }}>
            {note.name}
          </button>
        ))}
      </nav>

      {/* Search button */}
      {view !== 1 && <div ref={searchWrapRef} className={styles.searchWrap}>
        <button
          className={`${styles.searchBtn} ${searchOpen ? styles.searchBtnActive : ''}`}
          onClick={() => { playSound(searchOpen ? 'searchClose' : 'searchOpen'); setSearchOpen(o => !o) }}
          title="Search notes">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>

        {searchOpen && (
          <div className={styles.searchPanel}>
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') { playSound('searchClose'); setSearchOpen(false) } }}
              placeholder="Search notes… (regex ok)"
            />
            {searchQuery.trim() && (
              <div className={styles.searchResults}>
                {!validQuery ? (
                  <div className={styles.searchEmpty}>Invalid regex</div>
                ) : searchResults.length === 0 && !searchingDescriptions ? (
                  <div className={styles.searchEmpty}>No results</div>
                ) : (
                  <>
                    {headlineSearchResults.length > 0 && (
                      <div className={styles.searchResultSection}>
                        <div className={styles.searchResultSectionTitle}>In headline</div>
                        {headlineSearchResults.map(({ note }) => (
                          <button
                            key={note.id}
                            className={styles.searchResultCard}
                            onClick={() => openResult(note.id)}>
                            <span className={styles.searchResultTitle}>{note.title || 'Untitled'}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {descriptionSearchResults.length > 0 && (
                      <div className={styles.searchResultSection}>
                        <div className={styles.searchResultSectionTitle}>In description</div>
                        {descriptionSearchResults.map(({ note, snippet }) => (
                          <button
                            key={note.id}
                            className={styles.searchResultCard}
                            onClick={() => openResult(note.id)}>
                          <span className={styles.searchResultTitle}>{note.title || 'Untitled'}</span>
                            {snippet && (
                              <span className={styles.searchResultSnippet}>{snippet}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    {searchingDescriptions && (
                      <div className={styles.searchLoading}>Searching descriptions...</div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>}

      {/* Quick-add button */}
      {view !== 1 && <div ref={wrapRef} className={styles.quickAddWrap}>
        <button className={styles.quickAddBtn} onClick={() => {
          playSound(!open ? 'noteQuickAddOpen' : 'collapseToggle')
          if (open) closePopup()
          else setOpen(true)
        }} title={open ? 'Close quick add session' : 'Quick add note'}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M5 8h6M5 5.5h4M5 10.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M11.5 10l1 1 1.5-1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {open && (
          <div className={styles.quickAddPopup}>
            <div className={styles.quickAddTopRow}>
              <span className={styles.quickAddLabel}>Quick add note</span>
              <button
                className={`${styles.quickAddHdrBtn} ${headlineMode ? styles.quickAddHdrBtnActive : ''}`}
                onClick={toggleHeadline}>
                Header mode
              </button>
              <button
                className={styles.quickAddHdrBtn}
                onClick={() => { ensureCategoryData(); setCategoryPickerOpen(true) }}>
                Categories{quickAddCategoryDefaults.length ? ` (${quickAddCategoryDefaults.length})` : ''}
              </button>
              <button
                type="button"
                className={styles.quickAddCloseBtn}
                onClick={closePopup}
                title="Close quick add session"
                aria-label="Close quick add session">
                ×
              </button>
            </div>

            <div className={`${styles.quickAddDefaults} ${quickAddCategoryDefaults.length ? styles.quickAddDefaultsActive : ''}`}>
              <span className={styles.quickAddDefaultsLabel}>Applied to every new note</span>
              <div className={styles.quickAddDefaultChips}>
                {quickAddCategoryDefaults.length ? quickAddCategoryDefaults.map(({ dimension, category }) => (
                  <span key={dimension.id} className={styles.quickAddDefaultChip}>
                    <i style={{ background: category.color || '#94a3b8' }} />
                    <strong>{dimension.name}</strong>
                    <span>{category.name}</span>
                    <button
                      type="button"
                      onClick={() => setCategorySelections(previous => {
                        const next = { ...previous }
                        delete next[dimension.id]
                        return next
                      })}
                      title={`Remove ${category.name}`}
                      aria-label={`Remove ${category.name} from quick-add defaults`}>
                      ×
                    </button>
                  </span>
                )) : (
                  <span className={styles.quickAddDefaultsEmpty}>No default categories selected</span>
                )}
              </div>
            </div>

            <input
              ref={titleInputRef}
              className={styles.quickAddTitleInput}
              value={titleVal}
              onChange={e => { setTitleVal(e.target.value); setTitleManual(true) }}
              onKeyDown={handleKey}
              placeholder="Title (auto-fills from text below)"
            />

            <div className={styles.quickAddEditorWrap}>
              <div
                ref={editorRef}
                className={styles.quickAddEditor}
                contentEditable={!headlineMode}
                suppressContentEditableWarning
                data-placeholder="Describe your note…"
                onInput={handleDescInput}
                onKeyDown={handleKey}
              />
              {headlineMode && (
                <div className={styles.quickAddOverlay} onClick={() => setHeadlineMode(false)}>
                  {wordRects.map((w, i) => (
                    <button key={i} className={styles.quickAddWordBtn}
                      style={{ top: w.top, left: w.left, width: w.width, height: w.height }}
                      onMouseDown={e => e.preventDefault()}
                      onClick={e => { e.stopPropagation(); handleWordClick(w.word) }}
                    />
                  ))}
                </div>
              )}
              {!headlineMode && (
                <CategoryHashtagSuggestions
                  editorRef={editorRef}
                  dimensions={dimensions}
                  categories={categories}
                  placement="above"
                  onPick={cat => setCategorySelections(prev => ({ ...prev, [cat.dimensionId]: cat.id }))}
                />
              )}
            </div>

            <div className={styles.quickAddBottomRow}>
              <p className={styles.quickAddHint}>Enter to add another · categories stay selected · Esc closes</p>
              <button className={styles.quickAddSubmit} onClick={submit}>Add</button>
            </div>
            <CategoryAssignmentPicker
              open={categoryPickerOpen}
              dimensions={dimensions}
              categories={categories}
              selections={categorySelections}
              onChange={setCategorySelections}
              onClose={() => setCategoryPickerOpen(false)}
            />
          </div>
        )}
      </div>}
    </header>
  )
}
