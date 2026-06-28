import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import styles from './CalendarPage.module.css'

const DAY_MINUTES = 24 * 60
const HOUR_HEIGHT = 54
const UNASSIGNED_CATEGORY_ID = '__unassigned__'
const VIEW_OPTIONS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: '7 days' },
  { id: 'month', label: 'Month' },
]

function localMidnight(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function projectAnchor(project) {
  const raw = project?.createdAt
  if (!raw) return localMidnight()
  const match = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return localMidnight()
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function addMinutes(date, minutes) {
  const next = new Date(date)
  next.setMinutes(next.getMinutes() + minutes)
  return next
}

function minutesBetweenDates(start, end) {
  return Math.round((end.getTime() - start.getTime()) / 60000)
}

function calendarMonthBoundaryMinute(anchor, col) {
  const target = new Date(anchor.getFullYear(), anchor.getMonth() + col, 1)
  return minutesBetweenDates(anchor, target)
}

function calendarMonthColForMinute(anchor, minute, mode = 'floor') {
  const value = Math.max(0, Number(minute) || 0)
  let col = Math.max(0, Math.floor(value / (60 * 24 * 30)))
  while (calendarMonthBoundaryMinute(anchor, col + 1) <= value) col += 1
  while (col > 0 && calendarMonthBoundaryMinute(anchor, col) > value) col -= 1
  if (mode === 'ceil' && calendarMonthBoundaryMinute(anchor, col) < value) col += 1
  return col
}

function isCalendarMonthBoundary(anchor, minute) {
  const value = Math.max(0, Number(minute) || 0)
  return calendarMonthBoundaryMinute(anchor, calendarMonthColForMinute(anchor, value, 'floor')) === value
}

function isCalendarMonthRange(anchor, startCol, duration) {
  const start = Math.max(0, Number(startCol) || 0)
  const end = start + Math.max(0, Number(duration) || 0)
  return end > start && isCalendarMonthBoundary(anchor, start) && isCalendarMonthBoundary(anchor, end)
}

function timeSlotScale(slot, anchor) {
  const duration = Math.max(1, Number(slot?.duration) || 1)
  if (isCalendarMonthRange(anchor, slot?.startCol, duration)) return 'month'
  if (duration < DAY_MINUTES) return 'minute'
  if (duration < DAY_MINUTES * 30) return 'day'
  return 'month'
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

function dayKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function fmtDay(date) {
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function fmtMonth(date) {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function fmtTime(date) {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function overlapsDay(event, day) {
  const start = localMidnight(day)
  const end = addDays(start, 1)
  return event.start < end && event.end > start
}

function overlapsRange(event, start, end) {
  return event.start < end && event.end > start
}

function rangeLabel(event, day = null) {
  if (!day || isSameDay(event.start, event.end)) return `${fmtTime(event.start)} - ${fmtTime(event.end)}`
  if (isSameDay(event.start, day)) return `${fmtTime(event.start)} - continues`
  if (isSameDay(event.end, day)) return `until ${fmtTime(event.end)}`
  return 'all day'
}

function scaleLabel(scale) {
  if (scale === 'month') return 'Phase'
  if (scale === 'day') return 'Day'
  return 'Exact'
}

function layoutTimedEvents(events, day) {
  const timed = events.map(event => {
    const start = Math.max(0, (event.start - day) / 60000)
    const end = Math.min(DAY_MINUTES, (event.end - day) / 60000)
    return { ...event, startMinute: start, endMinute: Math.max(start + 1, end) }
  }).sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute)

  const groups = []
  let current = []
  let groupEnd = -1
  timed.forEach(event => {
    if (current.length === 0 || event.startMinute < groupEnd) {
      current.push(event)
      groupEnd = Math.max(groupEnd, event.endMinute)
    } else {
      groups.push(current)
      current = [event]
      groupEnd = event.endMinute
    }
  })
  if (current.length) groups.push(current)

  return groups.flatMap(group => {
    const columns = []
    const placed = group.map(event => {
      let col = columns.findIndex(end => end <= event.startMinute)
      if (col === -1) {
        col = columns.length
        columns.push(event.endMinute)
      } else {
        columns[col] = event.endMinute
      }
      return { ...event, layoutCol: col }
    })
    const colCount = Math.max(1, columns.length)
    return placed.map(event => ({ ...event, layoutCols: colCount }))
  })
}

function buildMonthDays(today) {
  const first = new Date(today.getFullYear(), today.getMonth(), 1)
  const start = addDays(first, -first.getDay())
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

function colorStyle(color) {
  return {
    '--event-color': color || '#1a73e8',
  }
}

function dimensionSwatches(dim, categories) {
  return categories.filter(cat => cat.dimensionId === dim.id).slice(0, 3)
}

function assignmentMapFromRows(rows) {
  const map = {}
  ;(rows || []).forEach(row => {
    if (!row.noteId || !row.dimensionId) return
    map[row.noteId] = map[row.noteId] || {}
    map[row.noteId][row.dimensionId] = row.categoryId
  })
  return map
}

function CalendarCategoryVisibilityDropdown({ categories, hiddenCatIds, onToggle, onShowAll, onHideAll }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const close = e => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const shownCount = categories.filter(cat => !hiddenCatIds.has(cat.id)).length

  return (
    <div ref={wrapRef} className={styles.categoryFilterWrap}>
      <button
        className={`${styles.categoryFilterBtn} ${open ? styles.categoryFilterBtnOpen : ''}`}
        onClick={() => setOpen(value => !value)}>
        {shownCount}/{categories.length} visible
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}>
          <path d="M7 10l5 5 5-5z"/>
        </svg>
      </button>
      {open && (
        <div className={styles.categoryFilterMenu}>
          {categories.length === 0 ? (
            <div className={styles.categoryFilterEmpty}>No categories</div>
          ) : (
            <>
              <div className={styles.categoryFilterBulkRow}>
                <button className={styles.categoryFilterAll} onClick={onShowAll}>Show all</button>
                <button className={styles.categoryFilterAll} onClick={onHideAll}>Hide all</button>
              </div>
              {categories.map((cat, index) => {
                const isUnassigned = cat.id === UNASSIGNED_CATEGORY_ID
                return (
                  <label key={cat.id} className={styles.categoryFilterItem}
                    style={isUnassigned && index > 0 ? { borderTop: '1px solid #f0f0f0', marginTop: 2 } : undefined}>
                    <input type="checkbox" checked={!hiddenCatIds.has(cat.id)} onChange={() => onToggle(cat.id)} />
                    <span className={styles.categoryFilterDot} style={{ background: cat.color || '#aaa' }} />
                    <span className={styles.categoryFilterName} style={isUnassigned ? { color: '#888', fontStyle: 'italic' } : undefined}>
                      {cat.name}
                    </span>
                  </label>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function CalendarGroupScroller({
  dimensions, categories, activeCategories, activeDimId, focusedCatId,
  onDimensionChange, onCategoryChange,
}) {
  const wheelAtRef = useRef(0)
  const categoryWheelAtRef = useRef(0)
  const pickerRef = useRef(null)
  const categoryPickerRef = useRef(null)
  const [dimensionMenuOpen, setDimensionMenuOpen] = useState(false)
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)

  const activeIndex = activeDimId ? dimensions.findIndex(dim => dim.id === activeDimId) : -1
  const currentDim = activeIndex >= 0 ? dimensions[activeIndex] : null
  const focusedCategory = activeCategories.find(cat => cat.id === focusedCatId) || null
  const focusedCategoryIndex = focusedCategory ? activeCategories.findIndex(cat => cat.id === focusedCategory.id) : -1
  const canCycleDimension = dimensions.length > 0
  const canCycleCategory = activeCategories.length > 0

  const selectDimensionIndex = index => {
    if (!canCycleDimension) return
    onDimensionChange(dimensions[(index + dimensions.length) % dimensions.length].id)
  }
  const prevDimension = () => selectDimensionIndex(activeIndex >= 0 ? activeIndex - 1 : dimensions.length - 1)
  const nextDimension = () => selectDimensionIndex(activeIndex >= 0 ? activeIndex + 1 : 0)
  const selectCategoryIndex = index => {
    if (!canCycleCategory) return
    onCategoryChange(activeCategories[(index + activeCategories.length) % activeCategories.length].id)
  }
  const prevCategory = () => selectCategoryIndex(focusedCategoryIndex >= 0 ? focusedCategoryIndex - 1 : activeCategories.length - 1)
  const nextCategory = () => selectCategoryIndex(focusedCategoryIndex >= 0 ? focusedCategoryIndex + 1 : 0)

  const cycleDimension = e => {
    e.preventDefault()
    const now = Date.now()
    if (now - wheelAtRef.current < 180) return
    wheelAtRef.current = now
    e.deltaY > 0 ? nextDimension() : prevDimension()
  }
  const cycleCategory = e => {
    if (!canCycleCategory) return
    e.preventDefault()
    const now = Date.now()
    if (now - categoryWheelAtRef.current < 180) return
    categoryWheelAtRef.current = now
    e.deltaY > 0 ? nextCategory() : prevCategory()
  }

  useEffect(() => {
    if (!dimensionMenuOpen && !categoryMenuOpen) return
    const close = e => {
      if (!pickerRef.current?.contains(e.target)) setDimensionMenuOpen(false)
      if (!categoryPickerRef.current?.contains(e.target)) setCategoryMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [categoryMenuOpen, dimensionMenuOpen])

  return (
    <div className={styles.groupScroller}>
      <div className={styles.groupScrollerUnit} onWheel={cycleDimension}>
        <span className={styles.groupScrollerLabel}>Canvas dimension</span>
        <div ref={pickerRef} className={styles.groupScrollerRow}>
          <button className={styles.groupScrollerArrow} onClick={prevDimension} disabled={!canCycleDimension} title="Previous dimension">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <button className={styles.groupScrollerName} onClick={() => setDimensionMenuOpen(value => !value)}
            disabled={!canCycleDimension} title="Pick canvas dimension">
            <span className={styles.groupScrollerSwatches}>
              {(currentDim ? dimensionSwatches(currentDim, categories) : []).map(cat => <b key={cat.id} style={{ background: cat.color || '#aaa' }} />)}
              {(!currentDim || dimensionSwatches(currentDim, categories).length === 0) && <b style={{ background: '#9ca3af' }} />}
            </span>
            <span className={styles.groupScrollerText}>{currentDim?.name ?? 'None'}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
          </button>
          <button className={styles.groupScrollerArrow} onClick={nextDimension} disabled={!canCycleDimension} title="Next dimension">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18l6-6-6-6"/></svg>
          </button>
          {dimensionMenuOpen && (
            <div className={styles.groupScrollerMenu}>
              {dimensions.map(dim => (
                <button key={dim.id}
                  className={dim.id === activeDimId ? styles.groupScrollerMenuItemActive : styles.groupScrollerMenuItem}
                  onClick={() => { onDimensionChange(dim.id); setDimensionMenuOpen(false) }}>
                  <span>
                    {dimensionSwatches(dim, categories).map(cat => <b key={cat.id} style={{ background: cat.color || '#aaa' }} />)}
                    {dimensionSwatches(dim, categories).length === 0 && <b style={{ background: '#9ca3af' }} />}
                  </span>
                  <strong>{dim.name}</strong>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className={styles.groupScrollerDots}>
          {dimensions.map(dim => (
            <button key={dim.id}
              className={`${styles.groupScrollerDot} ${dim.id === activeDimId ? styles.groupScrollerDotActive : ''}`}
              onClick={() => onDimensionChange(dim.id)} title={dim.name} />
          ))}
        </div>
      </div>

      {currentDim && (
        <div className={styles.groupScrollerUnit} onWheel={cycleCategory}>
          <span className={styles.groupScrollerLabel}>Category focus</span>
          <div ref={categoryPickerRef} className={styles.groupScrollerRow}>
            <button className={styles.groupScrollerArrow} onClick={prevCategory} disabled={!canCycleCategory} title="Previous category">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <button className={styles.groupScrollerName} onClick={() => setCategoryMenuOpen(value => !value)}
              disabled={!canCycleCategory} title="Pick category focus">
              <span className={styles.groupScrollerCatDot} style={{ background: focusedCategory?.color || '#9ca3af' }} />
              <span className={styles.groupScrollerText}>{focusedCategory?.name ?? 'All'}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
            <button className={styles.groupScrollerArrow} onClick={nextCategory} disabled={!canCycleCategory} title="Next category">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18l6-6-6-6"/></svg>
            </button>
            {categoryMenuOpen && (
              <div className={styles.groupScrollerMenu}>
                <button className={!focusedCatId ? styles.groupScrollerMenuItemActive : styles.groupScrollerMenuItem}
                  onClick={() => { onCategoryChange(''); setCategoryMenuOpen(false) }}>
                  <span className={styles.groupScrollerSingleSwatch}><b style={{ background: '#9ca3af' }} /></span>
                  <strong>All</strong>
                </button>
                {activeCategories.map(cat => (
                  <button key={cat.id}
                    className={cat.id === focusedCatId ? styles.groupScrollerMenuItemActive : styles.groupScrollerMenuItem}
                    onClick={() => { onCategoryChange(cat.id); setCategoryMenuOpen(false) }}>
                    <span className={styles.groupScrollerSingleSwatch}><b style={{ background: cat.color || '#aaa' }} /></span>
                    <strong>{cat.name}</strong>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={styles.groupScrollerDots}>
            {activeCategories.map(cat => (
              <button key={cat.id}
                className={`${styles.groupScrollerDot} ${cat.id === focusedCatId ? styles.groupScrollerDotActive : ''}`}
                onClick={() => onCategoryChange(cat.id)} title={cat.name} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function LegendDropUp({ dimensions, colorDimId, onColorDimension }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef()
  const menuRef = useRef()
  const [pos, setPos] = useState(null)
  const wheelAtRef = useRef(0)

  const current = dimensions.find(d => d.id === colorDimId)
  const options = ['', ...dimensions.map(d => d.id)]
  const cycleDimension = deltaY => {
    const now = Date.now()
    if (now - wheelAtRef.current < 180) return
    wheelAtRef.current = now
    const activeIdx = Math.max(0, options.indexOf(colorDimId))
    const dir = deltaY > 0 ? 1 : -1
    onColorDimension(options[(activeIdx + dir + options.length) % options.length])
  }

  const toggle = () => {
    if (!open) {
      const r = btnRef.current?.getBoundingClientRect()
      setPos({ bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width })
    }
    setOpen(value => !value)
  }

  useEffect(() => {
    if (!open) return
    const close = e => {
      if (btnRef.current?.contains(e.target)) return
      if (menuRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className={styles.dropUpWrap}>
      <button
        ref={btnRef}
        className={styles.dropUpBtn}
        onWheel={e => { e.preventDefault(); cycleDimension(e.deltaY) }}
        onClick={toggle}>
        <span className={styles.dropUpLabel}>{current?.name ?? 'Slot colors'}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className={styles.dropUpMenu}
          style={{ position: 'fixed', bottom: pos.bottom, left: pos.left, minWidth: pos.width }}>
          <button className={`${styles.dropUpOption} ${!colorDimId ? styles.dropUpActive : ''}`}
            onClick={() => { onColorDimension(''); setOpen(false) }}>Slot colors</button>
          {dimensions.map(dim => (
            <button key={dim.id}
              className={`${styles.dropUpOption} ${dim.id === colorDimId ? styles.dropUpActive : ''}`}
              onClick={() => { onColorDimension(dim.id); setOpen(false) }}>
              {dim.name}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

function ColorLegendWidget({ dimensions, categories, colorDimId, onColorDimension, expanded, onExpandedChange }) {
  const legendCats = categories.filter(cat => cat.dimensionId === colorDimId)

  return (
    <div className={styles.legendWidget}>
      {expanded && (
        <div className={styles.legendPanel} onClick={e => e.stopPropagation()}>
          <div className={styles.legendPanelHeader}>Color dimension</div>
          {!colorDimId && <div className={styles.legendEmpty}>Using schedule slot colors</div>}
          {colorDimId && legendCats.length === 0 && <div className={styles.legendEmpty}>No categories</div>}
          {legendCats.map(cat => (
            <div key={cat.id} className={styles.legendItem}>
              <span className={styles.legendDot} style={{ background: cat.color || '#aaa' }} />
              <span className={styles.legendName}>{cat.name}</span>
            </div>
          ))}
          <LegendDropUp dimensions={dimensions} colorDimId={colorDimId} onColorDimension={onColorDimension} />
        </div>
      )}

      <button
        className={`${styles.legendToggleBtn} ${expanded ? styles.legendToggleActive : ''}`}
        onClick={() => onExpandedChange(!expanded)}
        title={expanded ? 'Collapse color legend' : 'Color dimension'}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
        </svg>
      </button>
      {!expanded && (
        <span className={styles.floatingHint}>
          <strong>Color dimension</strong>
          <small>Color scheduled notes</small>
        </span>
      )}
    </div>
  )
}

function EventPill({ event, day, compact = false, onNoteOpen }) {
  return (
    <button
      type="button"
      className={`${styles.eventPill} ${compact ? styles.eventPillCompact : ''}`}
      style={colorStyle(event.color)}
      onClick={() => onNoteOpen?.(event.noteId)}
      title={`${event.title} · ${rangeLabel(event, day)}`}
    >
      <span className={styles.eventColor} />
      <span className={styles.eventText}>
        {!compact && <span className={styles.eventTime}>{scaleLabel(event.scale)} · {rangeLabel(event, day)}</span>}
        <span className={styles.eventTitle}>{event.title}</span>
        {!compact && event.locationCategory && <span className={styles.eventMeta}>{event.locationCategory.name}</span>}
      </span>
    </button>
  )
}

function SpanningEvent({ event, start, end, onNoteOpen }) {
  const left = Math.max(0, ((Math.max(event.start, start) - start) / (end - start)) * 100)
  const right = Math.max(0, ((end - Math.min(event.end, end)) / (end - start)) * 100)
  return (
    <button
      type="button"
      className={styles.spanningEvent}
      style={{ ...colorStyle(event.color), left: `${left}%`, right: `${right}%` }}
      onClick={() => onNoteOpen?.(event.noteId)}
      title={`${event.title} · ${scaleLabel(event.scale)}`}
    >
      <span>{scaleLabel(event.scale)}</span>
      <strong>{event.title}</strong>
    </button>
  )
}

export default function CalendarPage({ notes = [], project = null, isActive = false, onNoteOpen, refreshKey = 0 }) {
  const [view, setView] = useState('today')
  const [timeSlots, setTimeSlots] = useState([])
  const [dimensions, setDimensions] = useState([])
  const [categories, setCategories] = useState([])
  const [assignments, setAssignments] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [clock, setClock] = useState(() => new Date())
  const [canvasDimId, setCanvasDimId] = useState('')
  const [focusedCatId, setFocusedCatId] = useState('')
  const [colorDimId, setColorDimId] = useState('')
  const [legendOpen, setLegendOpen] = useState(false)
  const [hiddenCatIds, setHiddenCatIds] = useState(() => new Set())

  useEffect(() => {
    if (!isActive) return
    let alive = true
    setLoading(true)
    setError('')
    Promise.all([
      api.getTimeSlots(),
      api.getDimensions(),
      api.getAllCategories(),
      api.getAssignments(),
    ])
      .then(([slots, dims, cats, rows]) => {
        if (!alive) return
        setTimeSlots(slots || [])
        setDimensions(dims || [])
        setCategories(cats || [])
        setAssignments(assignmentMapFromRows(rows))
      })
      .catch(err => {
        console.error('Failed to load calendar data', err)
        if (alive) setError('Could not load scheduled notes')
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [isActive, refreshKey, project?.id])

  useEffect(() => {
    if (!dimensions.length) return
    setCanvasDimId(prev => prev || dimensions[0]?.id || '')
    setColorDimId(prev => prev || dimensions[0]?.id || '')
  }, [dimensions])

  useEffect(() => {
    setFocusedCatId('')
    setHiddenCatIds(new Set())
  }, [canvasDimId])

  useEffect(() => {
    if (focusedCatId && hiddenCatIds.has(focusedCatId)) setFocusedCatId('')
  }, [focusedCatId, hiddenCatIds])

  useEffect(() => {
    if (!isActive) return
    setClock(new Date())
    const id = window.setInterval(() => setClock(new Date()), 60 * 1000)
    return () => window.clearInterval(id)
  }, [isActive])

  const today = useMemo(() => localMidnight(clock), [clock])
  const now = clock
  const anchor = useMemo(() => projectAnchor(project), [project?.createdAt])
  const notesById = useMemo(() => new Map(notes.map(note => [note.id, note])), [notes])
  const categoriesById = useMemo(() => new Map(categories.map(cat => [cat.id, cat])), [categories])
  const activeCategories = useMemo(() => {
    if (!canvasDimId) return []
    return [
      ...categories.filter(cat => cat.dimensionId === canvasDimId),
      { id: UNASSIGNED_CATEGORY_ID, name: 'Unassigned', color: '#9ca3af' },
    ]
  }, [canvasDimId, categories])
  const visibleActiveCategories = useMemo(
    () => activeCategories.filter(cat => !hiddenCatIds.has(cat.id)),
    [activeCategories, hiddenCatIds]
  )

  const allEvents = useMemo(() => timeSlots.map(slot => {
    const note = notesById.get(slot.noteId)
    const start = addMinutes(anchor, Number(slot.startCol) || 0)
    const duration = Math.max(1, Number(slot.duration) || 1)
    const end = addMinutes(anchor, (Number(slot.startCol) || 0) + duration)
    const locationCatId = canvasDimId ? assignments[slot.noteId]?.[canvasDimId] || UNASSIGNED_CATEGORY_ID : ''
    const locationCategory = locationCatId === UNASSIGNED_CATEGORY_ID
      ? { id: UNASSIGNED_CATEGORY_ID, name: 'Unassigned', color: '#9ca3af' }
      : categoriesById.get(locationCatId)
    const colorCatId = colorDimId ? assignments[slot.noteId]?.[colorDimId] : ''
    const colorCategory = colorCatId ? categoriesById.get(colorCatId) : null
    return {
      id: slot.id,
      noteId: slot.noteId,
      title: note?.title || slot.title || 'Untitled note',
      color: colorCategory?.color || slot.color || '#1a73e8',
      locationCatId,
      locationCategory,
      scale: timeSlotScale(slot, anchor),
      start,
      end,
    }
  }).sort((a, b) => a.start - b.start), [timeSlots, notesById, anchor, assignments, canvasDimId, colorDimId, categoriesById])

  const events = useMemo(() => {
    const visibleEvents = canvasDimId
      ? allEvents.filter(event => !hiddenCatIds.has(event.locationCatId))
      : allEvents
    if (!focusedCatId) return visibleEvents
    return visibleEvents.filter(event => event.locationCatId === focusedCatId)
  }, [allEvents, focusedCatId, hiddenCatIds, canvasDimId])

  const toggleHiddenCategory = catId => {
    setHiddenCatIds(prev => {
      const next = new Set(prev)
      if (next.has(catId)) next.delete(catId)
      else next.add(catId)
      return next
    })
  }

  const showAllCategories = () => setHiddenCatIds(new Set())
  const hideAllCategories = () => setHiddenCatIds(new Set(activeCategories.map(cat => cat.id)))

  const todayEvents = useMemo(() => events.filter(event => overlapsDay(event, today)), [events, today])
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(today, i)), [today])
  const weekEnd = useMemo(() => addDays(weekDays[0], 7), [weekDays])
  const todayPhaseEvents = useMemo(() => todayEvents.filter(event => event.scale === 'month'), [todayEvents])
  const todayDayEvents = useMemo(() => todayEvents.filter(event => event.scale === 'day'), [todayEvents])
  const todayMinuteEvents = useMemo(() => todayEvents.filter(event => event.scale === 'minute'), [todayEvents])
  const todayTimedEvents = useMemo(() => layoutTimedEvents(todayMinuteEvents, today), [todayMinuteEvents, today])
  const weekPhaseEvents = useMemo(
    () => events.filter(event => event.scale === 'month' && overlapsRange(event, weekDays[0], weekEnd)),
    [events, weekDays, weekEnd]
  )
  const monthDays = useMemo(() => buildMonthDays(today), [today])
  const monthEventsByDay = useMemo(() => {
    const map = new Map(monthDays.map(day => [dayKey(day), []]))
    events.forEach(event => {
      monthDays.forEach(day => {
        if (overlapsDay(event, day)) map.get(dayKey(day))?.push(event)
      })
    })
    return map
  }, [events, monthDays])

  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_HEIGHT
  const visibleRange = view === 'today'
    ? fmtDay(today)
    : view === 'week'
      ? `${fmtDay(weekDays[0])} - ${fmtDay(weekDays[6])}`
      : fmtMonth(today)

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.titleBlock}>
          <div className={styles.label}>Calendar</div>
          <div className={styles.range}>{visibleRange}</div>
        </div>

        <div className={styles.segmented} aria-label="Calendar view">
          {VIEW_OPTIONS.map(option => (
            <button
              key={option.id}
              type="button"
              className={`${styles.segment} ${view === option.id ? styles.segmentActive : ''}`}
              onClick={() => setView(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <CalendarGroupScroller
          dimensions={dimensions}
          categories={categories}
          activeCategories={visibleActiveCategories}
          activeDimId={canvasDimId}
          focusedCatId={focusedCatId}
          onDimensionChange={setCanvasDimId}
          onCategoryChange={setFocusedCatId}
        />

        {activeCategories.length > 0 && (
          <CalendarCategoryVisibilityDropdown
            categories={activeCategories}
            hiddenCatIds={hiddenCatIds}
            onToggle={toggleHiddenCategory}
            onShowAll={showAllCategories}
            onHideAll={hideAllCategories}
          />
        )}

        <div className={styles.todayChip}>
          <span />
          Today
        </div>
      </div>

      <main className={styles.calendarShell}>
        {error && <div className={styles.status}>{error}</div>}
        {!error && loading && <div className={styles.status}>Loading scheduled notes...</div>}

        {!error && view === 'today' && (
          <section className={styles.todayView} aria-label="Today calendar">
            <div className={styles.todayHeader}>
              <div>
                <span className={styles.todayKicker}>Today</span>
                <strong>{fmtDay(today)}</strong>
              </div>
              <span>{todayEvents.length} scheduled</span>
            </div>
            {(todayPhaseEvents.length > 0 || todayDayEvents.length > 0) && (
              <div className={styles.todayPlanningBands}>
                {todayPhaseEvents.length > 0 && (
                  <div className={styles.planningBand}>
                    <span className={styles.planningBandLabel}>Phases</span>
                    <div className={styles.planningBandItems}>
                      {todayPhaseEvents.map(event => (
                        <EventPill key={`phase-${event.id}`} event={event} day={today} compact onNoteOpen={onNoteOpen} />
                      ))}
                    </div>
                  </div>
                )}
                {todayDayEvents.length > 0 && (
                  <div className={styles.planningBand}>
                    <span className={styles.planningBandLabel}>Day plan</span>
                    <div className={styles.planningBandItems}>
                      {todayDayEvents.map(event => (
                        <EventPill key={`day-${event.id}`} event={event} day={today} compact onNoteOpen={onNoteOpen} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className={styles.dayTimeline} style={{ '--hour-height': `${HOUR_HEIGHT}px` }}>
              <div className={styles.nowLine} style={{ top: `${nowTop}px` }}>
                <span>{fmtTime(now)}</span>
              </div>
              {Array.from({ length: 24 }, (_, hour) => (
                <div className={styles.hourRow} key={hour}>
                  <span>{String(hour).padStart(2, '0')}:00</span>
                </div>
              ))}
              {todayTimedEvents.map(event => {
                const top = (event.startMinute / 60) * HOUR_HEIGHT
                const height = Math.max(30, ((event.endMinute - event.startMinute) / 60) * HOUR_HEIGHT)
                const laneWidth = `calc((100% - 110px - ${(event.layoutCols - 1) * 6}px) / ${event.layoutCols})`
                const laneLeft = `calc(92px + ${event.layoutCol} * (${laneWidth} + 6px))`
                return (
                  <button
                    type="button"
                    key={event.id}
                    className={styles.timelineEvent}
                    style={{ ...colorStyle(event.color), top: `${top}px`, height: `${height}px`, left: laneLeft, width: laneWidth }}
                    onClick={() => onNoteOpen?.(event.noteId)}
                    title={`${event.title} · ${rangeLabel(event, today)}`}
                  >
                    <span>{scaleLabel(event.scale)} · {rangeLabel(event, today)}</span>
                    <strong>{event.title}</strong>
                    {event.locationCategory && <em>{event.locationCategory.name}</em>}
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {!error && view === 'week' && (
          <section className={styles.weekView} aria-label="Seven day calendar">
            {weekPhaseEvents.length > 0 && (
              <div className={styles.weekPhaseLane}>
                <div className={styles.weekPhaseTrack}>
                  <span className={styles.weekPhaseLabel}>Phases</span>
                  {weekPhaseEvents.map(event => (
                    <SpanningEvent key={`week-phase-${event.id}`} event={event} start={weekDays[0]} end={weekEnd} onNoteOpen={onNoteOpen} />
                  ))}
                </div>
              </div>
            )}
            <div className={styles.weekGrid}>
              {weekDays.map(day => {
                const dayEvents = events.filter(event => event.scale === 'day' && overlapsDay(event, day))
                return (
                  <div key={dayKey(day)} className={`${styles.weekDay} ${isSameDay(day, today) ? styles.todayCell : ''}`}>
                    <div className={styles.dayHeader}>
                      <span>{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                      <strong>{day.getDate()}</strong>
                      {isSameDay(day, today) && <em>Today</em>}
                    </div>
                    <div className={styles.eventStack}>
                      {dayEvents.length ? dayEvents.map(event => (
                        <EventPill key={`${dayKey(day)}-${event.id}`} event={event} day={day} onNoteOpen={onNoteOpen} />
                      )) : <span className={styles.emptyDay}>No day-scale notes</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {!error && view === 'month' && (
          <section className={styles.monthView} aria-label="Month calendar">
            <div className={styles.monthWeekdays}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <span key={day}>{day}</span>)}
            </div>
            <div className={styles.monthGrid}>
              {monthDays.map(day => {
                const dayEvents = monthEventsByDay.get(dayKey(day)) || []
                const visible = dayEvents.slice(0, 3)
                return (
                  <div
                    key={dayKey(day)}
                    className={[
                      styles.monthDay,
                      day.getMonth() !== today.getMonth() ? styles.outsideMonth : '',
                      isSameDay(day, today) ? styles.todayCell : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <div className={styles.monthDayHeader}>
                      <strong>{day.getDate()}</strong>
                      {isSameDay(day, today) && <em>Today</em>}
                    </div>
                    <div className={styles.monthEvents}>
                      {visible.map(event => (
                        <EventPill key={`${dayKey(day)}-${event.id}`} event={event} day={day} compact onNoteOpen={onNoteOpen} />
                      ))}
                      {dayEvents.length > visible.length && (
                        <span className={styles.moreEvents}>+{dayEvents.length - visible.length} more</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </main>

      <div className={styles.floatingViewTools}>
        <ColorLegendWidget
          dimensions={dimensions}
          categories={categories}
          colorDimId={colorDimId}
          onColorDimension={setColorDimId}
          expanded={legendOpen}
          onExpandedChange={setLegendOpen}
        />
      </div>
    </div>
  )
}
