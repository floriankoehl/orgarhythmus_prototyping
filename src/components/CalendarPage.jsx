import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { usePersonaCursor } from '../hooks/usePersonaCursor'
import PeopleWidget from './PeopleWidget'
import PersonaAvatarStack from './PersonaAvatarStack'
import styles from './CalendarPage.module.css'
import { playSound } from '../sounds/sound_registry'
import ColorPickerIcon from './ColorPickerIcon'
import ColorPickerCategoryBadge from './ColorPickerCategoryBadge'
import { COLOR_UNASSIGNED_CATEGORY_ID, colorPickerCategories } from './colorPickerCategories'
import StandardColorPicker from './StandardColorPicker'
import StandardIconPicker from './StandardIconPicker'
import SavedFilterEditorModal from './SavedFilterEditorModal'
import { FILTER_DIMENSION_ID, filterCategoryId, filterMatchesNote, normalizeSavedFilter, quickFilterMatchesNote } from './savedFilterUtils'
import { TIME_DIMENSION_ID, TIME_DYNAMIC_CATEGORIES, timeCategoryIdForNote } from './timeCategories'
import { TYPE_DIMENSION_ID, TYPE_DYNAMIC_CATEGORIES, typeCategoryIdForNote } from './typeCategories'

const DAY_MINUTES = 24 * 60
const DEFAULT_HOUR_HEIGHT = 54
const MIN_DAY_TIMELINE_COLUMNS = 5
const DEFAULT_CALENDAR_SLOT_MINUTES = 60
const DEFAULT_CALENDAR_SLOT_START_MINUTE = 18 * 60
const CALENDAR_SLOT_SNAP_MINUTES = 10
const UNASSIGNED_CATEGORY_ID = '__unassigned__'
const UNASSIGNED_COLOR = '#9ca3af'
const VIEW_OPTIONS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: '7 days' },
  { id: 'month', label: 'Month' },
]
const SCALE_OPTIONS = [
  { id: 'minute', label: 'Minute scale' },
  { id: 'day', label: 'Day scale' },
  { id: 'month', label: 'Month scale' },
]
const NONE_PERSPECTIVE_ID = '__none__'

function newClientId(prefix) {
  const random = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${random}`
}

function normalizePerspective(perspective) {
  return {
    ...perspective,
    name: (perspective?.name || 'Untitled perspective').trim(),
    state: perspective?.state ?? {},
  }
}

function SaveIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5 3h12l2 2v16H5V3zm2 2v5h9V5H7zm1 10v4h8v-4H8zm10-8.17V19h-1v-6H7v6H6V5h10.17L18 6.83z"/>
    </svg>
  )
}

function PerspectiveMenu({ perspectives, activePerspectiveId, defaultPerspectiveId, open, onOpenChange, onApply, onCreate, onUpdate, onRename, onDelete, onSetDefault }) {
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState('')
  const [editingName, setEditingName] = useState('')
  const wrapRef = useRef()
  const wheelAtRef = useRef(0)
  const applyTimerRef = useRef(null)
  const active = perspectives.find(perspective => perspective.id === activePerspectiveId)
  const canSaveActive = Boolean(active && !active.readOnly)

  useEffect(() => {
    if (!open) return
    const close = event => { if (!wrapRef.current?.contains(event.target)) onOpenChange(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [onOpenChange, open])

  useEffect(() => () => {
    if (applyTimerRef.current) window.clearTimeout(applyTimerRef.current)
  }, [])

  const create = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onCreate(trimmed)
    setName('')
  }

  const cycle = deltaY => {
    if (perspectives.length === 0) return
    const now = Date.now()
    if (now - wheelAtRef.current < 180) return
    wheelAtRef.current = now
    const activeIndex = Math.max(0, perspectives.findIndex(perspective => perspective.id === activePerspectiveId))
    const direction = deltaY > 0 ? 1 : -1
    onApply(perspectives[(activeIndex + direction + perspectives.length) % perspectives.length])
  }

  const commitRename = () => {
    const trimmed = editingName.trim()
    if (editingId && trimmed) onRename(editingId, trimmed)
    setEditingId('')
    setEditingName('')
  }

  const applyFromMenu = perspective => {
    if (applyTimerRef.current) window.clearTimeout(applyTimerRef.current)
    applyTimerRef.current = window.setTimeout(() => {
      onApply(perspective)
      onOpenChange(false)
      applyTimerRef.current = null
    }, 180)
  }

  return (
    <div ref={wrapRef} className={styles.perspectiveWrap}>
      <button
        className={styles.perspectiveToolbarSaveBtn}
        title={canSaveActive ? 'Update current perspective snapshot' : 'None cannot be saved'}
        disabled={!canSaveActive}
        onClick={() => canSaveActive && onUpdate(active.id)}>
        <SaveIcon />
      </button>
      <button
        className={`${styles.perspectiveBtn} ${open ? styles.perspectiveBtnOpen : ''}`}
        onWheel={event => { event.preventDefault(); cycle(event.deltaY) }}
        onClick={() => onOpenChange(!open)}>
        <span>{active?.name ?? 'None'}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z" /></svg>
      </button>
      {!open && (
        <span className={styles.floatingHint}>
          <strong>Perspective</strong>
          <small>Switch saved calendar views</small>
        </span>
      )}
      {open && (
        <div className={styles.perspectiveMenu}>
          <div className={styles.perspectiveCreateRow}>
            <input
              value={name}
              onChange={event => setName(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') create() }}
              placeholder="Perspective name"
            />
            <button onClick={create}>Save</button>
          </div>
          <div className={styles.perspectiveList}>
            {perspectives.map(perspective => (
              <div key={perspective.id} className={`${styles.perspectiveItem} ${perspective.id === activePerspectiveId ? styles.perspectiveItemActive : ''}`}>
                {editingId === perspective.id ? (
                  <input
                    className={styles.perspectiveRenameInput}
                    value={editingName}
                    autoFocus
                    onChange={event => setEditingName(event.target.value)}
                    onBlur={commitRename}
                    onKeyDown={event => {
                      if (event.key === 'Enter') commitRename()
                      if (event.key === 'Escape') { setEditingId(''); setEditingName('') }
                    }}
                  />
                ) : (
                  <button
                    className={styles.perspectiveApplyBtn}
                    onClick={() => applyFromMenu(perspective)}
                    onDoubleClick={event => {
                      event.preventDefault()
                      event.stopPropagation()
                      if (!perspective.readOnly) {
                        setEditingId(perspective.id)
                        setEditingName(perspective.name)
                      }
                    }}>
                    <span>{perspective.name}</span>
                  </button>
                )}
                <button
                  className={`${styles.perspectiveIconBtn} ${defaultPerspectiveId === perspective.id ? styles.perspectiveIconBtnActive : ''}`}
                  title="Use as the Calendar default for this context"
                  onClick={() => onSetDefault(perspective.id)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27z"/></svg>
                </button>
                <button className={styles.perspectiveIconBtn} title={perspective.readOnly ? 'None cannot be saved' : 'Update snapshot'} disabled={perspective.readOnly} onClick={() => !perspective.readOnly && onUpdate(perspective.id)}>
                  <SaveIcon />
                </button>
                <button className={styles.perspectiveIconBtn} title={perspective.readOnly ? 'None cannot be deleted' : 'Delete'} disabled={perspective.readOnly} onClick={() => !perspective.readOnly && onDelete(perspective.id)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 4l1-1h6l1 1h4v2H4V4h4z"/></svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function makeColorCursor(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="${color}" stroke="white" stroke-width="2"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`
}

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

function calendarDayCol(anchor, date) {
  const anchorUtc = Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
  const dateUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.round((dateUtc - anchorUtc) / 86400000) * DAY_MINUTES
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

function dateFromDayKey(value, fallback = new Date()) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return localMidnight(fallback)
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(parsed.getTime()) ? localMidnight(fallback) : parsed
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

function layoutTimedEvents(events, day, preferredColumns = new Map(), hourHeight = DEFAULT_HOUR_HEIGHT) {
  const minVisualMinutes = (30 / hourHeight) * 60
  const timed = events.map(event => {
    const start = Math.max(0, (event.start - day) / 60000)
    const end = Math.min(DAY_MINUTES, (event.end - day) / 60000)
    const endMinute = Math.max(start + 1, end)
    return { ...event, startMinute: start, endMinute, layoutEndMinute: Math.max(endMinute, start + minVisualMinutes) }
  }).sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute)

  const groups = []
  let current = []
  let groupEnd = -1
  timed.forEach(event => {
    if (current.length === 0 || event.startMinute < groupEnd + 1) {
      current.push(event)
      groupEnd = Math.max(groupEnd, event.layoutEndMinute)
    } else {
      groups.push(current)
      current = [event]
      groupEnd = event.layoutEndMinute
    }
  })
  if (current.length) groups.push(current)

  const placedGroups = groups.map(group => {
    const columns = []
    const placed = group.map(event => {
      const previewCol = Number.isInteger(event.preferredLayoutCol) ? event.preferredLayoutCol : null
      const savedCol = Number.isInteger(preferredColumns.get(event.id))
        ? preferredColumns.get(event.id)
        : null
      const preferredCol = previewCol ?? savedCol
      const isColumnFree = col => (columns[col] ?? -Infinity) + 1 <= event.startMinute
      let col = preferredCol !== null && isColumnFree(preferredCol) ? preferredCol : -1
      if (col === -1) {
        const searchCols = Math.max(MIN_DAY_TIMELINE_COLUMNS, columns.length + 1)
        for (let candidate = 0; candidate < searchCols; candidate += 1) {
          if (isColumnFree(candidate)) {
            col = candidate
            break
          }
        }
      }
      if (col === -1) col = columns.length
      columns[col] = event.layoutEndMinute
      if (savedCol === null) preferredColumns.set(event.id, col)
      return { ...event, layoutCol: col }
    })
    return { placed, colCount: Math.max(MIN_DAY_TIMELINE_COLUMNS, columns.length) }
  })

  const maxLayoutCol = Math.max(-1, ...placedGroups.flatMap(group => group.placed.map(event => event.layoutCol)))
  // The widest occupied lane grid determines the whole day.
  // Keeping that grid fixed prevents isolated events from expanding wider.
  const dayColumnCount = Math.max(MIN_DAY_TIMELINE_COLUMNS, maxLayoutCol + 1, ...placedGroups.map(group => group.colCount))
  return placedGroups.flatMap(group => (
    group.placed.map(event => ({ ...event, layoutCols: dayColumnCount }))
  ))
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

function ColorLegendWidget({ dimensions, categories, colorDimId, onColorDimension, expanded, onExpandedChange, paintCat, onPaintActivate }) {
  const legendCats = colorPickerCategories(categories, dimensions, colorDimId)

  return (
    <div className={styles.legendWidget}>
      {expanded && (
        <div className={styles.legendPanel} onClick={e => e.stopPropagation()}>
          <div className={styles.legendPanelHeader}>Color dimension</div>
          {!colorDimId && <div className={styles.legendEmpty}>Using schedule slot colors</div>}
          {legendCats.map(cat => (
            <button
              key={cat.id}
              type="button"
              className={`${styles.legendItem} ${paintCat?.id === cat.id ? styles.legendItemActive : ''}`}
              onClick={() => !cat.readOnly && onPaintActivate?.(cat.id, cat.color || UNASSIGNED_COLOR)}
              disabled={cat.readOnly}
              title={cat.readOnly ? 'Shows every note; not a paint action' : cat.unassign ? 'Remove this dimension assignment from calendar notes' : 'Paint this category onto calendar notes'}>
              <span className={styles.legendDot} style={{ background: cat.color || '#aaa' }} />
              <span className={styles.legendName}>{cat.name}</span>
              {cat.specialLabel && <ColorPickerCategoryBadge>{cat.specialLabel}</ColorPickerCategoryBadge>}
            </button>
          ))}
          <LegendDropUp dimensions={dimensions} colorDimId={colorDimId} onColorDimension={onColorDimension} />
        </div>
      )}

      <button
        className={`${styles.legendToggleBtn} ${expanded ? styles.legendToggleActive : ''}`}
        onClick={() => onExpandedChange(!expanded)}
        title={expanded ? 'Collapse color legend' : 'Color dimension'}>
        <ColorPickerIcon size={22} />
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

function EventPill({ event, day, compact = false, minimal = false, onNoteOpen, paintCat, onPaint, paintPersonaId, onPersonaPaint, onRemovePersona, draggable = false, onDragStart, onDragEnd, onContextMenu }) {
  const handleClick = e => {
    if (paintPersonaId) {
      e.stopPropagation()
      onPersonaPaint?.(event.noteId)
      return
    }
    if (paintCat) {
      e.stopPropagation()
      onPaint?.(event.noteId)
      return
    }
    onNoteOpen?.(event.noteId)
  }

  const hoverDetails = [
    event.title,
    `${event.scale.charAt(0).toUpperCase()}${event.scale.slice(1)} scale`,
    rangeLabel(event, day),
    event.locationCategory?.name,
  ].filter(Boolean).join(' · ')

  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={menuEvent => onContextMenu?.(menuEvent, event)}
      className={`${styles.eventPill} ${compact ? styles.eventPillCompact : ''} ${minimal ? styles.eventPillMinimal : ''}`}
      style={colorStyle(event.color)}
      onClick={handleClick}
      title={hoverDetails}
    >
      <span className={styles.eventColor} />
      <div className={styles.eventText}>
        {!compact && !minimal && <span className={styles.eventTime}>{scaleLabel(event.scale)} · {rangeLabel(event, day)}</span>}
        <div className={styles.eventTitleRow}>
          <span className={styles.eventTitle}>{event.title}</span>
          <PersonaAvatarStack personas={event.personas} onRemove={personaId => onRemovePersona?.(personaId, event.noteId)} />
        </div>
        {!compact && !minimal && event.locationCategory && <span className={styles.eventMeta}>{event.locationCategory.name}</span>}
      </div>
    </button>
  )
}

function SpanningEvent({ event, start, end, lane = null, onNoteOpen, paintCat, onPaint, paintPersonaId, onPersonaPaint, onRemovePersona, onContextMenu, draggable = false, onDragStart, onDragEnd, editable = false, onResizeStart }) {
  const left = Math.max(0, ((Math.max(event.start, start) - start) / (end - start)) * 100)
  const right = Math.max(0, ((end - Math.min(event.end, end)) / (end - start)) * 100)
  const handleClick = e => {
    if (paintPersonaId) {
      e.stopPropagation()
      onPersonaPaint?.(event.noteId)
      return
    }
    if (paintCat) {
      e.stopPropagation()
      onPaint?.(event.noteId)
      return
    }
    onNoteOpen?.(event.noteId)
  }

  return (
    <button
      type="button"
      className={`${styles.spanningEvent} ${editable ? styles.spanningEventEditable : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={{
        ...colorStyle(event.color),
        left: `${left}%`,
        right: `${right}%`,
        ...(lane === null ? {} : { top: `${5 + lane * 27}px`, bottom: 'auto', height: '23px' }),
      }}
      onClick={handleClick}
      onContextMenu={menuEvent => onContextMenu?.(menuEvent, event)}
      title={`${event.title} · ${scaleLabel(event.scale)}`}
    >
      {editable && event.start >= start && (
        <span className={`${styles.spanningResizeHandle} ${styles.spanningResizeHandleLeft}`} onMouseDown={mouseEvent => onResizeStart?.(mouseEvent, event, 'left')} aria-hidden="true" />
      )}
      <span>{scaleLabel(event.scale)}</span>
      <strong>{event.title}</strong>
      <PersonaAvatarStack personas={event.personas} onRemove={personaId => onRemovePersona?.(personaId, event.noteId)} />
      {editable && event.end <= end && (
        <span className={`${styles.spanningResizeHandle} ${styles.spanningResizeHandleRight}`} onMouseDown={mouseEvent => onResizeStart?.(mouseEvent, event, 'right')} aria-hidden="true" />
      )}
    </button>
  )
}

export default function CalendarPage({ notes = [], project = null, isActive = false, onNoteOpen, onNoteCreated, onNoteUpdated, onScheduleChanged, refreshKey = 0, peopleRefreshKey = 0, onPeopleChanged, restoreRequest = null, onRestoreConsumed, onRequestScheduleResolve, contextDefaultPerspectiveId, contextApplyToken, activeContextId = '', archivedDimensionIds = [], onSetContextDefaultPerspective, workspaceRootNoteId = null }) {
  const dateWheelAtRef = useRef(0)
  const [view, setView] = useState('today')
  const [focusDate, setFocusDate] = useState(() => localMidnight())
  const [timeSlots, setTimeSlots] = useState([])
  const [dimensions, setDimensions] = useState([])
  const [categories, setCategories] = useState([])
  const [assignments, setAssignments] = useState({})
  const [perspectives, setPerspectives] = useState([])
  const [activePerspectiveId, setActivePerspectiveId] = useState(NONE_PERSPECTIVE_ID)
  const [defaultPerspectiveId, setDefaultPerspectiveId] = useState(NONE_PERSPECTIVE_ID)
  const appliedDefaultRef = useRef(false)
  const restoringPerspectiveRef = useRef(false)
  const [personas, setPersonas] = useState([])
  const [personaNoteAssignments, setPersonaNoteAssignments] = useState([])
  const [noteInheritance, setNoteInheritance] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [clock, setClock] = useState(() => new Date())
  const [canvasDimId, setCanvasDimId] = useState('')
  const [focusedCatId, setFocusedCatId] = useState('')
  const [colorDimId, setColorDimId] = useState('')
  const [iconDimId, setIconDimId] = useState('')
  const [savedFilters, setSavedFilters] = useState([])
  const [activeFilterIds, setActiveFilterIds] = useState([])
  const [quickFilters, setQuickFilters] = useState([])
  const [editingFilter, setEditingFilter] = useState(null)
  const archivedDimensionSet = useMemo(() => new Set(archivedDimensionIds || []), [archivedDimensionIds])
  const visibleDimensions = useMemo(
    () => dimensions.filter(dim => !archivedDimensionSet.has(dim.id)),
    [dimensions, archivedDimensionSet]
  )
  const filterCategories = useMemo(() => savedFilters.map((filter, index) => ({
    id: filterCategoryId(filter.id), dimensionId: FILTER_DIMENSION_ID, name: filter.name,
    color: filter.color || '#64748b', dynamic: true, dynamicType: 'filter', dynamicLabel: 'Filter', filterId: filter.id,
  })), [savedFilters])
  const timeCategories = useMemo(() => TIME_DYNAMIC_CATEGORIES.map(category => ({ ...category, dimensionId: TIME_DIMENSION_ID, dynamic: true, dynamicType: 'time', dynamicLabel: 'Time' })), [])
  const typeCategories = useMemo(() => TYPE_DYNAMIC_CATEGORIES.map(category => ({ ...category, dimensionId: TYPE_DIMENSION_ID, dynamic: true, dynamicType: 'type', dynamicLabel: 'Type' })), [])
  const colorDimensions = useMemo(() => [...visibleDimensions,
    { id: FILTER_DIMENSION_ID, name: 'Filters', dynamic: true, dynamicType: 'filter', dynamicLabel: 'Filter' },
    { id: TIME_DIMENSION_ID, name: 'Time', dynamic: true, dynamicType: 'time', dynamicLabel: 'Time' },
    { id: TYPE_DIMENSION_ID, name: 'Type', dynamic: true, dynamicType: 'type', dynamicLabel: 'Type' },
  ], [visibleDimensions])
  const colorCategories = useMemo(() => [...categories, ...filterCategories, ...timeCategories, ...typeCategories], [categories, filterCategories, timeCategories, typeCategories])
  const [legendOpen, setLegendOpen] = useState(false)
  const [hiddenCatIds, setHiddenCatIds] = useState(() => new Set())
  const [visibleScales, setVisibleScales] = useState(() => new Set(SCALE_OPTIONS.map(option => option.id)))
  const [paintCat, setPaintCat] = useState(null)
  const [paintPersonaId, setPaintPersonaId] = useState(null)
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [iconOpen, setIconOpen] = useState(false)
  const [perspectiveOpen, setPerspectiveOpen] = useState(false)
  const [editPreview, setEditPreview] = useState(null)
  const [inlineTitleEdit, setInlineTitleEdit] = useState(null)
  const [dayColumnPrefsVersion, setDayColumnPrefsVersion] = useState(0)
  const [dayHourHeight, setDayHourHeight] = useState(DEFAULT_HOUR_HEIGHT)
  const [calendarWarning, setCalendarWarning] = useState(null)
  const [timeSlotContextMenu, setTimeSlotContextMenu] = useState(null)
  const suppressOpenRef = useRef(null)
  const restoreHandledRef = useRef(null)
  const dayTimelineRef = useRef(null)
  const dayTimelineColumnPrefsRef = useRef(new Map())
  const inlineTitleInputRef = useRef(null)
  const createTitleInputRef = useRef(null)
  const weekViewRef = useRef(null)
  const monthGridRef = useRef(null)

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
      api.getPersonas(),
      api.getDirectPersonaNoteAssignments(),
      api.getCalendarPerspectives(activeContextId),
      api.getNoteInheritance(),
      api.getFilters(),
    ])
      .then(([slots, dims, cats, rows, loadedPersonas, loadedPersonaAssignments, loadedPerspectives, loadedInheritance, loadedFilters]) => {
        if (!alive) return
        setTimeSlots(slots || [])
        setDimensions(dims || [])
        setCategories(cats || [])
        setAssignments(assignmentMapFromRows(rows))
        setPersonas(loadedPersonas || [])
        setPersonaNoteAssignments(loadedPersonaAssignments || [])
        setPerspectives((loadedPerspectives || []).map(normalizePerspective))
        setNoteInheritance(loadedInheritance || [])
        setSavedFilters((loadedFilters || []).map(normalizeSavedFilter))
      })
      .catch(err => {
        console.error('Failed to load calendar data', err)
        if (alive) setError('Could not load scheduled notes')
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [isActive, refreshKey, project?.id, activeContextId])

  const refreshDimensionData = () => {
    Promise.all([api.getDimensions(), api.getAllCategories()])
      .then(([dims, cats]) => {
        setDimensions(dims || [])
        setCategories(cats || [])
      })
      .catch(console.error)
  }

  useEffect(() => {
    if (!isActive || !peopleRefreshKey) return
    Promise.all([api.getPersonas(), api.getDirectPersonaNoteAssignments()])
      .then(([loadedPersonas, loadedAssignments]) => {
        setPersonas(loadedPersonas || [])
        setPersonaNoteAssignments(loadedAssignments || [])
      })
      .catch(console.error)
  }, [isActive, peopleRefreshKey])

  useEffect(() => {
    if (!visibleDimensions.length) return
    setCanvasDimId(prev => prev || visibleDimensions[0]?.id || '')
    setColorDimId(prev => prev || visibleDimensions[0]?.id || '')
  }, [visibleDimensions])

  useEffect(() => {
    if (canvasDimId && archivedDimensionSet.has(canvasDimId)) setCanvasDimId(visibleDimensions[0]?.id || '')
    if (colorDimId && archivedDimensionSet.has(colorDimId)) setColorDimId(visibleDimensions[0]?.id || '')
  }, [archivedDimensionSet, canvasDimId, colorDimId, visibleDimensions])

  useEffect(() => {
    if (restoringPerspectiveRef.current) {
      restoringPerspectiveRef.current = false
      return
    }
    setFocusedCatId('')
    setHiddenCatIds(new Set())
  }, [canvasDimId])

  useEffect(() => {
    if (focusedCatId && hiddenCatIds.has(focusedCatId)) setFocusedCatId('')
  }, [focusedCatId, hiddenCatIds])

  useEffect(() => {
    setPaintCat(null)
  }, [colorDimId])

  useEffect(() => {
    if (!isActive) return
    setClock(new Date())
    const id = window.setInterval(() => setClock(new Date()), 60 * 1000)
    return () => window.clearInterval(id)
  }, [isActive])

  useEffect(() => {
    if (!isActive || view !== 'today') return
    const timeline = dayTimelineRef.current
    if (!timeline) return
    const updateHourHeight = () => {
      const available = timeline.clientHeight
      if (available <= 0) return
      setDayHourHeight(Math.max(22, Math.min(DEFAULT_HOUR_HEIGHT, available / 24)))
    }
    updateHourHeight()
    const observer = new ResizeObserver(updateHourHeight)
    observer.observe(timeline)
    window.addEventListener('resize', updateHourHeight)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateHourHeight)
    }
  }, [isActive, view])

  const actualToday = useMemo(() => localMidnight(clock), [clock])
  const now = clock
  const anchor = useMemo(() => projectAnchor(project), [project?.createdAt])
  const notesById = useMemo(() => new Map(notes.map(note => [note.id, note])), [notes])
  const categoriesById = useMemo(() => new Map(categories.map(cat => [cat.id, cat])), [categories])
  const notePersonasMap = useMemo(() => {
    const map = {}
    personaNoteAssignments.forEach(assignment => {
      const persona = personas.find(item => item.id === assignment.personaId)
      if (persona) (map[assignment.noteId] = map[assignment.noteId] || []).push(persona)
    })
    return map
  }, [personas, personaNoteAssignments])
  const activePersona = useMemo(
    () => personas.find(persona => persona.id === paintPersonaId) ?? null,
    [personas, paintPersonaId]
  )
  const personaCursor = usePersonaCursor(activePersona)
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
    const effectiveSlot = editPreview?.id === slot.id ? { ...slot, ...editPreview } : slot
    const startCol = Number(effectiveSlot.startCol) || 0
    const start = addMinutes(anchor, startCol)
    const duration = Math.max(1, Number(effectiveSlot.duration) || 1)
    const end = addMinutes(anchor, startCol + duration)
    const locationCatId = canvasDimId ? assignments[slot.noteId]?.[canvasDimId] || UNASSIGNED_CATEGORY_ID : ''
    const locationCategory = locationCatId === UNASSIGNED_CATEGORY_ID
      ? { id: UNASSIGNED_CATEGORY_ID, name: 'Unassigned', color: '#9ca3af' }
      : categoriesById.get(locationCatId)
    let colorCategory = null
    if (colorDimId === FILTER_DIMENSION_ID) {
      colorCategory = filterCategories.find(category => filterMatchesNote(savedFilters.find(filter => filter.id === category.filterId), note, (noteId, dimensionId) => assignments[noteId]?.[dimensionId], { notes, timeSlots })) || null
    } else if (colorDimId === TIME_DIMENSION_ID) {
      const categoryId = timeCategoryIdForNote(note)
      colorCategory = timeCategories.find(category => category.id === categoryId) || null
    } else if (colorDimId === TYPE_DIMENSION_ID) {
      const categoryId = typeCategoryIdForNote(note, { notes, timeSlots })
      colorCategory = typeCategories.find(category => category.id === categoryId) || null
    } else {
      const colorCatId = colorDimId ? assignments[slot.noteId]?.[colorDimId] : ''
      colorCategory = colorCatId ? categoriesById.get(colorCatId) : null
    }
    const eventColor = colorDimId
      ? (colorCategory?.color || UNASSIGNED_COLOR)
      : (slot.color || '#1a73e8')
    return {
      id: slot.id,
      noteId: slot.noteId,
      title: note?.title || slot.title || 'Untitled note',
      color: eventColor,
      personas: notePersonasMap[slot.noteId] || [],
      locationCatId,
      locationCategory,
      scale: timeSlotScale(effectiveSlot, anchor),
      preferredLayoutCol: editPreview?.id === slot.id && Number.isInteger(editPreview.layoutCol)
        ? editPreview.layoutCol
        : undefined,
      start,
      end,
    }
  }).sort((a, b) => a.start - b.start), [timeSlots, notes, notesById, anchor, assignments, canvasDimId, colorDimId, categoriesById, notePersonasMap, editPreview, filterCategories, savedFilters, timeCategories, typeCategories])

  const events = useMemo(() => {
    const visibleEvents = canvasDimId
      ? allEvents.filter(event => !hiddenCatIds.has(event.locationCatId))
      : allEvents
    const focusedEvents = focusedCatId
      ? visibleEvents.filter(event => event.locationCatId === focusedCatId)
      : visibleEvents
    const scaledEvents = focusedEvents.filter(event => visibleScales.has(event.scale))
    const activeSavedFilters = activeFilterIds.map(id => savedFilters.find(filter => filter.id === id)).filter(Boolean)
    if (!activeSavedFilters.length && !quickFilters.length) return scaledEvents
    return scaledEvents.filter(event => {
      const note = notesById.get(event.noteId)
      const assignmentForDimension = (noteId, dimensionId) => assignments[noteId]?.[dimensionId]
      return activeSavedFilters.some(filter => filterMatchesNote(filter, note, assignmentForDimension, { notes, timeSlots })) || quickFilterMatchesNote(quickFilters, note, assignmentForDimension, { notes, timeSlots })
    })
  }, [allEvents, focusedCatId, hiddenCatIds, canvasDimId, visibleScales, activeFilterIds, savedFilters, quickFilters, notesById, assignments, notes, timeSlots])

  const toggleScale = scale => {
    setVisibleScales(prev => {
      const next = new Set(prev)
      if (next.has(scale)) next.delete(scale)
      else next.add(scale)
      return next
    })
  }

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

  const activatePaint = (catId, color) => {
    if (!colorDimId || !catId) return
    setPaintPersonaId(null)
    const deactivating = paintCat?.id === catId
    playSound(deactivating ? 'paintModeDeactivate' : 'paintModeActivate')
    setPaintCat(prev => prev?.id === catId ? null : { id: catId, color: color || UNASSIGNED_COLOR })
  }

  const toggleQuickFilter = (dimensionId, categoryId) => setQuickFilters(previous => {
    const exists = previous.some(filter => filter.dimId === dimensionId && filter.catId === categoryId)
    return exists ? previous.filter(filter => !(filter.dimId === dimensionId && filter.catId === categoryId)) : [...previous, { dimId: dimensionId, catId: categoryId }]
  })
  const toggleSavedFilter = filterId => setActiveFilterIds(previous => previous.includes(filterId) ? previous.filter(id => id !== filterId) : [...previous, filterId])
  const saveFilter = async filter => {
    try {
      const saved = normalizeSavedFilter(filter.id ? await api.updateFilter(filter.id, filter) : await api.createFilter(filter))
      setSavedFilters(previous => [...previous.filter(item => item.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)))
      setEditingFilter(null)
    } catch (error) { console.error(error) }
  }
  const deleteFilter = async filterId => {
    try {
      await api.deleteFilter(filterId)
      setSavedFilters(previous => previous.filter(filter => filter.id !== filterId))
      setActiveFilterIds(previous => previous.filter(id => id !== filterId))
      setEditingFilter(null)
    } catch (error) { console.error(error) }
  }

  const paintPersonaOnNote = async noteId => {
    if (!paintPersonaId || !noteId) return
    setPersonaNoteAssignments(prev => [
      ...prev.filter(assignment => !(assignment.personaId === paintPersonaId && assignment.noteId === noteId)),
      { personaId: paintPersonaId, noteId },
    ])
    try {
      await api.assignPersonaToNote(paintPersonaId, noteId)
      onPeopleChanged?.()
    } catch (err) {
      console.error('Failed to assign person from calendar', err)
      api.getDirectPersonaNoteAssignments().then(setPersonaNoteAssignments).catch(console.error)
    }
  }

  const removePersonaFromNote = async (personaId, noteId) => {
    if (!personaId || !noteId) return
    setPersonaNoteAssignments(prev => prev.filter(assignment => (
      !(assignment.personaId === personaId && assignment.noteId === noteId)
    )))
    try {
      await api.unassignPersonaFromNote(personaId, noteId)
      onPeopleChanged?.()
    } catch (err) {
      console.error('Failed to unassign person from calendar', err)
      api.getDirectPersonaNoteAssignments().then(setPersonaNoteAssignments).catch(console.error)
    }
  }

  const paintNote = async noteId => {
    if (!paintCat || !colorDimId || colorDimId === TYPE_DIMENSION_ID || !noteId) return
    playSound('paintApply')
    if (paintCat.id === COLOR_UNASSIGNED_CATEGORY_ID) {
      setAssignments(prev => {
        const dimensions = { ...(prev[noteId] ?? {}) }
        delete dimensions[colorDimId]
        return { ...prev, [noteId]: dimensions }
      })
      try {
        await api.unassign(noteId, colorDimId)
      } catch (err) {
        console.error('Failed to unassign calendar note', err)
        api.getAssignments().then(rows => setAssignments(assignmentMapFromRows(rows))).catch(console.error)
      }
      return
    }
    setAssignments(prev => ({
      ...prev,
      [noteId]: { ...(prev[noteId] ?? {}), [colorDimId]: paintCat.id },
    }))
    try {
      await api.assign(noteId, colorDimId, paintCat.id)
    } catch (err) {
      console.error('Failed to paint calendar note', err)
      api.getAssignments()
        .then(rows => setAssignments(assignmentMapFromRows(rows)))
        .catch(console.error)
    }
  }

  const nonePerspective = normalizePerspective({
    id: NONE_PERSPECTIVE_ID,
    name: 'None',
    readOnly: true,
    state: {
      canvasDimId: visibleDimensions[0]?.id || '',
      focusedCatId: '',
      hiddenCatIds: [],
      colorDimId: visibleDimensions[0]?.id || '',
      view: 'today',
      visibleScales: SCALE_OPTIONS.map(option => option.id),
      focusDate: dayKey(actualToday),
      dayTimelineColumns: [],
      scroll: { dayTop: 0, weekTop: 0, weekLeft: 0, monthTop: 0 },
    },
  })
  const perspectiveOptions = [nonePerspective, ...perspectives]

  const capturePerspectiveState = () => ({
    canvasDimId,
    focusedCatId,
    hiddenCatIds: [...hiddenCatIds],
    colorDimId,
    activeFilterIds,
    quickFilters,
    view,
    visibleScales: [...visibleScales],
    focusDate: dayKey(focusDate),
    dayTimelineColumns: [...dayTimelineColumnPrefsRef.current.entries()],
    scroll: {
      dayTop: dayTimelineRef.current?.scrollTop || 0,
      weekTop: weekViewRef.current?.scrollTop || 0,
      weekLeft: weekViewRef.current?.scrollLeft || 0,
      monthTop: monthGridRef.current?.scrollTop || 0,
    },
  })

  const applyPerspective = perspective => {
    playSound('perspectiveLoad')
    const state = perspective?.state ?? {}
    const nextCanvasDimId = visibleDimensions.some(dimension => dimension.id === state.canvasDimId)
      ? state.canvasDimId
      : visibleDimensions[0]?.id || ''
    const nextColorDimId = colorDimensions.some(dimension => dimension.id === state.colorDimId)
      ? state.colorDimId
      : visibleDimensions[0]?.id || ''
    const dimensionCategoryIds = new Set([
      ...categories.filter(category => category.dimensionId === nextCanvasDimId).map(category => category.id),
      UNASSIGNED_CATEGORY_ID,
    ])
    const nextFocusedCatId = dimensionCategoryIds.has(state.focusedCatId) ? state.focusedCatId : ''
    const nextHiddenCatIds = Array.isArray(state.hiddenCatIds)
      ? state.hiddenCatIds.filter(categoryId => dimensionCategoryIds.has(categoryId))
      : []
    const nextVisibleScales = Array.isArray(state.visibleScales)
      ? state.visibleScales.filter(scale => SCALE_OPTIONS.some(option => option.id === scale))
      : SCALE_OPTIONS.map(option => option.id)
    const nextColumnPrefs = new Map()
    if (Array.isArray(state.dayTimelineColumns)) {
      state.dayTimelineColumns.forEach(entry => {
        const [id, col] = Array.isArray(entry) ? entry : [entry?.id, entry?.col]
        if (id && Number.isInteger(col) && col >= 0) nextColumnPrefs.set(id, col)
      })
    }

    restoringPerspectiveRef.current = nextCanvasDimId !== canvasDimId
    dayTimelineColumnPrefsRef.current = nextColumnPrefs
    setDayColumnPrefsVersion(version => version + 1)
    setCanvasDimId(nextCanvasDimId)
    setFocusedCatId(nextFocusedCatId)
    setHiddenCatIds(new Set(nextHiddenCatIds))
    setColorDimId(nextColorDimId)
    setActiveFilterIds(Array.isArray(state.activeFilterIds) ? state.activeFilterIds : [])
    setQuickFilters(Array.isArray(state.quickFilters) ? state.quickFilters : [])
    setView(VIEW_OPTIONS.some(option => option.id === state.view) ? state.view : 'today')
    setVisibleScales(new Set(nextVisibleScales))
    setFocusDate(dateFromDayKey(state.focusDate, actualToday))
    setPaintCat(null)
    setPaintPersonaId(null)
    setLegendOpen(false)
    setPeopleOpen(false)
    setPerspectiveOpen(false)
    setActivePerspectiveId(perspective?.id ?? NONE_PERSPECTIVE_ID)
    window.requestAnimationFrame(() => {
      if (dayTimelineRef.current) dayTimelineRef.current.scrollTop = Math.max(0, Number(state.scroll?.dayTop) || 0)
      if (weekViewRef.current) {
        weekViewRef.current.scrollTop = Math.max(0, Number(state.scroll?.weekTop) || 0)
        weekViewRef.current.scrollLeft = Math.max(0, Number(state.scroll?.weekLeft) || 0)
      }
      if (monthGridRef.current) monthGridRef.current.scrollTop = Math.max(0, Number(state.scroll?.monthTop) || 0)
    })
  }

  const createPerspective = async name => {
    try {
      const created = normalizePerspective(await api.createCalendarPerspective({ name, state: capturePerspectiveState() }, activeContextId))
      playSound('perspectiveSave')
      setPerspectives(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      setActivePerspectiveId(created.id)
    } catch (err) { console.error('Failed to create calendar perspective', err) }
  }

  const updatePerspectiveSnapshot = async perspectiveId => {
    if (perspectiveId === NONE_PERSPECTIVE_ID) return
    try {
      const saved = normalizePerspective(await api.updateCalendarPerspective(perspectiveId, { state: capturePerspectiveState() }, activeContextId))
      playSound('perspectiveUpdate')
      setPerspectives(prev => prev.map(perspective => perspective.id === saved.id ? saved : perspective))
      setActivePerspectiveId(saved.id)
    } catch (err) { console.error('Failed to update calendar perspective', err) }
  }

  const renamePerspective = async (perspectiveId, name) => {
    if (perspectiveId === NONE_PERSPECTIVE_ID) return
    try {
      const saved = normalizePerspective(await api.updateCalendarPerspective(perspectiveId, { name }, activeContextId))
      playSound('perspectiveRename')
      setPerspectives(prev => prev
        .map(perspective => perspective.id === saved.id ? saved : perspective)
        .sort((a, b) => a.name.localeCompare(b.name)))
    } catch (err) { console.error('Failed to rename calendar perspective', err) }
  }

  const setCalendarDefaultPerspective = async perspectiveId => {
    const nextId = perspectiveId || NONE_PERSPECTIVE_ID
    const previousId = defaultPerspectiveId
    setDefaultPerspectiveId(nextId)
    try {
      await onSetContextDefaultPerspective?.('calendar', nextId)
    } catch (error) {
      setDefaultPerspectiveId(previousId)
      console.error('Failed to update context default perspective', error)
    }
  }

  useEffect(() => {
    if (contextDefaultPerspectiveId === undefined) return
    const nextId = contextDefaultPerspectiveId || NONE_PERSPECTIVE_ID
    setDefaultPerspectiveId(nextId)
    appliedDefaultRef.current = false
  }, [contextDefaultPerspectiveId, contextApplyToken])

  const deletePerspective = async perspectiveId => {
    if (perspectiveId === NONE_PERSPECTIVE_ID) return
    try {
      await api.deleteCalendarPerspective(perspectiveId, activeContextId)
      playSound('perspectiveDelete')
      setPerspectives(prev => prev.filter(perspective => perspective.id !== perspectiveId))
      if (activePerspectiveId === perspectiveId) applyPerspective(nonePerspective)
      if (defaultPerspectiveId === perspectiveId) setCalendarDefaultPerspective(NONE_PERSPECTIVE_ID)
    } catch (err) { console.error('Failed to delete calendar perspective', err) }
  }

  useEffect(() => {
    appliedDefaultRef.current = false
    dayTimelineColumnPrefsRef.current.clear()
  }, [isActive, project?.id])

  useEffect(() => {
    if (!isActive || !restoreRequest?.id || restoreHandledRef.current === restoreRequest.id) return
    restoreHandledRef.current = restoreRequest.id
    appliedDefaultRef.current = true
    const state = restoreRequest.state ?? {}
    applyPerspective({ id: state.activePerspectiveId ?? NONE_PERSPECTIVE_ID, state })
    onRestoreConsumed?.()
  }, [isActive, restoreRequest])

  useEffect(() => {
    if (!isActive || appliedDefaultRef.current || dimensions.length === 0) return
    const defaultPerspective = perspectiveOptions.find(perspective => perspective.id === defaultPerspectiveId) ?? nonePerspective
    appliedDefaultRef.current = true
    applyPerspective(defaultPerspective)
  }, [defaultPerspectiveId, dimensions.length, isActive, perspectives])

  const resolveTimeSlotIdsForWarning = (detail, editedSlot) => {
    const ids = new Set(Array.isArray(detail?.timeSlotIds) ? detail.timeSlotIds : [])
    if (detail?.id) ids.add(detail.id)
    if (editedSlot?.id) ids.add(editedSlot.id)
    if (detail?.type === 'inheritance_deadline' || detail?.type === 'inheritance_earliest_start') {
      noteInheritance
        .filter(link => link.childNoteId === editedSlot?.noteId)
        .forEach(link => {
          const parentSlot = timeSlots.find(slot => slot.noteId === link.parentNoteId)
          if (parentSlot) ids.add(parentSlot.id)
        })
    }
    return [...ids]
  }

  const showEditWarning = (detail, editedSlot) => {
    const type = detail?.type || 'transaction'
    const title = type === 'dependency' || type === 'scale_mismatch'
      ? 'Dependency violation'
      : type === 'deadline' ? 'Hard deadline'
      : type === 'inheritance_deadline' ? 'Inherited hard deadline'
      : type === 'earliest_start' ? 'Earliest start date'
      : type === 'inheritance_earliest_start' ? 'Inherited earliest start'
      : type === 'past' ? 'Before today'
      : 'Schedule change blocked'
    setCalendarWarning({
      title,
      message: detail?.message || 'This schedule change violates a scheduling rule.',
      timeSlotIds: resolveTimeSlotIdsForWarning(detail, editedSlot),
      type,
    })
  }

  useEffect(() => {
    if (!inlineTitleEdit?.slotId) return
    window.requestAnimationFrame(() => {
      inlineTitleInputRef.current?.focus()
      inlineTitleInputRef.current?.select()
    })
  }, [inlineTitleEdit?.slotId])

  useEffect(() => {
    if (timeSlotContextMenu?.type !== 'create') return
    window.requestAnimationFrame(() => {
      createTitleInputRef.current?.focus()
    })
  }, [timeSlotContextMenu?.type, timeSlotContextMenu?.x, timeSlotContextMenu?.y])

  const dayTimelineMinuteFromPointer = (pointerEvent, snapMode = 'round') => {
    const timeline = dayTimelineRef.current
    if (!timeline) return 0
    const rect = timeline.getBoundingClientRect()
    const rawMinute = ((pointerEvent.clientY - rect.top + timeline.scrollTop) / dayHourHeight) * 60
    const snap = snapMode === 'floor' ? Math.floor : snapMode === 'ceil' ? Math.ceil : Math.round
    return Math.max(0, Math.min(DAY_MINUTES - CALENDAR_SLOT_SNAP_MINUTES, snap(rawMinute / CALENDAR_SLOT_SNAP_MINUTES) * CALENDAR_SLOT_SNAP_MINUTES))
  }

  const createCalendarTimeSlot = async ({ day = focusDate, startMinute = DEFAULT_CALENDAR_SLOT_START_MINUTE, duration = DEFAULT_CALENDAR_SLOT_MINUTES, title = '' }) => {
    const dayStart = Math.max(0, calendarDayCol(anchor, day))
    const startCol = dayStart + Math.max(0, Math.min(DAY_MINUTES - CALENDAR_SLOT_SNAP_MINUTES, startMinute))
    const safeDuration = Math.max(
      CALENDAR_SLOT_SNAP_MINUTES,
      Math.min(DAY_MINUTES - (startCol - dayStart), duration || DEFAULT_CALENDAR_SLOT_MINUTES),
    )
    const todayMinute = Math.max(0, calendarDayCol(anchor, actualToday))
    if (startCol < todayMinute) {
      showEditWarning({
        type: 'past',
        message: 'This would create a time slot before today. Resolve it in Schedule if you intentionally need to work in the past.',
      }, { id: newClientId('ms-preview'), startCol, duration: safeDuration })
      return
    }

    const noteTitle = title.trim() || 'Untitled'
    const note = {
      id: newClientId('note'),
      html: title.trim(),
      title: noteTitle,
      collapsed: false,
      parentNoteId: workspaceRootNoteId,
    }
    const slot = {
      id: newClientId('ms'),
      noteId: note.id,
      startCol,
      duration: safeDuration,
      title: '',
      color: '#1a73e8',
    }

    try {
      const savedNote = await api.createNote(note)
      const savedSlot = await api.createTimeSlot(slot)
      if (canvasDimId && focusedCatId && focusedCatId !== UNASSIGNED_CATEGORY_ID) {
        setAssignments(prev => ({
          ...prev,
          [savedNote.id]: { ...(prev[savedNote.id] ?? {}), [canvasDimId]: focusedCatId },
        }))
        api.assign(savedNote.id, canvasDimId, focusedCatId).catch(console.error)
      } else {
        setHiddenCatIds(prev => {
          if (!prev.has(UNASSIGNED_CATEGORY_ID)) return prev
          const next = new Set(prev)
          next.delete(UNASSIGNED_CATEGORY_ID)
          return next
        })
      }
      onNoteCreated?.(savedNote)
      setTimeSlots(prev => [...prev, savedSlot])
      onScheduleChanged?.()
      setVisibleScales(prev => new Set([...prev, 'minute']))
      if (!title.trim()) setInlineTitleEdit({ slotId: savedSlot.id, noteId: savedNote.id, value: '' })
      playSound('timeSlotCreate')
      setCalendarWarning(null)
    } catch (err) {
      console.error('Failed to create calendar time slot', err)
      showEditWarning(err?.detail || { message: err?.message || 'Could not create this time slot.' }, slot)
    }
  }

  const openTimelineContextMenu = menuEvent => {
    if (paintCat || paintPersonaId) return
    if (menuEvent.target.closest?.(`.${styles.timelineEvent}`)) return
    menuEvent.preventDefault()
    menuEvent.stopPropagation()
    setTimeSlotContextMenu({
      type: 'create',
      x: menuEvent.clientX,
      y: menuEvent.clientY,
      dayKey: dayKey(focusDate),
      startMinute: dayTimelineMinuteFromPointer(menuEvent, 'floor'),
      title: '',
    })
  }

  const openCalendarDayContextMenu = (menuEvent, day) => {
    if (paintCat || paintPersonaId) return
    if (menuEvent.target.closest?.(`.${styles.eventPill}, .${styles.spanningEvent}, .${styles.timelineEvent}`)) return
    menuEvent.preventDefault()
    menuEvent.stopPropagation()
    setTimeSlotContextMenu({
      type: 'create',
      x: menuEvent.clientX,
      y: menuEvent.clientY,
      dayKey: dayKey(day),
      startMinute: DEFAULT_CALENDAR_SLOT_START_MINUTE,
      title: '',
    })
  }

  const createTimeSlotFromContextMenu = async () => {
    if (timeSlotContextMenu?.type !== 'create') return
    const startMinute = timeSlotContextMenu.startMinute
    const targetDay = dateFromDayKey(timeSlotContextMenu.dayKey, focusDate)
    const title = timeSlotContextMenu.title || ''
    setTimeSlotContextMenu(null)
    await createCalendarTimeSlot({ day: targetDay, startMinute, title })
  }

  const commitInlineTitleEdit = async () => {
    if (!inlineTitleEdit?.noteId) return
    const nextTitle = inlineTitleEdit.value.trim() || 'Untitled'
    const nextHtml = inlineTitleEdit.value.trim()
    const noteId = inlineTitleEdit.noteId
    setInlineTitleEdit(null)
    onNoteUpdated?.(noteId, { title: nextTitle, html: nextHtml })
    try {
      const saved = await api.updateNote(noteId, { title: nextTitle, html: nextHtml })
      onNoteUpdated?.(noteId, { title: saved.title, html: saved.html })
    } catch (err) {
      console.error('Failed to update calendar note title', err)
    }
  }

  const commitTimeSlotChange = async (slot, nextValues, label) => {
    if (!slot || !['minute', 'day'].includes(timeSlotScale(slot, anchor))) return false
    const after = { ...slot, ...nextValues }
    if (timeSlotScale(after, anchor) !== timeSlotScale(slot, anchor)) {
      showEditWarning({
        type: 'time_slot_scale_mismatch',
        message: 'This resize would change the planning scale of the time slot.',
        id: slot.id,
      }, slot)
      return false
    }
    if (after.startCol === slot.startCol && after.duration === slot.duration) return true
    const todayMinute = Math.max(0, calendarDayCol(anchor, actualToday))
    if (after.startCol < todayMinute) {
      showEditWarning({
        type: 'past',
        message: 'This change would place the time slot before today. Resolve it in Schedule if you intentionally need to work in the past.',
        id: slot.id,
      }, slot)
      return false
    }
    try {
      await api.applyTransaction({
        id: newClientId('tx'),
        type: label === 'Resize time slot' ? 'timeSlot.resize' : 'timeSlot.move',
        label,
        before: { timeSlots: [slot], dependencies: [] },
        after: { timeSlots: [after], dependencies: [] },
      })
      setTimeSlots(prev => prev.map(item => item.id === slot.id ? after : item))
      onScheduleChanged?.()
      playSound(label === 'Resize time slot' ? 'calendarEventResize' : 'calendarEventMove')
      setCalendarWarning(null)
      return true
    } catch (err) {
      console.error('Calendar schedule edit rejected', err)
      showEditWarning(err?.detail || { message: err?.message }, slot)
      return false
    }
  }

  const beginDayTimeEdit = (mouseEvent, event, mode) => {
    if (mouseEvent.button !== 0 || paintCat || paintPersonaId) return
    const slot = timeSlots.find(item => item.id === event.id)
    if (!slot || timeSlotScale(slot, anchor) !== 'minute') return
    mouseEvent.preventDefault()
    mouseEvent.stopPropagation()
    const startY = mouseEvent.clientY
    const timelineLayer = mouseEvent.currentTarget.parentElement
    const originalStart = Number(slot.startCol) || 0
    const originalDuration = Math.max(10, Number(slot.duration) || 10)
    const originalEnd = originalStart + originalDuration
    const originalLayoutCol = Number.isInteger(event.layoutCol)
      ? event.layoutCol
      : (dayTimelineColumnPrefsRef.current.get(slot.id) ?? 0)
    const dayStart = Math.max(0, calendarDayCol(anchor, focusDate))
    const dayEnd = dayStart + DAY_MINUTES
    let latest = { startCol: originalStart, duration: originalDuration, layoutCol: originalLayoutCol }
    let timeChanged = false
    let columnChanged = false

    const calculate = clientY => {
      const delta = Math.round(((clientY - startY) / dayHourHeight) * 6) * 10
      if (mode === 'move') {
        const startCol = Math.max(dayStart, Math.min(dayEnd - originalDuration, originalStart + delta))
        return { startCol, duration: originalDuration }
      }
      if (mode === 'resize-start') {
        const earliestMinuteScaleStart = originalEnd - (DAY_MINUTES - 10)
        const startCol = Math.min(
          originalEnd - 10,
          Math.max(dayStart, earliestMinuteScaleStart, originalStart + delta),
        )
        return { startCol, duration: originalEnd - startCol }
      }
      const latestMinuteScaleEnd = originalStart + DAY_MINUTES - 10
      const endCol = Math.max(originalStart + 10, Math.min(dayEnd, latestMinuteScaleEnd, originalEnd + delta))
      return { startCol: originalStart, duration: endCol - originalStart }
    }

    const calculateLayoutCol = clientX => {
      if (mode !== 'move') return originalLayoutCol
      const rect = timelineLayer?.getBoundingClientRect()
      const columnCount = Math.max(MIN_DAY_TIMELINE_COLUMNS, Number(event.layoutCols) || MIN_DAY_TIMELINE_COLUMNS)
      if (!rect?.width) return originalLayoutCol
      return Math.max(0, Math.min(columnCount - 1, Math.floor(((clientX - rect.left) / rect.width) * columnCount)))
    }

    const onMove = moveEvent => {
      moveEvent.preventDefault()
      latest = { ...calculate(moveEvent.clientY), layoutCol: calculateLayoutCol(moveEvent.clientX) }
      timeChanged = latest.startCol !== originalStart || latest.duration !== originalDuration
      columnChanged = mode === 'move' && latest.layoutCol !== originalLayoutCol
      if (timeChanged || columnChanged) suppressOpenRef.current = slot.id
      setEditPreview({ id: slot.id, ...latest })
    }

    const onUp = async upEvent => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (columnChanged) {
        dayTimelineColumnPrefsRef.current.set(slot.id, latest.layoutCol)
        setDayColumnPrefsVersion(version => version + 1)
        playSound('calendarEventMove')
      }
      if (timeChanged) {
        await commitTimeSlotChange(
          slot,
          { startCol: latest.startCol, duration: latest.duration },
          mode === 'move' ? 'Move time slot' : 'Resize time slot',
        )
      }
      setEditPreview(null)
      window.setTimeout(() => {
        if (suppressOpenRef.current === slot.id) suppressOpenRef.current = null
      }, 120)
      upEvent.preventDefault()
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const startCalendarTimeSlotDrag = (dragEvent, event) => {
    if (paintCat || paintPersonaId) {
      dragEvent.preventDefault()
      return
    }
    suppressOpenRef.current = event.id
    dragEvent.dataTransfer.setData('calendar-time-slot', event.id)
    dragEvent.dataTransfer.effectAllowed = 'move'
  }

  const endCalendarTimeSlotDrag = event => {
    window.setTimeout(() => {
      if (suppressOpenRef.current === event.id) suppressOpenRef.current = null
    }, 120)
  }

  const dropTimeSlotOnDay = async (dropEvent, day) => {
    const timeSlotId = dropEvent.dataTransfer.getData('calendar-time-slot')
    if (!timeSlotId) return
    dropEvent.preventDefault()
    dropEvent.stopPropagation()
    const slot = timeSlots.find(item => item.id === timeSlotId)
    if (!slot || !['minute', 'day'].includes(timeSlotScale(slot, anchor))) return
    const targetDayCol = calendarDayCol(anchor, day)
    const scale = timeSlotScale(slot, anchor)
    const minuteWithinDay = ((Number(slot.startCol) || 0) % DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES
    const startCol = scale === 'day' ? targetDayCol : targetDayCol + minuteWithinDay
    await commitTimeSlotChange(slot, { startCol, duration: slot.duration }, 'Move time slot')
    window.setTimeout(() => {
      if (suppressOpenRef.current === slot.id) suppressOpenRef.current = null
    }, 120)
  }

  const dropTimeSlotOnCalendarRow = (dropEvent, rowStart) => {
    const timeSlotId = dropEvent.dataTransfer.getData('calendar-time-slot')
    if (!timeSlotId) return
    const rect = dropEvent.currentTarget.getBoundingClientRect()
    const dayIndex = Math.max(0, Math.min(6, Math.floor(((dropEvent.clientX - rect.left) / rect.width) * 7)))
    dropTimeSlotOnDay(dropEvent, addDays(rowStart, dayIndex))
  }

  const beginDayScaleResize = (mouseEvent, event, side) => {
    if (mouseEvent.button !== 0 || paintCat || paintPersonaId) return
    const slot = timeSlots.find(item => item.id === event.id)
    if (!slot || timeSlotScale(slot, anchor) !== 'day') return
    mouseEvent.preventDefault()
    mouseEvent.stopPropagation()
    const track = mouseEvent.currentTarget.closest('button')?.parentElement
    const trackWidth = track?.getBoundingClientRect().width || 0
    if (trackWidth <= 0) return
    const startX = mouseEvent.clientX
    const originalStart = Number(slot.startCol) || 0
    const originalDuration = Math.max(DAY_MINUTES, Number(slot.duration) || DAY_MINUTES)
    const maxDayDuration = DAY_MINUTES * 29
    let latest = { startCol: originalStart, duration: originalDuration }
    let changed = false

    const calculate = clientX => {
      const deltaDays = Math.round((clientX - startX) / (trackWidth / 7))
      if (side === 'left') {
        const minDelta = Math.max(-Math.floor(originalStart / DAY_MINUTES), -Math.floor((maxDayDuration - originalDuration) / DAY_MINUTES))
        const maxDelta = Math.floor(originalDuration / DAY_MINUTES) - 1
        const clamped = Math.max(minDelta, Math.min(maxDelta, deltaDays))
        return {
          startCol: originalStart + clamped * DAY_MINUTES,
          duration: originalDuration - clamped * DAY_MINUTES,
        }
      }
      const minDelta = 1 - Math.floor(originalDuration / DAY_MINUTES)
      const maxDelta = Math.floor((maxDayDuration - originalDuration) / DAY_MINUTES)
      const clamped = Math.max(minDelta, Math.min(maxDelta, deltaDays))
      return { startCol: originalStart, duration: originalDuration + clamped * DAY_MINUTES }
    }

    const onMove = moveEvent => {
      moveEvent.preventDefault()
      latest = calculate(moveEvent.clientX)
      changed = latest.startCol !== originalStart || latest.duration !== originalDuration
      if (changed) suppressOpenRef.current = slot.id
      setEditPreview({ id: slot.id, ...latest })
    }

    const onUp = async upEvent => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (changed) await commitTimeSlotChange(slot, latest, 'Resize time slot')
      setEditPreview(null)
      window.setTimeout(() => {
        if (suppressOpenRef.current === slot.id) suppressOpenRef.current = null
      }, 120)
      upEvent.preventDefault()
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const openTimeSlotContextMenu = (menuEvent, event) => {
    menuEvent.preventDefault()
    menuEvent.stopPropagation()
    setTimeSlotContextMenu({ type: 'inspect', x: menuEvent.clientX, y: menuEvent.clientY, event })
  }

  const inspectTimeSlotInSchedule = event => {
    if (!event) return
    const visibleNoteIds = new Set(events.map(item => item.noteId))
    visibleNoteIds.add(event.noteId)
    onRequestScheduleResolve?.({
      id: newClientId('calendar-inspect'),
      mode: 'inspect',
      timeSlotIds: [event.id],
      timeScale: event.scale,
      calendarContext: {
        canvasDimId,
        focusedCatId,
        hiddenCatIds: [...hiddenCatIds],
        colorDimId,
        visibleNoteIds: [...visibleNoteIds],
      },
      calendarState: { ...capturePerspectiveState(), activePerspectiveId },
    })
    setTimeSlotContextMenu(null)
  }

  const openScheduleResolver = () => {
    if (!calendarWarning?.timeSlotIds?.length) return
    onRequestScheduleResolve?.({
      id: newClientId('calendar-resolve'),
      timeSlotIds: calendarWarning.timeSlotIds,
      violationType: calendarWarning.type,
      calendarState: { ...capturePerspectiveState(), activePerspectiveId },
    })
    setCalendarWarning(null)
  }

  const todayEvents = useMemo(() => events.filter(event => overlapsDay(event, focusDate)), [events, focusDate])
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(focusDate, i)), [focusDate])
  const weekEnd = useMemo(() => addDays(weekDays[0], 7), [weekDays])
  const todayWeekIndex = useMemo(
    () => weekDays.findIndex(day => isSameDay(day, actualToday)),
    [weekDays, actualToday]
  )
  const todayPhaseEvents = useMemo(() => todayEvents.filter(event => event.scale === 'month'), [todayEvents])
  const todayDayEvents = useMemo(() => todayEvents.filter(event => event.scale === 'day'), [todayEvents])
  const todayMinuteEvents = useMemo(() => todayEvents.filter(event => event.scale === 'minute'), [todayEvents])
  const todayTimedEvents = useMemo(
    () => layoutTimedEvents(todayMinuteEvents, focusDate, dayTimelineColumnPrefsRef.current, dayHourHeight),
    [todayMinuteEvents, focusDate, dayColumnPrefsVersion, dayHourHeight]
  )
  const weekPhaseEvents = useMemo(
    () => events.filter(event => event.scale === 'month' && overlapsRange(event, weekDays[0], weekEnd)),
    [events, weekDays, weekEnd]
  )
  const weekDayScaleEvents = useMemo(
    () => events.filter(event => event.scale === 'day' && overlapsRange(event, weekDays[0], weekEnd)),
    [events, weekDays, weekEnd]
  )
  const monthStart = useMemo(
    () => new Date(focusDate.getFullYear(), focusDate.getMonth(), 1),
    [focusDate]
  )
  const monthEnd = useMemo(() => new Date(focusDate.getFullYear(), focusDate.getMonth() + 1, 1), [focusDate])
  const monthPhaseEvents = useMemo(
    () => events.filter(event => event.scale === 'month' && overlapsRange(event, monthStart, monthEnd)),
    [events, monthStart, monthEnd]
  )
  const monthDays = useMemo(() => buildMonthDays(focusDate), [focusDate])
  const monthEventsByDay = useMemo(() => {
    const map = new Map(monthDays.map(day => [dayKey(day), []]))
    events.filter(event => event.scale === 'minute').forEach(event => {
      monthDays.forEach(day => {
        if (overlapsDay(event, day)) map.get(dayKey(day))?.push(event)
      })
    })
    return map
  }, [events, monthDays])

  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * dayHourHeight
  const visibleRange = view === 'today'
    ? fmtDay(focusDate)
    : view === 'week'
      ? `${fmtDay(weekDays[0])} – ${fmtDay(weekDays[6])}`
      : fmtMonth(focusDate)

  const navigateDate = direction => {
    playSound('calendarNavigate')
    setFocusDate(current => {
      if (view === 'month') {
        const targetMonth = new Date(current.getFullYear(), current.getMonth() + direction, 1)
        const lastDay = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate()
        return new Date(targetMonth.getFullYear(), targetMonth.getMonth(), Math.min(current.getDate(), lastDay))
      }
      return addDays(current, direction * (view === 'week' ? 7 : 1))
    })
  }

  const openDayView = day => {
    playSound('calendarViewChange')
    setFocusDate(localMidnight(day))
    setView('today')
  }

  const handleDateWheel = event => {
    event.preventDefault()
    const now = Date.now()
    if (now - dateWheelAtRef.current < 180) return
    dateWheelAtRef.current = now
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (delta !== 0) navigateDate(delta > 0 ? 1 : -1)
  }

  const personaPaintProps = {
    paintPersonaId,
    onPersonaPaint: paintPersonaOnNote,
    onRemovePersona: removePersonaFromNote,
    onContextMenu: openTimeSlotContextMenu,
  }

  return (
    <div
      className={`${styles.page} ${(paintCat || paintPersonaId) ? styles.paintMode : ''}`}
      style={paintPersonaId
        ? { cursor: personaCursor || 'crosshair' }
        : paintCat ? { cursor: makeColorCursor(paintCat.color) } : undefined}
      onClick={(paintCat || paintPersonaId) ? () => { setPaintCat(null); setPaintPersonaId(null) } : undefined}
    >
      <div className={styles.toolbar}>
        <CalendarGroupScroller
          dimensions={visibleDimensions}
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

        <div
          className={styles.dateNavigator}
          aria-label={`${visibleRange}, calendar navigation`}
          onWheel={handleDateWheel}
          title="Scroll to move through the calendar"
        >
          <button type="button" onClick={() => navigateDate(-1)} title={`Previous ${view === 'today' ? 'day' : view}`} aria-label={`Previous ${view === 'today' ? 'day' : view}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <div>
            <span>{view === 'today' ? 'Day' : view === 'week' ? '7 days' : 'Month'}</span>
            <strong>{visibleRange}</strong>
          </div>
          <button type="button" onClick={() => navigateDate(1)} title={`Next ${view === 'today' ? 'day' : view}`} aria-label={`Next ${view === 'today' ? 'day' : view}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>

        <div className={styles.toolbarRight}>
          <div className={styles.segmented} aria-label="Calendar view">
            {VIEW_OPTIONS.map(option => (
              <button
                key={option.id}
                type="button"
                className={`${styles.segment} ${view === option.id ? styles.segmentActive : ''}`}
                onClick={() => { playSound('calendarViewChange'); setView(option.id) }}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className={styles.scaleFilters} aria-label="Visible timeslot scales">
            {SCALE_OPTIONS.map(option => {
              const active = visibleScales.has(option.id)
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`${styles.scaleFilter} ${active ? styles.scaleFilterActive : ''}`}
                  aria-pressed={active}
                  onClick={() => toggleScale(option.id)}
                >
                  <span aria-hidden="true">{active ? '✓' : ''}</span>
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <main className={styles.calendarShell}>
        {error && <div className={styles.status}>{error}</div>}
        {!error && loading && <div className={styles.status}>Loading scheduled notes...</div>}

        {!error && view === 'today' && (
          <section className={styles.todayView} aria-label={`${fmtDay(focusDate)} calendar`}>
            <div className={styles.todayHeader}>
              <div>
                <span className={styles.todayKicker}>{isSameDay(focusDate, actualToday) ? 'Today' : 'Selected day'}</span>
                <strong>{fmtDay(focusDate)}</strong>
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
                        <EventPill key={`phase-${event.id}`} event={event} day={focusDate} compact onNoteOpen={onNoteOpen} paintCat={paintCat} onPaint={paintNote} {...personaPaintProps} />
                      ))}
                    </div>
                  </div>
                )}
                {todayDayEvents.length > 0 && (
                  <div className={styles.planningBand}>
                    <span className={styles.planningBandLabel}>Day plan</span>
                    <div className={styles.planningBandItems}>
                      {todayDayEvents.map(event => (
                        <EventPill key={`day-${event.id}`} event={event} day={focusDate} compact onNoteOpen={onNoteOpen} paintCat={paintCat} onPaint={paintNote} {...personaPaintProps} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div
              ref={dayTimelineRef}
              className={styles.dayTimeline}
              style={{ '--hour-height': `${dayHourHeight}px` }}
              onContextMenu={openTimelineContextMenu}
            >
              {isSameDay(focusDate, actualToday) && (
                <div className={styles.nowLine} style={{ top: `${nowTop}px` }}>
                  <span>{fmtTime(now)}</span>
                </div>
              )}
              {Array.from({ length: 24 }, (_, hour) => (
                <div className={styles.hourRow} key={hour}>
                  <span>{String(hour).padStart(2, '0')}:00</span>
                </div>
              ))}
              <div className={styles.timelineEventsLayer} style={{ height: `${24 * dayHourHeight}px` }}>
                {todayTimedEvents.map(event => {
                  const top = (event.startMinute / 60) * dayHourHeight
                  const height = Math.max(30, ((event.endMinute - event.startMinute) / 60) * dayHourHeight)
                  const colWidth = 100 / event.layoutCols
                  const gap = event.layoutCols > 1 ? 6 : 0
                  const sharedGap = gap * (event.layoutCols - 1) / event.layoutCols
                  const isInlineEditing = inlineTitleEdit?.slotId === event.id
                  return (
                    <div
                      role="button"
                      tabIndex={0}
                      key={event.id}
                      className={`${styles.timelineEvent} ${styles.timelineEventEditable}`}
                      style={{
                        ...colorStyle(event.color),
                        top: `${top}px`,
                        height: `${height}px`,
                        left: `calc(${event.layoutCol * colWidth}% + ${(event.layoutCol * gap) / event.layoutCols}px)`,
                        width: `calc(${colWidth}% - ${sharedGap}px)`,
                      }}
                      onMouseDown={mouseEvent => beginDayTimeEdit(mouseEvent, event, 'move')}
                      onContextMenu={menuEvent => openTimeSlotContextMenu(menuEvent, event)}
                      onClick={e => {
                        if (isInlineEditing) {
                          e.preventDefault()
                          e.stopPropagation()
                          return
                        }
                        if (suppressOpenRef.current === event.id) {
                          e.preventDefault()
                          e.stopPropagation()
                          return
                        }
                        if (paintPersonaId) {
                          e.stopPropagation()
                          paintPersonaOnNote(event.noteId)
                          return
                        }
                        if (paintCat) {
                          e.stopPropagation()
                          paintNote(event.noteId)
                          return
                        }
                        onNoteOpen?.(event.noteId)
                      }}
                      title={`${event.title} · ${rangeLabel(event, focusDate)}`}
                    >
                      <span
                        className={`${styles.timelineResizeHandle} ${styles.timelineResizeHandleTop}`}
                        onMouseDown={mouseEvent => beginDayTimeEdit(mouseEvent, event, 'resize-start')}
                        aria-hidden="true"
                      />
                      <span>{scaleLabel(event.scale)} · {rangeLabel(event, focusDate)}</span>
                      <div className={styles.timelineTitleRow}>
                        {isInlineEditing ? (
                          <input
                            ref={inlineTitleInputRef}
                            className={styles.timelineTitleInput}
                            value={inlineTitleEdit.value}
                            placeholder="Type note title"
                            onChange={inputEvent => setInlineTitleEdit(current => (
                              current?.slotId === event.id
                                ? { ...current, value: inputEvent.target.value }
                                : current
                            ))}
                            onMouseDown={inputEvent => inputEvent.stopPropagation()}
                            onClick={inputEvent => inputEvent.stopPropagation()}
                            onBlur={commitInlineTitleEdit}
                            onKeyDown={keyEvent => {
                              keyEvent.stopPropagation()
                              if (keyEvent.key === 'Enter') keyEvent.currentTarget.blur()
                              if (keyEvent.key === 'Escape') setInlineTitleEdit(null)
                            }}
                          />
                        ) : (
                          <strong>{event.title}</strong>
                        )}
                        <PersonaAvatarStack
                          personas={event.personas}
                          onRemove={personaId => removePersonaFromNote(personaId, event.noteId)}
                        />
                      </div>
                      {event.locationCategory && <em>{event.locationCategory.name}</em>}
                      <span
                        className={`${styles.timelineResizeHandle} ${styles.timelineResizeHandleBottom}`}
                        onMouseDown={mouseEvent => beginDayTimeEdit(mouseEvent, event, 'resize-end')}
                        aria-hidden="true"
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          </section>
        )}

        {!error && view === 'week' && (
          <section ref={weekViewRef} className={styles.weekView} aria-label="Seven day calendar">
            {weekPhaseEvents.length > 0 && (
              <div className={styles.weekPhaseLane}>
                <div className={styles.weekPhaseTrack}>
                  <span className={styles.weekPhaseLabel}>Phases</span>
                  {weekPhaseEvents.map(event => (
                    <SpanningEvent key={`week-phase-${event.id}`} event={event} start={weekDays[0]} end={weekEnd} onNoteOpen={onNoteOpen} paintCat={paintCat} onPaint={paintNote} {...personaPaintProps} />
                  ))}
                </div>
              </div>
            )}
            <div
              className={styles.weekGrid}
              onDragOver={dragEvent => {
                if (dragEvent.dataTransfer.types.includes('calendar-time-slot')) dragEvent.preventDefault()
              }}
              onDrop={dropEvent => dropTimeSlotOnCalendarRow(dropEvent, weekDays[0])}
            >
              {weekDays.map(day => {
                const dayEvents = events.filter(event => event.scale === 'minute' && overlapsDay(event, day))
                return (
                  <div
                    key={dayKey(day)}
                    className={`${styles.weekDay} ${isSameDay(day, actualToday) ? styles.todayCell : ''}`}
                    onDragOver={dragEvent => {
                      if (dragEvent.dataTransfer.types.includes('calendar-time-slot')) dragEvent.preventDefault()
                    }}
                    onContextMenu={menuEvent => openCalendarDayContextMenu(menuEvent, day)}
                    onDrop={dropEvent => dropTimeSlotOnDay(dropEvent, day)}
                  >
                    <div
                      className={styles.dayHeader}
                      onDoubleClick={event => {
                        event.preventDefault()
                        event.stopPropagation()
                        openDayView(day)
                      }}
                    >
                      <span>{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                      <strong>{day.getDate()}</strong>
                      {isSameDay(day, actualToday) && <em>Today</em>}
                    </div>
                    <div
                      className={styles.eventStack}
                      style={weekDayScaleEvents.length
                        ? { paddingTop: `${weekDayScaleEvents.length * 27 + 42}px` }
                        : undefined}
                    >
                      {dayEvents.length ? dayEvents.map(event => (
                        <EventPill
                          key={`${dayKey(day)}-${event.id}`}
                          event={event}
                          day={day}
                          onNoteOpen={noteId => {
                            if (suppressOpenRef.current === event.id) return
                            onNoteOpen?.(noteId)
                          }}
                          paintCat={paintCat}
                          onPaint={paintNote}
                          draggable={!paintCat && !paintPersonaId}
                          onDragStart={dragEvent => startCalendarTimeSlotDrag(dragEvent, event)}
                          onDragEnd={() => endCalendarTimeSlotDrag(event)}
                          {...personaPaintProps}
                        />
                      )) : <span className={styles.emptyDay}>No matching notes</span>}
                    </div>
                  </div>
                )
              })}
              {weekDayScaleEvents.length > 0 && (
                <div
                  className={styles.weekDaySpanLayer}
                  style={{ height: `${weekDayScaleEvents.length * 27 + 32}px` }}
                >
                  <span className={styles.weekDaySpanLabel}>Day-scale</span>
                  {todayWeekIndex >= 0 && (
                    <span
                      className={styles.weekDaySpanToday}
                      style={{ left: `${(todayWeekIndex / 7) * 100}%` }}
                      aria-hidden="true"
                    />
                  )}
                  <div className={styles.weekDaySpanBars}>
                    {weekDayScaleEvents.map((event, lane) => (
                      <SpanningEvent
                        key={`week-day-${event.id}`}
                        event={event}
                        start={weekDays[0]}
                        end={weekEnd}
                        lane={lane}
                        onNoteOpen={noteId => {
                          if (suppressOpenRef.current === event.id) return
                          onNoteOpen?.(noteId)
                        }}
                        paintCat={paintCat}
                        onPaint={paintNote}
                        draggable={!paintCat && !paintPersonaId}
                        onDragStart={dragEvent => startCalendarTimeSlotDrag(dragEvent, event)}
                        onDragEnd={() => endCalendarTimeSlotDrag(event)}
                        editable={!paintCat && !paintPersonaId}
                        onResizeStart={beginDayScaleResize}
                        {...personaPaintProps}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {!error && view === 'month' && (
          <section className={styles.monthView} aria-label="Month calendar">
            {visibleScales.has('month') && (
              <div className={styles.monthScaleLane}>
                <div className={styles.monthScaleHeader}>
                  <strong>Month-scale timeslots</strong>
                  <span>{fmtMonth(focusDate)}</span>
                </div>
                <div className={styles.monthScaleEvents}>
                  {monthPhaseEvents.length ? monthPhaseEvents.map(event => (
                    <EventPill
                      key={`month-global-${event.id}`}
                      event={event}
                      day={monthStart}
                      onNoteOpen={onNoteOpen}
                      paintCat={paintCat}
                      onPaint={paintNote}
                      {...personaPaintProps}
                    />
                  )) : (
                    <span className={styles.monthScaleEmpty}>No month-scale timeslots in this month</span>
                  )}
                </div>
              </div>
            )}
            <div className={styles.monthWeekdays}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <span key={day}>{day}</span>)}
            </div>
            <div ref={monthGridRef} className={styles.monthGrid}>
              {Array.from({ length: 6 }, (_, weekIndex) => {
                const calendarWeek = monthDays.slice(weekIndex * 7, weekIndex * 7 + 7)
                const calendarWeekEnd = addDays(calendarWeek[0], 7)
                const spanningDayEvents = events.filter(event => (
                  event.scale === 'day' && overlapsRange(event, calendarWeek[0], calendarWeekEnd)
                ))
                const spanLaneHeight = spanningDayEvents.length ? spanningDayEvents.length * 27 + 7 : 0
                return (
                  <div
                    key={dayKey(calendarWeek[0])}
                    className={styles.monthWeekRow}
                    style={{ '--month-span-height': `${spanLaneHeight}px` }}
                    onDragOver={dragEvent => {
                      if (dragEvent.dataTransfer.types.includes('calendar-time-slot')) dragEvent.preventDefault()
                    }}
                    onDrop={dropEvent => dropTimeSlotOnCalendarRow(dropEvent, calendarWeek[0])}
                  >
                    {calendarWeek.map(day => {
                      const dayEvents = monthEventsByDay.get(dayKey(day)) || []
                      return (
                        <div
                          key={dayKey(day)}
                          className={[
                            styles.monthDay,
                            day.getMonth() !== focusDate.getMonth() ? styles.outsideMonth : '',
                            isSameDay(day, actualToday) ? styles.todayCell : '',
                          ].filter(Boolean).join(' ')}
                          onDragOver={dragEvent => {
                            if (dragEvent.dataTransfer.types.includes('calendar-time-slot')) dragEvent.preventDefault()
                          }}
                          onContextMenu={menuEvent => openCalendarDayContextMenu(menuEvent, day)}
                          onDrop={dropEvent => dropTimeSlotOnDay(dropEvent, day)}
                        >
                          <div
                            className={styles.monthDayHeader}
                            onDoubleClick={event => {
                              event.preventDefault()
                              event.stopPropagation()
                              openDayView(day)
                            }}
                          >
                            <strong>{day.getDate()}</strong>
                            {isSameDay(day, actualToday) && <em>Today</em>}
                          </div>
                          {spanLaneHeight > 0 && <div className={styles.monthDaySpanSpacer} style={{ height: `${spanLaneHeight}px` }} aria-hidden="true" />}
                          <div className={styles.monthEvents}>
                            {dayEvents.map(event => (
                              <EventPill
                                key={`${dayKey(day)}-${event.id}`}
                                event={event}
                                day={day}
                                minimal
                                onNoteOpen={noteId => {
                                  if (suppressOpenRef.current === event.id) return
                                  onNoteOpen?.(noteId)
                                }}
                                paintCat={paintCat}
                                onPaint={paintNote}
                                draggable={!paintCat && !paintPersonaId}
                                onDragStart={dragEvent => startCalendarTimeSlotDrag(dragEvent, event)}
                                onDragEnd={() => endCalendarTimeSlotDrag(event)}
                                {...personaPaintProps}
                              />
                            ))}
                          </div>
                        </div>
                      )
                    })}
                    {spanningDayEvents.length > 0 && (
                      <div className={styles.monthDaySpanLayer} style={{ height: `${spanLaneHeight}px` }}>
                        {spanningDayEvents.map((event, lane) => (
                          <SpanningEvent
                            key={`${dayKey(calendarWeek[0])}-day-span-${event.id}`}
                            event={event}
                            start={calendarWeek[0]}
                            end={calendarWeekEnd}
                            lane={lane}
                            onNoteOpen={noteId => {
                              if (suppressOpenRef.current === event.id) return
                              onNoteOpen?.(noteId)
                            }}
                            paintCat={paintCat}
                            onPaint={paintNote}
                            draggable={!paintCat && !paintPersonaId}
                            onDragStart={dragEvent => startCalendarTimeSlotDrag(dragEvent, event)}
                            onDragEnd={() => endCalendarTimeSlotDrag(event)}
                            editable={!paintCat && !paintPersonaId}
                            onResizeStart={beginDayScaleResize}
                            {...personaPaintProps}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </main>

      <div className={styles.iconDimensionLeftDock}>
        <StandardIconPicker
          dimensions={colorDimensions}
          categories={colorCategories}
          iconDimensionId={iconDimId}
          onIconDimensionChange={setIconDimId}
          onDimensionDataChanged={refreshDimensionData}
          expanded={iconOpen}
          onExpandedChange={setIconOpen}
          enablePainting={false}
          align="dock-left"
        />
      </div>

      <div className={styles.floatingViewTools}>
        <StandardColorPicker
          dimensions={colorDimensions}
          categories={colorCategories}
          colorDimensionId={colorDimId}
          onColorDimensionChange={setColorDimId}
          expanded={legendOpen}
          onExpandedChange={open => { setLegendOpen(open); if (open) { setPeopleOpen(false); setPerspectiveOpen(false) } }}
          paintCategoryId={paintCat?.id}
          onPaintCategory={activatePaint}
          quickFilters={quickFilters}
          onToggleQuickFilter={toggleQuickFilter}
          activeSavedFilterIds={activeFilterIds}
          onToggleSavedFilter={toggleSavedFilter}
          onCreateSavedFilter={() => setEditingFilter({})}
          onEditSavedFilter={filterId => setEditingFilter(savedFilters.find(filter => filter.id === filterId))}
        />
        <PeopleWidget
          paintPersonaId={paintPersonaId}
          onPaintPersonaChange={id => { setPaintCat(null); setPaintPersonaId(id) }}
          expanded={peopleOpen}
          onExpandedChange={open => { setPeopleOpen(open); if (open) { setLegendOpen(false); setPerspectiveOpen(false) } }}
          refreshKey={peopleRefreshKey}
        />
      </div>
      {editingFilter && <SavedFilterEditorModal
        filter={editingFilter}
        dimensions={colorDimensions.filter(dimension => dimension.id !== FILTER_DIMENSION_ID)}
        categories={colorCategories.filter(category => category.dimensionId !== FILTER_DIMENSION_ID)}
        onSave={saveFilter}
        onDelete={deleteFilter}
        onClose={() => setEditingFilter(null)}
      />}

      {timeSlotContextMenu && createPortal(
        <>
          <div className={styles.calendarContextBackdrop} onMouseDown={() => setTimeSlotContextMenu(null)} />
          <div
            className={styles.calendarContextMenu}
            style={{
              left: Math.max(8, Math.min(timeSlotContextMenu.x, window.innerWidth - 238)),
              top: Math.max(8, Math.min(timeSlotContextMenu.y, window.innerHeight - 64)),
            }}>
            {timeSlotContextMenu.type === 'create' ? (
              <div className={styles.calendarCreateMenu}>
                <input
                  ref={createTitleInputRef}
                  value={timeSlotContextMenu.title || ''}
                  placeholder="Time slot title"
                  onChange={event => setTimeSlotContextMenu(current => (
                    current?.type === 'create'
                      ? { ...current, title: event.target.value }
                      : current
                  ))}
                  onMouseDown={event => event.stopPropagation()}
                  onClick={event => event.stopPropagation()}
                  onKeyDown={event => {
                    event.stopPropagation()
                    if (event.key === 'Enter') createTimeSlotFromContextMenu()
                    if (event.key === 'Escape') setTimeSlotContextMenu(null)
                  }}
                />
                <button type="button" onClick={createTimeSlotFromContextMenu}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z"/>
                  </svg>
                  Create
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => inspectTimeSlotInSchedule(timeSlotContextMenu.event)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M3 5h18v14H3V5zm2 2v10h14V7H5zm2 2h6v2H7V9zm0 4h10v2H7v-2z"/>
                </svg>
                Look in Schedule
              </button>
            )}
          </div>
        </>,
        document.body,
      )}

      {calendarWarning && (
        <div className={styles.calendarWarning} role="alertdialog" aria-modal="true">
          <button
            type="button"
            className={styles.calendarWarningClose}
            aria-label="Close warning"
            onClick={() => setCalendarWarning(null)}>
            ×
          </button>
          <strong>{calendarWarning.title}</strong>
          <p>{calendarWarning.message}</p>
          <div className={styles.calendarWarningActions}>
            <button type="button" onClick={() => setCalendarWarning(null)}>Close</button>
            {calendarWarning.timeSlotIds?.length > 0 && onRequestScheduleResolve && (
              <button type="button" className={styles.calendarWarningResolve} onClick={openScheduleResolver}>Resolve in Schedule</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
