import { useState, useRef, useEffect, useMemo } from 'react'
import styles from './BrainstormV2.module.css'
import { api } from '../api'
import CategoryAssignmentPicker from './CategoryAssignmentPicker'

const DRIFT_VARIANTS = 6

function deriveTitle(text) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 7).join(' ') || ''
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

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
      const rect = range.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0)
        result.push({ word: m[0], top: rect.top - base.top, left: rect.left - base.left, width: rect.width, height: rect.height })
    }
  }
  return result
}

// ── PostIt card ───────────────────────────────────────────────────────────────
function PostIt({ note, position, selected, onDragStart, onCollapse, onSelect, onOpen }) {
  const snippet = stripHtml(note.html || '')
  return (
    <div
      className={`${styles.postit} ${selected ? styles.postitSelected : ''}`}
      style={{ left: position.x, top: position.y }}
      onClick={onSelect}
      onDoubleClick={e => { e.stopPropagation(); onOpen() }}
    >
      <div className={styles.postitHeader} onPointerDown={onDragStart}>
        <div className={`${styles.selectDot} ${selected ? styles.selectDotOn : ''}`} />
        <span className={styles.postitTitle}>{note.title || 'Untitled'}</span>
        <button className={styles.postitClose} title="Collapse" onClick={e => { e.stopPropagation(); onCollapse() }}>×</button>
      </div>
      {snippet && <p className={styles.postitBody}>{snippet}</p>}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function BrainstormV2({ notes, onNoteCreated, onNoteOpen, onRefresh }) {
  // Canvas state
  const [openNoteIds, setOpenNoteIds] = useState(new Set())
  const [notePositions, setNotePositions]   = useState({})
  const [selectedIds, setSelectedIds]       = useState(new Set())

  // Drag
  const draggingRef   = useRef(null)
  const wasDraggedRef = useRef(false)
  const canvasRef     = useRef(null)

  // Canvas search
  const [findQuery, setFindQuery] = useState('')
  const [findFocused, setFindFocused] = useState(false)
  const findWrapRef = useRef(null)

  // Add-mode state
  const [titleVal, setTitleVal]         = useState('')
  const [titleManual, setTitleManual]   = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [headlineMode, setHeadlineMode] = useState(false)
  const [wordRects, setWordRects]       = useState([])
  const [ghost, setGhost]               = useState(null)
  const [dimensions, setDimensions]     = useState([])
  const [categories, setCategories]     = useState([])
  const [categorySelections, setCategorySelections] = useState({})
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false)

  const editorRef    = useRef(null)
  const titleInputRef = useRef(null)
  const positionsRef  = useRef({}) // floating background memo

  // ── Canvas search results ─────────────────────────────────────────────────────
  const findResults = useMemo(() => {
    const q = findQuery.trim()
    if (!q) return []
    let re
    try { re = new RegExp(q, 'i') } catch { return [] }
    const titleHits = notes.filter(n => re.test(n.title || ''))
    if (titleHits.length > 0) return titleHits
    return notes.filter(n => re.test(stripHtml(n.html || '')))
  }, [findQuery, notes])

  useEffect(() => {
    if (!findFocused) return
    const handler = e => {
      if (findWrapRef.current?.contains(e.target)) return
      setFindFocused(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [findFocused])

  // ── Canvas helpers ───────────────────────────────────────────────────────────
  const randomPos = () => {
    const w = (canvasRef.current?.offsetWidth  || 800)
    const h = (canvasRef.current?.offsetHeight || 600)
    return {
      x: 40  + Math.random() * Math.max(w - 320, 100),
      y: 40  + Math.random() * Math.max(h - 240, 100),
    }
  }

  const openOnCanvas = (noteId) => {
    setOpenNoteIds(prev => {
      if (prev.has(noteId)) return prev
      const next = new Set(prev); next.add(noteId); return next
    })
    setNotePositions(prev => {
      if (prev[noteId]) return prev
      return { ...prev, [noteId]: randomPos() }
    })
  }

  const collapseNote = (id) => {
    setOpenNoteIds(prev => { const n = new Set(prev); n.delete(id); return n })
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const toggleSelect = (id) => {
    if (wasDraggedRef.current) return
    setSelectedIds(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  // ── Merge ────────────────────────────────────────────────────────────────────
  const mergeSelected = async () => {
    const ids = [...selectedIds]
    if (ids.length < 2) return
    const toMerge = notes.filter(n => ids.includes(n.id))
    if (toMerge.length < 2) return

    const mergedTitle = toMerge.map(n => n.title || 'Untitled').join(' · ')
    const mergedHtml  = toMerge.map(n => n.html || n.title || '').join('<p style="color:#ccc;text-align:center;margin:8px 0">— — —</p>')

    try {
      await api.updateNote(toMerge[0].id, { title: mergedTitle, html: mergedHtml })
      await Promise.all(toMerge.slice(1).map(n => api.deleteNote(n.id)))
      const secondary = new Set(ids.slice(1))
      setOpenNoteIds(prev => { const n = new Set(prev); secondary.forEach(id => n.delete(id)); return n })
      setSelectedIds(new Set())
      onRefresh?.()
    } catch (e) {
      console.error('Merge failed', e)
    }
  }

  // ── Drag ─────────────────────────────────────────────────────────────────────
  const handlePointerDown = (e, id) => {
    if (e.button !== 0) return
    e.stopPropagation()
    wasDraggedRef.current = false
    const pos = notePositions[id] || { x: 100, y: 100 }
    draggingRef.current = { id, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e) => {
    if (!draggingRef.current) return
    const { id, startX, startY, origX, origY } = draggingRef.current
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) wasDraggedRef.current = true
    if (wasDraggedRef.current) {
      setNotePositions(prev => ({ ...prev, [id]: { x: origX + dx, y: origY + dy } }))
    }
  }

  const handlePointerUp = () => {
    draggingRef.current = null
    requestAnimationFrame(() => { wasDraggedRef.current = false })
  }

  // ── Floating background positions ─────────────────────────────────────────────
  const getPos = (noteId) => {
    if (!positionsRef.current[noteId]) {
      positionsRef.current[noteId] = {
        left:     3 + Math.random() * 87,
        top:      4 + Math.random() * 82,
        variant:  Math.floor(Math.random() * DRIFT_VARIANTS),
        duration: 38 + Math.random() * 50,
        delay:    -(Math.random() * 45),
        size:     11 + Math.random() * 10,
        opacity:  0.04 + Math.random() * 0.06,
      }
    }
    return positionsRef.current[noteId]
  }

  // ── Add-mode helpers ──────────────────────────────────────────────────────────
  const ensureCategoryData = () => {
    if (dimensions.length || categories.length) return
    Promise.all([api.getDimensions(), api.getAllCategories()])
      .then(([dims, cats]) => { setDimensions(dims); setCategories(cats) })
      .catch(console.error)
  }

  useEffect(() => {
    if (editingTitle) { titleInputRef.current?.focus(); titleInputRef.current?.select() }
  }, [editingTitle])

  useEffect(() => { editorRef.current?.focus() }, [])

  useEffect(() => {
    if (!headlineMode && !editingTitle) return
    const h = e => { if (e.key === 'Escape') { setHeadlineMode(false); setEditingTitle(false) } }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [headlineMode, editingTitle])

  const handleDescInput = () => {
    if (!titleManual && editorRef.current)
      setTitleVal(deriveTitle(editorRef.current.innerText || ''))
    if (headlineMode && editorRef.current)
      setWordRects(computeWordRects(editorRef.current))
  }

  const handleWordClick = word => {
    setTitleVal(prev => prev ? prev + ' ' + word : word)
    setTitleManual(true)
    titleInputRef.current?.focus()
  }

  const submit = async () => {
    const content = editorRef.current?.innerText?.trim() || ''
    if (!content) return
    const finalTitle = titleVal.trim() || deriveTitle(content) || 'Untitled'
    const html = editorRef.current?.innerHTML || ''

    const rect = editorRef.current?.getBoundingClientRect()
    if (rect) setGhost({ html, rect })
    if (editorRef.current) { editorRef.current.innerHTML = ''; editorRef.current.focus() }
    setTitleVal('')
    setTitleManual(false)
    setEditingTitle(false)
    setHeadlineMode(false)
    const selections = categorySelections
    setCategorySelections({})

    const newNote = { id: crypto.randomUUID(), html, title: finalTitle, collapsed: false }
    try {
      const saved = await api.createNote(newNote)
      await Promise.all(Object.entries(selections)
        .filter(([, catId]) => Boolean(catId))
        .map(([dimId, catId]) => api.assign(newNote.id, dimId, catId)))
      const out = saved || newNote
      openOnCanvas(out.id)
      onNoteCreated?.(out)
    } catch (e) {
      console.error('Create failed', e)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className={styles.note}>

      {/* Floating background */}
      <div className={styles.floatingLayer} aria-hidden="true">
        {notes.map(g => {
          const p = getPos(g.id)
          return (
            <span key={g.id}
              className={`${styles.floatingNote} ${styles[`drift${p.variant}`]}`}
              style={{
                left:              `${p.left}%`,
                top:               `${p.top}%`,
                fontSize:          `${p.size}px`,
                opacity:           p.opacity,
                animationDuration: `${p.duration}s`,
                animationDelay:    `${p.delay}s`,
              }}>
              {g.title}
            </span>
          )
        })}
      </div>

      {/* Canvas */}
      <div
        ref={canvasRef}
        className={styles.canvas}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {[...openNoteIds].map(id => {
          const note = notes.find(n => n.id === id)
          if (!note) return null
          const pos = notePositions[id] || { x: 100, y: 100 }
          return (
            <PostIt
              key={id}
              note={note}
              position={pos}
              selected={selectedIds.has(id)}
              onDragStart={e => handlePointerDown(e, id)}
              onCollapse={() => collapseNote(id)}
              onSelect={() => toggleSelect(id)}
              onOpen={() => { if (!wasDraggedRef.current) { setSelectedIds(new Set()); onNoteOpen?.(id) } }}
            />
          )
        })}
      </div>

      {/* Merge bar */}
      {selectedIds.size >= 2 && (
        <div className={styles.mergeBar}>
          <span className={styles.mergeLabel}>{selectedIds.size} selected</span>
          <button className={styles.mergeBtn} onClick={mergeSelected}>Merge</button>
          <button className={styles.mergeClear} onClick={() => setSelectedIds(new Set())}>Clear</button>
        </div>
      )}

      {/* Top-center search */}
      <div ref={findWrapRef} className={styles.canvasSearch}>
        <input
          className={styles.canvasSearchInput}
          value={findQuery}
          onChange={e => setFindQuery(e.target.value)}
          onFocus={() => setFindFocused(true)}
          onKeyDown={e => { if (e.key === 'Escape') { setFindQuery(''); setFindFocused(false) } }}
          placeholder="Search notes…"
        />
        {findFocused && findQuery.trim() && (
          <div className={styles.canvasSearchResults}>
            {findResults.length === 0 ? (
              <div className={styles.findEmpty}>No matches</div>
            ) : findResults.map(note => (
              <button key={note.id}
                className={`${styles.findResult} ${openNoteIds.has(note.id) ? styles.findResultOpen : ''}`}
                onMouseDown={e => e.preventDefault()}
                onClick={() => { openOnCanvas(note.id); setFindQuery(''); setFindFocused(false) }}>
                <span>{note.title || 'Untitled'}</span>
                {openNoteIds.has(note.id) && <span className={styles.findBadge}>on canvas</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Bottom card */}
      <div className={styles.center}>
        <div className={styles.titleRow}>
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className={styles.titleEditInput}
              value={titleVal}
              onChange={e => { setTitleVal(e.target.value); setTitleManual(true) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
              placeholder="Title…"
            />
          ) : (
            <div className={styles.titleDisplay} onClick={() => { setEditingTitle(true); setHeadlineMode(true); if (editorRef.current) setWordRects(computeWordRects(editorRef.current)) }}>
              <span className={titleVal ? styles.titleText : styles.titlePlaceholder}>{titleVal || 'Title…'}</span>
              <svg className={styles.editIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </div>
          )}
        </div>

        <div className={styles.editorWrap}>
          <div
            ref={editorRef}
            className={styles.editor}
            contentEditable={!headlineMode}
            suppressContentEditableWarning
            data-placeholder="define notes…"
            onInput={handleDescInput}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          />
          {headlineMode && (
            <div className={styles.overlay} onClick={() => { setHeadlineMode(false); setEditingTitle(false) }}>
              {wordRects.map((w, i) => (
                <button key={i} className={styles.wordBtn}
                  style={{ top: w.top, left: w.left, width: w.width, height: w.height }}
                  onMouseDown={e => e.preventDefault()}
                  onClick={e => { e.stopPropagation(); handleWordClick(w.word) }}
                />
              ))}
            </div>
          )}
        </div>

        <div className={styles.actions}>
          <button className={styles.categoryBtn} onClick={() => { ensureCategoryData(); setCategoryPickerOpen(true) }}>
            Categories
          </button>
          <button className={styles.submitBtn} onClick={submit}>add ↵</button>
        </div>
      </div>

      <CategoryAssignmentPicker
        open={categoryPickerOpen}
        dimensions={dimensions}
        categories={categories}
        selections={categorySelections}
        onChange={setCategorySelections}
        onClose={() => setCategoryPickerOpen(false)}
      />

      {ghost && (
        <div
          className={styles.floatGhost}
          style={{ left: ghost.rect.left, top: ghost.rect.top, width: ghost.rect.width, height: ghost.rect.height }}
          dangerouslySetInnerHTML={{ __html: ghost.html }}
          onAnimationEnd={() => setGhost(null)}
        />
      )}
    </div>
  )
}
