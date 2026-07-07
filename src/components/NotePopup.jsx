import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import styles from './NotePopup.module.css'
import { api } from '../api'
import CategoryAssignmentPicker from './CategoryAssignmentPicker'
import CategoryHashtagSuggestions from './CategoryHashtagSuggestions'
import PersonaAvatarStack from './PersonaAvatarStack'
import { mergeSelectionsWithHashtags } from '../categoryHashtags'
import { playSound } from '../sounds/sound_registry'
import NoteHierarchyTree, { buildNoteHierarchyRows } from './NoteHierarchyTree'

// ── Headline-mode helpers ─────────────────────────────────────────────────────
function computeWordRects(editorEl) {
  const baseRect = editorEl.getBoundingClientRect()
  const result = []
  const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const re = /\S+/g; let m
    while ((m = re.exec(node.textContent)) !== null) {
      const range = document.createRange()
      range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length)
      const rect = range.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0)
        result.push({
          word: m[0],
          top: rect.top - baseRect.top,
          left: rect.left - baseRect.left,
          width: rect.width,
          height: rect.height,
        })
    }
  }
  return result
}

// ── Icons ─────────────────────────────────────────────────────────────────────
function TagIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
      <line x1="7" y1="7" x2="7.01" y2="7"/>
    </svg>
  )
}

function ChevronIcon({ down }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"
      style={{ transform: down ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>
      <path d="M7 10l5 5 5-5z"/>
    </svg>
  )
}

function descendantIdsForNote(notes, noteId) {
  const childrenByParent = new Map()
  notes.forEach(item => {
    if (!item.parentNoteId) return
    if (!childrenByParent.has(item.parentNoteId)) childrenByParent.set(item.parentNoteId, [])
    childrenByParent.get(item.parentNoteId).push(item.id)
  })
  const descendants = new Set()
  const pending = [...(childrenByParent.get(noteId) || [])]
  while (pending.length) {
    const id = pending.pop()
    if (!id || descendants.has(id)) continue
    descendants.add(id)
    pending.push(...(childrenByParent.get(id) || []))
  }
  return descendants
}

function compareHierarchyNoteOrder(a, b) {
  const aOrder = a.orderIdx ?? a.order_idx ?? Number.MAX_SAFE_INTEGER
  const bOrder = b.orderIdx ?? b.order_idx ?? Number.MAX_SAFE_INTEGER
  if (aOrder !== bOrder) return aOrder - bOrder
  return String(a.title || '').localeCompare(String(b.title || ''))
}

// ── Main popup ────────────────────────────────────────────────────────────────
export default function NotePopup({ note, notes = [], isProjectRootNote = false, initiallyEditTitle = false, onClose, onNoteUpdated, onAssignmentsChanged, onPeopleChanged, onNoteDeleted, onNoteOpen, onOpenAsWorkspace, onNotesChanged }) {
  const [expanded, setExpanded]           = useState(false)
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false)
  const [headlineMode, setHeadlineMode]   = useState(false)
  const [wordRects, setWordRects]         = useState([])
  const [headlineStarted, setHeadlineStarted] = useState(false)
  const [editingTitle, setEditingTitle]   = useState(false)
  const [titleVal, setTitleVal]           = useState(note.title)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [descendantDepth, setDescendantDepth] = useState(1)
  const [expandedHierarchyNoteIds, setExpandedHierarchyNoteIds] = useState(() => new Set())
  const [collapsedHierarchyNoteIds, setCollapsedHierarchyNoteIds] = useState(() => new Set())
  const [selectedHierarchyNoteIds, setSelectedHierarchyNoteIds] = useState(() => new Set())
  const [draggedHierarchyNoteIds, setDraggedHierarchyNoteIds] = useState(() => new Set())
  const [hierarchyDropTargetId, setHierarchyDropTargetId] = useState(null)
  const [hierarchyReorderDragId, setHierarchyReorderDragId] = useState(null)
  const [hierarchyReorderTarget, setHierarchyReorderTarget] = useState(null)
  const [aiHeadlineLoading, setAiHeadlineLoading] = useState(false)
  const [aiHeadlineSuggestion, setAiHeadlineSuggestion] = useState(null)
  const [aiHeadlineError, setAiHeadlineError] = useState('')

  // expanded data
  const [dimensions, setDimensions]   = useState([])
  const [categories, setCategories]   = useState([])
  const [assignments, setAssignments] = useState({}) // { dimId: catId }
  const [personas, setPersonas] = useState([])
  const [personaNoteAssignments, setPersonaNoteAssignments] = useState([])

  const editorRef      = useRef(null)
  const popupRef       = useRef(null)
  const titleInputRef  = useRef(null)
  const saveTimerRef   = useRef(null)
  const notesById = new Map(notes.map(item => [item.id, item]))
  const hierarchyRows = buildNoteHierarchyRows(notes, note.id, { includeRoot: true })
  const hierarchyDepthById = new Map(hierarchyRows.map(row => [row.note.id, row.depth]))
  const rootHierarchyDepth = hierarchyDepthById.get(note.id) ?? 0
  const isHierarchyNodeExpanded = useCallback(noteId => {
    if (collapsedHierarchyNoteIds.has(noteId)) return false
    if (expandedHierarchyNoteIds.has(noteId)) return true
    const nodeDepth = hierarchyDepthById.get(noteId)
    if (nodeDepth === undefined || nodeDepth < rootHierarchyDepth) return false
    const hopsBelowRoot = nodeDepth - rootHierarchyDepth
    return descendantDepth === 'all' || hopsBelowRoot < descendantDepth
  }, [collapsedHierarchyNoteIds, descendantDepth, expandedHierarchyNoteIds, hierarchyDepthById, rootHierarchyDepth])
  const visibleHierarchyRows = hierarchyRows.filter(row => {
    if (row.note.id === note.id) return true
    let parentId = row.note.parentNoteId
    while (parentId && parentId !== note.id) {
      if (!isHierarchyNodeExpanded(parentId)) return false
      parentId = notesById.get(parentId)?.parentNoteId || null
    }
    return parentId === note.id && isHierarchyNodeExpanded(note.id)
  })
  const childCount = notes.filter(item => item.parentNoteId === note.id).length

  // Keep note title in sync if parent updates note
  useEffect(() => { setTitleVal(note.title) }, [note.title])

  useEffect(() => {
    setCategoryPickerOpen(false)
    setAiHeadlineSuggestion(null)
    setAiHeadlineError('')
    setDescendantDepth(1)
    setExpandedHierarchyNoteIds(new Set())
    setCollapsedHierarchyNoteIds(new Set())
    setSelectedHierarchyNoteIds(new Set())
    setDraggedHierarchyNoteIds(new Set())
    setHierarchyDropTargetId(null)
    setHierarchyReorderDragId(null)
    setHierarchyReorderTarget(null)
  }, [note.id])

  useEffect(() => {
    setEditingTitle(Boolean(initiallyEditTitle))
  }, [initiallyEditTitle, note.id])

  // Focus title input when editing starts
  useEffect(() => {
    if (editingTitle) { titleInputRef.current?.focus(); titleInputRef.current?.select() }
  }, [editingTitle])

  // Escape closes headline mode or popup
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (headlineMode) { setHeadlineMode(false); return }
        if (confirmDelete) { setConfirmDelete(false); return }
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [headlineMode, confirmDelete, onClose])

  // Fetch dimension/category/assignment data for compact and expanded views
  useEffect(() => {
    Promise.all([
      api.getDimensions(),
      api.getAllCategories(),
      api.getAssignments(),
      api.getPersonas(),
      api.getDirectPersonaNoteAssignments(),
    ])
      .then(([dims, cats, asns, pers, pnAsns]) => {
        setDimensions(dims)
        setCategories(cats)
        setPersonas(pers)
        setPersonaNoteAssignments(pnAsns)
        // asns is array of { noteId, dimensionId, categoryId }
        const myAsns = asns.filter(a => a.noteId === note.id)
        const map = {}
        myAsns.forEach(a => { map[a.dimensionId] = a.categoryId })
        setAssignments(map)
      })
      .catch(console.error)
  }, [note.id])

  // ── Title commit ──────────────────────────────────────────────────────────
  const commitTitle = useCallback(async (val) => {
    const trimmed = val.trim() || 'Untitled'
    setTitleVal(trimmed)
    setEditingTitle(false)
    playSound('noteEditCommit')
    try {
      await api.updateNote(note.id, { title: trimmed })
      onNoteUpdated?.(note.id, { title: trimmed })
    } catch (e) { console.error(e) }
  }, [note.id, onNoteUpdated])

  // ── Description save (debounced 600ms) ───────────────────────────────────
  const saveHtml = useCallback((html) => {
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      playSound('noteAutoSave')
      try {
        await api.updateNote(note.id, { html })
        onNoteUpdated?.(note.id, { html })
      } catch (e) { console.error(e) }
    }, 600)
  }, [note.id, onNoteUpdated])

  // ── Headline mode ─────────────────────────────────────────────────────────
  const enterHeadlineMode = () => {
    if (!editorRef.current) return
    setWordRects(computeWordRects(editorRef.current))
    setHeadlineStarted(false)
    setHeadlineMode(true)
  }

  const handleWordClick = async (word) => {
    const next = headlineStarted ? titleVal + ' ' + word : word
    if (!headlineStarted) setHeadlineStarted(true)
    setTitleVal(next)
    try {
      await api.updateNote(note.id, { title: next })
      onNoteUpdated?.(note.id, { title: next })
    } catch (e) { console.error(e) }
  }

  const suggestAiHeadline = async () => {
    const description = editorRef.current?.innerHTML || note.html || ''
    if (!description.trim()) {
      setAiHeadlineError('Add a description first, then I can suggest a headline.')
      setAiHeadlineSuggestion(null)
      return
    }
    setAiHeadlineLoading(true)
    setAiHeadlineError('')
    setAiHeadlineSuggestion(null)
    try {
      const result = await api.suggestHeadline({
        description,
        currentHeadline: titleVal,
        style: 'concise project note',
        maxWords: 7,
      })
      setAiHeadlineSuggestion(result)
      playSound('message')
    } catch (e) {
      console.error(e)
      setAiHeadlineError(e.message || 'AI headline suggestion failed.')
      playSound('blocked')
    } finally {
      setAiHeadlineLoading(false)
    }
  }

  const acceptAiHeadline = async () => {
    if (!aiHeadlineSuggestion?.headline) return
    await commitTitle(aiHeadlineSuggestion.headline)
    setAiHeadlineSuggestion(null)
    setAiHeadlineError('')
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  const confirmAndDelete = async () => {
    try {
      await api.deleteNote(note.id)
      playSound('noteDelete')
      onNoteDeleted?.(note.id)
      onClose()
    } catch (e) { console.error(e) }
  }

  const categoryName = (dimId) => {
    const catId = assignments[dimId]
    if (!catId) return null
    return categories.find(c => c.id === catId)
  }

  const assignedSummary = dimensions
    .map(dim => {
      const cat = categoryName(dim.id)
      return cat ? { dim, cat } : null
    })
    .filter(Boolean)

  const notePersonas = personaNoteAssignments
    .filter(a => a.noteId === note.id)
    .map(a => personas.find(p => p.id === a.personaId))
    .filter(Boolean)

  const removePersonaFromNote = async personaId => {
    playSound('personaRemove')
    const previous = personaNoteAssignments
    setPersonaNoteAssignments(prev => prev.filter(a => !(a.personaId === personaId && a.noteId === note.id)))
    try {
      await api.unassignPersonaFromNote(personaId, note.id)
      onPeopleChanged?.()
    } catch (e) {
      console.error(e)
      setPersonaNoteAssignments(previous)
    }
  }

  const toggleHierarchyNode = noteId => {
    const currentlyExpanded = isHierarchyNodeExpanded(noteId)
    setExpandedHierarchyNoteIds(prev => {
      const next = new Set(prev)
      if (currentlyExpanded) next.delete(noteId)
      else next.add(noteId)
      return next
    })
    setCollapsedHierarchyNoteIds(prev => {
      const next = new Set(prev)
      if (currentlyExpanded) next.add(noteId)
      else next.delete(noteId)
      return next
    })
  }

  const changeDescendantDepth = value => {
    setDescendantDepth(value)
    setExpandedHierarchyNoteIds(new Set())
    setCollapsedHierarchyNoteIds(new Set())
  }

  const cycleDescendantDepth = deltaY => {
    const options = [1, 2, 3, 'all']
    const currentIndex = Math.max(0, options.findIndex(option => option === descendantDepth))
    const direction = deltaY > 0 ? 1 : -1
    changeDescendantDepth(options[(currentIndex + direction + options.length) % options.length])
  }

  const selectHierarchyNode = (event, noteId) => {
    if (event.ctrlKey || event.metaKey) {
      setSelectedHierarchyNoteIds(prev => {
        const next = new Set(prev)
        if (next.has(noteId)) next.delete(noteId)
        else next.add(noteId)
        return next
      })
      return
    }
    setSelectedHierarchyNoteIds(new Set([noteId]))
  }

  const moveHierarchyNotes = async (noteIds, parentNoteId) => {
    const uniqueIds = [...new Set(Array.isArray(noteIds) ? noteIds : [noteIds])].filter(Boolean)
    const movableIds = uniqueIds.filter(noteId => {
      const movedNote = notesById.get(noteId)
      if (!movedNote || movedNote.parentNoteId === parentNoteId || noteId === parentNoteId) return false
      return !descendantIdsForNote(notes, noteId).has(parentNoteId)
    })
    if (!movableIds.length) return
    try {
      await Promise.all(movableIds.map(noteId => api.updateNote(noteId, { parentNoteId })))
      await onNotesChanged?.()
    } catch (error) {
      console.error('Popup hierarchy move failed', error)
    }
  }

  const reorderHierarchyNote = async (noteId, targetNoteId, position = 'before') => {
    if (!noteId || !targetNoteId || noteId === targetNoteId) return
    const movedNote = notesById.get(noteId)
    const targetNote = notesById.get(targetNoteId)
    if (!movedNote || !targetNote) return
    if (movedNote.id === note.id || targetNote.id === note.id) return
    if ((movedNote.parentNoteId || '') !== (targetNote.parentNoteId || '')) return
    const siblings = notes
      .filter(item => (item.parentNoteId || '') === (movedNote.parentNoteId || ''))
      .sort(compareHierarchyNoteOrder)
    const fromIdx = siblings.findIndex(item => item.id === noteId)
    const targetIdx = siblings.findIndex(item => item.id === targetNoteId)
    if (fromIdx === -1 || targetIdx === -1) return
    const reordered = [...siblings]
    reordered.splice(fromIdx, 1)
    const targetAfterRemovalIdx = reordered.findIndex(item => item.id === targetNoteId)
    if (targetAfterRemovalIdx === -1) return
    reordered.splice(position === 'after' ? targetAfterRemovalIdx + 1 : targetAfterRemovalIdx, 0, movedNote)
    if (reordered.every((item, index) => item.id === siblings[index]?.id)) return
    try {
      await api.reorderNotes(reordered.map(item => item.id))
      await onNotesChanged?.()
    } catch (error) {
      console.error('Popup hierarchy reorder failed', error)
    }
  }

  const handleCategoryChange = async (newSels) => {
    const old = { ...assignments }
    const allDimIds = new Set([...Object.keys(old), ...Object.keys(newSels)])
    for (const dimId of allDimIds) {
      const oldCat = old[dimId] || null
      const newCat = newSels[dimId] || null
      if (oldCat === newCat) continue
      if (!newCat) {
        setAssignments(prev => { const n = { ...prev }; delete n[dimId]; return n })
        try {
          await api.unassign(note.id, dimId)
          onAssignmentsChanged?.()
        }
        catch (e) { console.error(e); setAssignments(old) }
      } else {
        setAssignments(prev => ({ ...prev, [dimId]: newCat }))
        try {
          await api.assign(note.id, dimId, newCat)
          onAssignmentsChanged?.()
        }
        catch (e) { console.error(e); setAssignments(old) }
      }
    }
  }

  const handleEditorInput = e => {
    const html = e.currentTarget.innerHTML
    const text = e.currentTarget.innerText || ''
    saveHtml(html)
    const nextAssignments = mergeSelectionsWithHashtags(assignments, text, categories)
    if (JSON.stringify(nextAssignments) !== JSON.stringify(assignments)) {
      handleCategoryChange(nextAssignments)
    }
  }

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) { playSound('noteClose'); onClose() } }}>
      <div ref={popupRef} className={styles.popup}>

        {/* Header row */}
        <div className={styles.popupHeader}>
          <div className={styles.titleArea}>
            {editingTitle ? (
              <input
                ref={titleInputRef}
                className={styles.titleInput}
                value={titleVal}
                onChange={e => setTitleVal(e.target.value)}
                onBlur={e => commitTitle(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') e.target.blur()
                  if (e.key === 'Escape') { setTitleVal(note.title); setEditingTitle(false) }
                }}
              />
            ) : (
              <h2
                className={styles.title}
                onDoubleClick={() => { playSound('noteEditStart'); setEditingTitle(true) }}
                title="Double-click to edit"
              >
                {titleVal}
              </h2>
            )}
          </div>
          <div className={styles.headerActions}>
            {onOpenAsWorkspace && (
              <button
                className={styles.openWorkspaceBtn}
                onClick={() => { playSound('viewChange'); onOpenAsWorkspace(note.id) }}
                title="Open this note as a project"
              >
                Open as project
              </button>
            )}
            <button
              className={styles.expandBtn}
              onClick={() => { playSound('collapseToggle'); setExpanded(e => !e) }}
              title={expanded ? 'Collapse' : 'Show categories'}
            >
              <ChevronIcon down={expanded} />
              {expanded ? 'Less' : 'More'}
            </button>
            <button className={styles.deleteBtn} onClick={() => { playSound('blocked'); setConfirmDelete(true) }} title="Delete note">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
            </button>
            <button className={styles.closeBtn} onClick={() => { playSound('noteClose'); onClose() }} title="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        <div className={styles.compactCategories}>
          <div className={styles.compactCategoriesHeader}>
            <span className={styles.sectionLabel}>Categories</span>
            {dimensions.length > 0 && (
              <button
                className={styles.editCategoriesBtn}
                onClick={() => setCategoryPickerOpen(true)}
              >
                Edit categorization
              </button>
            )}
          </div>
          {dimensions.length === 0 ? (
            <p className={styles.emptyNote}>No dimensions defined yet.</p>
          ) : assignedSummary.length === 0 ? (
            <p className={styles.emptyNote}>No categories assigned.</p>
          ) : (
            <div className={styles.compactCategoryList}>
              {assignedSummary.map(({ dim, cat }) => (
                <span
                  key={dim.id}
                  className={styles.compactCategoryBadge}
                  style={{ borderColor: cat.color, background: `${cat.color}18`, color: cat.color }}
                >
                  <span className={styles.compactCategoryDim}>{dim.name}</span>
                  <span className={styles.catDot} style={{ background: cat.color }} />
                  {cat.name}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className={styles.peopleSection}>
          <div className={styles.peopleSectionHeader}>
            <span className={styles.sectionLabel}>People</span>
            <span className={styles.peopleCount}>{notePersonas.length}</span>
          </div>
          {notePersonas.length === 0 ? (
            <p className={styles.emptyNote}>No people assigned.</p>
          ) : (
            <div className={styles.peopleStackWrap}>
              <PersonaAvatarStack
                personas={notePersonas}
                onRemove={removePersonaFromNote}
              />
            </div>
          )}
        </div>

        <div className={styles.childrenSection}>
          <div className={styles.childrenHeader}>
            <span className={styles.sectionLabel}>{isProjectRootNote ? 'Child notes' : 'Subnotes'}</span>
            <div className={styles.childrenControls}>
              {childCount > 0 && (
                <label className={styles.depthControl}>
                  <span>Depth</span>
                  <select
                    value={descendantDepth}
                    onWheel={event => {
                      event.preventDefault()
                      cycleDescendantDepth(event.deltaY)
                    }}
                    onChange={event => changeDescendantDepth(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
                    <option value={1}>1 hop</option>
                    <option value={2}>2 hops</option>
                    <option value={3}>3 hops</option>
                    <option value="all">All</option>
                  </select>
                </label>
              )}
              <span className={styles.childrenCount}>{childCount}</span>
            </div>
          </div>
          {childCount === 0 ? (
            <p className={styles.emptyNote}>No child notes.</p>
          ) : (
            <NoteHierarchyTree
              rows={visibleHierarchyRows}
              rootNoteId={note.id}
              selectedIds={selectedHierarchyNoteIds}
              draggedIds={draggedHierarchyNoteIds}
              dropTargetId={hierarchyDropTargetId}
              reorderDragId={hierarchyReorderDragId}
              reorderTarget={hierarchyReorderTarget}
              isExpanded={isHierarchyNodeExpanded}
              onToggle={toggleHierarchyNode}
              onSelect={selectHierarchyNode}
              onOpenWorkspace={noteId => { playSound('viewChange'); onOpenAsWorkspace?.(noteId) }}
              onMove={moveHierarchyNotes}
              onReorder={reorderHierarchyNote}
              onDragStartIds={noteId => selectedHierarchyNoteIds.has(noteId)
                ? [...selectedHierarchyNoteIds]
                : [noteId]}
              onDragStateChange={({ draggedIds, selectedId, dropTargetId, onlyIfDropTargetId }) => {
                if (draggedIds) setDraggedHierarchyNoteIds(draggedIds)
                if (selectedId && !selectedHierarchyNoteIds.has(selectedId)) setSelectedHierarchyNoteIds(new Set([selectedId]))
                if (dropTargetId !== undefined) {
                  if (onlyIfDropTargetId) setHierarchyDropTargetId(current => current === onlyIfDropTargetId ? dropTargetId : current)
                  else setHierarchyDropTargetId(dropTargetId)
                }
              }}
              onReorderDragStateChange={({ dragId, target, onlyIfTargetId }) => {
                if (dragId !== undefined) setHierarchyReorderDragId(dragId)
                if (target !== undefined) {
                  if (onlyIfTargetId) setHierarchyReorderTarget(current => current?.noteId === onlyIfTargetId ? target : current)
                  else setHierarchyReorderTarget(target)
                }
              }}
              onClearSelection={() => setSelectedHierarchyNoteIds(new Set())}
              ariaLabel="Subnote hierarchy"
            />
          )}
        </div>

        {/* Description section */}
        <div className={styles.descSection}>
          <div className={styles.descHeader}>
            <span className={styles.sectionLabel}>Description</span>
            <div className={styles.descActions}>
              <button
                className={styles.aiHeadlineBtn}
                onClick={suggestAiHeadline}
                disabled={aiHeadlineLoading}
                title="Let local AI suggest a headline from the description"
              >
                {aiHeadlineLoading ? 'Thinking…' : 'Let AI suggest headline'}
              </button>
              <button
                className={`${styles.headlineBtn} ${headlineMode ? styles.headlineBtnActive : ''}`}
                onClick={headlineMode ? () => { playSound('settingToggle'); setHeadlineMode(false) } : () => { playSound('settingToggle'); enterHeadlineMode() }}
                title={headlineMode ? 'Exit headline mode (Esc)' : 'Pick headline words from description'}
              >
                <TagIcon />
                {headlineMode ? 'Exit headline mode' : 'Headline mode'}
              </button>
            </div>
          </div>
          {(aiHeadlineSuggestion || aiHeadlineError) && (
            <div className={aiHeadlineError ? styles.aiHeadlineError : styles.aiHeadlineSuggestion}>
              {aiHeadlineError ? (
                <span>{aiHeadlineError}</span>
              ) : (
                <>
                  <span className={styles.aiHeadlineText}>{aiHeadlineSuggestion.headline}</span>
                  <span className={styles.aiHeadlineProvider}>{aiHeadlineSuggestion.provider}</span>
                  <button className={styles.aiHeadlineAcceptBtn} onClick={acceptAiHeadline}>Accept</button>
                  <button className={styles.aiHeadlineDismissBtn} onClick={() => setAiHeadlineSuggestion(null)}>Dismiss</button>
                </>
              )}
            </div>
          )}
          <div className={styles.editorWrap}>
            <div
              ref={el => {
                editorRef.current = el
                if (el && !el._ready) { el.innerHTML = note.html || ''; el._ready = true }
              }}
              className={styles.editor}
              contentEditable={!headlineMode}
              suppressContentEditableWarning
              spellCheck={!headlineMode}
              onInput={handleEditorInput}
              data-placeholder="Add a description…"
            />
            {!headlineMode && (
              <CategoryHashtagSuggestions
                editorRef={editorRef}
                dimensions={dimensions}
                categories={categories}
                onPick={cat => handleCategoryChange({ ...assignments, [cat.dimensionId]: cat.id })}
              />
            )}
            {headlineMode && (
              <div className={styles.headlineOverlay} onClick={() => setHeadlineMode(false)}>
                {wordRects.map((w, i) => (
                  <button
                    key={i}
                    className={styles.wordBtn}
                    style={{ top: w.top, left: w.left, width: w.width, height: w.height }}
                    onClick={e => { e.stopPropagation(); handleWordClick(w.word) }}
                  />
                ))}
              </div>
            )}
          </div>
          {headlineMode && (
            <p className={styles.headlineHint}>
              Click words to build the headline. Current: <strong>{titleVal}</strong>
            </p>
          )}
        </div>

        {/* Expanded: category assignments */}
        {expanded && (
          <div className={styles.expandedSection}>
            <div className={styles.expandedHeader}>
              <span className={styles.sectionLabel}>Categories</span>
              {dimensions.length > 0 && (
                <button
                  className={styles.editCategoriesBtn}
                  onClick={() => setCategoryPickerOpen(true)}
                >
                  Edit categorization
                </button>
              )}
            </div>
            {dimensions.length === 0 && (
              <p className={styles.emptyNote}>No dimensions defined yet.</p>
            )}
            {dimensions.map(dim => {
              const cat = categoryName(dim.id)
              return (
                <div key={dim.id} className={styles.dimRow}>
                  <span className={styles.dimName}>{dim.name}</span>
                  {cat ? (
                    <span
                      className={styles.catBadge}
                      style={{ borderColor: cat.color, background: `${cat.color}18`, color: cat.color }}
                    >
                      <span className={styles.catDot} style={{ background: cat.color }} />
                      {cat.name}
                    </span>
                  ) : (
                    <span className={styles.catUnassigned}>Unassigned</span>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <CategoryAssignmentPicker
          open={categoryPickerOpen}
          dimensions={dimensions}
          categories={categories}
          selections={assignments}
          onChange={handleCategoryChange}
          onClose={() => setCategoryPickerOpen(false)}
        />

        {/* Delete confirmation overlay */}
        {confirmDelete && (
          <div className={styles.confirmOverlay}>
            <div className={styles.confirmBox}>
              <p className={styles.confirmText}>Delete <strong>"{titleVal}"</strong>? This cannot be undone.</p>
              <div className={styles.confirmActions}>
                <button className={styles.cancelBtn} onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button className={styles.dangerBtn} onClick={confirmAndDelete}>Yes, delete</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
