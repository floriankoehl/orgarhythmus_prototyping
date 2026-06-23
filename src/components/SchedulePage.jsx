import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import styles from './SchedulePage.module.css'
import { api } from '../api'

// ── Constants ─────────────────────────────────────────────────────────────────
const TOTAL_DAYS    = 3650   // virtual grid width (~10 years)
const ORIGIN        = 1825   // column index for today
const HEADER_H      = 52     // time-axis header height (px)
const LANE_HDR_H    = 30     // lane/category header row height (px)
const COL_BUF       = 5
const ROW_BUF       = 3
const MIN_ROWS      = 20

const DEFAULT_SPACING = { colW: 44, rowH: 36, rowGap: 0, laneGap: 28 }

const DAY_ABR   = ['Su','Mo','Tu','We','Th','Fr','Sa']
const MONTH_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function colToDate(col) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + col - ORIGIN)
  return d
}

// ── Row model ─────────────────────────────────────────────────────────────────
// Returns a flat list of items with absolute `top` and `height` values.
// Types: 'lane-gap' | 'lane-header' | 'goal' | 'empty'
function buildRowItems(goals, categories, assignments, activeDimId, spacing) {
  const { rowH, rowGap, laneGap } = spacing
  const slotH = rowH + rowGap

  if (!activeDimId) {
    const items = goals.map((g, i) => ({
      type: 'goal', goal: g, cat: null,
      top: i * slotH, height: slotH,
    }))
    const padTo = Math.max(goals.length, MIN_ROWS)
    for (let i = goals.length; i < padTo; i++) {
      items.push({ type: 'empty', top: i * slotH, height: slotH })
    }
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

  const items = []
  let top = 0

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

  // Pad to minimum visual height
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

// ── Toolbar ───────────────────────────────────────────────────────────────────
function GanttToolbar({ dimensions, activeDimId, onDimChange, spacing, onSpacingChange }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsBtnRef = useRef()
  const closeSettings  = useCallback(() => setSettingsOpen(false), [])

  return (
    <div className={styles.toolbar}>
      {/* Mode toggle — placeholder, fills out later */}
      <div className={styles.modePills}>
        <button className={`${styles.modePill} ${styles.modePillActive}`}>Edit</button>
        <button className={styles.modePill}>Dependencies</button>
      </div>

      <div className={styles.toolbarDiv} />

      {/* Dimension selector */}
      <span className={styles.toolbarLabel}>Dimension</span>
      <select className={styles.dimSelect} value={activeDimId}
        onChange={e => onDimChange(e.target.value)}>
        <option value="">None</option>
        {dimensions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>

      <div style={{ flex: 1 }} />

      {/* Spacing settings */}
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

// ── Main component ────────────────────────────────────────────────────────────
export default function SchedulePage({ goals = [], isActive = false }) {
  // ── API data ───────────────────────────────────────────────────────────────
  const [dimensions, setDimensions] = useState([])
  const [categories, setCategories] = useState([])
  const [assignments, setAssignments] = useState({})

  useEffect(() => {
    if (!isActive) return
    Promise.all([api.getDimensions(), api.getAllCategories(), api.getAssignments()])
      .then(([dims, cats, assigns]) => {
        setDimensions(dims)
        setCategories(cats)
        const map = {}
        assigns.forEach(a => {
          if (!map[a.goalId]) map[a.goalId] = {}
          map[a.goalId][a.dimensionId] = a.categoryId
        })
        setAssignments(map)
      })
      .catch(console.error)
  }, [isActive])

  // ── Toolbar state ──────────────────────────────────────────────────────────
  const [activeDimId, setActiveDimId] = useState('')
  const [spacing, setSpacing]         = useState(DEFAULT_SPACING)

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const gridBodyRef      = useRef()   // single scroll container
  const leftBodyInnerRef = useRef()   // translated by -scrollTop
  const highlightRef     = useRef()   // hover cell
  const scrollLeftRef    = useRef(0)
  const scrollTopRef     = useRef(0)
  const initializedRef   = useRef(false)
  const hoveredCellRef   = useRef(null)  // { col, item } — read by future milestone code
  const rowItemsRef      = useRef([])
  const spacingRef       = useRef(spacing)
  const vpRef            = useRef({ w: 0, h: 0 })

  useEffect(() => { spacingRef.current = spacing }, [spacing])

  // ── Virtual-render state ───────────────────────────────────────────────────
  const [vpSize, setVpSize]         = useState({ w: 0, h: 0 })
  const [scrollLeft, setScrollLeft] = useState(0)
  const [scrollTop,  setScrollTop]  = useState(0)

  // ── Row model ──────────────────────────────────────────────────────────────
  const rowItems = useMemo(
    () => buildRowItems(goals, categories, assignments, activeDimId, spacing),
    [goals, categories, assignments, activeDimId, spacing]
  )
  rowItemsRef.current = rowItems

  const totalContentH = rowItems.length > 0
    ? rowItems[rowItems.length - 1].top + rowItems[rowItems.length - 1].height
    : MIN_ROWS * spacing.rowH

  // ── Measure ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = gridBodyRef.current
    if (!el) return
    const obs = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect
      vpRef.current = { w: width, h: height }
      setVpSize({ w: width, h: height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // ── Initial scroll: center today ───────────────────────────────────────────
  useEffect(() => {
    if (initializedRef.current || vpSize.w === 0 || !gridBodyRef.current) return
    initializedRef.current = true
    gridBodyRef.current.scrollLeft = Math.max(0, ORIGIN * spacing.colW - Math.round(vpSize.w / 2))
  }, [vpSize.w])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scroll handler ─────────────────────────────────────────────────────────
  // Time axis no longer needs sync (position: sticky handles it).
  // Only the left panel body needs translateY.
  const handleScroll = useCallback(() => {
    const el = gridBodyRef.current
    if (!el) return
    scrollLeftRef.current = el.scrollLeft
    scrollTopRef.current  = el.scrollTop
    if (leftBodyInnerRef.current) {
      leftBodyInnerRef.current.style.transform = `translateY(${-el.scrollTop}px)`
    }
    setScrollLeft(el.scrollLeft)
    setScrollTop(el.scrollTop)
  }, [])

  // ── Mouse tracking ─────────────────────────────────────────────────────────
  const handleMouseMove = useCallback(e => {
    const rect = gridBodyRef.current?.getBoundingClientRect()
    if (!rect) return
    const sp   = spacingRef.current
    const rawX = e.clientX - rect.left + scrollLeftRef.current
    const rawY = e.clientY - rect.top  + scrollTopRef.current - HEADER_H
    if (rawY < 0) { if (highlightRef.current) highlightRef.current.style.display = ''; return }
    const col = Math.floor(rawX / sp.colW)
    if (col < 0 || col >= TOTAL_DAYS) return
    const item = rowItemsRef.current.find(r => rawY >= r.top && rawY < r.top + r.height)
    if (!item || item.type !== 'goal') {
      if (highlightRef.current) highlightRef.current.style.display = ''; return
    }
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
  }, [])

  // ── Spacing change with scroll compensation ────────────────────────────────
  const handleSpacingChange = useCallback(next => {
    const prev = spacingRef.current
    if (next.colW !== prev.colW && gridBodyRef.current) {
      const centerDay  = (scrollLeftRef.current + vpRef.current.w / 2) / prev.colW
      const newLeft    = centerDay * next.colW - vpRef.current.w / 2
      gridBodyRef.current.scrollLeft = Math.max(0, Math.round(newLeft))
    }
    setSpacing(next)
  }, [])

  // ── Virtual ranges ─────────────────────────────────────────────────────────
  const { colW, rowH } = spacing

  const startCol = Math.max(0,          Math.floor(scrollLeft / colW) - COL_BUF)
  const endCol   = Math.min(TOTAL_DAYS, Math.ceil((scrollLeft + vpSize.w) / colW) + COL_BUF)
  const visCols  = Array.from({ length: Math.max(0, endCol - startCol) }, (_, i) => startCol + i)

  const bufH     = ROW_BUF * rowH
  const visItems = rowItems.filter(r =>
    r.top + r.height >= scrollTop - bufH &&
    r.top            <= scrollTop + vpSize.h + bufH
  )

  const inLaneMode = Boolean(activeDimId)

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>
      <GanttToolbar
        dimensions={dimensions}
        activeDimId={activeDimId}
        onDimChange={setActiveDimId}
        spacing={spacing}
        onSpacingChange={handleSpacingChange}
      />

      <div className={styles.canvasRow}>

        {/* ── Fixed left panel ─────────────────────────────────────────── */}
        <div className={styles.leftPanel}>
          <div className={styles.corner} />
          <div className={styles.leftBodyClip}>
            <div ref={leftBodyInnerRef} className={styles.leftBodyInner}
              style={{ height: totalContentH }}>

              {visItems.map((item, idx) => {
                if (item.type === 'lane-gap') {
                  return <div key={`lg-${idx}`} className={styles.laneGap}
                    style={{ top: item.top, height: item.height }} />
                }
                if (item.type === 'lane-header') {
                  return (
                    <div key={`lh-${item.cat?.id ?? 'none'}`} className={styles.laneHdr}
                      style={{
                        top: item.top, height: item.height,
                        borderLeftColor: item.cat?.color ?? '#bbb',
                        background: item.cat ? `${item.cat.color}18` : '#f3f3f3',
                      }}>
                      <span className={styles.laneHdrName}>
                        {item.cat?.name ?? 'Unassigned'}
                      </span>
                    </div>
                  )
                }
                if (item.type === 'goal') {
                  return (
                    <div key={item.goal.id}
                      className={inLaneMode ? styles.goalRowLane : styles.goalRow}
                      style={{
                        top: item.top, height: item.height,
                        borderLeftColor: item.cat?.color ?? 'transparent',
                      }}>
                      <span className={styles.goalTitle}>{item.goal.title}</span>
                    </div>
                  )
                }
                return <div key={`em-${idx}`} className={styles.emptyRow}
                  style={{ top: item.top, height: item.height }} />
              })}

            </div>
          </div>
        </div>

        {/* ── Grid body (the single scroll container) ───────────────────── */}
        <div ref={gridBodyRef} className={styles.gridBody}
          onScroll={handleScroll}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}>

          <div className={styles.gridInner}
            style={{
              width:  TOTAL_DAYS * colW,
              height: totalContentH + HEADER_H,
              '--col-w': `${colW}px`,
            }}>

            {/* Time axis — sticky top, scrolls horizontally with grid */}
            <div className={styles.timeAxis}>
              {visCols.map(ci => {
                const date     = colToDate(ci)
                const dow      = date.getDay()
                const isToday  = ci === ORIGIN
                const isWeekend = dow === 0 || dow === 6
                const isMonthStart = date.getDate() === 1
                return (
                  <div key={ci}
                    className={[
                      styles.dayHeader,
                      isToday              && styles.dayHeaderToday,
                      isWeekend && !isToday && styles.dayHeaderWeekend,
                    ].filter(Boolean).join(' ')}
                    style={{ left: ci * colW, width: colW }}>
                    <span className={isMonthStart ? styles.monthLabel : styles.dayAbr}>
                      {isMonthStart ? MONTH_ABR[date.getMonth()] : DAY_ABR[dow]}
                    </span>
                    <span className={[styles.dayNum, isToday && styles.dayNumToday].filter(Boolean).join(' ')}>
                      {date.getDate()}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Today column tint */}
            <div className={styles.todayCol} style={{ left: ORIGIN * colW, width: colW }} />

            {/* Weekend tints */}
            {visCols.map(ci => {
              const dow = colToDate(ci).getDay()
              if (dow !== 0 && dow !== 6) return null
              return <div key={`wk-${ci}`} className={styles.weekendCol}
                style={{ left: ci * colW, width: colW }} />
            })}

            {/* Row stripes — mirror the left panel structure */}
            {visItems.map((item, idx) => {
              if (item.type === 'lane-gap') {
                return <div key={`gg-${idx}`} className={styles.gridLaneGap}
                  style={{ top: HEADER_H + item.top, height: item.height }} />
              }
              if (item.type === 'lane-header') {
                return <div key={`gh-${item.cat?.id ?? 'none'}`} className={styles.gridLaneHdr}
                  style={{
                    top: HEADER_H + item.top, height: item.height,
                    background: item.cat ? `${item.cat.color}0d` : 'rgba(0,0,0,0.02)',
                  }} />
              }
              if (item.type === 'goal') {
                return <div key={`gr-${item.goal.id}`} className={styles.gridGoalRow}
                  style={{ top: HEADER_H + item.top, height: item.height }} />
              }
              return null
            })}

            {/* Cell hover highlight — all geometry via CSS custom properties set imperatively */}
            <div ref={highlightRef} className={styles.cellHighlight} />

          </div>
        </div>

      </div>
    </div>
  )
}
