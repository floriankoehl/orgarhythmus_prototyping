import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import styles from './NotePopup.module.css'
import { api } from '../api'
import CategoryAssignmentPicker from './CategoryAssignmentPicker'
import CategoryHashtagSuggestions from './CategoryHashtagSuggestions'
import PersonaAvatarStack from './PersonaAvatarStack'
import { mergeSelectionsWithHashtags } from '../categoryHashtags'
import { playSound } from '../sounds/sound_registry'

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

function ChildNotesPreview({ note, notes = [], isProjectRootNote = false, onNoteOpen }) {
  const [checked, setChecked] = useState({})
  const children = notes
    .filter(item => item.parentNoteId === note.id)
    .sort((a, b) => (a.orderIdx ?? 0) - (b.orderIdx ?? 0))

  useEffect(() => {
    setChecked({})
  }, [note.id])

  return (
    <div className={styles.childrenSection}>
      <div className={styles.childrenHeader}>
        <span className={styles.sectionLabel}>{isProjectRootNote ? 'Child notes' : 'Subnotes'}</span>
        <span className={styles.childrenCount}>{children.length}</span>
      </div>
      {children.length === 0 ? (
        <p className={styles.emptyNote}>No child notes.</p>
      ) : (
        <div className={styles.childrenList}>
          {children.map(child => {
            const isChecked = Boolean(checked[child.id])
            return (
              <div key={child.id} className={styles.childRow}>
                {isProjectRootNote ? (
                  <span className={styles.childBullet} />
                ) : (
                  <input
                    className={styles.childCheckbox}
                    type="checkbox"
                    checked={isChecked}
                    onChange={e => setChecked(prev => ({ ...prev, [child.id]: e.target.checked }))}
                  />
                )}
                <button
                  type="button"
                  className={`${styles.childTitle} ${isChecked ? styles.childTitleChecked : ''}`}
                  onClick={() => onNoteOpen?.(child.id)}
                  title="Open child note">
                  {child.title || 'Untitled'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main popup ────────────────────────────────────────────────────────────────
export default function NotePopup({ note, notes = [], isProjectRootNote = false, onClose, onNoteUpdated, onAssignmentsChanged, onPeopleChanged, onNoteDeleted, onNoteOpen, onOpenAsWorkspace }) {
  const [expanded, setExpanded]           = useState(false)
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false)
  const [headlineMode, setHeadlineMode]   = useState(false)
  const [wordRects, setWordRects]         = useState([])
  const [headlineStarted, setHeadlineStarted] = useState(false)
  const [editingTitle, setEditingTitle]   = useState(false)
  const [titleVal, setTitleVal]           = useState(note.title)
  const [confirmDelete, setConfirmDelete] = useState(false)

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

  // Keep note title in sync if parent updates note
  useEffect(() => { setTitleVal(note.title) }, [note.title])

  useEffect(() => {
    setCategoryPickerOpen(false)
  }, [note.id])

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

        <ChildNotesPreview
          note={note}
          notes={notes}
          isProjectRootNote={isProjectRootNote}
          onNoteOpen={childId => {
            onClose()
            requestAnimationFrame(() => onNoteOpen?.(childId))
          }}
        />

        {/* Description section */}
        <div className={styles.descSection}>
          <div className={styles.descHeader}>
            <span className={styles.sectionLabel}>Description</span>
            <button
              className={`${styles.headlineBtn} ${headlineMode ? styles.headlineBtnActive : ''}`}
              onClick={headlineMode ? () => { playSound('settingToggle'); setHeadlineMode(false) } : () => { playSound('settingToggle'); enterHeadlineMode() }}
              title={headlineMode ? 'Exit headline mode (Esc)' : 'Pick headline words from description'}
            >
              <TagIcon />
              {headlineMode ? 'Exit headline mode' : 'Headline mode'}
            </button>
          </div>
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
