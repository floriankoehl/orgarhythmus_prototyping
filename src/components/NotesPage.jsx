import { useState, useRef, useEffect, useMemo } from 'react'
import styles from './NotesPage.module.css'
import { api } from '../api'
import CategoryAssignmentPicker from './CategoryAssignmentPicker'
import DimensionDropUp from './DimensionDropUp'

const DRIFT_VARIANTS = 6

function makeColorCursor(color) {
  const safeColor = /^#[0-9a-f]{3,8}$/i.test(String(color)) ? color : '#1a73e8'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="9" cy="9" r="7" fill="${safeColor}" stroke="white" stroke-width="2"/><path d="M14 14l8 8" stroke="black" stroke-width="2.5" stroke-linecap="round"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 9 9, pointer`
}

function deriveTitle(text) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 7).join(' ') || ''
}

function stripHtml(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function PaletteIcon({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" stroke="none"/>
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" stroke="none"/>
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" stroke="none"/>
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" stroke="none"/>
      <path d="M12 22a10 10 0 1 1 10-10c0 2.2-1.8 4-4 4h-1.5a2 2 0 0 0-1.7 3l.2.4A1.8 1.8 0 0 1 13.4 22H12z"/>
    </svg>
  )
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
function PostIt({
  note,
  position,
  size,
  isMergeTarget,
  backgroundColor,
  interactionMode,
  paintCat,
  onPaint,
  onDragStart,
  onCollapse,
  onOpen,
  onSplit,
  onResize,
  onRegisterCard,
  onInlineUpdate,
}) {
  const [cutY, setCutY]               = useState(null) // px from top of card
  const [cutOffset, setCutOffset]     = useState(null) // char index in snippet text
  const [inlineEditing, setInlineEditing] = useState(false)
  const [draftTitle, setDraftTitle]   = useState(note.title || '')
  const [draftText, setDraftText]     = useState('')
  const cardRef  = useRef(null)
  const bodyRef  = useRef(null)
  const titleEditRef = useRef(null)
  const lineBreaksRef = useRef(null)

  const snippet = stripHtml(note.html || '')
  const splitActive = interactionMode === 'scissor'

  useEffect(() => {
    onRegisterCard?.(note.id, cardRef.current)
    return () => onRegisterCard?.(note.id, null)
  }, [note.id, onRegisterCard])

  useEffect(() => {
    if (inlineEditing) return
    setDraftTitle(note.title || '')
    setDraftText(snippet)
  }, [inlineEditing, note.title, snippet])

  // Compute paragraph-based line break positions relative to body element
  const buildLineBreaks = () => {
    const body = bodyRef.current
    if (!body) return []
    const textNode = body.firstChild
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return []
    const text = textNode.textContent
    const bodyRect = body.getBoundingClientRect()
    const breaks = []
    let idx = 0
    while (idx < text.length) {
      const nl = text.indexOf('\n', idx)
      if (nl === -1) break
      const range = document.createRange()
      range.setStart(textNode, nl)
      range.setEnd(textNode, nl + 1)
      const rects = range.getClientRects()
      if (rects.length > 0) {
        breaks.push({ relBottom: rects[0].bottom - bodyRect.top, charOffset: nl + 1 })
      }
      idx = nl + 1
    }
    return breaks
  }

  useEffect(() => {
    if (splitActive) {
      // defer so the body is rendered first
      setTimeout(() => { lineBreaksRef.current = buildLineBreaks() }, 0)
    } else {
      lineBreaksRef.current = null
      setCutY(null)
      setCutOffset(null)
    }
  }, [splitActive, snippet]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!splitActive) return
    const handler = e => { if (e.key === 'Escape') { setCutY(null); setCutOffset(null) } }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [splitActive])

  useEffect(() => {
    if (!inlineEditing) return
    requestAnimationFrame(() => titleEditRef.current?.focus())
  }, [inlineEditing])

  const handleMouseMove = (e) => {
    if (!splitActive || !lineBreaksRef.current) return
    const card = cardRef.current
    const body = bodyRef.current
    if (!card || !body) return

    const cardRect = card.getBoundingClientRect()
    const relX = e.clientX - cardRect.left
    if (relX > 56) { setCutY(null); setCutOffset(null); return }

    const bodyRect = body.getBoundingClientRect()
    const mouseRelBody = e.clientY - bodyRect.top

    let best = null, bestDist = Infinity
    for (const lb of lineBreaksRef.current) {
      const d = Math.abs(mouseRelBody - lb.relBottom)
      if (d < bestDist) { bestDist = d; best = lb }
    }

    if (best && bestDist < 24) {
      setCutY(best.relBottom + (bodyRect.top - cardRect.top))
      setCutOffset(best.charOffset)
    } else {
      setCutY(null)
      setCutOffset(null)
    }
  }

  const handleResizeDown = (e) => {
    e.stopPropagation()
    e.preventDefault()
    const card = cardRef.current
    if (!card) return
    const startX = e.clientX
    const startY = e.clientY
    const startW = card.offsetWidth
    const startH = card.offsetHeight
    const onMove = ev => {
      const cardRect = card.getBoundingClientRect()
      const maxW = Math.max(220, window.innerWidth - cardRect.left - 24)
      const maxH = Math.max(120, window.innerHeight - cardRect.top - 24)
      const nextW = Math.min(maxW, Math.max(180, startW + ev.clientX - startX))
      const nextH = Math.min(maxH, Math.max(80, startH + ev.clientY - startY))
      onResize?.(nextW, nextH)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const handleClick = (e) => {
    if (paintCat) {
      e.stopPropagation()
      onPaint?.(note.id)
      return
    }
    if (splitActive && cutY !== null && cutOffset !== null) {
      e.stopPropagation()
      const part1 = snippet.slice(0, cutOffset).trimEnd()
      const part2 = snippet.slice(cutOffset).trimStart()
      onSplit?.(part1, part2)
    }
  }

  const startInlineEdit = () => {
    setDraftTitle(note.title || '')
    setDraftText(snippet)
    setInlineEditing(true)
  }

  const commitInlineEdit = async () => {
    if (!inlineEditing) return
    const nextTitle = draftTitle.trim() || deriveTitle(draftText) || 'Untitled'
    const nextHtml = draftText.replace(/\n/g, '<br>')
    setInlineEditing(false)
    if (nextTitle === (note.title || '') && nextHtml === (note.html || '')) return
    try {
      await onInlineUpdate?.(note.id, { title: nextTitle, html: nextHtml })
    } catch (e) {
      console.error('Inline note update failed', e)
      setInlineEditing(true)
    }
  }

  const cancelInlineEdit = () => {
    setDraftTitle(note.title || '')
    setDraftText(snippet)
    setInlineEditing(false)
  }

  const handleDoubleClick = (e) => {
    e.stopPropagation()
    if (paintCat || splitActive) return
    if (interactionMode === 'edit') {
      startInlineEdit()
      return
    }
    onOpen()
  }

  return (
    <div
      ref={cardRef}
      className={`${styles.postit} ${isMergeTarget ? styles.postitMergeTarget : ''} ${splitActive ? styles.postitSplitMode : ''}`}
      style={{ left: position.x, top: position.y, backgroundColor, ...(size ? { width: size.w, height: size.h } : {}) }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onBlurCapture={e => {
        if (!inlineEditing) return
        if (e.currentTarget.contains(e.relatedTarget)) return
        commitInlineEdit()
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => { if (splitActive) { setCutY(null); setCutOffset(null) } }}
    >
      <div className={styles.postitHeader} onPointerDown={paintCat || inlineEditing ? undefined : onDragStart}>
        {inlineEditing ? (
          <input
            ref={titleEditRef}
            className={styles.inlineTitleInput}
            value={draftTitle}
            onChange={e => setDraftTitle(e.target.value)}
            onPointerDown={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitInlineEdit() }
              if (e.key === 'Escape') { e.preventDefault(); cancelInlineEdit() }
            }}
            placeholder="Untitled"
          />
        ) : (
          <span className={styles.postitTitle}>{note.title || 'Untitled'}</span>
        )}
        <button className={styles.postitClose} title="Collapse" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onCollapse() }}>×</button>
      </div>

      {inlineEditing ? (
        <textarea
          ref={bodyRef}
          className={styles.inlineBodyInput}
          value={draftText}
          onChange={e => setDraftText(e.target.value)}
          onPointerDown={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commitInlineEdit() }
            if (e.key === 'Escape') { e.preventDefault(); cancelInlineEdit() }
          }}
          placeholder="Description..."
        />
      ) : (
        snippet && <p ref={bodyRef} className={styles.postitBody}>{snippet}</p>
      )}

      <div className={styles.resizeHandle} onPointerDown={handleResizeDown}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <circle cx="9" cy="9" r="1.2"/><circle cx="5.5" cy="9" r="1.2"/><circle cx="9" cy="5.5" r="1.2"/>
          <circle cx="2" cy="9" r="1.2"/><circle cx="5.5" cy="5.5" r="1.2"/><circle cx="9" cy="2" r="1.2"/>
        </svg>
      </div>

      {splitActive && cutY !== null && (
        <div className={styles.cutLine} style={{ top: cutY }}>
          <svg className={styles.cutScissor} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
            <line x1="20" y1="4" x2="8.12" y2="15.88"/>
            <line x1="14.47" y1="14.48" x2="20" y2="20"/>
            <line x1="8.12" y1="8.12" x2="12" y2="12"/>
          </svg>
          <div className={styles.cutDash} />
        </div>
      )}
    </div>
  )
}

function NotesColorLegendWidget({
  dimensions,
  categories,
  colorDimId,
  categoryNoteCounts,
  onColorDimChange,
  paintCat,
  onPaintActivate,
  onExpandCategory,
  expanded,
  onExpandedChange,
}) {
  const legendCats = categories.filter(c => c.dimensionId === colorDimId)
  return (
    <div className={styles.legendWidget} onClick={e => e.stopPropagation()}>
      {expanded && (
        <div className={styles.legendPanel}>
          {legendCats.map(cat => (
            <div
              key={cat.id}
              className={styles.legendItem}
            >
              <button
                className={styles.legendPaintArea}
                onClick={() => onPaintActivate(cat.id, cat.color)}
                title="Click notes to assign this category"
              >
                <span className={styles.legendDot} style={{ background: cat.color }} />
                <span className={styles.legendName}>{cat.name}</span>
              </button>
              <button
                className={styles.legendExpandBtn}
                onClick={() => onExpandCategory(cat.id)}
                disabled={(categoryNoteCounts[cat.id] ?? 0) === 0}
                title="Open matching notes on canvas"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H3v5" />
                  <path d="M16 3h5v5" />
                  <path d="M8 21H3v-5" />
                  <path d="M16 21h5v-5" />
                  <path d="M3 3l7 7" />
                  <path d="M21 3l-7 7" />
                  <path d="M3 21l7-7" />
                  <path d="M21 21l-7-7" />
                </svg>
              </button>
            </div>
          ))}
          {colorDimId && legendCats.length === 0 && (
            <div className={styles.legendEmpty}>No categories</div>
          )}
          <DimensionDropUp
            dimensions={dimensions}
            value={colorDimId}
            onChange={onColorDimChange}
            emptyLabel="Color legend"
          />
        </div>
      )}

      <button
        className={`${styles.legendToggleBtn} ${expanded ? styles.legendToggleActive : ''}`}
        onClick={() => onExpandedChange(!expanded)}
        title={expanded ? 'Collapse legend' : 'Color legend'}
      >
        <PaletteIcon size={16} />
      </button>
      {!expanded && (
        <span className={styles.floatingHint}>
          <strong>Color dimension</strong>
          <small>Color notes</small>
        </span>
      )}
    </div>
  )
}

function ModeControls({ mode, onModeChange }) {
  const modes = [
    {
      id: 'edit',
      label: 'Edit',
      title: 'Edit mode: double-click a note to edit title and description inline',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
      ),
    },
    {
      id: 'scissor',
      label: 'Scissor',
      title: 'Scissor mode: click the left edge of a note at a line break to split it',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <line x1="20" y1="4" x2="8.12" y2="15.88" />
          <line x1="14.47" y1="14.48" x2="20" y2="20" />
          <line x1="8.12" y1="8.12" x2="12" y2="12" />
        </svg>
      ),
    },
    {
      id: 'merge',
      label: 'Merge',
      title: 'Merge mode: drag one note over another to merge them',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="7" height="7" rx="1.5" />
          <rect x="14" y="12" width="7" height="7" rx="1.5" />
          <path d="M10 8.5h4" />
          <path d="M12.5 6l3 2.5-3 2.5" />
        </svg>
      ),
    },
  ]

  return (
    <div className={styles.modeControls} aria-label="Canvas interaction mode">
      {modes.map(item => (
        <button
          key={item.id}
          className={`${styles.modeBtn} ${mode === item.id ? styles.modeBtnActive : ''}`}
          onClick={() => onModeChange(item.id)}
          title={item.title}
          aria-label={item.title}
          aria-pressed={mode === item.id}
        >
          {item.icon}
        </button>
      ))}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function NotesPage({ notes, onNoteCreated, onNoteOpen, onNoteUpdated, onRefresh, refreshKey = 0 }) {
  // Canvas state
  const [openNoteIds, setOpenNoteIds]       = useState(new Set())
  const [notePositions, setNotePositions]   = useState({})
  const [mergeCandidate, setMergeCandidate] = useState(null)
  const [mergeProposal, setMergeProposal]   = useState(null)
  const [noteSizes, setNoteSizes]           = useState({}) // { [id]: { w, h } }

  // Drag
  const draggingRef   = useRef(null)
  const wasDraggedRef = useRef(false)
  const canvasRef     = useRef(null)
  const cardRefs      = useRef({})

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
  const [allAssignments, setAllAssignments] = useState([])
  const [colorDimId, setColorDimId] = useState('')
  const [paintCat, setPaintCat] = useState(null)
  const [floatingPanel, setFloatingPanel] = useState(null)
  const [interactionMode, setInteractionMode] = useState('edit')

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

  // ── Load category metadata ──────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([api.getDimensions(), api.getAllCategories(), api.getAssignments()])
      .then(([dims, cats, asns]) => {
        setDimensions(dims)
        setCategories(cats)
        setAllAssignments(asns)
      })
      .catch(console.error)
  }, [refreshKey])

  useEffect(() => {
    if (colorDimId && !dimensions.some(d => d.id === colorDimId)) {
      setColorDimId('')
      setPaintCat(null)
    }
  }, [colorDimId, dimensions])

  const changeColorDim = dimId => {
    setColorDimId(dimId)
    setPaintCat(null)
  }

  const activatePaint = (catId, color) => {
    setPaintCat(prev => prev?.id === catId ? null : { id: catId, color })
  }

  const changeInteractionMode = mode => {
    setInteractionMode(mode)
    setMergeCandidate(null)
    setMergeProposal(null)
  }

  const paintNote = async noteId => {
    if (!paintCat || !colorDimId) return
    try {
      await api.assign(noteId, colorDimId, paintCat.id)
      setAllAssignments(prev => [
        ...prev.filter(a => !(a.noteId === noteId && a.dimensionId === colorDimId)),
        { noteId, dimensionId: colorDimId, categoryId: paintCat.id },
      ])
    } catch (e) {
      console.error(e)
    }
  }

  const categoryNoteCounts = useMemo(() => {
    const counts = {}
    if (!colorDimId) return counts
    allAssignments.forEach(a => {
      if (a.dimensionId !== colorDimId) return
      counts[a.categoryId] = (counts[a.categoryId] ?? 0) + 1
    })
    return counts
  }, [allAssignments, colorDimId])

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

  const layoutNotesOnCanvas = noteIds => {
    if (noteIds.length === 0) return
    const canvas = canvasRef.current
    const w = canvas?.offsetWidth || 900
    const h = canvas?.offsetHeight || 640
    const cardW = 240
    const cardH = 150
    const marginX = 48
    const top = 72
    const bottomReserve = 220
    const usableW = Math.max(cardW, w - marginX * 2 - cardW)
    const usableH = Math.max(cardH, h - top - bottomReserve - cardH)
    const cols = Math.max(1, Math.min(noteIds.length, Math.ceil(Math.sqrt(noteIds.length * (usableW / Math.max(usableH, 1))))))
    const rows = Math.ceil(noteIds.length / cols)
    const xStep = cols > 1 ? usableW / (cols - 1) : 0
    const yStep = rows > 1 ? usableH / (rows - 1) : 0
    const nextPositions = {}

    noteIds.forEach((noteId, idx) => {
      const row = Math.floor(idx / cols)
      const col = idx % cols
      const rowCount = row === rows - 1 ? noteIds.length - row * cols : cols
      const rowOffset = rowCount < cols ? ((cols - rowCount) * xStep) / 2 : 0
      nextPositions[noteId] = {
        x: Math.round(marginX + rowOffset + col * xStep),
        y: Math.round(top + row * yStep),
      }
    })

    setOpenNoteIds(prev => new Set([...prev, ...noteIds]))
    setNotePositions(prev => ({ ...prev, ...nextPositions }))
  }

  const expandCategoryOnCanvas = catId => {
    if (!colorDimId) return
    const noteIds = notes
      .filter(note => allAssignments.some(a =>
        a.noteId === note.id &&
        a.dimensionId === colorDimId &&
        a.categoryId === catId
      ))
      .map(note => note.id)
    layoutNotesOnCanvas(noteIds)
  }

  const expandSearchResultsOnCanvas = () => {
    layoutNotesOnCanvas(findResults.map(note => note.id))
    setFindFocused(false)
  }

  const collapseNote = (id) => {
    setOpenNoteIds(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const clearCanvas = () => {
    setOpenNoteIds(new Set())
    setMergeCandidate(null)
    setMergeProposal(null)
  }

  const handleInlineUpdate = async (noteId, patch) => {
    await api.updateNote(noteId, patch)
    onNoteUpdated?.(noteId, patch)
  }

  // ── Merge ────────────────────────────────────────────────────────────────────
  const confirmMerge = async () => {
    if (!mergeProposal) return
    const { sourceId, targetId } = mergeProposal
    setMergeProposal(null)
    const src = notes.find(n => n.id === sourceId)
    const tgt = notes.find(n => n.id === targetId)
    if (!src || !tgt) return

    const mergedHtml = (tgt.html || tgt.title || '') +
      `<br><br><br><strong>${src.title || 'Untitled'}</strong><br>${src.html || ''}`

    try {
      await api.updateNote(targetId, { title: tgt.title, html: mergedHtml })
      await api.deleteNote(sourceId)
      setOpenNoteIds(prev => { const n = new Set(prev); n.delete(sourceId); return n })
      onRefresh?.()
    } catch (e) {
      console.error('Merge failed', e)
    }
  }

  // ── Split ────────────────────────────────────────────────────────────────────
  const handleSplitNote = async (noteId, text1, text2) => {
    const original = notes.find(n => n.id === noteId)
    if (!original) return
    const title2 = deriveTitle(text2) || 'Untitled'
    try {
      await api.updateNote(noteId, { html: text1, title: original.title })
      const newId = crypto.randomUUID()
      await api.createNote({ id: newId, html: text2, title: title2, collapsed: false })
      const base = notePositions[noteId] || randomPos()
      setNotePositions(prev => ({ ...prev, [newId]: { x: base.x + 260, y: base.y + 20 } }))
      setOpenNoteIds(prev => new Set([...prev, newId]))
      onRefresh?.()
    } catch (e) {
      console.error('Split failed', e)
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

  const registerCard = (id, el) => {
    if (el) cardRefs.current[id] = el
    else delete cardRefs.current[id]
  }

  const findMergeCandidate = (dragId, dragPos) => {
    const draggedEl = cardRefs.current[dragId]
    const draggedSize = {
      width: draggedEl?.offsetWidth || 240,
      height: draggedEl?.offsetHeight || 150,
    }
    const dragRect = {
      left: dragPos.x,
      top: dragPos.y,
      right: dragPos.x + draggedSize.width,
      bottom: dragPos.y + draggedSize.height,
      width: draggedSize.width,
      height: draggedSize.height,
    }

    let best = null
    let bestArea = 0
    for (const otherId of openNoteIds) {
      if (otherId === dragId) continue
      const otherEl = cardRefs.current[otherId]
      const otherPos = notePositions[otherId]
      if (!otherEl || !otherPos) continue
      const otherRect = {
        left: otherPos.x,
        top: otherPos.y,
        right: otherPos.x + otherEl.offsetWidth,
        bottom: otherPos.y + otherEl.offsetHeight,
        width: otherEl.offsetWidth,
        height: otherEl.offsetHeight,
      }
      const overlapW = Math.min(dragRect.right, otherRect.right) - Math.max(dragRect.left, otherRect.left)
      const overlapH = Math.min(dragRect.bottom, otherRect.bottom) - Math.max(dragRect.top, otherRect.top)
      if (overlapW <= 0 || overlapH <= 0) continue

      const overlapArea = overlapW * overlapH
      const smallerArea = Math.min(dragRect.width * dragRect.height, otherRect.width * otherRect.height)
      const overlapRatio = overlapArea / Math.max(smallerArea, 1)
      if (overlapRatio < 0.18 || overlapW < 48 || overlapH < 36) continue
      if (overlapArea > bestArea) {
        best = otherId
        bestArea = overlapArea
      }
    }
    return best
  }

  const handlePointerMove = (e) => {
    if (!draggingRef.current) return
    const { id, startX, startY, origX, origY } = draggingRef.current
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) wasDraggedRef.current = true
    if (!wasDraggedRef.current) return

    const newPos = { x: origX + dx, y: origY + dy }
    setNotePositions(prev => ({ ...prev, [id]: newPos }))
    if (interactionMode === 'merge') {
      setMergeCandidate(findMergeCandidate(id, newPos))
    } else {
      setMergeCandidate(null)
    }
  }

  const handlePointerUp = () => {
    const { id } = draggingRef.current || {}
    draggingRef.current = null

    if (interactionMode === 'merge' && id && mergeCandidate && wasDraggedRef.current) {
      const pos = notePositions[id] || { x: 200, y: 200 }
      setMergeProposal({ sourceId: id, targetId: mergeCandidate, x: pos.x + 130, y: pos.y + 70 })
      setMergeCandidate(null)
    } else {
      setMergeCandidate(null)
    }

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
    <div
      className={`${styles.note} ${paintCat ? styles.paintMode : ''}`}
      style={paintCat ? { cursor: makeColorCursor(paintCat.color) } : undefined}
      onClick={paintCat ? () => setPaintCat(null) : undefined}
    >

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
          const noteAsns = allAssignments.filter(a => a.noteId === id)
          const colorCatId = colorDimId ? noteAsns.find(a => a.dimensionId === colorDimId)?.categoryId : null
          const noteBackground = colorCatId ? categories.find(c => c.id === colorCatId)?.color ?? '#fff' : '#fff'
          return (
            <PostIt
              key={id}
              note={note}
              position={pos}
              size={noteSizes[id] || null}
              isMergeTarget={mergeCandidate === id}
              backgroundColor={noteBackground}
              interactionMode={interactionMode}
              onDragStart={e => handlePointerDown(e, id)}
              onCollapse={() => collapseNote(id)}
              onOpen={() => { if (!wasDraggedRef.current) onNoteOpen?.(id) }}
              onSplit={(t1, t2) => handleSplitNote(id, t1, t2)}
              onResize={(w, h) => setNoteSizes(prev => ({ ...prev, [id]: { w, h } }))}
              onRegisterCard={registerCard}
              onInlineUpdate={handleInlineUpdate}
              paintCat={paintCat}
              onPaint={paintNote}
            />
          )
        })}
      </div>

      <div className={styles.floatingModeTools}>
        <ModeControls mode={interactionMode} onModeChange={changeInteractionMode} />
      </div>

      <div className={styles.floatingViewTools}>
        <button
          className={styles.clearCanvasBtn}
          onClick={clearCanvas}
          disabled={openNoteIds.size === 0}
          title="Clear canvas"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="5" width="9" height="7" rx="1.5" />
            <rect x="7" y="10" width="9" height="7" rx="1.5" />
            <path d="M15 6h5v5" />
            <path d="M20 6l-6 6" />
          </svg>
        </button>
        <NotesColorLegendWidget
          dimensions={dimensions}
          categories={categories}
          colorDimId={colorDimId}
          categoryNoteCounts={categoryNoteCounts}
          onColorDimChange={changeColorDim}
          paintCat={paintCat}
          onPaintActivate={activatePaint}
          onExpandCategory={expandCategoryOnCanvas}
          expanded={floatingPanel === 'color'}
          onExpandedChange={open => setFloatingPanel(open ? 'color' : null)}
        />
      </div>

      {/* Merge proposal dialog */}
      {mergeProposal && (
        <div className={styles.mergeDialog} style={{ left: mergeProposal.x, top: mergeProposal.y }}>
          <span className={styles.mergeDialogText}>Merge notes?</span>
          <button className={styles.mergeDialogConfirm} onClick={confirmMerge}>Merge</button>
          <button className={styles.mergeDialogCancel} onClick={() => setMergeProposal(null)}>Cancel</button>
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
            ) : (
              <>
                <button
                  className={styles.findExpandAll}
                  onMouseDown={e => e.preventDefault()}
                  onClick={expandSearchResultsOnCanvas}
                  title="Open all matching notes on canvas"
                >
                  <span>Expand all matches</span>
                  <span className={styles.findBadge}>{findResults.length}</span>
                </button>
                {findResults.map(note => (
                  <button key={note.id}
                    className={`${styles.findResult} ${openNoteIds.has(note.id) ? styles.findResultOpen : ''}`}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => { openOnCanvas(note.id); setFindQuery(''); setFindFocused(false) }}>
                    <span>{note.title || 'Untitled'}</span>
                    {openNoteIds.has(note.id) && <span className={styles.findBadge}>on canvas</span>}
                  </button>
                ))}
              </>
            )}
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
