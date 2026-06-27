import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import styles from './NotesPage.module.css'
import { api } from '../api'
import CategoryAssignmentPicker from './CategoryAssignmentPicker'
import CategoryHashtagSuggestions from './CategoryHashtagSuggestions'
import DimensionDropUp from './DimensionDropUp'
import { categoryMatchesForHashtags, mergeSelectionsWithHashtags } from '../categoryHashtags'
import { useProgressiveNoteSearch } from '../useProgressiveNoteSearch'

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
  selected,
  backgroundColor,
  zIndex,
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
  const [inlineEditSize, setInlineEditSize] = useState(null)
  const [draftTitle, setDraftTitle]   = useState(note.title || '')
  const [draftText, setDraftText]     = useState('')
  const cardRef  = useRef(null)
  const bodyRef  = useRef(null)
  const titleEditRef = useRef(null)
  const lineBreaksRef = useRef(null)

  const snippet = stripHtml(note.html || '')
  const splitActive = interactionMode === 'refractor'

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
      if (inlineEditing) setInlineEditSize({ w: nextW, h: nextH })
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
    const card = cardRef.current
    if (card) setInlineEditSize({ w: card.offsetWidth, h: card.offsetHeight })
    setDraftTitle(note.title || '')
    setDraftText(snippet)
    setInlineEditing(true)
  }

  const commitInlineEdit = async () => {
    if (!inlineEditing) return
    const nextTitle = draftTitle.trim() || deriveTitle(draftText) || 'Untitled'
    const nextHtml = draftText.replace(/\n/g, '<br>')
    const editSize = inlineEditSize
    setInlineEditing(false)
    setInlineEditSize(null)
    if (nextTitle === (note.title || '') && nextHtml === (note.html || '')) return
    try {
      await onInlineUpdate?.(note.id, { title: nextTitle, html: nextHtml })
    } catch (e) {
      console.error('Inline note update failed', e)
      setInlineEditSize(editSize)
      setInlineEditing(true)
    }
  }

  const cancelInlineEdit = () => {
    setDraftTitle(note.title || '')
    setDraftText(snippet)
    setInlineEditing(false)
    setInlineEditSize(null)
  }

  const handleDoubleClick = (e) => {
    e.stopPropagation()
    if (paintCat) return
    if (interactionMode === 'edit') {
      startInlineEdit()
      return
    }
    onOpen()
  }

  const renderedSize = inlineEditing && inlineEditSize ? inlineEditSize : size
  const hasAccent = backgroundColor && backgroundColor !== '#fff'

  return (
    <div
      ref={cardRef}
      className={`${styles.postit} ${isMergeTarget ? styles.postitMergeTarget : ''} ${splitActive ? styles.postitSplitMode : ''} ${selected ? styles.postitSelected : ''}`}
      style={{ left: position.x, top: position.y, zIndex, ...(renderedSize ? { width: renderedSize.w, height: renderedSize.h } : {}) }}
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
      <div
        className={styles.postitHeader}
        style={hasAccent ? { backgroundColor, borderBottomColor: backgroundColor + '55' } : undefined}
        onPointerDown={paintCat || inlineEditing ? undefined : onDragStart}
      >
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
        {!inlineEditing && interactionMode === 'edit' && (
          <>
            <button
              className={styles.postitOpenBtn}
              title="Edit inline"
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); startInlineEdit() }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
            </button>
            <button
              className={styles.postitOpenBtn}
              title="Open detailed view"
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onOpen() }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </button>
          </>
        )}
        <button className={styles.postitClose} title="Collapse" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onCollapse() }}>×</button>
      </div>

      {inlineEditing ? (
        <textarea
          ref={bodyRef}
          className={styles.inlineBodyInput}
          style={hasAccent ? { backgroundColor: backgroundColor + '22' } : undefined}
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
        snippet && <p ref={bodyRef} className={styles.postitBody} style={hasAccent ? { backgroundColor: backgroundColor + '22' } : undefined}>{snippet}</p>
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
  onReorderDims,
  onApplyToAll,
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
                className={styles.legendApplyAllBtn}
                onClick={() => onApplyToAll(cat.id)}
                title="Apply to all canvas notes"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 11 12 14 22 4"/>
                  <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
                </svg>
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
            onReorder={onReorderDims}
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
      title: 'Edit mode: drag notes or double-click a note to edit inline',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
      ),
    },
    {
      id: 'refractor',
      label: 'Refractor',
      title: 'Refractor mode: drag notes together to merge, or click the left edge of a note at a line break to split it',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8z" />
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
  const [noteZIndexes, setNoteZIndexes]     = useState({})

  // Drag
  const draggingRef   = useRef(null)
  const wasDraggedRef = useRef(false)
  const canvasRef     = useRef(null)
  const cardRefs      = useRef({})
  const zCounterRef   = useRef(20)

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
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [gridCols, setGridCols] = useState(6)
  const [gridHeight, setGridHeight] = useState(180)
  const [gridPickerOpen, setGridPickerOpen] = useState(false)
  const [addPanelOpen, setAddPanelOpen] = useState(true)
  const [marquee, setMarquee] = useState(null) // { startX, startY, endX, endY } canvas coords

  const editorRef    = useRef(null)
  const titleInputRef = useRef(null)
  const positionsRef  = useRef({}) // floating background memo

  // ── Canvas search results ─────────────────────────────────────────────────────
  const { results: findResults, searchingDescriptions, validQuery } = useProgressiveNoteSearch(notes, findQuery)
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

  const applyCatToAll = async (catId) => {
    if (!colorDimId || !catId) return
    const ids = [...openNoteIds]
    await Promise.all(ids.map(id => api.assign(id, colorDimId, catId).catch(console.error)))
    setAllAssignments(prev => [
      ...prev.filter(a => !(ids.includes(a.noteId) && a.dimensionId === colorDimId)),
      ...ids.map(id => ({ noteId: id, dimensionId: colorDimId, categoryId: catId })),
    ])
  }

  const reorderDimensions = async ids => {
    const ordered = ids.map(id => dimensions.find(d => d.id === id)).filter(Boolean)
    setDimensions(ordered)
    try { await api.reorderDimensions(ids) }
    catch (e) { console.error(e) }
  }

  const arrangeInGrid = (cols, height) => {
    const ids = [...openNoteIds]
    if (ids.length === 0) return
    const GAP_X = 10
    const GAP_Y = 10
    const PAD_X = 20
    const START_Y = 80
    const canvasW = canvasRef.current?.offsetWidth || 1200
    const cardW = Math.floor((canvasW - PAD_X * 2 - GAP_X * (cols - 1)) / cols)
    const newPositions = {}
    const newSizes = {}
    ids.forEach((id, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      newPositions[id] = {
        x: PAD_X + col * (cardW + GAP_X),
        y: START_Y + row * (height + GAP_Y),
      }
      newSizes[id] = { w: cardW, h: height }
    })
    setNotePositions(prev => ({ ...prev, ...newPositions }))
    setNoteSizes(prev => ({ ...prev, ...newSizes }))
    setGridPickerOpen(false)
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

  const [canvasScrollHeight, setCanvasScrollHeight] = useState(0)
  useLayoutEffect(() => {
    let maxBottom = 0
    for (const id of openNoteIds) {
      const pos = notePositions[id]
      if (!pos) continue
      const el = cardRefs.current[id]
      const h = el ? el.offsetHeight : (noteSizes[id]?.h ?? 0)
      maxBottom = Math.max(maxBottom, pos.y + h)
    }
    setCanvasScrollHeight(maxBottom + 40)
  }, [openNoteIds, notePositions, noteSizes])

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
    const GAP_X = 10
    const GAP_Y = 10
    const PAD_X = 20
    const START_Y = 80
    const canvasW = canvasRef.current?.offsetWidth || 1200
    const cardW = Math.floor((canvasW - PAD_X * 2 - GAP_X * (gridCols - 1)) / gridCols)
    const nextPositions = {}
    const nextSizes = {}
    noteIds.forEach((noteId, i) => {
      const col = i % gridCols
      const row = Math.floor(i / gridCols)
      nextPositions[noteId] = {
        x: PAD_X + col * (cardW + GAP_X),
        y: START_Y + row * (gridHeight + GAP_Y),
      }
      nextSizes[noteId] = { w: cardW, h: gridHeight }
    })
    setOpenNoteIds(prev => new Set([...prev, ...noteIds]))
    setNotePositions(prev => ({ ...prev, ...nextPositions }))
    setNoteSizes(prev => ({ ...prev, ...nextSizes }))
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

  const expandSearchResultsOnCanvas = (onlyStrong = false) => {
    const results = onlyStrong
      ? findResults.filter(result => result.matchType === 'strong')
      : findResults
    layoutNotesOnCanvas(results.map(result => result.note.id))
    setFindFocused(false)
  }

  const strongFindCount = findResults.filter(result => result.matchType === 'strong').length
  const headlineFindResults = findResults.filter(result => result.matchType === 'strong')
  const descriptionFindResults = findResults.filter(result => result.matchType === 'weak')

  const collapseNote = (id) => {
    setOpenNoteIds(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const clearCanvas = () => {
    setOpenNoteIds(new Set())
    setMergeCandidate(null)
    setMergeProposal(null)
  }

  const bringNotesToFront = noteIds => {
    const ids = noteIds.filter(Boolean)
    if (!ids.length) return
    setNoteZIndexes(prev => {
      const next = { ...prev }
      ids.forEach(id => {
        zCounterRef.current += 1
        next[id] = zCounterRef.current
      })
      return next
    })
  }

  const handleInlineUpdate = async (noteId, patch) => {
    await api.updateNote(noteId, patch)
    if (patch.html !== undefined) {
      const matches = categoryMatchesForHashtags(stripHtml(patch.html), categories)
      if (matches.length) {
        await Promise.all(matches.map(cat => api.assign(noteId, cat.dimensionId, cat.id).catch(console.error)))
        setAllAssignments(prev => [
          ...prev.filter(a => !matches.some(cat => a.noteId === noteId && a.dimensionId === cat.dimensionId)),
          ...matches.map(cat => ({ noteId, dimensionId: cat.dimensionId, categoryId: cat.id })),
        ])
      }
    }
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
    const originalAsns = allAssignments.filter(a => a.noteId === noteId)
    try {
      await api.updateNote(noteId, { html: text1, title: original.title })
      const newId = crypto.randomUUID()
      await api.createNote({ id: newId, html: text2, title: title2, collapsed: false })
      await Promise.all(originalAsns.map(a => api.assign(newId, a.dimensionId, a.categoryId)))
      setAllAssignments(prev => [
        ...prev,
        ...originalAsns.map(a => ({ noteId: newId, dimensionId: a.dimensionId, categoryId: a.categoryId })),
      ])
      const base = notePositions[noteId] || randomPos()
      setNotePositions(prev => ({ ...prev, [newId]: { x: base.x + 260, y: base.y + 20 } }))
      setOpenNoteIds(prev => new Set([...prev, newId]))
      bringNotesToFront([noteId, newId])
      onRefresh?.()
    } catch (e) {
      console.error('Split failed', e)
    }
  }

  // ── Drag ─────────────────────────────────────────────────────────────────────
  const handlePointerDown = (e, id) => {
    if (e.button !== 0) return
    e.stopPropagation()

    if (e.ctrlKey || e.metaKey) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      return
    }

    wasDraggedRef.current = false
    const dragIds = selectedIds.has(id) ? [...selectedIds] : [id]
    if (!selectedIds.has(id)) setSelectedIds(new Set([id]))
    bringNotesToFront(dragIds)

    const origPositions = {}
    dragIds.forEach(did => {
      const pos = notePositions[did] || { x: 100, y: 100 }
      origPositions[did] = { x: pos.x, y: pos.y }
    })

    draggingRef.current = {
      type: 'card', id, ids: dragIds,
      startX: e.clientX, startY: e.clientY,
      origPositions,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handleCanvasPointerDown = (e) => {
    if (e.button !== 0 || paintCat) return

    let clickedId = null
    for (const [id, el] of Object.entries(cardRefs.current)) {
      if (el && el.contains(e.target)) { clickedId = id; break }
    }

    if (clickedId !== null) {
      if (e.ctrlKey || e.metaKey) {
        setSelectedIds(prev => {
          const next = new Set(prev)
          if (next.has(clickedId)) next.delete(clickedId)
          else next.add(clickedId)
          return next
        })
      } else if (!selectedIds.has(clickedId)) {
        setSelectedIds(new Set([clickedId]))
      }
      return
    }

    // Empty canvas — deselect all, start marquee
    setSelectedIds(new Set())
    const canvasRect = canvasRef.current.getBoundingClientRect()
    const scrollTop = canvasRef.current.scrollTop
    const x = e.clientX - canvasRect.left
    const y = e.clientY - canvasRect.top + scrollTop
    draggingRef.current = { type: 'marquee', startX: x, startY: y }
    setMarquee({ startX: x, startY: y, endX: x, endY: y })
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
    const { type } = draggingRef.current

    if (type === 'marquee') {
      const canvasRect = canvasRef.current.getBoundingClientRect()
      const scrollTop = canvasRef.current.scrollTop
      const endX = e.clientX - canvasRect.left
      const endY = e.clientY - canvasRect.top + scrollTop
      const { startX, startY } = draggingRef.current
      setMarquee({ startX, startY, endX, endY })

      const x1 = Math.min(startX, endX), x2 = Math.max(startX, endX)
      const y1 = Math.min(startY, endY), y2 = Math.max(startY, endY)
      const newSelected = new Set()
      for (const id of openNoteIds) {
        const el = cardRefs.current[id]; const pos = notePositions[id]
        if (!el || !pos) continue
        if (pos.x < x2 && pos.x + el.offsetWidth > x1 && pos.y < y2 && pos.y + el.offsetHeight > y1)
          newSelected.add(id)
      }
      setSelectedIds(newSelected)
      return
    }

    if (type === 'card') {
      const { id, ids, startX, startY, origPositions } = draggingRef.current
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) wasDraggedRef.current = true
      if (!wasDraggedRef.current) return

      setNotePositions(prev => {
        const next = { ...prev }
        ids.forEach(did => {
          const orig = origPositions[did]
          if (orig) next[did] = { x: orig.x + dx, y: orig.y + dy }
        })
        return next
      })

      if (interactionMode === 'refractor' && ids.length === 1) {
        setMergeCandidate(findMergeCandidate(id, { x: origPositions[id].x + dx, y: origPositions[id].y + dy }))
      } else {
        setMergeCandidate(null)
      }
    }
  }

  const handlePointerUp = () => {
    const dragging = draggingRef.current
    draggingRef.current = null

    if (dragging?.type === 'marquee') {
      setMarquee(null)
      return
    }

    if (dragging?.type === 'card') {
      const { id, ids } = dragging
      if (interactionMode === 'refractor' && ids.length === 1 && mergeCandidate && wasDraggedRef.current) {
        const pos = notePositions[id] || { x: 200, y: 200 }
        setMergeProposal({ sourceId: id, targetId: mergeCandidate, x: pos.x + 130, y: pos.y + 70 })
        setMergeCandidate(null)
      } else {
        setMergeCandidate(null)
      }
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

  useEffect(() => { if (addPanelOpen) editorRef.current?.focus() }, [addPanelOpen])

  useEffect(() => {
    if (!headlineMode && !editingTitle) return
    const h = e => { if (e.key === 'Escape') { setHeadlineMode(false); setEditingTitle(false) } }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [headlineMode, editingTitle])

  const handleDescInput = () => {
    const text = editorRef.current?.innerText || ''
    if (text.includes('#')) ensureCategoryData()
    if (!titleManual && editorRef.current)
      setTitleVal(deriveTitle(text))
    setCategorySelections(prev => mergeSelectionsWithHashtags(prev, text, categories))
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
    const selections = mergeSelectionsWithHashtags(categorySelections, content, categories)
    setCategorySelections({})

    const newNote = { id: crypto.randomUUID(), html, title: finalTitle, collapsed: false }
    try {
      const saved = await api.createNote(newNote)
      await Promise.all(Object.entries(selections)
        .filter(([, catId]) => Boolean(catId))
        .map(([dimId, catId]) => api.assign(newNote.id, dimId, catId)))
      setAllAssignments(prev => [
        ...prev.filter(a => !(a.noteId === newNote.id && selections[a.dimensionId])),
        ...Object.entries(selections)
          .filter(([, catId]) => Boolean(catId))
          .map(([dimensionId, categoryId]) => ({ noteId: newNote.id, dimensionId, categoryId })),
      ])
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
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div style={{ position: 'absolute', top: 0, left: 0, width: 1, height: canvasScrollHeight, pointerEvents: 'none' }} />
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
              selected={selectedIds.has(id)}
              backgroundColor={noteBackground}
              zIndex={noteZIndexes[id] ?? undefined}
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

        {marquee && (
          <div
            className={styles.marquee}
            style={{
              left: Math.min(marquee.startX, marquee.endX),
              top: Math.min(marquee.startY, marquee.endY),
              width: Math.abs(marquee.endX - marquee.startX),
              height: Math.abs(marquee.endY - marquee.startY),
            }}
          />
        )}
      </div>

      <div className={styles.floatingModeTools}>
        <ModeControls mode={interactionMode} onModeChange={changeInteractionMode} />
        <div className={styles.gridArrangeWrap}>
          {gridPickerOpen && (
            <div className={styles.gridPicker}>
              <span className={styles.gridPickerLabel}>Cols</span>
              <button className={styles.gridPickerStep} onClick={() => setGridCols(c => Math.max(1, c - 1))} disabled={gridCols <= 1}>−</button>
              <span className={styles.gridPickerVal}>{gridCols}</span>
              <button className={styles.gridPickerStep} onClick={() => setGridCols(c => Math.min(6, c + 1))} disabled={gridCols >= 6}>+</button>
              <span className={styles.gridPickerDivider} />
              <span className={styles.gridPickerLabel}>Height</span>
              <button className={styles.gridPickerStep} onClick={() => setGridHeight(h => Math.max(80, h - 20))} disabled={gridHeight <= 80}>−</button>
              <span className={styles.gridPickerVal}>{gridHeight}</span>
              <button className={styles.gridPickerStep} onClick={() => setGridHeight(h => Math.min(500, h + 20))} disabled={gridHeight >= 500}>+</button>
            </div>
          )}
          <div className={styles.gridArrangeBtnGroup}>
            <button
              className={styles.gridArrangeBtn}
              onClick={() => arrangeInGrid(gridCols, gridHeight)}
              disabled={openNoteIds.size === 0}
              title={`Arrange in grid (${gridCols} cols, ${gridHeight}px)`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
              </svg>
              Grid
            </button>
            <button
              className={`${styles.gridSettingsBtn} ${gridPickerOpen ? styles.gridSettingsBtnActive : ''}`}
              onClick={() => setGridPickerOpen(v => !v)}
              title="Grid settings"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.01 7.01 0 0 0-1.62-.94l-.36-2.54A.484.484 0 0 0 14 2h-4c-.25 0-.46.18-.49.42l-.36 2.54a7.3 7.3 0 0 0-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.63 8.48a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.3.59.22l2.39-.96c.5.36 1.04.67 1.62.94l.36 2.54c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.36-2.54a7.3 7.3 0 0 0 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
              </svg>
            </button>
          </div>
        </div>
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
          onReorderDims={reorderDimensions}
          onApplyToAll={applyCatToAll}
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
            {!validQuery ? (
              <div className={styles.findEmpty}>Invalid regex</div>
            ) : findResults.length === 0 && !searchingDescriptions ? (
              <div className={styles.findEmpty}>No matches</div>
            ) : (
              <>
                {findResults.length > 0 && (
                  <div className={styles.findExpandActions}>
                    <button
                      className={styles.findExpandBtn}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => expandSearchResultsOnCanvas(false)}
                      title="Open all matching notes on canvas"
                    >
                      <span>Expand all</span>
                      <span className={styles.findBadge}>{findResults.length}</span>
                    </button>
                    <button
                      className={styles.findExpandBtn}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => expandSearchResultsOnCanvas(true)}
                      disabled={strongFindCount === 0}
                      title="Open only headline matches on canvas"
                    >
                      <span>Expand headlines</span>
                      <span className={styles.findBadge}>{strongFindCount}</span>
                    </button>
                  </div>
                )}
                {headlineFindResults.length > 0 && (
                  <div className={styles.findResultSection}>
                    <div className={styles.findResultSectionTitle}>In headline</div>
                    {headlineFindResults.map(({ note }) => (
                      <button key={note.id}
                        className={`${styles.findResult} ${openNoteIds.has(note.id) ? styles.findResultOpen : ''}`}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => { openOnCanvas(note.id); setFindQuery(''); setFindFocused(false) }}>
                        <span className={styles.findResultTitle}>{note.title || 'Untitled'}</span>
                        <span className={styles.findResultMeta}>
                          {openNoteIds.has(note.id) && <span className={styles.findBadge}>on canvas</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {descriptionFindResults.length > 0 && (
                  <div className={styles.findResultSection}>
                    <div className={styles.findResultSectionTitle}>In description</div>
                    {descriptionFindResults.map(({ note }) => (
                      <button key={note.id}
                        className={`${styles.findResult} ${openNoteIds.has(note.id) ? styles.findResultOpen : ''}`}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => { openOnCanvas(note.id); setFindQuery(''); setFindFocused(false) }}>
                        <span className={styles.findResultTitle}>{note.title || 'Untitled'}</span>
                        <span className={styles.findResultMeta}>
                          {openNoteIds.has(note.id) && <span className={styles.findBadge}>on canvas</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {searchingDescriptions && (
                  <div className={styles.findLoading}>Searching descriptions...</div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Bottom card */}
      {addPanelOpen ? (
        <div className={styles.center}>
          <button
            className={styles.centerCollapseBtn}
            onClick={() => setAddPanelOpen(false)}
            title="Collapse"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 15l-7-7-7 7"/>
            </svg>
          </button>

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
            {!headlineMode && (
              <CategoryHashtagSuggestions
                editorRef={editorRef}
                dimensions={dimensions}
                categories={categories}
                onPick={cat => setCategorySelections(prev => ({ ...prev, [cat.dimensionId]: cat.id }))}
              />
            )}
          </div>

          <div className={styles.actions}>
            <button className={styles.categoryBtn} onClick={() => { ensureCategoryData(); setCategoryPickerOpen(true) }}>
              Categories
            </button>
            <button className={styles.submitBtn} onClick={submit}>add ↵</button>
          </div>
        </div>
      ) : (
        <button
          className={styles.centerCollapsed}
          onClick={() => { setAddPanelOpen(true); setTimeout(() => editorRef.current?.focus(), 50) }}
          title="Add a note"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
          </svg>
          New note
        </button>
      )}

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
