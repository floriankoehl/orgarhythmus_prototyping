import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import styles from './SchedulePage.module.css'
import { api } from '../api'

// ── Constants ─────────────────────────────────────────────────────────────────
const HEADER_H     = 52
const LANE_HDR_H   = 30
const MILESTONE_H  = 20   // block height in px
const MILESTONE_Y  = 8    // offset from row top
const COL_BUF      = 8
const ROW_BUF      = 3
const MIN_ROWS     = 20
const EXTEND_DELTA = 365  // days added per extension

const DEFAULT_SPACING = { colW: 44, rowH: 36, rowGap: 0, laneGap: 28 }
const INIT_ORIGIN     = 0     // today is ALWAYS the left border — no past scrolling
const INIT_TOTAL_DAYS = 60    // initial days; grows to cover viewport + buffer on mount
const EDGE_COLS       = 5     // columns from right edge before extending

const DAY_ABR   = ['Su','Mo','Tu','We','Th','Fr','Sa']
const MONTH_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// col 0 = today; col N = N days from today
function colToDate(col) {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + col)
  return d
}

function dateFmt(col) {
  return colToDate(col).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ── Dependency helpers ────────────────────────────────────────────────────────
function hasCycle(fromId, toId, deps) {
  const visited = new Set()
  const queue = [toId]
  while (queue.length) {
    const curr = queue.shift()
    if (curr === fromId) return true
    if (visited.has(curr)) continue
    visited.add(curr)
    deps.filter(d => d.fromId === curr).forEach(d => queue.push(d.toId))
  }
  return false
}

function computeViolations(msList, deps) {
  const msMap = Object.fromEntries(msList.map(m => [m.id, m]))
  const violations = new Set()
  deps.forEach(dep => {
    const from = msMap[dep.fromId]; const to = msMap[dep.toId]
    if (from && to && from.startCol + from.duration > to.startCol) violations.add(to.id)
  })
  // Cascade: if B violates, check if B also causes downstream violations
  const queue = [...violations]
  while (queue.length) {
    const id = queue.shift()
    const ms = msMap[id]; if (!ms) continue
    deps.forEach(dep => {
      if (dep.fromId !== id || violations.has(dep.toId)) return
      const to = msMap[dep.toId]
      if (to && ms.startCol + ms.duration > to.startCol) { violations.add(dep.toId); queue.push(dep.toId) }
    })
  }
  return violations
}

// ── Row model ─────────────────────────────────────────────────────────────────
function buildRowItems(goals, categories, assignments, activeDimId, spacing) {
  const { rowH, rowGap, laneGap } = spacing
  const slotH = rowH + rowGap

  if (!activeDimId) {
    const items = goals.map((g, i) => ({ type: 'goal', goal: g, cat: null, top: i * slotH, height: slotH }))
    const padTo = Math.max(goals.length, MIN_ROWS)
    for (let i = goals.length; i < padTo; i++) items.push({ type: 'empty', top: i * slotH, height: slotH })
    return items
  }

  const cats    = categories.filter(c => c.dimensionId === activeDimId)
  const catMap  = Object.fromEntries(cats.map(c => [c.id, []]))
  const unassigned = []
  goals.forEach(g => {
    const cid = assignments[g.id]?.[activeDimId]
    if (cid && catMap[cid]) catMap[cid].push(g)
    else unassigned.push(g)
  })

  const items = []; let top = 0
  const addLane = (cat, laneGoals, first) => {
    if (!first) { items.push({ type: 'lane-gap', cat: null, top, height: laneGap }); top += laneGap }
    items.push({ type: 'lane-header', cat, top, height: LANE_HDR_H }); top += LANE_HDR_H
    if (laneGoals.length === 0) {
      items.push({ type: 'empty', cat, top, height: slotH }); top += slotH
    } else {
      laneGoals.forEach(g => { items.push({ type: 'goal', goal: g, cat, top, height: slotH }); top += slotH })
    }
  }
  cats.forEach((cat, i) => addLane(cat, catMap[cat.id] ?? [], i === 0))
  if (unassigned.length > 0 || cats.length === 0) addLane(null, unassigned, cats.length === 0)
  const minH = MIN_ROWS * slotH
  if (top < minH) { items.push({ type: 'empty', top, height: minH - top }); top = minH }
  return items
}

// ── Spacing panel ─────────────────────────────────────────────────────────────
function SpacingPanel({ spacing, onChange, onClose, anchorRef }) {
  const panelRef = useRef()
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })
  useEffect(() => {
    const handler = e => {
      if (panelRef.current?.contains(e.target)) return
      if (anchorRef?.current?.contains(e.target)) return
      closeRef.current()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [anchorRef])

  const set = (key, val) => onChange({ ...spacing, [key]: +val })
  const rows = [
    ['colW',    'Column width', 20, 120, 'px'],
    ['rowH',    'Row height',   20,  80, 'px'],
    ['rowGap',  'Row gap',       0,  24, 'px'],
    ['laneGap', 'Lane gap',      8,  80, 'px'],
  ]
  return (
    <div ref={panelRef} className={styles.spacingPanel}>
      <div className={styles.spacingPanelHdr}>
        <span>Spacing</span>
        <button className={styles.spacingClose} onClick={onClose}>✕</button>
      </div>
      {rows.map(([key, label, min, max, unit]) => (
        <label key={key} className={styles.spacingRow}>
          <span className={styles.spacingLabel}>{label}</span>
          <input type="range" className={styles.spacingSlider}
            min={min} max={max} value={spacing[key]}
            onChange={e => set(key, e.target.value)} />
          <span className={styles.spacingVal}>{spacing[key]}{unit}</span>
        </label>
      ))}
    </div>
  )
}

// ── Context menu ──────────────────────────────────────────────────────────────
function ContextMenu({ menu, onClose, onCreate, onInsertDay, onDeleteDay, onSetDeadline, onRemoveDeadline }) {
  if (!menu) return null
  return createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onMouseDown={onClose} />
      <div className={styles.ctxMenu} style={{ left: menu.x, top: menu.y }}>
        {menu.type === 'cell' && (<>
          <button className={styles.ctxItem}
            onClick={() => { onCreate(menu.goalId, menu.col, menu.color); onClose() }}>
            Add milestone — {menu.goalTitle}
          </button>
          {menu.hasDeadline
            ? <button className={styles.ctxItem}
                onClick={() => { onRemoveDeadline(menu.goalId); onClose() }}>
                Remove hard deadline
              </button>
            : <button className={styles.ctxItem}
                onClick={() => { onSetDeadline(menu.goalId, menu.col); onClose() }}>
                Set hard deadline here
              </button>
          }
        </>)}
        {menu.type === 'header' && (<>
          <button className={styles.ctxItem} onClick={() => { onInsertDay(menu.col); onClose() }}>
            Insert day before
          </button>
          <button className={styles.ctxItem} onClick={() => { onDeleteDay(menu.col); onClose() }}>
            Remove this day
          </button>
        </>)}
      </div>
    </>,
    document.body
  )
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
function GanttToolbar({ dimensions, activeDimId, onDimChange, spacing, onSpacingChange, mode, onModeChange }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsBtnRef = useRef()
  const closeSettings  = useCallback(() => setSettingsOpen(false), [])
  return (
    <div className={styles.toolbar}>
      <div className={styles.modePills}>
        <button className={`${styles.modePill} ${mode === 'edit' ? styles.modePillActive : ''}`}
          onClick={() => onModeChange('edit')}>Edit</button>
        <button className={`${styles.modePill} ${mode === 'dependency' ? styles.modePillActive : ''}`}
          onClick={() => onModeChange('dependency')}>Dependencies</button>
      </div>
      <div className={styles.toolbarDiv} />
      <span className={styles.toolbarLabel}>Dimension</span>
      <select className={styles.dimSelect} value={activeDimId}
        onChange={e => onDimChange(e.target.value)}>
        <option value="">None</option>
        {dimensions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <div style={{ flex: 1 }} />
      <div className={styles.spacingWrap}>
        <button ref={settingsBtnRef}
          className={`${styles.spacingBtn} ${settingsOpen ? styles.spacingBtnOpen : ''}`}
          onClick={() => setSettingsOpen(v => !v)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 6h18v2H3V6zm3 5h12v2H6v-2zm3 5h6v2H9v-2z"/>
          </svg>
          Spacing
        </button>
        {settingsOpen && (
          <SpacingPanel spacing={spacing} onChange={onSpacingChange}
            onClose={closeSettings} anchorRef={settingsBtnRef} />
        )}
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function SchedulePage({ goals = [], isActive = false }) {
  // ── API data ───────────────────────────────────────────────────────────────
  const [dimensions,   setDimensions]   = useState([])
  const [categories,   setCategories]   = useState([])
  const [assignments,  setAssignments]  = useState({})
  const [milestones,   setMilestones]   = useState([])
  const [dependencies, setDependencies] = useState([])
  const [deadlines,    setDeadlines]    = useState([])
  const [drawingState, setDrawingState] = useState(null)  // { fromId } while drawing

  useEffect(() => {
    if (!isActive) return
    Promise.all([
      api.getDimensions(), api.getAllCategories(), api.getAssignments(),
      api.getMilestones(), api.getDependencies(), api.getDeadlines(),
    ]).then(([dims, cats, assigns, mss, deps, dls]) => {
      setDimensions(dims); setCategories(cats)
      const map = {}
      assigns.forEach(a => { if (!map[a.goalId]) map[a.goalId] = {}; map[a.goalId][a.dimensionId] = a.categoryId })
      setAssignments(map)
      setMilestones(mss)
      setDependencies(deps)
      setDeadlines(dls)
    }).catch(console.error)
  }, [isActive])

  // ── Toolbar / mode state ───────────────────────────────────────────────────
  const [mode,        setMode]        = useState('edit')
  const [activeDimId, setActiveDimId] = useState('')
  const [spacing,     setSpacing]     = useState(DEFAULT_SPACING)

  // ── Infinite timeline state ────────────────────────────────────────────────
  const [totalDays,  setTotalDays]  = useState(INIT_TOTAL_DAYS)

  // ── Selection + context menu ───────────────────────────────────────────────
  const [selectedIds,  setSelectedIds]  = useState(new Set())
  const [contextMenu,  setContextMenu]  = useState(null)

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const gridBodyRef      = useRef()
  const leftBodyInnerRef = useRef()
  const highlightRef     = useRef()
  const marqueeRef       = useRef()

  // ── Imperative refs — always current, no stale closure ────────────────────
  const scrollLeftRef   = useRef(0)
  const scrollTopRef    = useRef(0)
  const vpRef           = useRef({ w: 0, h: 0 })
  const spacingRef      = useRef(spacing)
  const totalDaysRef    = useRef(INIT_TOTAL_DAYS)
  const rafIdRef          = useRef(null)         // requestAnimationFrame id
  const gridInnerRef      = useRef(null)         // for synchronous width update during extension
  const lastExtensionRef  = useRef(0)            // timestamp — prevents stacked extensions
  const dragRef           = useRef(null)         // drag state machine
  const milestoneElsRef = useRef(new Map())      // id → DOM element
  const hoveredCellRef  = useRef(null)
  const drawingRef      = useRef(null)           // { fromId } sync access during drawing
  const previewArrowRef = useRef(null)           // SVG path element for live preview
  const dependenciesRef = useRef([])
  const deadlinesRef    = useRef([])
  const modeRef         = useRef('edit')

  // Keep imperative refs in sync with state (assigned synchronously in render)
  spacingRef.current       = spacing
  totalDaysRef.current     = totalDays
  dependenciesRef.current  = dependencies
  deadlinesRef.current     = deadlines
  modeRef.current          = mode

  // Live refs that closures read — no useEffect needed
  const milestonesRef  = useRef([])
  milestonesRef.current = milestones
  const selectedIdsRef = useRef(new Set())
  selectedIdsRef.current = selectedIds

  // ── Virtual-render state ───────────────────────────────────────────────────
  const [vpSize,      setVpSize]      = useState({ w: 0, h: 0 })
  const [scrollLeft,  setScrollLeft]  = useState(0)
  const [scrollTop,   setScrollTop]   = useState(0)

  // ── Row model ──────────────────────────────────────────────────────────────
  const rowItems = useMemo(
    () => buildRowItems(goals, categories, assignments, activeDimId, spacing),
    [goals, categories, assignments, activeDimId, spacing]
  )
  const rowItemsRef = useRef([])
  rowItemsRef.current = rowItems

  const goalRowMap = useMemo(() => {
    const map = {}
    rowItems.forEach(item => { if (item.type === 'goal') map[item.goal.id] = item })
    return map
  }, [rowItems])
  const goalRowMapRef = useRef({})
  goalRowMapRef.current = goalRowMap

  const totalContentH = rowItems.length > 0
    ? rowItems[rowItems.length - 1].top + rowItems[rowItems.length - 1].height
    : MIN_ROWS * spacing.rowH

  // Violations: recomputed whenever milestones or dependencies change
  const violationIds = useMemo(() => computeViolations(milestones, dependencies), [milestones, dependencies])

  // ── Measure + ensure grid covers viewport ─────────────────────────────────
  useEffect(() => {
    const el = gridBodyRef.current; if (!el) return
    const obs = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect
      vpRef.current = { w: width, h: height }
      setVpSize({ w: width, h: height })
      // Ensure grid is always wide enough to have a scrollbar
      const needed = Math.ceil(width / spacingRef.current.colW) + COL_BUF + EDGE_COLS + 1
      if (needed > totalDaysRef.current) {
        totalDaysRef.current = needed
        setTotalDays(needed)
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // ── Scroll ────────────────────────────────────────────────────────────────
  // DOM mutations (left-panel sync) are immediate.
  // React state updates are rAF-throttled to avoid 60fps re-renders.
  const handleScroll = useCallback(() => {
    const el = gridBodyRef.current; if (!el) return
    const sp  = spacingRef.current
    const sl  = el.scrollLeft
    const st  = el.scrollTop
    scrollLeftRef.current = sl; scrollTopRef.current = st

    // Immediate: keep left panel in sync
    if (leftBodyInnerRef.current) leftBodyInnerRef.current.style.transform = `translateY(${-st}px)`

    // Extend timeline rightward when scrolling near the right edge
    if (!dragRef.current) {
      const now = Date.now()
      if (now - lastExtensionRef.current >= 150 &&
          sl + vpRef.current.w > (totalDaysRef.current - EDGE_COLS) * sp.colW) {
        lastExtensionRef.current = now
        const newTd = totalDaysRef.current + EXTEND_DELTA
        if (gridInnerRef.current) gridInnerRef.current.style.width = `${newTd * sp.colW}px`
        totalDaysRef.current = newTd
        setTotalDays(newTd)
      }
    }

    // Throttle virtual-range re-renders to one per animation frame
    if (rafIdRef.current) return
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null
      setScrollLeft(scrollLeftRef.current)
      setScrollTop(scrollTopRef.current)
    })
  }, [])

  // ── Hover highlight ────────────────────────────────────────────────────────
  const handleMouseMove = useCallback(e => {
    // Update dependency drawing preview
    if (drawingRef.current) {
      const rect = gridBodyRef.current?.getBoundingClientRect()
      if (rect && previewArrowRef.current) {
        const from = milestonesRef.current.find(m => m.id === drawingRef.current.fromId)
        const fromRow = from && goalRowMapRef.current[from.goalId]
        if (from && fromRow) {
          const sp = spacingRef.current
          const x1 = (from.startCol + from.duration) * sp.colW
          const y1 = HEADER_H + fromRow.top + Math.floor(fromRow.height / 2)
          const x2 = e.clientX - rect.left + scrollLeftRef.current
          const y2 = e.clientY - rect.top + scrollTopRef.current
          const cp = Math.max(40, Math.abs(x2 - x1) * 0.45)
          previewArrowRef.current.setAttribute('d', `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`)
          previewArrowRef.current.style.display = ''
        }
      }
      if (highlightRef.current) highlightRef.current.style.display = ''
      return
    }
    if (dragRef.current) { if (highlightRef.current) highlightRef.current.style.display = ''; return }
    if (e.target.closest('[data-ms-id]')) { if (highlightRef.current) highlightRef.current.style.display = ''; return }
    const rect = gridBodyRef.current?.getBoundingClientRect(); if (!rect) return
    const sp   = spacingRef.current
    const rawX = e.clientX - rect.left + scrollLeftRef.current
    const rawY = e.clientY - rect.top  + scrollTopRef.current - HEADER_H
    if (rawY < 0) { if (highlightRef.current) highlightRef.current.style.display = ''; return }
    const col  = Math.floor(rawX / sp.colW)
    if (col < 0 || col >= totalDaysRef.current) return
    const item = rowItemsRef.current.find(r => rawY >= r.top && rawY < r.top + r.height)
    if (!item || item.type !== 'goal') { if (highlightRef.current) highlightRef.current.style.display = ''; return }
    hoveredCellRef.current = { col, item }
    const h = highlightRef.current
    if (h) {
      h.style.display = 'block'
      h.style.setProperty('--hw', `${sp.colW}px`)
      h.style.setProperty('--hh', `${item.height}px`)
      h.style.setProperty('--hx', `${col * sp.colW}px`)
      h.style.setProperty('--hy', `${HEADER_H + item.top}px`)
    }
  }, [])

  const handleMouseLeave = useCallback(() => {
    hoveredCellRef.current = null
    if (highlightRef.current) highlightRef.current.style.display = ''
    if (previewArrowRef.current) previewArrowRef.current.style.display = 'none'
  }, [])

  // ── Spacing change ─────────────────────────────────────────────────────────
  const handleSpacingChange = useCallback(next => {
    const prev = spacingRef.current
    if (next.colW !== prev.colW && gridBodyRef.current) {
      const centerDay = (scrollLeftRef.current + vpRef.current.w / 2) / prev.colW
      gridBodyRef.current.scrollLeft = Math.max(0, Math.round(centerDay * next.colW - vpRef.current.w / 2))
      // Ensure grid stays wider than viewport after colW change
      const needed = Math.ceil(vpRef.current.w / next.colW) + COL_BUF + EDGE_COLS + 1
      if (needed > totalDaysRef.current) {
        totalDaysRef.current = needed
        setTotalDays(needed)
      }
    }
    setSpacing(next)
  }, [])

  // ── Context menu ───────────────────────────────────────────────────────────
  const handleContextMenu = useCallback(e => {
    e.preventDefault()
    const rect = gridBodyRef.current?.getBoundingClientRect(); if (!rect) return
    const sp   = spacingRef.current
    const relY = e.clientY - rect.top
    const rawX = e.clientX - rect.left + scrollLeftRef.current
    const col  = Math.floor(rawX / sp.colW)

    if (relY < HEADER_H) {
      setContextMenu({ type: 'header', x: e.clientX, y: e.clientY, col })
      return
    }
    if (e.target.closest('[data-ms-id]')) return  // right-click on milestone — skip for now

    const rawY = e.clientY - rect.top + scrollTopRef.current - HEADER_H
    const item = rowItemsRef.current.find(r => rawY >= r.top && rawY < r.top + r.height)
    if (!item || item.type !== 'goal') return

    // Compute suggested milestone color from category
    let color = '#1a73e8'
    if (item.cat?.color) color = item.cat.color

    const hasDeadline = deadlinesRef.current.some(d => d.goalId === item.goal.id)
    setContextMenu({ type: 'cell', x: e.clientX, y: e.clientY, col,
      goalId: item.goal.id, goalTitle: item.goal.title, color, hasDeadline })
  }, [])

  // ── Milestone CRUD ─────────────────────────────────────────────────────────
  const handleCreateMilestone = useCallback(async (goalId, startCol, color) => {
    const data = { goal_id: goalId, start_col: startCol, duration: 1, title: '', color: color || '#1a73e8' }
    try {
      const ms = await api.createMilestone(data)
      setMilestones(prev => [...prev, ms])
    } catch (err) { console.error(err) }
  }, [])

  // ── Column insert / delete ─────────────────────────────────────────────────
  const handleInsertDay = useCallback(async col => {
    const updates = []
    const updated = milestonesRef.current.map(m => {
      if (m.startCol >= col) { updates.push({ id: m.id, startCol: m.startCol + 1 }); return { ...m, startCol: m.startCol + 1 } }
      return m
    })
    setMilestones(updated)
    if (updates.length) { try { await api.batchUpdateMilestones(updates) } catch (e) { console.error(e) } }
  }, [])

  const handleDeleteDay = useCallback(async col => {
    const updates = []
    const updated = milestonesRef.current.map(m => {
      if (m.startCol > col) {
        updates.push({ id: m.id, startCol: m.startCol - 1 })
        return { ...m, startCol: m.startCol - 1 }
      }
      if (m.startCol <= col && col < m.startCol + m.duration) {
        const d = Math.max(1, m.duration - 1)
        updates.push({ id: m.id, duration: d })
        return { ...m, duration: d }
      }
      return m
    })
    setMilestones(updated)
    if (updates.length) { try { await api.batchUpdateMilestones(updates) } catch (e) { console.error(e) } }
  }, [])

  // ── Drag helpers ───────────────────────────────────────────────────────────
  function startMoveDrag(startMouseX, originals) {
    const sp = spacingRef.current
    dragRef.current = { type: 'move', hasMoved: false, originals }
    document.body.style.cursor = 'grabbing'

    const onMove = e => {
      const rawDx = e.clientX - startMouseX
      if (Math.abs(rawDx) > 2) dragRef.current.hasMoved = true
      // Compute clamped dx: can't go before col 0 or past any deadline
      let dx = rawDx
      Object.entries(originals).forEach(([id, orig]) => {
        dx = Math.max(dx, -orig.startCol * sp.colW)
        const ms = milestonesRef.current.find(m => m.id === id)
        const dl = deadlinesRef.current.find(d => d.goalId === ms?.goalId)
        if (dl) dx = Math.min(dx, (dl.col - orig.duration - orig.startCol) * sp.colW)
      })
      Object.entries(originals).forEach(([id, orig]) => {
        const el = milestoneElsRef.current.get(id)
        if (el) el.style.left = `${orig.startCol * sp.colW + dx}px`
      })
    }

    const onUp = async e => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      const { hasMoved } = dragRef.current || {}
      dragRef.current = null
      if (!hasMoved) return

      let colDelta = Math.round((e.clientX - startMouseX) / sp.colW)
      const updates = []
      const next = milestonesRef.current.map(m => {
        if (!originals[m.id]) return m
        let newStartCol = Math.max(0, originals[m.id].startCol + colDelta)
        // Clamp to deadline
        const dl = deadlinesRef.current.find(d => d.goalId === m.goalId)
        if (dl) newStartCol = Math.min(newStartCol, dl.col - originals[m.id].duration)
        newStartCol = Math.max(0, newStartCol)
        if (newStartCol !== originals[m.id].startCol) updates.push({ id: m.id, startCol: newStartCol })
        return { ...m, startCol: newStartCol }
      })
      setMilestones(next)
      // Auto-select any new violations created by this move
      const viol = computeViolations(next, dependenciesRef.current)
      if (viol.size > 0) setSelectedIds(prev => new Set([...prev, ...viol]))
      if (updates.length) { try { await api.batchUpdateMilestones(updates) } catch (e) { console.error(e) } }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function startResizeDrag(startMouseX, milestoneId, side) {
    const sp  = spacingRef.current
    const ms  = milestonesRef.current.find(m => m.id === milestoneId)
    if (!ms) return
    const origStart = ms.startCol; const origDur = ms.duration
    dragRef.current = { type: `resize-${side}` }
    document.body.style.cursor = 'col-resize'

    const onMove = e => {
      const dx   = e.clientX - startMouseX
      const el   = milestoneElsRef.current.get(milestoneId); if (!el) return
      if (side === 'left') {
        const origRight   = (origStart + origDur) * sp.colW
        const newLeft     = Math.min(origRight - sp.colW, Math.max(0, origStart * sp.colW + dx))
        el.style.left     = `${newLeft}px`
        el.style.width    = `${origRight - newLeft}px`
      } else {
        const origLeft    = origStart * sp.colW
        const origRight   = (origStart + origDur) * sp.colW
        const newRight    = Math.max(origLeft + sp.colW, origRight + dx)
        el.style.width    = `${newRight - origLeft}px`
      }
    }

    const onUp = async e => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      dragRef.current = null

      const colDelta  = Math.round((e.clientX - startMouseX) / sp.colW)
      let newStart    = origStart; let newDur = origDur
      if (side === 'left') {
        newStart = Math.max(0, origStart + colDelta)
        newDur   = Math.max(1, origDur - (newStart - origStart))
      } else {
        newDur = Math.max(1, origDur + colDelta)
      }
      const nextAll = milestonesRef.current.map(m => m.id === milestoneId ? { ...m, startCol: newStart, duration: newDur } : m)
      setMilestones(nextAll)
      const viol = computeViolations(nextAll, dependenciesRef.current)
      if (viol.size > 0) setSelectedIds(prev => new Set([...prev, ...viol]))
      try { await api.updateMilestone(milestoneId, { startCol: newStart, duration: newDur }) }
      catch (err) { console.error(err) }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function startMarqueeDrag(startClientX, startClientY) {
    const rect = gridBodyRef.current?.getBoundingClientRect(); if (!rect) return
    const anchorX = startClientX - rect.left + scrollLeftRef.current
    const anchorY = startClientY - rect.top  + scrollTopRef.current - HEADER_H
    dragRef.current = { type: 'marquee' }
    setSelectedIds(new Set())

    const mEl = marqueeRef.current
    if (mEl) { mEl.style.display = 'block'; mEl.style.left = `${anchorX}px`; mEl.style.top = `${HEADER_H + anchorY}px`; mEl.style.width = '0px'; mEl.style.height = '0px' }

    const onMove = e => {
      const curX = e.clientX - rect.left + scrollLeftRef.current
      const curY = e.clientY - rect.top  + scrollTopRef.current - HEADER_H
      if (mEl) {
        mEl.style.left   = `${Math.min(anchorX, curX)}px`
        mEl.style.top    = `${HEADER_H + Math.min(anchorY, curY)}px`
        mEl.style.width  = `${Math.abs(curX - anchorX)}px`
        mEl.style.height = `${Math.abs(curY - anchorY)}px`
      }
    }

    const onUp = e => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (mEl) mEl.style.display = 'none'
      dragRef.current = null

      const curX  = e.clientX - rect.left + scrollLeftRef.current
      const curY  = e.clientY - rect.top  + scrollTopRef.current - HEADER_H
      const selL  = Math.min(anchorX, curX); const selR = Math.max(anchorX, curX)
      const selT  = Math.min(anchorY, curY); const selB = Math.max(anchorY, curY)
      if (selR - selL < 4 && selB - selT < 4) return  // tiny drag = click, skip

      const sp    = spacingRef.current
      const grm   = goalRowMapRef.current
      const hit   = new Set()
      milestonesRef.current.forEach(m => {
        const row = grm[m.goalId]; if (!row) return
        const mL  = m.startCol * sp.colW; const mR = (m.startCol + m.duration) * sp.colW
        if (mR > selL && mL < selR && row.top + row.height > selT && row.top < selB) hit.add(m.id)
      })
      setSelectedIds(hit)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ── Dependency drawing ─────────────────────────────────────────────────────
  const handleDepEdgeClick = useCallback(async (milestoneId, side) => {
    if (side === 'right') {
      // Start drawing an arrow from the right edge of this milestone
      drawingRef.current = { fromId: milestoneId }
      setDrawingState({ fromId: milestoneId })
    } else {
      // Left edge: complete the arrow (or cancel if same milestone / no source)
      const fromId = drawingRef.current?.fromId
      drawingRef.current = null
      setDrawingState(null)
      if (previewArrowRef.current) previewArrowRef.current.style.display = 'none'
      if (!fromId || fromId === milestoneId) return
      if (hasCycle(fromId, milestoneId, dependenciesRef.current)) return
      if (dependenciesRef.current.some(d => d.fromId === fromId && d.toId === milestoneId)) return
      try {
        const dep = await api.createDependency({ from_id: fromId, to_id: milestoneId })
        setDependencies(prev => [...prev, dep])
      } catch (err) { console.error(err) }
    }
  }, []) // eslint-disable-line

  // ── Deadlines ──────────────────────────────────────────────────────────────
  const handleSetDeadline = useCallback(async (goalId, col) => {
    try {
      const dl = await api.setDeadline(goalId, col)
      setDeadlines(prev => { const next = prev.filter(d => d.goalId !== goalId); return [...next, dl] })
    } catch (err) { console.error(err) }
  }, [])

  const handleRemoveDeadline = useCallback(async goalId => {
    try {
      await api.removeDeadline(goalId)
      setDeadlines(prev => prev.filter(d => d.goalId !== goalId))
    } catch (err) { console.error(err) }
  }, [])

  // ── Milestone mouse-down (move / resize) ───────────────────────────────────
  const handleMilestoneMouseDown = useCallback((e, milestoneId, side) => {
    e.stopPropagation()
    if (e.button !== 0) return
    setContextMenu(null)
    if (modeRef.current === 'dependency') return  // handled by handleDepEdgeClick

    if (side) {
      startResizeDrag(e.clientX, milestoneId, side)
      return
    }

    const alreadySelected = selectedIdsRef.current.has(milestoneId)
    const idsToMove = alreadySelected ? [...selectedIdsRef.current] : [milestoneId]
    // Always call setSelectedIds — this triggers a re-render that picks up dragRef.current.originals
    // so dragged milestones are never culled from visMilestones during the drag.
    setSelectedIds(new Set(idsToMove))

    const originals = {}
    idsToMove.forEach(id => {
      const m = milestonesRef.current.find(m => m.id === id)
      if (m) originals[id] = { startCol: m.startCol, duration: m.duration }
    })
    startMoveDrag(e.clientX, originals)
  }, []) // eslint-disable-line

  // ── Grid mouse-down (marquee / deselect) ──────────────────────────────────
  const handleGridMouseDown = useCallback(e => {
    if (e.button !== 0) return
    setContextMenu(null)
    // In dep mode: any background click cancels in-progress arrow drawing
    if (modeRef.current === 'dependency') {
      if (drawingRef.current) {
        drawingRef.current = null
        setDrawingState(null)
        if (previewArrowRef.current) previewArrowRef.current.style.display = 'none'
      }
      return
    }
    const rect = gridBodyRef.current?.getBoundingClientRect(); if (!rect) return
    if (e.clientY - rect.top < HEADER_H) return  // in time axis
    if (e.target.closest('[data-ms-id]')) return  // handled by milestone
    startMarqueeDrag(e.clientX, e.clientY)
  }, []) // eslint-disable-line

  // ── Virtual ranges ─────────────────────────────────────────────────────────
  const { colW, rowH } = spacing
  // Milestone geometry — clamp to fit within row height
  const msH = Math.min(MILESTONE_H, Math.max(4, rowH - 8))
  const msY = Math.max(2, Math.floor((rowH - msH) / 2))

  const startCol = Math.max(0,         Math.floor(scrollLeft / colW) - COL_BUF)
  const endCol   = Math.min(totalDays, Math.ceil((scrollLeft + vpSize.w) / colW) + COL_BUF)
  const visCols  = Array.from({ length: Math.max(0, endCol - startCol) }, (_, i) => startCol + i)

  const bufH    = ROW_BUF * rowH
  const visItems = rowItems.filter(r => r.top + r.height >= scrollTop - bufH && r.top <= scrollTop + vpSize.h + bufH)

  // Milestones: filter to visible columns + rows + always include dragged
  const draggedIds = dragRef.current?.type === 'move'
    ? new Set(Object.keys(dragRef.current?.originals || {}))
    : new Set()

  const visMilestones = milestones.filter(m => {
    if (draggedIds.has(m.id)) return true
    if (m.startCol + m.duration < startCol || m.startCol > endCol) return false
    const row = goalRowMap[m.goalId]; if (!row) return false
    return row.top + row.height >= scrollTop - bufH && row.top <= scrollTop + vpSize.h + bufH
  })

  const inLaneMode = Boolean(activeDimId)

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>
      <GanttToolbar
        dimensions={dimensions} activeDimId={activeDimId} onDimChange={setActiveDimId}
        spacing={spacing} onSpacingChange={handleSpacingChange}
        mode={mode} onModeChange={setMode}
      />

      <div className={styles.canvasRow}>

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div className={styles.leftPanel}>
          <div className={styles.corner} />
          <div className={styles.leftBodyClip}>
            <div ref={leftBodyInnerRef} className={styles.leftBodyInner} style={{ height: totalContentH }}>
              {visItems.map((item, idx) => {
                if (item.type === 'lane-gap')
                  return <div key={`lg-${idx}`} className={styles.laneGap} style={{ top: item.top, height: item.height }} />
                if (item.type === 'lane-header')
                  return (
                    <div key={`lh-${item.cat?.id ?? 'none'}`} className={styles.laneHdr}
                      style={{ top: item.top, height: item.height, borderLeftColor: item.cat?.color ?? '#bbb', background: item.cat ? `${item.cat.color}18` : '#f3f3f3' }}>
                      <span className={styles.laneHdrName}>{item.cat?.name ?? 'Unassigned'}</span>
                    </div>
                  )
                if (item.type === 'goal')
                  return (
                    <div key={item.goal.id}
                      className={inLaneMode ? styles.goalRowLane : styles.goalRow}
                      style={{ top: item.top, height: item.height, borderLeftColor: item.cat?.color ?? 'transparent' }}>
                      <span className={styles.goalTitle}>{item.goal.title}</span>
                    </div>
                  )
                return <div key={`em-${idx}`} className={styles.emptyRow} style={{ top: item.top, height: item.height }} />
              })}
            </div>
          </div>
        </div>

        {/* ── Grid body ───────────────────────────────────────────────────── */}
        <div ref={gridBodyRef} className={styles.gridBody}
          onScroll={handleScroll}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onMouseDown={handleGridMouseDown}
          onContextMenu={handleContextMenu}>

          <div ref={gridInnerRef} className={styles.gridInner}
            style={{ width: totalDays * colW, height: totalContentH + HEADER_H, '--col-w': `${colW}px` }}>

            {/* Sticky time axis */}
            <div className={styles.timeAxis}>
              {visCols.map(ci => {
                const date = colToDate(ci)
                const dow  = date.getDay()
                const isToday   = ci === 0
                const isWeekend = dow === 0 || dow === 6
                return (
                  <div key={ci}
                    className={[styles.dayHeader, isToday && styles.dayHeaderToday, isWeekend && !isToday && styles.dayHeaderWeekend].filter(Boolean).join(' ')}
                    style={{ left: ci * colW, width: colW }}>
                    <span className={styles.monthLabel}>
                      {MONTH_ABR[date.getMonth()]}
                    </span>
                    <span className={[styles.dayNum, isToday && styles.dayNumToday].filter(Boolean).join(' ')}>
                      {date.getDate()}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Today + weekend column tints */}
            <div className={styles.todayCol} style={{ left: 0, width: colW }} />
            {visCols.map(ci => {
              const dow = colToDate(ci).getDay()
              return (dow === 0 || dow === 6)
                ? <div key={`wk-${ci}`} className={styles.weekendCol} style={{ left: ci * colW, width: colW }} />
                : null
            })}

            {/* Row stripes */}
            {visItems.map((item, idx) => {
              if (item.type === 'lane-gap')
                return <div key={`gg-${idx}`} className={styles.gridLaneGap} style={{ top: HEADER_H + item.top, height: item.height }} />
              if (item.type === 'lane-header')
                return <div key={`gh-${item.cat?.id ?? 'none'}`} className={styles.gridLaneHdr}
                  style={{ top: HEADER_H + item.top, height: item.height, background: item.cat ? `${item.cat.color}0d` : 'rgba(0,0,0,0.02)' }} />
              if (item.type === 'goal')
                return <div key={`gr-${item.goal.id}`} className={styles.gridGoalRow} style={{ top: HEADER_H + item.top, height: item.height }} />
              return null
            })}

            {/* Hard deadline markers */}
            {deadlines.map(dl => {
              const row = goalRowMap[dl.goalId]; if (!row) return null
              if (dl.col < startCol - 1 || dl.col > endCol + 1) return null
              return (
                <div key={`dl-${dl.goalId}`} className={styles.deadlineLine}
                  style={{ left: dl.col * colW, top: HEADER_H + row.top, height: row.height }} />
              )
            })}

            {/* Milestones */}
            {visMilestones.map(m => {
              const row = goalRowMap[m.goalId]; if (!row) return null
              const isSelected  = selectedIds.has(m.id)
              const isViolating = violationIds.has(m.id)
              const isDepMode   = mode === 'dependency'
              const isSource    = drawingState?.fromId === m.id
              return (
                <div key={m.id}
                  data-ms-id={m.id}
                  ref={el => { el ? milestoneElsRef.current.set(m.id, el) : milestoneElsRef.current.delete(m.id) }}
                  className={[
                    styles.milestone,
                    isSelected  && styles.milestoneSelected,
                    isViolating && styles.milestoneViolation,
                    isDepMode   && styles.milestoneDepMode,
                  ].filter(Boolean).join(' ')}
                  style={{
                    left:       m.startCol * colW,
                    top:        HEADER_H + row.top + msY,
                    width:      m.duration * colW,
                    height:     msH,
                    background: m.color,
                  }}
                  onMouseDown={e => handleMilestoneMouseDown(e, m.id, null)}>
                  <div
                    className={[styles.msHandle, isDepMode && styles.depHandle, isDepMode && isSource && styles.depHandleSource].filter(Boolean).join(' ')}
                    data-ms-id={m.id}
                    onMouseDown={e => {
                      e.stopPropagation()
                      if (isDepMode) handleDepEdgeClick(m.id, 'left')
                      else handleMilestoneMouseDown(e, m.id, 'left')
                    }} />
                  <span className={styles.msLabel}>{m.title || dateFmt(m.startCol)}</span>
                  <div
                    className={[styles.msHandle, styles.msHandleRight, isDepMode && styles.depHandle, isDepMode && isSource && styles.depHandleSource].filter(Boolean).join(' ')}
                    data-ms-id={m.id}
                    onMouseDown={e => {
                      e.stopPropagation()
                      if (isDepMode) handleDepEdgeClick(m.id, 'right')
                      else handleMilestoneMouseDown(e, m.id, 'right')
                    }} />
                </div>
              )
            })}

            {/* Dependency arrows SVG — pointer-events none on container, individual paths can override */}
            <svg className={styles.depSvg}
              style={{ width: totalDays * colW, height: totalContentH + HEADER_H }}>
              <defs>
                <marker id="dep-arrow" markerWidth="8" markerHeight="7" refX="7" refY="3.5" orient="auto">
                  <path d="M0,0 L0,7 L8,3.5 z" fill="#5b8dee" />
                </marker>
                <marker id="dep-arrow-viol" markerWidth="8" markerHeight="7" refX="7" refY="3.5" orient="auto">
                  <path d="M0,0 L0,7 L8,3.5 z" fill="#ef4444" />
                </marker>
              </defs>
              {dependencies.map(dep => {
                const from = milestones.find(m => m.id === dep.fromId)
                const to   = milestones.find(m => m.id === dep.toId)
                if (!from || !to) return null
                const fromRow = goalRowMap[from.goalId]; const toRow = goalRowMap[to.goalId]
                if (!fromRow || !toRow) return null
                const x1 = (from.startCol + from.duration) * colW
                const y1 = HEADER_H + fromRow.top + Math.floor(fromRow.height / 2)
                const x2 = to.startCol * colW
                const y2 = HEADER_H + toRow.top + Math.floor(toRow.height / 2)
                const cp = Math.max(40, Math.abs(x2 - x1) * 0.45)
                const isViol = violationIds.has(dep.toId)
                return (
                  <path key={dep.id}
                    d={`M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`}
                    stroke={isViol ? '#ef4444' : '#5b8dee'} strokeWidth="1.5" fill="none"
                    strokeOpacity="0.8" markerEnd={`url(#dep-arrow${isViol ? '-viol' : ''})`}
                  />
                )
              })}
              {/* Live preview arrow while drawing */}
              <path ref={previewArrowRef} style={{ display: 'none' }}
                stroke="#5b8dee" strokeWidth="1.5" fill="none"
                strokeDasharray="5,3" strokeOpacity="0.9" markerEnd="url(#dep-arrow)" />
            </svg>

            {/* Marquee selection rect */}
            <div ref={marqueeRef} className={styles.marqueeRect} />

            {/* Hover highlight */}
            <div ref={highlightRef} className={styles.cellHighlight} />

          </div>
        </div>

      </div>

      <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)}
        onCreate={handleCreateMilestone}
        onInsertDay={handleInsertDay}
        onDeleteDay={handleDeleteDay}
        onSetDeadline={handleSetDeadline}
        onRemoveDeadline={handleRemoveDeadline} />
    </div>
  )
}
