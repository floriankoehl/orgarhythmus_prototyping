import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import styles from './NotePopup.module.css'
import { api } from '../api'
import CategoryAssignmentPicker from './CategoryAssignmentPicker'

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

// ── Main popup ────────────────────────────────────────────────────────────────
export default function NotePopup({ note, onClose, onNoteUpdated, onNoteDeleted }) {
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

  const editorRef      = useRef(null)
  const popupRef       = useRef(null)
  const titleInputRef  = useRef(null)
  const saveTimerRef   = useRef(null)

  // Keep note title in sync if parent updates note
  useEffect(() => { setTitleVal(note.title) }, [note.title])

  useEffect(() => {
    setCategoryPickerOpen(false)
  }, [expanded, note.id])

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

  // Fetch dimension/category/assignment data when expanded
  useEffect(() => {
    if (!expanded) return
    Promise.all([api.getDimensions(), api.getAllCategories(), api.getAssignments()])
      .then(([dims, cats, asns]) => {
        setDimensions(dims)
        setCategories(cats)
        // asns is array of { noteId, dimensionId, categoryId }
        const myAsns = asns.filter(a => a.noteId === note.id)
        const map = {}
        myAsns.forEach(a => { map[a.dimensionId] = a.categoryId })
        setAssignments(map)
      })
      .catch(console.error)
  }, [expanded, note.id])

  // ── Title commit ──────────────────────────────────────────────────────────
  const commitTitle = useCallback(async (val) => {
    const trimmed = val.trim() || 'Untitled'
    setTitleVal(trimmed)
    setEditingTitle(false)
    try {
      await api.updateNote(note.id, { title: trimmed })
      onNoteUpdated?.(note.id, { title: trimmed })
    } catch (e) { console.error(e) }
  }, [note.id, onNoteUpdated])

  // ── Description save (debounced 600ms) ───────────────────────────────────
  const saveHtml = useCallback((html) => {
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
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
      onNoteDeleted?.(note.id)
      onClose()
    } catch (e) { console.error(e) }
  }

  const categoryName = (dimId) => {
    const catId = assignments[dimId]
    if (!catId) return null
    return categories.find(c => c.id === catId)
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
        try { await api.unassign(note.id, dimId) }
        catch (e) { console.error(e); setAssignments(old) }
      } else {
        setAssignments(prev => ({ ...prev, [dimId]: newCat }))
        try { await api.assign(note.id, dimId, newCat) }
        catch (e) { console.error(e); setAssignments(old) }
      }
      break
    }
  }

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
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
                onDoubleClick={() => setEditingTitle(true)}
                title="Double-click to edit"
              >
                {titleVal}
              </h2>
            )}
          </div>
          <div className={styles.headerActions}>
            <button
              className={styles.expandBtn}
              onClick={() => setExpanded(e => !e)}
              title={expanded ? 'Collapse' : 'Show categories'}
            >
              <ChevronIcon down={expanded} />
              {expanded ? 'Less' : 'More'}
            </button>
            <button className={styles.deleteBtn} onClick={() => setConfirmDelete(true)} title="Delete note">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
            </button>
            <button className={styles.closeBtn} onClick={onClose} title="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Description section */}
        <div className={styles.descSection}>
          <div className={styles.descHeader}>
            <span className={styles.sectionLabel}>Description</span>
            <button
              className={`${styles.headlineBtn} ${headlineMode ? styles.headlineBtnActive : ''}`}
              onClick={headlineMode ? () => setHeadlineMode(false) : enterHeadlineMode}
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
              onInput={e => saveHtml(e.currentTarget.innerHTML)}
              data-placeholder="Add a description…"
            />
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
