import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import styles from './SchedulePage.module.css'
import { api, projectsApi } from '../api'

// ── Constants ─────────────────────────────────────────────────────────────────
const HEADER_H     = 52
const LANE_HDR_H   = 30
const MILESTONE_H  = 20   // block height in px
const COL_BUF      = 8
const ROW_BUF      = 3
const EXTEND_DELTA = 365  // extra columns added when scrolling to the right edge

const DEFAULT_SPACING = { colW: 110, rowH: 36, rowGap: 0, laneGap: 28 }
const INIT_TOTAL_COLS = 60    // initial column count; grows to cover viewport + buffer on mount
const EDGE_COLS       = 5     // columns from right edge before extending

const MONTH_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const FILTER_DIMENSION_ID = '__filters__'
const FILTER_CATEGORY_PREFIX = 'filter:'
const NONE_PERSPECTIVE_ID = '__none__'
const SCHEDULE_DEFAULT_PERSPECTIVE_KEY = 'schedule.defaultPerspectiveId'

const TIME_ZOOM_LEVELS = [
  { value: 'minutes', label: '15 min', short: '15m', unit: 15 },
  { value: 'hours', label: 'Hours', short: 'h', unit: 60 },
  { value: 'days', label: 'Days', short: 'd', unit: 60 * 24 },
  { value: 'weeks', label: 'Weeks', short: 'wk', unit: 60 * 24 * 7 },
  { value: 'months', label: 'Months', short: 'mo', unit: 60 * 24 * 30 },
]
const TIME_ZOOM_BY_VALUE = Object.fromEntries(TIME_ZOOM_LEVELS.map(level => [level.value, level]))
const DEFAULT_TIME_ZOOM = 'days'
const MIN_MILESTONE_DURATION = 15
const DEFAULT_WARNING_SETTINGS = {
  resizeWarnOrderThreshold: 2,
  resizeBlockOrderThreshold: 2,
  resizeScaleCrossingWarningEnabled: true,
}

function makeColorCursor(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="${color}" stroke="white" stroke-width="2"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`
}

function filterMatchesNote(filter, noteId, assignments) {
  if (!filter) return false
  const entries = Object.entries(filter.selections ?? {}).filter(([, catIds]) => catIds.length > 0)
  if (entries.length === 0) return false
  const matchesDim = ([dimId, catIds]) => catIds.includes(assignments[noteId]?.[dimId])
  return filter.gate === 'OR' ? entries.some(matchesDim) : entries.every(matchesDim)
}

function filterCategoryId(filterId) {
  return `${FILTER_CATEGORY_PREFIX}${filterId}`
}

// ── Axis / label helpers ───────────────────────────────────────────────────────

// minute 0 = today at 00:00.
function minuteToDate(minute) {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  d.setMinutes(d.getMinutes() + minute)
  return d
}

function isoWeekInfo(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
  return { week, year: d.getUTCFullYear() }
}

function getZoomUnit(timeZoom) {
  return TIME_ZOOM_BY_VALUE[timeZoom]?.unit ?? TIME_ZOOM_BY_VALUE[DEFAULT_TIME_ZOOM].unit
}

function zoomColToMinute(col, timeZoom) {
  return col * getZoomUnit(timeZoom)
}

function minuteToZoomCol(minute, timeZoom) {
  return Math.floor(Math.max(0, Number(minute) || 0) / getZoomUnit(timeZoom))
}

function minuteEndToZoomCol(minute, timeZoom) {
  return Math.ceil(Math.max(0, Number(minute) || 0) / getZoomUnit(timeZoom))
}

function getVisualRange(item, timeZoom) {
  const start = Math.max(0, Number(item.startCol) || 0)
  const end = start + Math.max(MIN_MILESTONE_DURATION, Number(item.duration) || MIN_MILESTONE_DURATION)
  const startCol = minuteToZoomCol(start, timeZoom)
  const endCol = Math.max(startCol + 1, minuteEndToZoomCol(end, timeZoom))
  return { startCol, endCol, duration: endCol - startCol }
}

function minuteToLabel(minute, timeZoom) {
  const date = minuteToDate(minute)
  switch (timeZoom) {
    case 'minutes':
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    case 'hours':
      return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' })
    case 'weeks': {
      const { week, year } = isoWeekInfo(date)
      return `KW ${week} ${year}`
    }
    case 'months':
      return `${MONTH_ABR[date.getMonth()]} ${date.getFullYear()}`
    default:
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
}

function zoomColToLabel(col, timeZoom) {
  return minuteToLabel(zoomColToMinute(col, timeZoom), timeZoom)
}

function durationOrderMagnitudeChange(originalDuration, nextDuration) {
  const original = Math.max(MIN_MILESTONE_DURATION, Number(originalDuration) || MIN_MILESTONE_DURATION)
  const next = Math.max(MIN_MILESTONE_DURATION, Number(nextDuration) || MIN_MILESTONE_DURATION)
  const ratio = Math.max(original, next) / Math.min(original, next)
  return Math.log10(ratio)
}

function durationScaleBucket(duration) {
  const value = Math.max(MIN_MILESTONE_DURATION, Number(duration) || MIN_MILESTONE_DURATION)
  if (value < 60) return 'minute'
  if (value < 1440) return 'hour'
  if (value < 10080) return 'day'
  if (value < 43200) return 'week'
  return 'month'
}

function durationScaleBucketIndex(bucket) {
  return ['minute', 'hour', 'day', 'week', 'month'].indexOf(bucket)
}

function formatMinutesDuration(minutes) {
  const value = Math.max(MIN_MILESTONE_DURATION, Number(minutes) || MIN_MILESTONE_DURATION)
  if (value < 60) return `${value} min`
  if (value < 60 * 24) return `${(value / 60).toFixed(value % 60 === 0 ? 0 : 1)} h`
  return `${(value / (60 * 24)).toFixed(value % (60 * 24) === 0 ? 0 : 1)} d`
}

// Build axis band segments by grouping consecutive cols sharing the same key (date-based, for 'days')
function buildAxisSegments(cols, getDate, getKey, getLabel) {
  const segments = []
  cols.forEach(col => {
    const date = getDate(col)
    const key = getKey(date)
    const last = segments[segments.length - 1]
    if (last?.key === key) {
      last.endCol = col + 1
    } else {
      segments.push({ key, label: getLabel(date), startCol: col, endCol: col + 1 })
    }
  })
  return segments
}

// Build axis band segments by grouping consecutive visible zoom columns.
function buildColSegments(cols, getGroup, getLabel) {
  const segments = []
  cols.forEach(col => {
    const key = String(getGroup(col))
    const last = segments[segments.length - 1]
    if (last?.key === key) {
      last.endCol = col + 1
    } else {
      segments.push({ key, label: getLabel(col), startCol: col, endCol: col + 1 })
    }
  })
  return segments
}

function snapPxToCol(px, colW) {
  const raw = px / colW
  const lower = Math.floor(raw)
  const fraction = raw - lower
  return fraction < 0.5 ? lower : lower + 1
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

function getDependencyViolations(msList, deps) {
  const msMap = Object.fromEntries(msList.map(m => [m.id, m]))
  return deps
    .map(dep => {
      const from = msMap[dep.fromId]
      const to = msMap[dep.toId]
      if (!from || !to || from.startCol + from.duration <= to.startCol) return null
      return { dep, from, to }
    })
    .filter(Boolean)
}

function hasAlternateDependencyPath(fromId, toId, deps, ignoredDepId) {
  const queue = [fromId]
  const visited = new Set()
  while (queue.length) {
    const curr = queue.shift()
    if (curr === toId) return true
    if (visited.has(curr)) continue
    visited.add(curr)
    deps.forEach(dep => {
      if (dep.id === ignoredDepId || dep.fromId !== curr) return
      queue.push(dep.toId)
    })
  }
  return false
}

function getCrucialDependencyIds(deps) {
  return new Set(
    deps
      .filter(dep => !hasAlternateDependencyPath(dep.fromId, dep.toId, deps, dep.id))
      .map(dep => dep.id)
  )
}

function dependencyLabelPreview(reason) {
  const words = String(reason || '').trim().split(/\s+/).filter(Boolean)
  const preview = words.slice(0, 4).join(' ')
  if (words.length > 4) return `${preview}...`
  return preview.length > 28 ? `${preview.slice(0, 25)}...` : preview
}

function getOverlapViolation(msList, movedIds = new Set()) {
  const byNote = new Map()
  msList.forEach(m => {
    if (!byNote.has(m.noteId)) byNote.set(m.noteId, [])
    byNote.get(m.noteId).push(m)
  })
  for (const laneMilestones of byNote.values()) {
    for (let i = 0; i < laneMilestones.length; i += 1) {
      for (let j = i + 1; j < laneMilestones.length; j += 1) {
        const a = laneMilestones[i]
        const b = laneMilestones[j]
        const overlaps = a.startCol < b.startCol + b.duration && b.startCol < a.startCol + a.duration
        if (overlaps && (movedIds.has(a.id) || movedIds.has(b.id))) return [a.id, b.id]
      }
    }
  }
  return null
}

function getMilestoneOrderViolation(beforeList, afterList, movedIds = new Set()) {
  const beforeById = Object.fromEntries(beforeList.map(m => [m.id, m]))
  const afterById = Object.fromEntries(afterList.map(m => [m.id, m]))
  const ids = Object.keys(beforeById).filter(id => afterById[id])
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const aBefore = beforeById[ids[i]]
      const bBefore = beforeById[ids[j]]
      const aAfter = afterById[ids[i]]
      const bAfter = afterById[ids[j]]
      if (aBefore.noteId !== bBefore.noteId || aAfter.noteId !== bAfter.noteId) continue
      if (!movedIds.has(aBefore.id) && !movedIds.has(bBefore.id)) continue
      const beforeRelation = aBefore.startCol + aBefore.duration <= bBefore.startCol
        ? 'a-before-b'
        : bBefore.startCol + bBefore.duration <= aBefore.startCol
          ? 'b-before-a'
          : null
      const afterRelation = aAfter.startCol + aAfter.duration <= bAfter.startCol
        ? 'a-before-b'
        : bAfter.startCol + bAfter.duration <= aAfter.startCol
          ? 'b-before-a'
          : null
      if (beforeRelation && afterRelation && beforeRelation !== afterRelation) return [aBefore.id, bBefore.id]
    }
  }
  return null
}

function newClientId(prefix) {
  const random = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${random}`
}

function normalizeTransactionState(state = {}) {
  return {
    milestones: state.milestones ?? [],
    dependencies: state.dependencies ?? [],
  }
}

// ── Row model ─────────────────────────────────────────────────────────────────
const UNASSIGNED_LANE = '__unassigned__'

function laneKeyForCat(cat) {
  return cat?.id ?? UNASSIGNED_LANE
}

function buildRowItems(notes, categories, assignments, assignmentOrders, activeDimId, spacing, hiddenCatIds = new Set(), hiddenNotesByLane = {}, filterAsLane = null) {
  const { rowH, rowGap, laneGap } = spacing
  const slotH = rowH + rowGap

  // Filter-as-lane: two lanes — notes matching the filter, and the rest
  if (filterAsLane) {
    const matchCat   = { id: filterAsLane.id, name: filterAsLane.name, color: filterAsLane.color }
    const matchNotes = notes.filter(g => filterMatchesNote(filterAsLane, g.id, assignments))
    const otherNotes = notes.filter(g => !filterMatchesNote(filterAsLane, g.id, assignments))
    const items = []; let top = 0
    const addFilterLane = (cat, laneNotes, key, first) => {
      const hiddenNoteIds = hiddenNotesByLane[key] ?? new Set()
      const visible = laneNotes.filter(g => !hiddenNoteIds.has(g.id))
      if (!first) { items.push({ type: 'lane-gap', cat: null, top, height: laneGap }); top += laneGap }
      items.push({ type: 'lane-header', cat, top, height: LANE_HDR_H }); top += LANE_HDR_H
      if (laneNotes.length === 0) {
        items.push({ type: 'empty', cat, top, height: slotH }); top += slotH
      } else {
        visible.forEach(g => { items.push({ type: 'note', note: g, cat, top, height: slotH }); top += slotH })
      }
    }
    const matchHidden = hiddenCatIds.has(filterAsLane.id)
    const otherHidden = hiddenCatIds.has(UNASSIGNED_LANE)
    if (!matchHidden) addFilterLane(matchCat, matchNotes, filterAsLane.id, true)
    if (!otherHidden) addFilterLane(null, otherNotes, UNASSIGNED_LANE, matchHidden)
    return items
  }

  if (!activeDimId) {
    return notes.map((g, i) => ({ type: 'note', note: g, cat: null, top: i * slotH, height: slotH }))
  }

  const allCats = categories.filter(c => c.dimensionId === activeDimId)
  const cats    = allCats.filter(c => !hiddenCatIds.has(c.id))
  const allCatIds = new Set(allCats.map(c => c.id))
  const catMap  = Object.fromEntries(cats.map(c => [c.id, []]))
  const unassigned = []
  notes.forEach(g => {
    const cid = assignments[g.id]?.[activeDimId]
    if (cid && catMap[cid]) catMap[cid].push(g)
    else if (cid && allCatIds.has(cid)) return
    else unassigned.push(g)
  })

  const sortLaneNotes = laneNotes => [...laneNotes].sort((a, b) => {
    const ao = assignmentOrders[a.id]?.[activeDimId] ?? Number.MAX_SAFE_INTEGER
    const bo = assignmentOrders[b.id]?.[activeDimId] ?? Number.MAX_SAFE_INTEGER
    return ao - bo
  })

  const items = []; let top = 0
  const addLane = (cat, laneNotes, first) => {
    const hiddenNoteIds = hiddenNotesByLane[laneKeyForCat(cat)] ?? new Set()
    const visibleLaneNotes = sortLaneNotes(laneNotes).filter(g => !hiddenNoteIds.has(g.id))
    if (!first) { items.push({ type: 'lane-gap', cat: null, top, height: laneGap }); top += laneGap }
    items.push({ type: 'lane-header', cat, top, height: LANE_HDR_H }); top += LANE_HDR_H
    if (laneNotes.length === 0) {
      items.push({ type: 'empty', cat, top, height: slotH }); top += slotH
    } else {
      visibleLaneNotes.forEach(g => { items.push({ type: 'note', note: g, cat, top, height: slotH }); top += slotH })
    }
  }
  cats.forEach((cat, i) => addLane(cat, catMap[cat.id] ?? [], i === 0))
  if (!hiddenCatIds.has(UNASSIGNED_LANE) && (unassigned.length > 0 || cats.length === 0))
    addLane(null, unassigned, cats.length === 0)
  return items
}

// ── Visual settings panel ─────────────────────────────────────────────────────
function SpacingPanel({
  spacing, onChange, onClose, anchorRef, axisMode, onAxisModeChange,
  timeZoom, onTimeZoomChange,
  showDepLabels, onShowDepLabelsChange,
  showDeps, onShowDepsChange,
  hideCrossCatDeps, onHideCrossCatDepsChange,
  showCrucialDepsOnly, onShowCrucialDepsOnlyChange,
  colorDependencyDirection, onColorDependencyDirectionChange,
  canFilterToSelection, onFilterToSelectedNotes, onExpandEverything,
}) {
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
    ['colW',    'Column width', 20, 250, 'px'],
    ['rowH',    'Row height',   20,  80, 'px'],
    ['laneGap', 'Lane gap',      8,  80, 'px'],
  ]
  return (
    <div ref={panelRef} className={styles.spacingPanel}>
      <div className={styles.spacingPanelHdr}>
        <span>Visual settings</span>
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
      <div className={styles.axisModeRow}>
        <span className={styles.spacingLabel}>Zoom</span>
        <div className={styles.axisModePills}>
          {TIME_ZOOM_LEVELS.map(level => (
            <button key={level.value}
              className={`${styles.axisModePill} ${timeZoom === level.value ? styles.axisModePillActive : ''}`}
              onClick={() => onTimeZoomChange(level.value)}>
              {level.label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.axisModeRow}>
        <span className={styles.spacingLabel}>Display</span>
        <div className={styles.axisModePills}>
          {[['full', 'Time'], ['numbers', 'Numbers'], ['none', 'None']].map(([val, label]) => (
            <button key={val}
              className={`${styles.axisModePill} ${axisMode === val ? styles.axisModePillActive : ''}`}
              onClick={() => onAxisModeChange(val)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.axisModeRow}>
        <span className={styles.spacingLabel}>Deps</span>
        <div className={styles.depToggles}>
          <label className={styles.depToggle} title="Show dependencies">
            <input type="checkbox" checked={showDeps} onChange={e => onShowDepsChange(e.target.checked)} />
            <span>Show</span>
          </label>
          <label className={styles.depToggle} title="Same-category only" style={{ opacity: showDeps ? 1 : 0.4 }}>
            <input type="checkbox" checked={hideCrossCatDeps} disabled={!showDeps} onChange={e => onHideCrossCatDepsChange(e.target.checked)} />
            <span>Same cat</span>
          </label>
          <label className={styles.depToggle} title="Hide dependencies already implied by another dependency path" style={{ opacity: showDeps ? 1 : 0.4 }}>
            <input type="checkbox" checked={showCrucialDepsOnly} disabled={!showDeps} onChange={e => onShowCrucialDepsOnlyChange(e.target.checked)} />
            <span>Crucial only</span>
          </label>
          <label className={styles.depToggle} title="Color selected milestone incoming dependencies red and outgoing dependencies green" style={{ opacity: showDeps ? 1 : 0.4 }}>
            <input type="checkbox" checked={colorDependencyDirection} disabled={!showDeps} onChange={e => onColorDependencyDirectionChange(e.target.checked)} />
            <span>Direction colors</span>
          </label>
          <label className={styles.depToggle} title="Show dependency labels">
            <input type="checkbox" checked={showDepLabels} onChange={e => onShowDepLabelsChange(e.target.checked)} />
            <span>Labels</span>
          </label>
        </div>
      </div>
      <div className={styles.axisModeRow}>
        <span className={styles.spacingLabel}>View</span>
        <div className={styles.panelActions}>
          <button
            className={styles.panelActionBtn}
            disabled={!canFilterToSelection}
            onClick={onFilterToSelectedNotes}
            title="Show only notes that have selected milestones">
            Only selected notes
          </button>
          <button
            className={styles.panelActionBtn}
            onClick={onExpandEverything}
            title="Show all lane categories and notes">
            Expand everything
          </button>
        </div>
      </div>
    </div>
  )
}

function WarningSettingsPanel({
  settings,
  onSettingsChange,
  autoResolveDependencyView,
  onAutoResolveDependencyViewChange,
  onClose,
  anchorRef,
}) {
  const [draft, setDraft] = useState(settings)
  const [pendingSettingChange, setPendingSettingChange] = useState(null)
  const panelRef = useRef()
  const pendingSettingRef = useRef(null)
  const closeRef = useRef(onClose)
  useEffect(() => { setDraft(settings) }, [settings])
  useEffect(() => { closeRef.current = onClose })
  useEffect(() => { pendingSettingRef.current = pendingSettingChange }, [pendingSettingChange])
  useEffect(() => {
    const handler = e => {
      if (pendingSettingRef.current) return
      if (panelRef.current?.contains(e.target)) return
      if (anchorRef?.current?.contains(e.target)) return
      closeRef.current?.()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [anchorRef])

  const setDraftNumber = (key, raw) => {
    const value = Math.max(0, Number(raw) || 0)
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  const requestNumberChange = key => {
    const value = Math.max(0, Number(draft[key]) || 0)
    const current = Math.max(0, Number(settings[key]) || 0)
    if (value === current) return
    setPendingSettingChange({
      key,
      value,
      previousValue: current,
      nextSettings: { ...settings, [key]: value },
      label: key === 'resizeWarnOrderThreshold' ? 'warning threshold' : 'extra confirmation threshold',
    })
  }

  const cancelPendingSettingChange = () => {
    setDraft(settings)
    setPendingSettingChange(null)
  }

  return (
    <>
      <div ref={panelRef} className={`${styles.spacingPanel} ${styles.warningSettingsPanel}`}>
        <div className={styles.spacingPanelHdr}>
          <span>Warning settings</span>
          <button className={styles.spacingClose} onClick={onClose}>×</button>
        </div>
        <label className={styles.warningSettingsToggle}>
          <input
            type="checkbox"
            checked={autoResolveDependencyView}
            onChange={e => onAutoResolveDependencyViewChange(e.target.checked)}
          />
          <span>Auto-enter dependency resolve view</span>
        </label>
        <div className={styles.warningSettingsText}>
          Resize protection compares the new duration with the original duration using log10 of the ratio.
        </div>
        <label className={styles.warningSettingsToggle}>
          <input
            type="checkbox"
            checked={settings.resizeScaleCrossingWarningEnabled}
            onChange={e => onSettingsChange({ ...settings, resizeScaleCrossingWarningEnabled: e.target.checked })}
          />
          <span>Warn when resize crosses minute/hour/day/week/month scale</span>
        </label>
        <label className={styles.warningSettingsRow}>
          <span>Warn at</span>
          <input
            type="number"
            min="0"
            step="0.1"
            value={draft.resizeWarnOrderThreshold}
            onChange={e => setDraftNumber('resizeWarnOrderThreshold', e.target.value)}
            onBlur={() => requestNumberChange('resizeWarnOrderThreshold')}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setDraft(settings)
            }}
          />
          <small>orders</small>
        </label>
        <label className={styles.warningSettingsRow}>
          <span>Extra confirm at</span>
          <input
            type="number"
            min="0"
            step="0.1"
            value={draft.resizeBlockOrderThreshold}
            onChange={e => setDraftNumber('resizeBlockOrderThreshold', e.target.value)}
            onBlur={() => requestNumberChange('resizeBlockOrderThreshold')}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setDraft(settings)
            }}
          />
          <small>orders</small>
        </label>
      </div>
      {pendingSettingChange && createPortal(
        <div className={styles.deleteModalBackdrop} onMouseDown={cancelPendingSettingChange}>
          <div className={styles.deleteModal} role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
            <div className={styles.deleteModalTitle}>Change warning threshold?</div>
            <div className={styles.deleteModalText}>
              This resize warning metric is important for keeping the schedule dimensions stable. Changing the {pendingSettingChange.label} from {pendingSettingChange.previousValue} to {pendingSettingChange.value} can make accidental large duration changes easier to miss.
            </div>
            <div className={styles.deleteModalActions}>
              <button className={styles.modalSafePrimaryBtn} autoFocus onClick={cancelPendingSettingChange}>
                Cancel
              </button>
              <button className={styles.modalDangerMutedBtn} onClick={() => {
                onSettingsChange(pendingSettingChange.nextSettings)
                setPendingSettingChange(null)
              }}>
                Accept setting change
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

// ── Context menu ──────────────────────────────────────────────────────────────
function ContextMenu({ menu, onClose, onCreate, onInsertTimeUnit, onDeleteTimeUnit, onSetDeadline, onRemoveDeadline, onDeleteMilestone, onEditDepReason, onDeleteDep }) {
  if (!menu) return null
  return createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onMouseDown={onClose} />
      <div className={styles.ctxMenu} style={{ left: menu.x, top: menu.y }}>
        {menu.type === 'cell' && (<>
          <button className={styles.ctxItem}
            onClick={() => { onCreate(menu.noteId, menu.col, menu.color); onClose() }}>
            Add milestone — {menu.noteTitle}
          </button>
          {menu.hasDeadline
            ? <button className={styles.ctxItem}
                onClick={() => { onRemoveDeadline(menu.noteId); onClose() }}>
                Remove hard deadline
              </button>
            : <button className={styles.ctxItem}
                onClick={() => { onSetDeadline(menu.noteId, menu.col); onClose() }}>
                Set hard deadline here
              </button>
          }
        </>)}
        {menu.type === 'header' && (<>
          <button className={styles.ctxItem} onClick={() => { onInsertTimeUnit(menu.col); onClose() }}>
            Insert {menu.unitLabel || 'unit'} before
          </button>
          <button className={styles.ctxItem} onClick={() => { onDeleteTimeUnit(menu.col); onClose() }}>
            Remove this {menu.unitLabel || 'unit'}
          </button>
        </>)}
        {menu.type === 'milestone' && (
          <button className={`${styles.ctxItem} ${styles.ctxItemDanger}`}
            onClick={() => { onDeleteMilestone(menu.milestoneId, menu.label); onClose() }}>
            Delete milestone
          </button>
        )}
        {menu.type === 'dep' && (<>
          <button className={styles.ctxItem}
            onClick={() => { onEditDepReason(menu.depId, menu.reason); onClose() }}>
            {menu.reason ? 'Edit reason…' : 'Add reason…'}
          </button>
          <button className={`${styles.ctxItem} ${styles.ctxItemDanger}`}
            onClick={() => { onDeleteDep(menu.depId, menu.label); onClose() }}>
            Delete dependency
          </button>
        </>)}
      </div>
    </>,
    document.body
  )
}

function CategoryVisibilityDropdown({ categories, hiddenCatIds, onToggle, onShowAll, disabled }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef()

  useEffect(() => {
    if (!open) return
    const close = e => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const shownCount = categories.filter(c => !hiddenCatIds.has(c.id)).length
  const label = disabled ? 'Categories' : `${shownCount}/${categories.length} visible`

  return (
    <div ref={wrapRef} className={styles.categoryFilterWrap}>
      <button
        className={`${styles.categoryFilterBtn} ${open ? styles.categoryFilterBtnOpen : ''}`}
        disabled={disabled}
        onClick={() => setOpen(v => !v)}>
        {label}
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
                <button className={styles.categoryFilterAll} onClick={onShowAll}>
                  Show all
                </button>
                <button className={styles.categoryFilterAll} onClick={() =>
                  categories.forEach(cat => { if (!hiddenCatIds.has(cat.id)) onToggle(cat.id) })
                }>
                  Hide all
                </button>
              </div>
              {categories.map((cat, i) => {
                const isUnassigned = cat.id === UNASSIGNED_LANE
                return (
                  <label key={cat.id}
                    className={styles.categoryFilterItem}
                    style={isUnassigned ? { borderTop: i > 0 ? '1px solid #f0f0f0' : undefined, marginTop: i > 0 ? 2 : 0 } : undefined}>
                    <input
                      type="checkbox"
                      checked={!hiddenCatIds.has(cat.id)}
                      onChange={() => onToggle(cat.id)}
                    />
                    <span className={styles.categoryFilterDot} style={{ background: cat.color }} />
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

function LaneNoteFilter({ laneKey, notes, hiddenNoteIds, onToggleNote, onShowAllNotes, onHideAllNotes }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef()
  const menuRef = useRef()
  const [pos, setPos] = useState(null)

  const openMenu = e => {
    e.stopPropagation()
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 6, left: rect.left, width: Math.max(220, rect.width) })
    setOpen(v => !v)
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

  const hiddenCount = notes.filter(g => hiddenNoteIds.has(g.id)).length

  return (
    <>
      <button
        ref={btnRef}
        className={`${styles.laneFilterBtn} ${hiddenCount > 0 ? styles.laneFilterBtnActive : ''}`}
        disabled={notes.length === 0}
        title="Filter notes in this lane"
        onClick={openMenu}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"/>
        </svg>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className={styles.laneFilterMenu}
          style={{ top: pos.top, left: pos.left, minWidth: pos.width }}>
          {notes.length === 0 ? (
            <div className={styles.laneFilterEmpty}>No notes</div>
          ) : (
            <>
              <div className={styles.laneFilterActions}>
                <button className={styles.laneFilterAll} onClick={() => onShowAllNotes(laneKey)}>Show all</button>
                <button className={styles.laneFilterAll} onClick={() => onHideAllNotes(laneKey, notes.map(g => g.id))}>Show none</button>
              </div>
              {notes.map(note => (
                <label key={note.id} className={styles.laneFilterItem}>
                  <input
                    type="checkbox"
                    checked={!hiddenNoteIds.has(note.id)}
                    onChange={() => onToggleNote(laneKey, note.id)}
                  />
                  <span className={styles.laneFilterName}>{note.title}</span>
                </label>
              ))}
            </>
          )}
        </div>,
        document.body
      )}
    </>
  )
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
function GanttToolbar({
  dimensions, activeDimId, activeCategories, hiddenCatIds,
  onToggleCategory, onShowAllCategories,
  savedFilters, activeLaneFilterId, onLaneGroupChange,
  spacing, onSpacingChange, mode, onModeChange,
  axisMode, onAxisModeChange,
  timeZoom, onTimeZoomChange,
  showDepLabels, onShowDepLabelsChange,
  showDeps, onShowDepsChange, hideCrossCatDeps, onHideCrossCatDepsChange,
  showCrucialDepsOnly, onShowCrucialDepsOnlyChange,
  colorDependencyDirection, onColorDependencyDirectionChange,
  autoResolveDependencyView, onAutoResolveDependencyViewChange,
  warningSettings, onWarningSettingsChange,
  canDeleteSelection, onDeleteSelection,
  canFilterToSelection, onFilterToSelectedNotes, onExpandEverything,
  canUndo, canRedo, onUndo, onRedo,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [warningSettingsOpen, setWarningSettingsOpen] = useState(false)
  const settingsBtnRef = useRef()
  const warningSettingsBtnRef = useRef()
  const closeSettings  = useCallback(() => setSettingsOpen(false), [])
  const closeWarningSettings = useCallback(() => setWarningSettingsOpen(false), [])

  return (
    <div className={styles.toolbar}>
      <button
        className={styles.toolbarDeleteBtn}
        disabled={!canDeleteSelection}
        onClick={onDeleteSelection}>
        Delete
      </button>
      <div className={styles.historyButtons}>
        <button className={styles.historyBtn} disabled={!canUndo} onClick={onUndo} title="Undo last Gantt transaction">
          Undo
        </button>
        <button className={styles.historyBtn} disabled={!canRedo} onClick={onRedo} title="Redo last undone Gantt transaction">
          Redo
        </button>
      </div>
      <div className={styles.modePills}>
        <button className={`${styles.modePill} ${mode === 'milestone' ? styles.modePillActive : ''}`}
          onClick={() => onModeChange('milestone')}>Milestone</button>
        <button className={`${styles.modePill} ${mode === 'dependency' ? styles.modePillActive : ''}`}
          onClick={() => onModeChange('dependency')}>Dependency</button>
      </div>
      <div className={styles.toolbarDiv} />
      <span className={styles.toolbarLabel}>Group by</span>
      <select
        className={styles.dimSelect}
        value={activeDimId ? `d:${activeDimId}` : activeLaneFilterId ? `f:${activeLaneFilterId}` : ''}
        onChange={e => onLaneGroupChange(e.target.value)}>
        <option value="">None</option>
        {dimensions.length > 0 && (
          <optgroup label="Dimensions">
            {dimensions.map(d => <option key={d.id} value={`d:${d.id}`}>{d.name}</option>)}
          </optgroup>
        )}
        {savedFilters.length > 0 && (
          <optgroup label="Filters">
            {savedFilters.map(f => <option key={f.id} value={`f:${f.id}`}>{f.name}</option>)}
          </optgroup>
        )}
      </select>
      {activeDimId && (
        <CategoryVisibilityDropdown
          categories={[...activeCategories, { id: UNASSIGNED_LANE, name: 'Unassigned', color: '#bbb' }]}
          hiddenCatIds={hiddenCatIds}
          onToggle={onToggleCategory}
          onShowAll={onShowAllCategories}
          disabled={false}
        />
      )}
      {activeLaneFilterId && (
        <CategoryVisibilityDropdown
          categories={[{ id: UNASSIGNED_LANE, name: 'Unassigned', color: '#bbb' }]}
          hiddenCatIds={hiddenCatIds}
          onToggle={onToggleCategory}
          onShowAll={onShowAllCategories}
          disabled={false}
        />
      )}
      <div style={{ flex: 1 }} />
      <div className={styles.spacingWrap}>
        <button ref={warningSettingsBtnRef}
          className={`${styles.toolbarToggleBtn} ${warningSettingsOpen || autoResolveDependencyView ? styles.toolbarToggleBtnActive : ''}`}
          onClick={() => setWarningSettingsOpen(v => !v)}
          title="Configure resize and dependency warning behavior">
          Warning settings
        </button>
        {warningSettingsOpen && (
          <WarningSettingsPanel
            settings={warningSettings}
            onSettingsChange={onWarningSettingsChange}
            autoResolveDependencyView={autoResolveDependencyView}
            onAutoResolveDependencyViewChange={onAutoResolveDependencyViewChange}
            onClose={closeWarningSettings}
            anchorRef={warningSettingsBtnRef}
          />
        )}
      </div>
      <div className={styles.spacingWrap}>
        <button ref={settingsBtnRef}
          className={`${styles.spacingBtn} ${settingsOpen ? styles.spacingBtnOpen : ''}`}
          onClick={() => setSettingsOpen(v => !v)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 6h18v2H3V6zm3 5h12v2H6v-2zm3 5h6v2H9v-2z"/>
          </svg>
          Visual settings
        </button>
        {settingsOpen && (
          <SpacingPanel spacing={spacing} onChange={onSpacingChange}
            onClose={closeSettings} anchorRef={settingsBtnRef}
            axisMode={axisMode} onAxisModeChange={onAxisModeChange}
            timeZoom={timeZoom} onTimeZoomChange={onTimeZoomChange}
            showDepLabels={showDepLabels} onShowDepLabelsChange={onShowDepLabelsChange}
            showDeps={showDeps} onShowDepsChange={onShowDepsChange}
            hideCrossCatDeps={hideCrossCatDeps} onHideCrossCatDepsChange={onHideCrossCatDepsChange}
            showCrucialDepsOnly={showCrucialDepsOnly} onShowCrucialDepsOnlyChange={onShowCrucialDepsOnlyChange}
            colorDependencyDirection={colorDependencyDirection} onColorDependencyDirectionChange={onColorDependencyDirectionChange}
            canFilterToSelection={canFilterToSelection}
            onFilterToSelectedNotes={onFilterToSelectedNotes}
            onExpandEverything={onExpandEverything} />
        )}
      </div>
    </div>
  )
}

function ScheduleLegendDropUp({ dimensions, colorDimId, onColorDimChange }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef()
  const menuRef = useRef()
  const [pos, setPos] = useState(null)
  const wheelAtRef = useRef(0)

  const toggle = () => {
    if (!open) {
      const r = btnRef.current?.getBoundingClientRect()
      setPos({ bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width })
    }
    setOpen(v => !v)
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

  const current = dimensions.find(d => d.id === colorDimId)
  const cycleDimension = deltaY => {
    const options = ['', ...dimensions.map(d => d.id)]
    if (options.length === 0) return
    const now = Date.now()
    if (now - wheelAtRef.current < 180) return
    wheelAtRef.current = now
    const activeIdx = Math.max(0, options.indexOf(colorDimId))
    const dir = deltaY > 0 ? 1 : -1
    onColorDimChange(options[(activeIdx + dir + options.length) % options.length])
  }

  return (
    <div className={styles.legendDropUpWrap}>
      <button
        ref={btnRef}
        className={styles.legendDropUpBtn}
        onWheel={e => { e.preventDefault(); cycleDimension(e.deltaY) }}
        onClick={toggle}>
        <span className={styles.legendDropUpLabel}>{current?.name ?? 'Color legend'}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className={styles.legendDropUpMenu}
          style={{ position: 'fixed', bottom: pos.bottom, left: pos.left, minWidth: pos.width }}>
          <button className={`${styles.legendDropUpOption} ${!colorDimId ? styles.legendDropUpActive : ''}`}
            onClick={() => { onColorDimChange(''); setOpen(false) }}>None</button>
          {dimensions.map(d => (
            <button key={d.id}
              className={`${styles.legendDropUpOption} ${d.id === colorDimId ? styles.legendDropUpActive : ''}`}
              onClick={() => { onColorDimChange(d.id); setOpen(false) }}>
              {d.name}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

function normalizeSavedFilter(filter) {
  const selections = {}
  Object.entries(filter?.selections ?? {}).forEach(([dimId, catIds]) => {
    const ids = Array.isArray(catIds) ? [...new Set(catIds)].filter(Boolean) : []
    if (ids.length) selections[dimId] = ids
  })
  return {
    ...filter,
    name: (filter?.name || 'Untitled filter').trim(),
    gate: filter?.gate === 'OR' ? 'OR' : 'AND',
    color: filter?.color || '#64748b',
    selections,
  }
}

function ScheduleFilterEditorModal({ filter, dimensions, categories, onSave, onDelete, onClose }) {
  const [name, setName] = useState(filter?.name ?? 'New filter')
  const [gate, setGate] = useState(filter?.gate ?? 'AND')
  const [color, setColor] = useState(filter?.color ?? '#64748b')
  const [selections, setSelections] = useState(filter?.selections ?? {})
  const isEdit = Boolean(filter?.id)
  const presetColors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8']

  const toggleCat = (dimId, catId) => {
    setSelections(prev => {
      const current = new Set(prev[dimId] ?? [])
      if (current.has(catId)) current.delete(catId)
      else current.add(catId)
      const next = { ...prev }
      const ids = [...current]
      if (ids.length) next[dimId] = ids
      else delete next[dimId]
      return next
    })
  }

  const save = () => {
    onSave(normalizeSavedFilter({ ...filter, name, gate, color, selections }))
  }

  return createPortal(
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={`${styles.modal} ${styles.filterModal}`} onClick={e => e.stopPropagation()}>
        <div className={styles.filterModalHeader}>
          <input className={styles.filterNameInput} value={name} onChange={e => setName(e.target.value)} autoFocus />
          <div className={styles.filterGateToggle}>
            <button className={gate === 'AND' ? styles.filterGateActive : ''} onClick={() => setGate('AND')}>AND</button>
            <button className={gate === 'OR' ? styles.filterGateActive : ''} onClick={() => setGate('OR')}>OR</button>
          </div>
        </div>

        <div className={styles.colorSection}>
          <span className={styles.sectionLabel}>Color</span>
          <div className={styles.colorSwatches}>
            {presetColors.map(c => (
              <button key={c} type="button" className={styles.colorSwatch}
                style={{ background: c, boxShadow: color === c ? `0 0 0 2px #fff, 0 0 0 3.5px ${c}` : 'none' }}
                onClick={() => setColor(c)} />
            ))}
            <input type="color" className={styles.colorFullPicker} value={color} onChange={e => setColor(e.target.value)} />
          </div>
        </div>

        <div className={styles.filterDimList}>
          {dimensions.map(dim => {
            const dimCats = categories.filter(c => c.dimensionId === dim.id)
            return (
              <section key={dim.id} className={styles.filterDimSection}>
                <div className={styles.filterDimTitle}>{dim.name}</div>
                <div className={styles.filterCatGrid}>
                  {dimCats.length === 0 ? (
                    <span className={styles.filterEmpty}>No categories</span>
                  ) : dimCats.map(cat => (
                    <label key={cat.id} className={styles.filterCatOption}>
                      <input
                        type="checkbox"
                        checked={(selections[dim.id] ?? []).includes(cat.id)}
                        onChange={() => toggleCat(dim.id, cat.id)}
                      />
                      <span className={styles.legendDot} style={{ background: cat.color }} />
                      <span>{cat.name}</span>
                    </label>
                  ))}
                </div>
              </section>
            )
          })}
        </div>

        <div className={styles.modalActions}>
          {isEdit && <button className={styles.dangerBtn} onClick={() => onDelete(filter.id)}>Delete</button>}
          <div style={{ flex: 1 }} />
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button className={styles.submitBtn} onClick={save}>{isEdit ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>,
    document.body
  )
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
  const active = perspectives.find(p => p.id === activePerspectiveId)
  const canSaveActive = Boolean(active && !active.readOnly)

  useEffect(() => {
    if (!open) return
    const close = e => { if (!wrapRef.current?.contains(e.target)) onOpenChange(false) }
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
    const activeIdx = Math.max(0, perspectives.findIndex(p => p.id === activePerspectiveId))
    const dir = deltaY > 0 ? 1 : -1
    const nextIdx = (activeIdx + dir + perspectives.length) % perspectives.length
    onApply(perspectives[nextIdx])
  }

  const startRename = perspective => {
    if (applyTimerRef.current) {
      window.clearTimeout(applyTimerRef.current)
      applyTimerRef.current = null
    }
    setEditingId(perspective.id)
    setEditingName(perspective.name)
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
        onWheel={e => { e.preventDefault(); cycle(e.deltaY) }}
        onClick={() => onOpenChange(!open)}>
        <span>{active?.name ?? 'None'}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>
      {!open && (
        <span className={styles.floatingHint}>
          <strong>Perspective</strong>
          <small>Switch saved Gantt views</small>
        </span>
      )}
      {open && (
        <div className={styles.perspectiveMenu}>
          <div className={styles.perspectiveCreateRow}>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') create() }}
              placeholder="Perspective name"
            />
            <button onClick={create}>Save</button>
          </div>
          <div className={styles.perspectiveList}>
            {perspectives.length === 0 ? (
              <div className={styles.perspectiveEmpty}>No perspectives yet</div>
            ) : perspectives.map(p => (
              <div key={p.id} className={`${styles.perspectiveItem} ${p.id === activePerspectiveId ? styles.perspectiveItemActive : ''}`}>
                {editingId === p.id ? (
                  <input
                    className={styles.perspectiveRenameInput}
                    value={editingName}
                    autoFocus
                    onChange={e => setEditingName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') { setEditingId(''); setEditingName('') }
                    }}
                  />
                ) : (
                  <button
                    className={styles.perspectiveApplyBtn}
                    onClick={() => applyFromMenu(p)}
                    onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); if (!p.readOnly) startRename(p) }}>
                    <span>{p.name}</span>
                  </button>
                )}
                <button
                  className={`${styles.perspectiveIconBtn} ${defaultPerspectiveId === p.id ? styles.perspectiveIconBtnActive : ''}`}
                  title="Use as schedule default"
                  onClick={() => onSetDefault(p.id)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27z"/>
                  </svg>
                </button>
                <button className={styles.perspectiveIconBtn} title={p.readOnly ? 'None cannot be saved' : 'Update snapshot'} disabled={p.readOnly} onClick={() => !p.readOnly && onUpdate(p.id)}>
                  <SaveIcon />
                </button>
                <button className={styles.perspectiveIconBtn} title={p.readOnly ? 'None cannot be deleted' : 'Delete'} disabled={p.readOnly} onClick={() => !p.readOnly && onDelete(p.id)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 4l1-1h6l1 1h4v2H4V4h4z"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ScheduleColorLegendWidget({
  dimensions, categories, colorDimId, onColorDimChange,
  activeFilterIds, onToggleSavedFilter, quickFilters, onToggleQuickFilter, onEditFilter, paintCat, onPaintActivate,
  expanded, onExpandedChange,
}) {
  const legendCats = categories.filter(c => c.dimensionId === colorDimId)

  return (
    <div className={styles.legendWidget}>
      {expanded && (
        <div className={styles.legendPanel}>
          {legendCats.map(cat => (
            <div key={cat.id}
              className={[
                styles.legendItem,
                cat.dynamic && styles.dynamicLegendItem,
                (cat.dynamic ? activeFilterIds.includes(cat.filterId) : paintCat?.id === cat.id) && styles.legendItemActive,
              ].filter(Boolean).join(' ')}
              onClick={e => {
                e.stopPropagation()
                if (cat.dynamic) onToggleSavedFilter(cat.filterId)
                else onPaintActivate(cat.id, cat.color)
              }}>
              <span className={styles.legendDot} style={{ background: cat.color }} />
              <span className={styles.legendName}>{cat.name}</span>
              {cat.dynamic && <span className={styles.dynamicBadge}>Filter</span>}
              {cat.dynamic ? (
                <button
                  className={`${styles.legendPaintBtn} ${activeFilterIds.includes(cat.filterId) ? styles.legendPaintBtnActive : ''}`}
                  title="Edit filter"
                  onClick={e => { e.stopPropagation(); onEditFilter(cat.filterId) }}
                  onDoubleClick={e => e.stopPropagation()}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                  </svg>
                </button>
              ) : (
                <button
                  className={`${styles.legendPaintBtn} ${quickFilters.some(f => f.dimId === colorDimId && f.catId === cat.id) ? styles.legendPaintBtnActive : ''}`}
                  title="Quick filter notes by this category"
                  onClick={e => { e.stopPropagation(); onToggleQuickFilter(colorDimId, cat.id) }}
                  onDoubleClick={e => e.stopPropagation()}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"/>
                  </svg>
                </button>
              )}
            </div>
          ))}
          {colorDimId && legendCats.length === 0 && (
            <div className={styles.legendEmpty}>No categories</div>
          )}
          <ScheduleLegendDropUp
            dimensions={dimensions}
            colorDimId={colorDimId}
            onColorDimChange={onColorDimChange}
          />
        </div>
      )}

      <button
        className={`${styles.legendToggleBtn} ${expanded ? styles.legendToggleActive : ''}`}
        onClick={() => onExpandedChange(!expanded)}
        title={expanded ? 'Collapse legend' : 'Color legend'}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
        </svg>
      </button>
      {!expanded && (
        <span className={styles.floatingHint}>
          <strong>Color dimension</strong>
          <small>Color and quick-filter notes</small>
        </span>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function SchedulePage({ notes = [], project = null, isActive = false, onNoteOpen, onProjectUpdate, refreshKey = 0 }) {
  // ── API data ───────────────────────────────────────────────────────────────
  const [dimensions,   setDimensions]   = useState([])
  const [categories,   setCategories]   = useState([])
  const [assignments,  setAssignments]  = useState({})
  const [assignmentOrders, setAssignmentOrders] = useState({})
  const [milestones,   setMilestones]   = useState([])
  const [dependencies, setDependencies] = useState([])
  const [deadlines,    setDeadlines]    = useState([])
  const [transactionHistory, setTransactionHistory] = useState({ undo: [], redo: [] })
  const [savedFilters, setSavedFilters] = useState([])
  const [perspectives, setPerspectives] = useState([])
  const [activePerspectiveId, setActivePerspectiveId] = useState(NONE_PERSPECTIVE_ID)
  const [defaultPerspectiveId, setDefaultPerspectiveId] = useState(() => {
    try { return window.localStorage.getItem(SCHEDULE_DEFAULT_PERSPECTIVE_KEY) || NONE_PERSPECTIVE_ID }
    catch { return NONE_PERSPECTIVE_ID }
  })
  const appliedDefaultRef = useRef(false)
  const [editingFilter, setEditingFilter] = useState(null)
  const [drawingState, setDrawingState] = useState(null)  // { fromId } while drawing

  const applyAssignments = assigns => {
    const map = {}
    const orderMap = {}
    assigns.forEach(a => {
      if (!map[a.noteId]) map[a.noteId] = {}
      if (!orderMap[a.noteId]) orderMap[a.noteId] = {}
      map[a.noteId][a.dimensionId] = a.categoryId
      orderMap[a.noteId][a.dimensionId] = a.orderIdx ?? 0
    })
    setAssignments(map)
    setAssignmentOrders(orderMap)
  }

  useEffect(() => {
    if (!isActive) return
    Promise.all([
      api.getDimensions(), api.getAllCategories(), api.getAssignments(),
      api.getMilestones(), api.getDependencies(), api.getDeadlines(), api.getFilters(), api.getSchedulePerspectives(),
      api.getTransactionHistory(),
    ]).then(([dims, cats, assigns, mss, deps, dls, filters, loadedPerspectives, history]) => {
      setDimensions(dims); setCategories(cats)
      setSavedFilters(filters)
      setPerspectives(loadedPerspectives.map(normalizePerspective))
      applyAssignments(assigns)
      setMilestones(mss)
      setDependencies(deps)
      setDeadlines(dls)
      setTransactionHistory(history)
    }).catch(console.error)
  }, [isActive])

  useEffect(() => {
    if (!refreshKey) return
    api.getAssignments().then(applyAssignments).catch(console.error)
  }, [refreshKey])

  // ── Toolbar / mode state ───────────────────────────────────────────────────
  const [mode,              setMode]              = useState('milestone')
  const [activeDimId,       setActiveDimId]       = useState('')
  const [activeLaneFilterId, setActiveLaneFilterId] = useState('')
  const [axisMode, setAxisMode] = useState('full')
  const [timeZoom, setTimeZoom] = useState(DEFAULT_TIME_ZOOM)
  const [showDepLabels, setShowDepLabels] = useState(true)
  const [showDeps, setShowDeps] = useState(true)
  const [hideCrossCatDeps, setHideCrossCatDeps] = useState(false)
  const [showCrucialDepsOnly, setShowCrucialDepsOnly] = useState(false)
  const [colorDependencyDirection, setColorDependencyDirection] = useState(false)
  const [reasonModal, setReasonModal] = useState(null)   // null | { depId }
  const [reasonDraft, setReasonDraft] = useState('')
  const reasonInputRef = useRef()
  const [colorDimId,        setColorDimId]        = useState('')
  const [activeFilterIds, setActiveFilterIds] = useState([])
  const [quickFilters, setQuickFilters] = useState([])
  const [paintCat, setPaintCat] = useState(null)
  const [floatingPanel, setFloatingPanel] = useState(null)
  const [spacing,     setSpacing]     = useState(DEFAULT_SPACING)
  const [hiddenCatIds, setHiddenCatIds] = useState(new Set())
  const [hiddenNotesByLane, setHiddenNotesByLane] = useState({})
  const [revealedConflictNoteIds, setRevealedConflictNoteIds] = useState(new Set())
  const [visibleNoteFilterIds, setVisibleNoteFilterIds] = useState(new Set())
  const [pendingConflictMilestoneIds, setPendingConflictMilestoneIds] = useState(new Set())
  const [warningPrompt, setWarningPrompt] = useState(null)
  const [blinkingDepIds, setBlinkingDepIds] = useState(new Set())
  const [blinkingMilestoneIds, setBlinkingMilestoneIds] = useState(new Set())
  const [pendingDependencyResolveIds, setPendingDependencyResolveIds] = useState(new Set())
  const [dependencyResolveSnapshot, setDependencyResolveSnapshot] = useState(null)
  const [autoResolveDependencyView, setAutoResolveDependencyView] = useState(false)
  const [deleteDraft, setDeleteDraft] = useState(null)
  const [resizeConfirmDraft, setResizeConfirmDraft] = useState(null)
  const warningPromptTimerRef = useRef(null)
  const capturePerspectiveStateRef = useRef(null)
  const resolveDependencySelectionRef = useRef(null)
  const autoResolveDependencyViewRef = useRef(false)
  const [dragOverNoteId, setDragOverNoteId] = useState(null)
  const [dragOverLaneCatId, setDragOverLaneCatId] = useState(null)
  const [draggingCatId, setDraggingCatId] = useState(null)
  const [dragOverCatReorderId, setDragOverCatReorderId] = useState(null)

  const warningSettings = useMemo(() => ({
    resizeWarnOrderThreshold: Number.isFinite(Number(project?.resizeWarnOrderThreshold))
      ? Number(project.resizeWarnOrderThreshold)
      : DEFAULT_WARNING_SETTINGS.resizeWarnOrderThreshold,
    resizeBlockOrderThreshold: Number.isFinite(Number(project?.resizeBlockOrderThreshold))
      ? Number(project.resizeBlockOrderThreshold)
      : DEFAULT_WARNING_SETTINGS.resizeBlockOrderThreshold,
    resizeScaleCrossingWarningEnabled: typeof project?.resizeScaleCrossingWarningEnabled === 'boolean'
      ? project.resizeScaleCrossingWarningEnabled
      : DEFAULT_WARNING_SETTINGS.resizeScaleCrossingWarningEnabled,
  }), [project?.resizeBlockOrderThreshold, project?.resizeScaleCrossingWarningEnabled, project?.resizeWarnOrderThreshold])

  const updateWarningSettings = useCallback(async next => {
    const normalized = {
      resizeWarnOrderThreshold: Math.max(0, Number(next.resizeWarnOrderThreshold) || 0),
      resizeBlockOrderThreshold: Math.max(0, Number(next.resizeBlockOrderThreshold) || 0),
      resizeScaleCrossingWarningEnabled: next.resizeScaleCrossingWarningEnabled !== false,
    }
    onProjectUpdate?.({ ...(project ?? {}), ...normalized })
    if (!project?.id) return
    try {
      const saved = await projectsApi.updateProject(project.id, normalized)
      onProjectUpdate?.(saved)
    } catch (err) {
      console.error(err)
    }
  }, [onProjectUpdate, project])

  useEffect(() => () => {
    if (warningPromptTimerRef.current) window.clearTimeout(warningPromptTimerRef.current)
  }, [])

  const clearWarningPrompt = useCallback(() => {
    if (warningPromptTimerRef.current) {
      window.clearTimeout(warningPromptTimerRef.current)
      warningPromptTimerRef.current = null
    }
    setWarningPrompt(null)
  }, [])

  const showWarningPrompt = useCallback(prompt => {
    if (warningPromptTimerRef.current) window.clearTimeout(warningPromptTimerRef.current)
    setWarningPrompt(prompt)
    if (prompt?.actions === 'confirm') {
      warningPromptTimerRef.current = null
      return
    }
    warningPromptTimerRef.current = window.setTimeout(() => {
      setWarningPrompt(null)
      warningPromptTimerRef.current = null
    }, 4500)
  }, [])

  useEffect(() => {
    autoResolveDependencyViewRef.current = autoResolveDependencyView
  }, [autoResolveDependencyView])

  const activeCategories = useMemo(
    () => categories.filter(c => c.dimensionId === activeDimId),
    [categories, activeDimId]
  )

  const activeLaneFilter = useMemo(
    () => savedFilters.find(f => f.id === activeLaneFilterId) ?? null,
    [savedFilters, activeLaneFilterId]
  )

  const nonePerspective = useMemo(() => {
    const priorityDim = dimensions.find(d => d.name === 'Priority')
    return normalizePerspective({
      id: NONE_PERSPECTIVE_ID,
      name: 'None',
      readOnly: true,
      state: {
        spacing: DEFAULT_SPACING,
        timeZoom: DEFAULT_TIME_ZOOM,
        axisMode: 'full',
        showDepLabels: true,
        showDeps: true,
        hideCrossCatDeps: false,
        showCrucialDepsOnly: false,
        colorDependencyDirection: false,
        leftPanelWidth: 220,
        group: { activeDimId: '', activeLaneFilterId: '' },
        collapsedCategories: [],
        hiddenNotesByLane: {},
        scrollLeft: 0,
        color: {
          colorDimId: priorityDim?.id ?? '',
          activeFilterIds: [],
          quickFilters: [],
        },
      },
    })
  }, [dimensions])

  const perspectiveOptions = useMemo(
    () => [nonePerspective, ...perspectives],
    [nonePerspective, perspectives]
  )

  const handleLaneGroupChange = useCallback((value) => {
    if (!value) { setActiveDimId(''); setActiveLaneFilterId('') }
    else if (value.startsWith('d:')) { setActiveDimId(value.slice(2)); setActiveLaneFilterId('') }
    else { setActiveLaneFilterId(value.slice(2)); setActiveDimId('') }
  }, [])

  const restoringPerspectiveRef = useRef(false)
  const restoringColorRef = useRef(false)

  useEffect(() => {
    if (restoringPerspectiveRef.current) {
      restoringPerspectiveRef.current = false
      return
    }
    setHiddenCatIds(activeLaneFilterId ? new Set([UNASSIGNED_LANE]) : new Set())
    setHiddenNotesByLane({})
  }, [activeDimId, activeLaneFilterId])

  useEffect(() => {
    if (restoringColorRef.current) {
      restoringColorRef.current = false
      return
    }
    setQuickFilters([])
    if (colorDimId !== FILTER_DIMENSION_ID) setActiveFilterIds([])
    setPaintCat(null)
  }, [colorDimId])

  const toggleNoteVisibility = useCallback((laneKey, noteId) => {
    setHiddenNotesByLane(prev => {
      const nextLane = new Set(prev[laneKey] ?? [])
      if (nextLane.has(noteId)) nextLane.delete(noteId)
      else nextLane.add(noteId)
      return { ...prev, [laneKey]: nextLane }
    })
  }, [])

  const showAllLaneNotes = useCallback(laneKey => {
    setHiddenNotesByLane(prev => ({ ...prev, [laneKey]: new Set() }))
  }, [])

  const hideAllLaneNotes = useCallback((laneKey, noteIds) => {
    setHiddenNotesByLane(prev => ({ ...prev, [laneKey]: new Set(noteIds) }))
  }, [])


  const toggleCategoryVisibility = useCallback(catId => {
    setHiddenCatIds(prev => {
      const next = new Set(prev)
      if (next.has(catId)) next.delete(catId)
      else next.add(catId)
      return next
    })
  }, [])

  const showAllCategories = useCallback(() => setHiddenCatIds(new Set()), [])

  const presentConflictMilestones = useCallback(ids => {
    const idSet = new Set(ids)
    const conflictMilestones = milestonesRef.current.filter(m => idSet.has(m.id))
    const noteIds = conflictMilestones.map(m => m.noteId)
    if (conflictMilestones.length === 0 || noteIds.length === 0) return
    const hiddenMilestoneIds = conflictMilestones
      .filter(m => !noteRowMapRef.current[m.noteId])
      .map(m => m.id)
    setPendingConflictMilestoneIds(new Set(hiddenMilestoneIds.length ? hiddenMilestoneIds : conflictMilestones.map(m => m.id)))
    setRevealedConflictNoteIds(prev => new Set([...prev, ...noteIds]))
    setHiddenCatIds(prev => {
      const next = new Set(prev)
      noteIds.forEach(noteId => {
        if (activeLaneFilter) {
          if (filterMatchesNote(activeLaneFilter, noteId, assignments)) next.delete(activeLaneFilter.id)
        } else if (activeDimId) {
          const catId = assignments[noteId]?.[activeDimId]
          if (catId) next.delete(catId)
        }
      })
      return next
    })
    if (colorDimId && colorDimId !== FILTER_DIMENSION_ID) {
      const colorFilterAdds = noteIds
        .map(noteId => assignments[noteId]?.[colorDimId])
        .filter(Boolean)
      if (colorFilterAdds.length > 0) {
        setQuickFilters(prev => {
          if (prev.length === 0) return prev
          const next = [...prev]
          colorFilterAdds.forEach(catId => {
            if (!next.some(filter => filter.dimId === colorDimId && filter.catId === catId)) {
              next.push({ dimId: colorDimId, catId })
            }
          })
          return next
        })
      }
    }
    setHiddenNotesByLane(prev => {
      const next = { ...prev }
      noteIds.forEach(noteId => {
        Object.entries(next).forEach(([laneKey, hiddenIds]) => {
          if (!hiddenIds?.has?.(noteId)) return
          const laneHidden = new Set(hiddenIds)
          laneHidden.delete(noteId)
          next[laneKey] = laneHidden
        })
      })
      return next
    })
    setBlinkingMilestoneIds(idSet)
    window.setTimeout(() => setBlinkingMilestoneIds(new Set()), 3000)
    setSelectedDepIds(new Set())
    setSelectedIds(idSet)
  }, [activeDimId, activeLaneFilter, assignments, colorDimId])

  const presentDependencyConflictMilestones = useCallback(ids => {
    const idSet = new Set(ids)
    const conflictMilestones = milestonesRef.current.filter(m => idSet.has(m.id))
    const noteIds = new Set(conflictMilestones.map(m => m.noteId))
    if (conflictMilestones.length === 0 || noteIds.size === 0) return

    setRevealedConflictNoteIds(new Set(noteIds))
    setPendingConflictMilestoneIds(idSet)
    setPendingDependencyResolveIds(prev => new Set([...prev, ...idSet]))
    setSelectedDepIds(new Set())
  }, [])

  const toggleSavedFilter = useCallback(filterId => {
    setActiveFilterIds(prev => prev.includes(filterId) ? prev.filter(id => id !== filterId) : [...prev, filterId])
  }, [])

  const toggleQuickFilter = useCallback((dimId, catId) => {
    if (!dimId || !catId || dimId === FILTER_DIMENSION_ID) return
    setQuickFilters(prev => {
      const exists = prev.some(f => f.dimId === dimId && f.catId === catId)
      return exists
        ? prev.filter(f => !(f.dimId === dimId && f.catId === catId))
        : [...prev, { dimId, catId }]
    })
  }, [])

  const activatePaint = useCallback((catId, color) => {
    setPaintCat(prev => prev?.id === catId ? null : { id: catId, color })
  }, [])

  const paintNote = useCallback(async noteId => {
    if (!paintCat || !colorDimId || colorDimId === FILTER_DIMENSION_ID) return
    try {
      await api.assign(noteId, colorDimId, paintCat.id)
      setAssignments(prev => ({ ...prev, [noteId]: { ...(prev[noteId] ?? {}), [colorDimId]: paintCat.id } }))
    } catch (err) { console.error(err) }
  }, [colorDimId, paintCat])

  const saveFilter = useCallback(async filter => {
    const normalized = normalizeSavedFilter(filter)
    try {
      const saved = normalizeSavedFilter(await api.updateFilter(normalized.id, normalized))
      setSavedFilters(prev => prev.map(f => f.id === saved.id ? saved : f))
      setEditingFilter(null)
    } catch (err) { console.error(err) }
  }, [])

  const deleteFilter = useCallback(async filterId => {
    try {
      await api.deleteFilter(filterId)
      setSavedFilters(prev => prev.filter(f => f.id !== filterId))
      setActiveFilterIds(prev => prev.filter(id => id !== filterId))
      setEditingFilter(null)
    } catch (err) { console.error(err) }
  }, [])

  // ── Infinite timeline state ────────────────────────────────────────────────
  const [totalCols,  setTotalCols]  = useState(INIT_TOTAL_COLS)

  // ── Selection + context menu ───────────────────────────────────────────────
  const [selectedIds,  setSelectedIds]  = useState(new Set())
  const [selectedDepIds, setSelectedDepIds] = useState(new Set())
  const [contextMenu,  setContextMenu]  = useState(null)
  const [clickedNoteId, setClickedNoteId] = useState(null)

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
  const timeZoomRef     = useRef(timeZoom)
  const totalColsRef    = useRef(INIT_TOTAL_COLS)
  const rafIdRef          = useRef(null)         // requestAnimationFrame id
  const gridInnerRef      = useRef(null)         // for synchronous width update during extension
  const lastExtensionRef  = useRef(0)            // timestamp — prevents stacked extensions
  const dragRef           = useRef(null)         // drag state machine
  const milestoneElsRef = useRef(new Map())      // id → DOM element
  const hoveredCellRef  = useRef(null)
  const drawingRef      = useRef(null)           // { fromId } sync access during drawing
  const previewArrowRef = useRef(null)           // SVG path element for live preview
  const depPathElsRef   = useRef(new Map())      // dependency id -> SVG path element
  const dependenciesRef = useRef([])
  const deadlinesRef    = useRef([])
  const modeRef         = useRef('milestone')

  // Keep imperative refs in sync with state (assigned synchronously in render)
  spacingRef.current       = spacing
  timeZoomRef.current      = timeZoom
  totalColsRef.current     = totalCols
  dependenciesRef.current  = dependencies
  deadlinesRef.current     = deadlines
  modeRef.current          = mode

  const visualRangeFor = useCallback(item => getVisualRange(item, timeZoomRef.current), [])
  const visualColToMinute = useCallback(col => zoomColToMinute(col, timeZoomRef.current), [])
  const minuteLabel = useCallback(minute => minuteToLabel(minute, timeZoomRef.current), [])

  // Live refs that closures read — no useEffect needed
  const milestonesRef  = useRef([])
  milestonesRef.current = milestones
  const selectedIdsRef = useRef(new Set())
  selectedIdsRef.current = selectedIds
  const selectedDepIdsRef = useRef(new Set())
  selectedDepIdsRef.current = selectedDepIds

  const applyTransactionState = useCallback((nextState, previousState = {}) => {
    const next = normalizeTransactionState(nextState)
    const previous = normalizeTransactionState(previousState)
    const touchedMsIds = new Set([...previous.milestones, ...next.milestones].map(m => m.id))
    const touchedDepIds = new Set([...previous.dependencies, ...next.dependencies].map(d => d.id))
    const nextMsById = new Map(next.milestones.map(m => [m.id, m]))
    const nextDepById = new Map(next.dependencies.map(d => [d.id, d]))
    setMilestones(prev => {
      const existingIds = new Set(prev.map(m => m.id))
      return [
        ...prev.flatMap(m => {
          if (!touchedMsIds.has(m.id)) return [m]
          return nextMsById.has(m.id) ? [nextMsById.get(m.id)] : []
        }),
        ...next.milestones.filter(m => !existingIds.has(m.id)),
      ]
    })
    setDependencies(prev => {
      const existingIds = new Set(prev.map(d => d.id))
      return [
        ...prev.flatMap(d => {
          if (!touchedDepIds.has(d.id)) return [d]
          return nextDepById.has(d.id) ? [nextDepById.get(d.id)] : []
        }),
        ...next.dependencies.filter(d => !existingIds.has(d.id)),
      ]
    })
  }, [])

  const refreshGanttTransactions = useCallback(async () => {
    const [mss, deps, history] = await Promise.all([
      api.getMilestones(),
      api.getDependencies(),
      api.getTransactionHistory(),
    ])
    setMilestones(mss)
    setDependencies(deps)
    setTransactionHistory(history)
  }, [])

  const showTransactionFailure = useCallback(err => {
    const detail = err?.message || 'The backend rejected this transaction.'
    showWarningPrompt({ title: 'Transaction rejected', message: detail })
  }, [showWarningPrompt])

  const commitTransaction = useCallback(async transaction => {
    const before = normalizeTransactionState(transaction.before)
    const after = normalizeTransactionState(transaction.after)
    applyTransactionState(after, before)
    try {
      const result = await api.applyTransaction({ ...transaction, before, after })
      setTransactionHistory(result.history)
      return true
    } catch (err) {
      console.error(err)
      applyTransactionState(before, after)
      const detail = err?.detail
      if (detail?.type === 'overlap' && Array.isArray(detail.milestoneIds)) {
        presentConflictMilestones(detail.milestoneIds)
        showWarningPrompt({ title: 'Milestone overlap', message: detail.message, actions: 'close' })
      } else if (detail?.type === 'deadline') {
        showWarningPrompt({ title: 'Hard deadline', message: detail.message, actions: 'close' })
      } else if (detail?.type === 'dependency') {
        const depIds = detail.dependencyIds ?? []
        const milestoneIds = new Set(detail.milestoneIds ?? [])
        depIds.forEach(depId => {
          const dep = dependenciesRef.current.find(d => d.id === depId)
          if (dep) { milestoneIds.add(dep.fromId); milestoneIds.add(dep.toId) }
        })
        presentDependencyConflictMilestones(milestoneIds)
        setBlinkingDepIds(new Set(depIds))
        window.setTimeout(() => setBlinkingDepIds(new Set()), 3000)
        showWarningPrompt({ title: 'Dependency violation', message: detail.message, actions: 'dependency', dependencyIds: depIds })
        if (autoResolveDependencyViewRef.current) {
          resolveDependencySelectionRef.current?.(milestoneIds)
        }
      } else {
        showTransactionFailure(err)
      }
      return false
    }
  }, [applyTransactionState, presentConflictMilestones, presentDependencyConflictMilestones, showTransactionFailure, showWarningPrompt])

  const undoGanttTransaction = useCallback(async () => {
    try {
      await api.undoTransaction()
      await refreshGanttTransactions()
    } catch (err) {
      console.error(err)
      showTransactionFailure(err)
    }
  }, [refreshGanttTransactions, showTransactionFailure])

  const redoGanttTransaction = useCallback(async () => {
    try {
      await api.redoTransaction()
      await refreshGanttTransactions()
    } catch (err) {
      console.error(err)
      showTransactionFailure(err)
    }
  }, [refreshGanttTransactions, showTransactionFailure])

  // ── Virtual-render state ───────────────────────────────────────────────────
  const [vpSize,      setVpSize]      = useState({ w: 0, h: 0 })
  const [scrollLeft,  setScrollLeft]  = useState(0)
  const [scrollTop,   setScrollTop]   = useState(0)

  const filterCategories = useMemo(
    () => savedFilters.map(filter => ({
      id: filterCategoryId(filter.id),
      dimensionId: FILTER_DIMENSION_ID,
      name: filter.name,
      color: filter.color || '#64748b',
      dynamic: true,
      filterId: filter.id,
    })),
    [savedFilters]
  )
  const colorDimensions = useMemo(
    () => [...dimensions, { id: FILTER_DIMENSION_ID, name: 'Filters', dynamic: true }],
    [dimensions]
  )
  const colorCategories = useMemo(
    () => [...categories, ...filterCategories],
    [categories, filterCategories]
  )

  const visibleNotes = useMemo(
    () => {
      if (visibleNoteFilterIds.size > 0) {
        return notes.filter(note => visibleNoteFilterIds.has(note.id))
      }
      const activeSavedFilters = activeFilterIds
        .map(id => savedFilters.find(filter => filter.id === id))
        .filter(Boolean)
      const hasActiveFiltering = activeSavedFilters.length > 0 || quickFilters.length > 0
      if (!hasActiveFiltering) return notes
      return notes.filter(note =>
        revealedConflictNoteIds.has(note.id) ||
        activeSavedFilters.some(filter => filterMatchesNote(filter, note.id, assignments)) ||
        quickFilters.some(filter => assignments[note.id]?.[filter.dimId] === filter.catId)
      )
    },
    [activeFilterIds, assignments, notes, quickFilters, revealedConflictNoteIds, savedFilters, visibleNoteFilterIds]
  )

  // ── Row model ──────────────────────────────────────────────────────────────
  const rowItems = useMemo(
    () => buildRowItems(visibleNotes, categories, assignments, assignmentOrders, activeDimId, spacing, hiddenCatIds, hiddenNotesByLane, activeLaneFilter),
    [visibleNotes, categories, assignments, assignmentOrders, activeDimId, spacing, hiddenCatIds, hiddenNotesByLane, activeLaneFilter]
  )
  const rowItemsRef = useRef([])
  rowItemsRef.current = rowItems

  const noteRowMap = useMemo(() => {
    const map = {}
    rowItems.forEach(item => { if (item.type === 'note') map[item.note.id] = item })
    return map
  }, [rowItems])
  const noteRowMapRef = useRef({})
  noteRowMapRef.current = noteRowMap

  useEffect(() => {
    if (selectedIds.size === 0) return
    const milestoneById = new Map(milestones.map(m => [m.id, m]))
    let changed = false
    const next = new Set()
    selectedIds.forEach(msId => {
      const milestone = milestoneById.get(msId)
      if (milestone && noteRowMap[milestone.noteId]) {
        next.add(msId)
      } else {
        changed = true
      }
    })
    if (changed) setSelectedIds(next)
  }, [noteRowMap, milestones, selectedIds])

  useEffect(() => {
    if (pendingConflictMilestoneIds.size === 0) return
    const target = milestones.find(m => pendingConflictMilestoneIds.has(m.id) && noteRowMap[m.noteId])
    if (!target) return
    const row = noteRowMap[target.noteId]
    requestAnimationFrame(() => {
      const el = gridBodyRef.current
      if (!el) return
      const inset = Math.max(40, Math.floor(vpRef.current.h * 0.25))
      const nextTop = Math.max(0, row.top - inset)
      el.scrollTop = nextTop
      scrollTopRef.current = el.scrollTop
      if (leftBodyInnerRef.current) leftBodyInnerRef.current.style.transform = `translateY(${-el.scrollTop}px)`
      setScrollTop(el.scrollTop)
      setPendingConflictMilestoneIds(new Set())
    })
  }, [noteRowMap, milestones, pendingConflictMilestoneIds])

  const selectedNoteIds = useMemo(() => {
    const set = new Set()
    selectedIds.forEach(msId => {
      const m = milestones.find(m => m.id === msId)
      if (m) set.add(m.noteId)
    })
    return set
  }, [selectedIds, milestones])

  const applyNoteVisibilityFilter = useCallback(noteIds => {
    if (noteIds.size === 0) return
    setVisibleNoteFilterIds(new Set(noteIds))

    if (activeLaneFilter) {
      let hasMatch = false
      let hasOther = false
      noteIds.forEach(noteId => {
        if (filterMatchesNote(activeLaneFilter, noteId, assignments)) hasMatch = true
        else hasOther = true
      })
      const nextHidden = new Set()
      if (!hasMatch) nextHidden.add(activeLaneFilter.id)
      if (!hasOther) nextHidden.add(UNASSIGNED_LANE)
      setHiddenCatIds(nextHidden)
      setHiddenNotesByLane({
        [activeLaneFilter.id]: new Set(notes.filter(note => !noteIds.has(note.id)).map(note => note.id)),
        [UNASSIGNED_LANE]: new Set(notes.filter(note => !noteIds.has(note.id)).map(note => note.id)),
      })
      return
    }

    if (activeDimId) {
      const selectedCatIds = new Set()
      let hasUnassigned = false
      noteIds.forEach(noteId => {
        const catId = assignments[noteId]?.[activeDimId]
        if (catId) selectedCatIds.add(catId)
        else hasUnassigned = true
      })
      const nextHidden = new Set(
        categories
          .filter(cat => cat.dimensionId === activeDimId && !selectedCatIds.has(cat.id))
          .map(cat => cat.id)
      )
      if (!hasUnassigned) nextHidden.add(UNASSIGNED_LANE)
      setHiddenCatIds(nextHidden)
      const nextHiddenNotesByLane = {}
      categories
        .filter(cat => cat.dimensionId === activeDimId)
        .forEach(cat => {
          nextHiddenNotesByLane[cat.id] = new Set(
            notes
              .filter(note => assignments[note.id]?.[activeDimId] === cat.id && !noteIds.has(note.id))
              .map(note => note.id)
          )
        })
      nextHiddenNotesByLane[UNASSIGNED_LANE] = new Set(
        notes
          .filter(note => !assignments[note.id]?.[activeDimId] && !noteIds.has(note.id))
          .map(note => note.id)
      )
      setHiddenNotesByLane(nextHiddenNotesByLane)
      return
    }

    setHiddenCatIds(new Set())
    setHiddenNotesByLane({
      [UNASSIGNED_LANE]: new Set(notes.filter(note => !noteIds.has(note.id)).map(note => note.id)),
    })
  }, [activeDimId, activeLaneFilter, assignments, categories, notes])

  const filterToSelectedNotes = useCallback(() => {
    applyNoteVisibilityFilter(selectedNoteIds)
  }, [applyNoteVisibilityFilter, selectedNoteIds])

  const expandEverything = useCallback(() => {
    setVisibleNoteFilterIds(new Set())
    setHiddenCatIds(new Set())
    setHiddenNotesByLane({})
  }, [])

  const resolveDependencySelection = useCallback((milestoneIds = null) => {
    const explicitIds = milestoneIds ? new Set(milestoneIds) : null
    const idsToResolve = explicitIds?.size > 0
      ? explicitIds
      : pendingDependencyResolveIds.size > 0
      ? pendingDependencyResolveIds
      : selectedIdsRef.current
    const accumulatedIds = new Set([...selectedIdsRef.current, ...idsToResolve])
    const noteIds = new Set()
    accumulatedIds.forEach(msId => {
      const milestone = milestonesRef.current.find(m => m.id === msId)
      if (milestone) noteIds.add(milestone.noteId)
    })
    const snapshot = capturePerspectiveStateRef.current?.()
    if (snapshot) setDependencyResolveSnapshot(prev => prev ?? snapshot)
    setSelectedDepIds(new Set())
    setSelectedIds(accumulatedIds)
    setActiveFilterIds([])
    setQuickFilters([])
    setPaintCat(null)
    setHiddenCatIds(new Set())
    setHiddenNotesByLane({})
    applyNoteVisibilityFilter(noteIds)
    setPendingDependencyResolveIds(new Set())
    clearWarningPrompt()
  }, [applyNoteVisibilityFilter, clearWarningPrompt, pendingDependencyResolveIds])
  resolveDependencySelectionRef.current = resolveDependencySelection

  const isNoteHighlighted = noteId => selectedNoteIds.has(noteId) || noteId === clickedNoteId

  const notesForLane = useCallback(cat => {
    if (activeLaneFilter) {
      const key = laneKeyForCat(cat)
      return key === UNASSIGNED_LANE
        ? visibleNotes.filter(g => !filterMatchesNote(activeLaneFilter, g.id, assignments))
        : visibleNotes.filter(g => filterMatchesNote(activeLaneFilter, g.id, assignments))
    }
    if (!activeDimId) return visibleNotes
    const key = laneKeyForCat(cat)
    return visibleNotes.filter(note => {
      const assignedCatId = assignments[note.id]?.[activeDimId]
      return key === UNASSIGNED_LANE ? !assignedCatId : assignedCatId === key
    }).sort((a, b) => {
      const ao = assignmentOrders[a.id]?.[activeDimId] ?? Number.MAX_SAFE_INTEGER
      const bo = assignmentOrders[b.id]?.[activeDimId] ?? Number.MAX_SAFE_INTEGER
      return ao - bo
    })
  }, [activeDimId, activeLaneFilter, assignmentOrders, assignments, visibleNotes])

  const reorderNoteInLane = useCallback(async (dragNoteId, targetNoteId) => {
    if (!activeDimId || dragNoteId === targetNoteId) return
    const catId = assignments[dragNoteId]?.[activeDimId]
    if (!catId || assignments[targetNoteId]?.[activeDimId] !== catId) return
    const laneNotes = notesForLane(categories.find(c => c.id === catId))
    const fromIdx = laneNotes.findIndex(g => g.id === dragNoteId)
    const toIdx = laneNotes.findIndex(g => g.id === targetNoteId)
    if (fromIdx === -1 || toIdx === -1) return
    const reordered = [...laneNotes]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    const noteIds = reordered.map(g => g.id)
    setAssignmentOrders(prev => {
      const next = { ...prev }
      noteIds.forEach((noteId, idx) => {
        next[noteId] = { ...(next[noteId] ?? {}), [activeDimId]: idx }
      })
      return next
    })
    try { await api.reorderAssignments(activeDimId, catId, noteIds) }
    catch (err) { console.error(err) }
  }, [activeDimId, assignments, categories, notesForLane])

  const moveNoteToLane = useCallback(async (noteId, targetCatId) => {
    if (!activeDimId) return
    const currentCatId = assignments[noteId]?.[activeDimId] ?? null
    if (currentCatId === targetCatId) return
    // Optimistic update
    setAssignments(prev => {
      const next = { ...prev }
      if (targetCatId === null) {
        const ga = { ...(next[noteId] ?? {}) }
        delete ga[activeDimId]
        next[noteId] = ga
      } else {
        next[noteId] = { ...(next[noteId] ?? {}), [activeDimId]: targetCatId }
      }
      return next
    })
    try {
      if (targetCatId === null) await api.unassign(noteId, activeDimId)
      else await api.assign(noteId, activeDimId, targetCatId)
    } catch (err) {
      console.error(err)
      // Revert
      setAssignments(prev => {
        const next = { ...prev }
        if (currentCatId === null) {
          const ga = { ...(next[noteId] ?? {}) }
          delete ga[activeDimId]
          next[noteId] = ga
        } else {
          next[noteId] = { ...(next[noteId] ?? {}), [activeDimId]: currentCatId }
        }
        return next
      })
    }
  }, [activeDimId, assignments])

  const reorderCategoryInGantt = useCallback(async (draggedCatId, targetCatId) => {
    if (!activeDimId || draggedCatId === targetCatId) return
    const dimCats = categories.filter(c => c.dimensionId === activeDimId)
    const fromIdx = dimCats.findIndex(c => c.id === draggedCatId)
    const toIdx   = dimCats.findIndex(c => c.id === targetCatId)
    if (fromIdx === -1 || toIdx === -1) return
    const reordered = [...dimCats]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    setCategories(prev => [...prev.filter(c => c.dimensionId !== activeDimId), ...reordered])
    try {
      await api.reorderCategories(reordered.map(c => c.id))
    } catch (err) {
      console.error(err)
      setCategories(prev => [...prev.filter(c => c.dimensionId !== activeDimId), ...dimCats])
    }
  }, [activeDimId, categories])

  const getMilestoneColor = useCallback(milestone => {
    if (!colorDimId) return milestone.color
    if (colorDimId === FILTER_DIMENSION_ID) {
      const match = filterCategories.find(cat => filterMatchesNote(savedFilters.find(f => f.id === cat.filterId), milestone.noteId, assignments))
      return match?.color ?? null
    }
    const catId = assignments[milestone.noteId]?.[colorDimId]
    if (!catId) return null
    return categories.find(c => c.id === catId)?.color ?? null
  }, [assignments, categories, colorDimId, filterCategories, savedFilters])

  // Color for the note row indicator dot — same logic as milestones but returns null when unassigned
  const getNoteColor = useCallback(noteId => {
    if (!colorDimId) return null
    if (colorDimId === FILTER_DIMENSION_ID) {
      const match = filterCategories.find(cat => filterMatchesNote(savedFilters.find(f => f.id === cat.filterId), noteId, assignments))
      return match?.color ?? null
    }
    const catId = assignments[noteId]?.[colorDimId]
    if (!catId) return null
    return categories.find(c => c.id === catId)?.color ?? null
  }, [assignments, categories, colorDimId, filterCategories, savedFilters])

  const getDependencyPathD = useCallback((dep, overrides = {}) => {
    const from = overrides[dep.fromId] ?? milestonesRef.current.find(m => m.id === dep.fromId)
    const to   = overrides[dep.toId]   ?? milestonesRef.current.find(m => m.id === dep.toId)
    if (!from || !to) return null
    const fromRow = noteRowMapRef.current[from.noteId]
    const toRow   = noteRowMapRef.current[to.noteId]
    if (!fromRow || !toRow) return null
    const sp = spacingRef.current
    const fromVisual = visualRangeFor(from)
    const toVisual = visualRangeFor(to)
    const fromLeftPx = from.leftPx ?? fromVisual.startCol * sp.colW
    const fromWidthPx = from.widthPx ?? fromVisual.duration * sp.colW
    const toLeftPx = to.leftPx ?? toVisual.startCol * sp.colW
    const x1 = fromLeftPx + fromWidthPx
    const y1 = HEADER_H + fromRow.top + Math.floor(fromRow.height / 2)
    const x2 = toLeftPx
    const y2 = HEADER_H + toRow.top + Math.floor(toRow.height / 2)
    const cp = Math.max(40, Math.abs(x2 - x1) * 0.45)
    return `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`
  }, [visualRangeFor])

  const updateDependencyPaths = useCallback((overrides = {}) => {
    dependenciesRef.current.forEach(dep => {
      const path = depPathElsRef.current.get(dep.id)
      if (!path) return
      const d = getDependencyPathD(dep, overrides)
      if (d) {
        path.setAttribute('d', d)
        path.style.display = ''
      } else {
        path.style.display = 'none'
      }
    })
  }, [getDependencyPathD])

  const totalContentH = rowItems.length > 0
    ? rowItems[rowItems.length - 1].top + rowItems[rowItems.length - 1].height
    : 0

  // Violations: recomputed whenever milestones or dependencies change
  const violationIds = useMemo(() => computeViolations(milestones, dependencies), [milestones, dependencies])
  const crucialDependencyIds = useMemo(() => getCrucialDependencyIds(dependencies), [dependencies])

  const reportOverlapViolation = useCallback(ids => {
    presentConflictMilestones(ids)
    showWarningPrompt({
      title: 'Milestone overlap',
      message: 'Milestones in the same note row cannot overlap or pass each other.',
      actions: 'close',
    })
  }, [presentConflictMilestones, showWarningPrompt])

  const reportDeadlineViolation = useCallback(() => {
    showWarningPrompt({
      title: 'Hard deadline',
      message: "Milestones cannot move before today or past their note's hard deadline.",
      actions: 'close',
    })
  }, [showWarningPrompt])

  const reportDependencyViolations = useCallback(violations => {
    const depIds = violations.map(v => v.dep.id).filter(Boolean)
    const milestoneIds = new Set()
    violations.forEach(v => {
      milestoneIds.add(v.from.id)
      milestoneIds.add(v.to.id)
    })
    presentDependencyConflictMilestones(milestoneIds)
    setBlinkingDepIds(new Set(depIds))
    window.setTimeout(() => setBlinkingDepIds(new Set()), 3000)
    showWarningPrompt({
      title: 'Dependency violation',
      message: violations.length === 1
        ? 'A predecessor milestone must finish before its successor starts.'
        : `${violations.length} dependency constraints were violated.`,
      actions: 'dependency',
      dependencyIds: depIds,
    })
    if (autoResolveDependencyViewRef.current) {
      resolveDependencySelectionRef.current?.(milestoneIds)
    }
  }, [presentDependencyConflictMilestones, showWarningPrompt])

  const maybeBlockDependencyWarning = useCallback((nextMilestones, nextDependencies) => {
    const violations = getDependencyViolations(nextMilestones, nextDependencies)
    if (violations.length === 0) return false
    reportDependencyViolations(violations)
    return true
  }, [reportDependencyViolations])

  // ── Measure + ensure grid covers viewport ─────────────────────────────────
  const ensureGridCoversVp = useCallback((w, h) => {
    if (w <= 0) return
    vpRef.current = { w, h }
    setVpSize({ w, h })
    const needed = Math.ceil(w / spacingRef.current.colW) + COL_BUF + EDGE_COLS + 1
    if (needed > totalColsRef.current) {
      totalColsRef.current = needed
      setTotalCols(needed)
    }
  }, [])

  useEffect(() => {
    const el = gridBodyRef.current; if (!el) return
    // Seed immediately from current layout so the very first render has correct
    // column counts (ResizeObserver fires asynchronously on the next frame).
    const init = el.getBoundingClientRect()
    ensureGridCoversVp(init.width, init.height)
    const obs = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect
      ensureGridCoversVp(width, height)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [ensureGridCoversVp])

  // When colW changes (via slider or perspective restore), re-check totalCols.
  // applyPerspective calls setSpacing directly, bypassing handleSpacingChange,
  // so totalCols can fall short of what's needed to cover the viewport.
  useEffect(() => {
    const w = vpRef.current.w
    if (w <= 0) return
    const needed = Math.ceil(w / spacing.colW) + COL_BUF + EDGE_COLS + 1
    if (needed > totalColsRef.current) {
      totalColsRef.current = needed
      setTotalCols(needed)
    }
  }, [spacing.colW])

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
          sl + vpRef.current.w > (totalColsRef.current - EDGE_COLS) * sp.colW) {
        lastExtensionRef.current = now
        const newTd = totalColsRef.current + EXTEND_DELTA
        if (gridInnerRef.current) gridInnerRef.current.style.width = `${newTd * sp.colW}px`
        totalColsRef.current = newTd
        setTotalCols(newTd)
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
    // Preview arrow is updated by the document-level onMove listener in startDependencyDrag
    if (drawingRef.current) {
      if (highlightRef.current) highlightRef.current.style.display = ''
      return
    }
    if (modeRef.current !== 'milestone') {
      hoveredCellRef.current = null
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
    if (col < 0 || col >= totalColsRef.current) return
    const item = rowItemsRef.current.find(r => rawY >= r.top && rawY < r.top + r.height)
    if (!item || item.type !== 'note') { if (highlightRef.current) highlightRef.current.style.display = ''; return }
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
      const leftDay = scrollLeftRef.current / prev.colW
      const nextScrollLeft = Math.max(0, Math.round(leftDay * next.colW))
      if (gridInnerRef.current) gridInnerRef.current.style.width = `${totalColsRef.current * next.colW}px`
      gridBodyRef.current.scrollLeft = nextScrollLeft
      scrollLeftRef.current = gridBodyRef.current.scrollLeft
      setScrollLeft(scrollLeftRef.current)
      // Ensure grid stays wider than viewport after colW change
      const needed = Math.ceil(vpRef.current.w / next.colW) + COL_BUF + EDGE_COLS + 1
      if (needed > totalColsRef.current) {
        totalColsRef.current = needed
        setTotalCols(needed)
      }
    }
    setSpacing(next)
  }, [])

  const handleTimeZoomChange = useCallback(nextZoom => {
    if (!TIME_ZOOM_BY_VALUE[nextZoom]) return
    const prevZoom = timeZoomRef.current
    if (nextZoom === prevZoom) return
    const sp = spacingRef.current
    const currentMinute = (scrollLeftRef.current / sp.colW) * getZoomUnit(prevZoom)
    const nextScrollLeft = Math.max(0, Math.round((currentMinute / getZoomUnit(nextZoom)) * sp.colW))
    setTimeZoom(nextZoom)
    requestAnimationFrame(() => {
      if (gridBodyRef.current) gridBodyRef.current.scrollLeft = nextScrollLeft
      scrollLeftRef.current = gridBodyRef.current?.scrollLeft ?? nextScrollLeft
      setScrollLeft(scrollLeftRef.current)
      const needed = Math.ceil((scrollLeftRef.current + vpRef.current.w) / sp.colW) + COL_BUF + EDGE_COLS + 1
      if (needed > totalColsRef.current) {
        totalColsRef.current = needed
        setTotalCols(needed)
      }
    })
  }, [])

  // ── Context menu ───────────────────────────────────────────────────────────
  const getNoteCellFromPointer = useCallback(e => {
    const rect = gridBodyRef.current?.getBoundingClientRect(); if (!rect) return
    const sp   = spacingRef.current
    const relY = e.clientY - rect.top
    const rawX = e.clientX - rect.left + scrollLeftRef.current
    const visualCol = Math.floor(rawX / sp.colW)
    if (visualCol < 0 || visualCol >= totalColsRef.current) return null
    const col = visualColToMinute(visualCol)

    if (relY < HEADER_H) return { type: 'header', col, visualCol }

    const rawY = e.clientY - rect.top + scrollTopRef.current - HEADER_H
    const item = rowItemsRef.current.find(r => rawY >= r.top && rawY < r.top + r.height)
    if (!item || item.type !== 'note') return null

    let color = '#1a73e8'
    if (item.cat?.color) color = item.cat.color

    return { type: 'cell', col, visualCol, noteId: item.note.id, noteTitle: item.note.title, color }
  }, [visualColToMinute])

  const handleContextMenu = useCallback(e => {
    e.preventDefault()
    const cell = getNoteCellFromPointer(e)
    if (!cell) return

    if (cell.type === 'header') {
      const { col } = cell
      setContextMenu({ type: 'header', x: e.clientX, y: e.clientY, col, unitLabel: TIME_ZOOM_BY_VALUE[timeZoomRef.current]?.label.toLowerCase() ?? 'unit' })
      return
    }
    if (e.target.closest('[data-ms-id]')) return  // right-click on milestone — skip for now

    const hasDeadline = deadlinesRef.current.some(d => d.noteId === cell.noteId)
    setContextMenu({ type: 'cell', x: e.clientX, y: e.clientY, col: cell.col,
      noteId: cell.noteId, noteTitle: cell.noteTitle, color: cell.color, hasDeadline })
  }, [getNoteCellFromPointer])

  // ── Milestone CRUD ─────────────────────────────────────────────────────────
  const handleCreateMilestone = useCallback(async (noteId, startCol, color) => {
    clearWarningPrompt()
    const duration = Math.max(MIN_MILESTONE_DURATION, getZoomUnit(timeZoomRef.current))
    const ms = { id: newClientId('ms'), noteId, startCol, duration, title: '', color: color || '#1a73e8' }
    const dl = deadlinesRef.current.find(d => d.noteId === noteId)
    if (startCol < 0 || (dl && startCol + duration > dl.col)) {
      reportDeadlineViolation()
      return
    }
    const overlap = getOverlapViolation([...milestonesRef.current, ms], new Set([ms.id]))
    if (overlap) {
      reportOverlapViolation(overlap)
      return
    }
    await commitTransaction({
      id: newClientId('tx'),
      type: 'milestone.create',
      label: 'Create milestone',
      before: { milestones: [], dependencies: [] },
      after: { milestones: [ms], dependencies: [] },
    })
  }, [clearWarningPrompt, commitTransaction, reportDeadlineViolation, reportOverlapViolation])

  const handleGridDoubleClick = useCallback(e => {
    if (modeRef.current !== 'milestone') return
    if (e.target.closest('[data-ms-id]')) return
    const cell = getNoteCellFromPointer(e)
    if (!cell || cell.type !== 'cell') return
    e.preventDefault()
    handleCreateMilestone(cell.noteId, cell.col, cell.color)
  }, [getNoteCellFromPointer, handleCreateMilestone])

  // ── Column insert / delete ─────────────────────────────────────────────────
  const handleInsertTimeUnit = useCallback(async col => {
    const unit = getZoomUnit(timeZoomRef.current)
    const updates = []
    milestonesRef.current.forEach(m => {
      if (m.startCol >= col) updates.push({ id: m.id, startCol: m.startCol + unit })
    })
    if (updates.length) {
      const before = updates.map(u => milestonesRef.current.find(m => m.id === u.id)).filter(Boolean)
      const after = before.map(m => ({ ...m, startCol: m.startCol + unit }))
      const tx = {
        id: newClientId('tx'),
        type: 'milestone.move-many',
        label: 'Insert time unit',
        before: { milestones: before, dependencies: [] },
        after: { milestones: after, dependencies: [] },
      }
      const nextMilestones = milestonesRef.current.map(m => after.find(candidate => candidate.id === m.id) ?? m)
      const overlap = getOverlapViolation(nextMilestones, new Set(before.map(m => m.id)))
      if (overlap) { reportOverlapViolation(overlap); return }
      const order = getMilestoneOrderViolation(milestonesRef.current, nextMilestones, new Set(before.map(m => m.id)))
      if (order) { reportOverlapViolation(order); return }
      if (maybeBlockDependencyWarning(nextMilestones, dependenciesRef.current)) return
      await commitTransaction(tx)
    }
  }, [commitTransaction, maybeBlockDependencyWarning, reportOverlapViolation])

  const handleDeleteTimeUnit = useCallback(async col => {
    const unit = getZoomUnit(timeZoomRef.current)
    const cutEnd = col + unit
    const updates = []
    const updated = milestonesRef.current.map(m => {
      if (m.startCol >= cutEnd) {
        updates.push({ id: m.id, startCol: Math.max(0, m.startCol - unit) })
        return { ...m, startCol: Math.max(0, m.startCol - unit) }
      }
      const overlapStart = Math.max(m.startCol, col)
      const overlapEnd = Math.min(m.startCol + m.duration, cutEnd)
      if (overlapStart < overlapEnd) {
        const d = Math.max(MIN_MILESTONE_DURATION, m.duration - (overlapEnd - overlapStart))
        updates.push({ id: m.id, duration: d })
        return { ...m, duration: d }
      }
      return m
    })
    if (updates.length) {
      const before = updates.map(u => milestonesRef.current.find(m => m.id === u.id)).filter(Boolean)
      const after = before.map(m => updated.find(next => next.id === m.id)).filter(Boolean)
      const tx = {
        id: newClientId('tx'),
        type: 'milestone.move-many',
        label: 'Delete time unit',
        before: { milestones: before, dependencies: [] },
        after: { milestones: after, dependencies: [] },
      }
      const overlap = getOverlapViolation(updated, new Set(before.map(m => m.id)))
      if (overlap) { reportOverlapViolation(overlap); return }
      const order = getMilestoneOrderViolation(milestonesRef.current, updated, new Set(before.map(m => m.id)))
      if (order) { reportOverlapViolation(order); return }
      if (maybeBlockDependencyWarning(updated, dependenciesRef.current)) return
      await commitTransaction(tx)
    }
  }, [commitTransaction, maybeBlockDependencyWarning, reportOverlapViolation])

  // ── Drag helpers ───────────────────────────────────────────────────────────
  function startMoveDrag(startMouseX, originals) {
    if (Object.keys(originals).length === 0) return
    clearWarningPrompt()
    const sp = spacingRef.current
    dragRef.current = { type: 'move', hasMoved: false, originals, lastValidColDelta: 0, blockedOverlap: null, blockedBarrier: null, hitBoundary: false }
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'

    const getBounds = () => {
      let minDelta = -Infinity
      let maxDelta = Infinity
      Object.entries(originals).forEach(([id, orig]) => {
        minDelta = Math.max(minDelta, -orig.startCol)
        const ms = milestonesRef.current.find(m => m.id === id)
        const dl = deadlinesRef.current.find(d => d.noteId === ms?.noteId)
        if (dl) maxDelta = Math.min(maxDelta, dl.col - orig.duration - orig.startCol)
      })
      return { minDelta, maxDelta }
    }

    const getSnappedColDelta = clientX => {
      const rawDx = clientX - startMouseX
      const firstOrig = Object.values(originals)[0]
      if (!firstOrig) return 0
      const unit = getZoomUnit(timeZoomRef.current)
      const firstVisualStart = minuteToZoomCol(firstOrig.startCol, timeZoomRef.current)
      const requestedVisual = snapPxToCol(firstVisualStart * sp.colW + rawDx, sp.colW)
      let colDelta = (requestedVisual - firstVisualStart) * unit
      const { minDelta, maxDelta } = getBounds()
      const clamped = Math.max(minDelta, Math.min(maxDelta, colDelta))
      if (dragRef.current && clamped !== colDelta) dragRef.current.hitBoundary = true
      return clamped
    }

    const buildMovedMilestones = colDelta => milestonesRef.current.map(m => {
      if (!originals[m.id]) return m
      return { ...m, startCol: originals[m.id].startCol + colDelta }
    })

    const getLiveDx = clientX => {
      const rawDx = clientX - startMouseX
      let dx = rawDx
      Object.entries(originals).forEach(([id, orig]) => {
        const origVisual = getVisualRange(orig, timeZoomRef.current)
        dx = Math.max(dx, -origVisual.startCol * sp.colW)
        const ms = milestonesRef.current.find(m => m.id === id)
        const dl = deadlinesRef.current.find(d => d.noteId === ms?.noteId)
        if (dl) {
          const maxStart = Math.max(0, dl.col - orig.duration)
          const maxVisual = minuteToZoomCol(maxStart, timeZoomRef.current)
          dx = Math.min(dx, (maxVisual - origVisual.startCol) * sp.colW)
        }
      })
      return dx
    }

    const onMove = e => {
      e.preventDefault()
      const dx = getLiveDx(e.clientX)
      if (Math.abs(dx) > 2) dragRef.current.hasMoved = true
      const overrides = {}
      Object.entries(originals).forEach(([id, orig]) => {
        const ms = milestonesRef.current.find(m => m.id === id)
        const origVisual = getVisualRange(orig, timeZoomRef.current)
        const leftPx = origVisual.startCol * sp.colW + dx
        if (ms) overrides[id] = { ...ms, leftPx, widthPx: origVisual.duration * sp.colW }
        const el = milestoneElsRef.current.get(id)
        if (el) el.style.left = `${leftPx}px`
      })
      updateDependencyPaths(overrides)
    }

    const onUp = async e => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const { hasMoved, hitBoundary } = dragRef.current || {}
      dragRef.current = null
      const resetToOriginal = () => {
        Object.entries(originals).forEach(([id, orig]) => {
          const el = milestoneElsRef.current.get(id)
          const origVisual = getVisualRange(orig, timeZoomRef.current)
          if (el) el.style.left = `${origVisual.startCol * sp.colW}px`
        })
        updateDependencyPaths()
      }
      if (!hasMoved) { resetToOriginal(); return }

      const colDelta = getSnappedColDelta(e.clientX)
      const finalOverlap = getOverlapViolation(buildMovedMilestones(colDelta), new Set(Object.keys(originals)))
      if (finalOverlap) {
        resetToOriginal()
        reportOverlapViolation(finalOverlap)
        return
      }
      if (hitBoundary) reportDeadlineViolation()
      const updates = []
      const next = milestonesRef.current.map(m => {
        if (!originals[m.id]) return m
        const newStartCol = Math.max(0, originals[m.id].startCol + colDelta)
        if (newStartCol !== originals[m.id].startCol) {
          updates.push({ id: m.id, startCol: newStartCol })
        }
        return { ...m, startCol: newStartCol }
      })
      const finalOrder = getMilestoneOrderViolation(milestonesRef.current, next, new Set(Object.keys(originals)))
      if (finalOrder) {
        resetToOriginal()
        reportOverlapViolation(finalOrder)
        return
      }
      if (updates.length) {
        const applyMove = async () => {
          const before = Object.entries(originals)
            .map(([id]) => milestonesRef.current.find(m => m.id === id))
            .filter(Boolean)
          const after = before.map(m => next.find(candidate => candidate.id === m.id)).filter(Boolean)
          await commitTransaction({
            id: newClientId('tx'),
            type: before.length > 1 ? 'milestone.move-many' : 'milestone.move',
            label: before.length > 1 ? 'Move milestones' : 'Move milestone',
            before: { milestones: before, dependencies: [] },
            after: { milestones: after, dependencies: [] },
          })
        }
        const blocked = maybeBlockDependencyWarning(next, dependenciesRef.current)
        if (blocked) {
          resetToOriginal()
          return
        }
        try { await applyMove() } catch (e) { console.error(e) }
      } else {
        resetToOriginal()
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function startResizeDrag(startMouseX, milestoneId, side) {
    clearWarningPrompt()
    const sp  = spacingRef.current
    const ms  = milestonesRef.current.find(m => m.id === milestoneId)
    if (!ms) return
    const origStart = ms.startCol; const origDur = ms.duration
    const origRight = origStart + origDur
    dragRef.current = { type: `resize-${side}`, blockedOverlap: null, hitBoundary: false, lastValid: { startCol: origStart, duration: origDur } }
    document.body.style.cursor = 'col-resize'

    const resetToOriginal = () => {
      const el = milestoneElsRef.current.get(milestoneId)
      if (el) {
        const origVisual = getVisualRange({ startCol: origStart, duration: origDur }, timeZoomRef.current)
        el.style.left = `${origVisual.startCol * sp.colW}px`
        el.style.width = `${origVisual.duration * sp.colW}px`
      }
      updateDependencyPaths()
    }

    const getSnappedResize = clientX => {
      const dx = clientX - startMouseX
      const dl = deadlinesRef.current.find(d => d.noteId === ms.noteId)
      const maxRight = dl?.col ?? Infinity
      const unit = getZoomUnit(timeZoomRef.current)
      if (side === 'left') {
        const origVisualStart = minuteToZoomCol(origStart, timeZoomRef.current)
        const requestedVisual = snapPxToCol(origVisualStart * sp.colW + dx, sp.colW)
        const requested = requestedVisual * unit
        const leftCol = Math.min(origRight - MIN_MILESTONE_DURATION, Math.max(0, requested))
        if (dragRef.current && leftCol !== requested) dragRef.current.hitBoundary = true
        return { startCol: leftCol, duration: origRight - leftCol }
      }
      const origVisualRight = minuteEndToZoomCol(origRight, timeZoomRef.current)
      const requestedVisual = snapPxToCol(origVisualRight * sp.colW + dx, sp.colW)
      const requested = requestedVisual * unit
      const rightCol = Math.min(maxRight, Math.max(origStart + MIN_MILESTONE_DURATION, requested))
      if (dragRef.current && rightCol !== requested) dragRef.current.hitBoundary = true
      return { startCol: origStart, duration: rightCol - origStart }
    }

    const buildResizedMilestones = next => milestonesRef.current.map(m =>
      m.id === milestoneId ? { ...m, startCol: next.startCol, duration: next.duration } : m
    )

    const getSafeResize = clientX => {
      const next = getSnappedResize(clientX)
      const overlap = getOverlapViolation(buildResizedMilestones(next), new Set([milestoneId]))
      if (!overlap) {
        if (dragRef.current) {
          dragRef.current.lastValid = next
          dragRef.current.blockedOverlap = null
        }
        return next
      }
      if (dragRef.current) dragRef.current.blockedOverlap = overlap
      return dragRef.current?.lastValid ?? { startCol: origStart, duration: origDur }
    }

    const getLiveResize = clientX => {
      const next = getSafeResize(clientX)
      const visual = getVisualRange(next, timeZoomRef.current)
      return { leftPx: visual.startCol * sp.colW, widthPx: visual.duration * sp.colW }
    }

    const onMove = e => {
      const el   = milestoneElsRef.current.get(milestoneId); if (!el) return
      const next = getLiveResize(e.clientX)
      const overrides = { [milestoneId]: { ...ms, leftPx: next.leftPx, widthPx: next.widthPx } }
      if (side === 'left') {
        el.style.left     = `${next.leftPx}px`
        el.style.width    = `${next.widthPx}px`
      } else {
        el.style.width    = `${next.widthPx}px`
      }
      updateDependencyPaths(overrides)
    }

    const onUp = async e => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''

      const dragState = dragRef.current || {}
      dragRef.current = null
      const { startCol: newStart, duration: newDur } = getSnappedResize(e.clientX)
      const finalOverlap = dragState.blockedOverlap || getOverlapViolation(
        buildResizedMilestones({ startCol: newStart, duration: newDur }),
        new Set([milestoneId])
      )
      if (finalOverlap) {
        resetToOriginal()
        reportOverlapViolation(finalOverlap)
        return
      }
      if (dragState.hitBoundary) reportDeadlineViolation()
      const changed = newStart !== origStart || newDur !== origDur
      const nextAll = milestonesRef.current.map(m => m.id === milestoneId ? { ...m, startCol: newStart, duration: newDur } : m)
      if (changed) {
        const applyResize = async () => {
          const current = milestonesRef.current.find(m => m.id === milestoneId)
          const next = nextAll.find(m => m.id === milestoneId)
          await commitTransaction({
            id: newClientId('tx'),
            type: 'milestone.resize',
            label: 'Resize milestone',
            before: { milestones: current ? [current] : [], dependencies: [] },
            after: { milestones: next ? [next] : [], dependencies: [] },
          })
        }
        const applyResizeIfValid = async () => {
          const blocked = maybeBlockDependencyWarning(nextAll, dependenciesRef.current)
          if (blocked) return
          try { await applyResize() } catch (err) { console.error(err) }
        }
        const magnitude = durationOrderMagnitudeChange(origDur, newDur)
        const warnThreshold = warningSettings.resizeWarnOrderThreshold
        const extraConfirmThreshold = warningSettings.resizeBlockOrderThreshold
        const originalScale = durationScaleBucket(origDur)
        const nextScale = durationScaleBucket(newDur)
        const scaleJump = Math.abs(durationScaleBucketIndex(nextScale) - durationScaleBucketIndex(originalScale))
        const crossedScale = warningSettings.resizeScaleCrossingWarningEnabled && originalScale !== nextScale
        const crossedMagnitude = magnitude >= warnThreshold
        const needsScaleJumpConfirm = crossedScale && scaleJump >= 2
        if (crossedMagnitude || crossedScale) {
          resetToOriginal()
          const durationChange = `The duration would move from ${formatMinutesDuration(origDur)} to ${formatMinutesDuration(newDur)}.`
          const concerns = [
            crossedMagnitude
              ? `Magnitude level ${magnitude.toFixed(1)} is unusually high for the currently picked duration of that milestone.`
              : null,
            crossedScale
              ? `It also crosses from ${originalScale} level to ${nextScale} level.`
              : null,
          ].filter(Boolean).join(' ')
          const baseMessage = `${durationChange} ${concerns} Changing it could lead to some trouble.`
          showWarningPrompt({
            title: 'Large resize',
            message: `${baseMessage} Apply it anyway?`,
            actions: 'confirm',
            confirmLabel: 'Apply resize',
            onConfirm: (crossedMagnitude && magnitude > extraConfirmThreshold) || needsScaleJumpConfirm
              ? () => setResizeConfirmDraft({
                  magnitude,
                  originalDuration: origDur,
                  nextDuration: newDur,
                  originalScale,
                  nextScale,
                  scaleJump,
                  onConfirm: applyResizeIfValid,
                })
              : applyResizeIfValid,
          })
          return
        }
        await applyResizeIfValid()
      } else {
        resetToOriginal()
      }
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
    setSelectedDepIds(new Set())

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
      const grm   = noteRowMapRef.current
      const hit   = new Set()
      milestonesRef.current.forEach(m => {
        const row = grm[m.noteId]; if (!row) return
        const visual = getVisualRange(m, timeZoomRef.current)
        const mL  = visual.startCol * sp.colW; const mR = visual.endCol * sp.colW
        if (mR > selL && mL < selR && row.top + row.height > selT && row.top < selB) hit.add(m.id)
      })
      setSelectedIds(hit)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ── Dependency drawing ─────────────────────────────────────────────────────
  const createDependencyFromDrag = useCallback(async (fromId, toId) => {
    clearWarningPrompt()
    if (!fromId || !toId || fromId === toId) return
    if (hasCycle(fromId, toId, dependenciesRef.current)) return
    if (dependenciesRef.current.some(d => d.fromId === fromId && d.toId === toId)) return
    const pendingDep = { id: newClientId('dep'), fromId, toId, reason: '' }
    const nextDependencies = [...dependenciesRef.current, pendingDep]
    const applyDependency = async () => {
      await commitTransaction({
        id: newClientId('tx'),
        type: 'dependency.create',
        label: 'Create dependency',
        before: { milestones: [], dependencies: [] },
        after: { milestones: [], dependencies: [pendingDep] },
      })
    }
    const blocked = maybeBlockDependencyWarning(milestonesRef.current, nextDependencies)
    if (blocked) return
    try { await applyDependency() } catch (err) { console.error(err) }
  }, [clearWarningPrompt, commitTransaction, maybeBlockDependencyWarning])

  const updatePreviewArrow = useCallback((sourceId, clientX, clientY) => {
    const rect = gridBodyRef.current?.getBoundingClientRect()
    const source = milestonesRef.current.find(m => m.id === sourceId)
    const sourceRow = source && noteRowMapRef.current[source.noteId]
    if (!rect || !source || !sourceRow || !previewArrowRef.current) return
    const sp = spacingRef.current
    const x2 = clientX - rect.left + scrollLeftRef.current
    const y2 = clientY - rect.top + scrollTopRef.current
    const sourceVisual = getVisualRange(source, timeZoomRef.current)
    // Pick source edge based on which side of the milestone the cursor is on
    const sourceCenter = (sourceVisual.startCol + sourceVisual.duration / 2) * sp.colW
    const x1 = x2 >= sourceCenter
      ? sourceVisual.endCol * sp.colW
      : sourceVisual.startCol * sp.colW
    const y1 = HEADER_H + sourceRow.top + Math.floor(sourceRow.height / 2)
    const dx = x2 - x1
    const cp = Math.max(40, Math.abs(dx) * 0.45)
    const cpDir = dx >= 0 ? 1 : -1
    previewArrowRef.current.setAttribute('d',
      `M ${x1} ${y1} C ${x1 + cpDir * cp} ${y1}, ${x2 - cpDir * cp} ${y2}, ${x2} ${y2}`)
    previewArrowRef.current.style.display = ''
  }, [])

  const startDependencyDrag = useCallback((e, sourceId) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const getSide = (clientX) => {
      const rect = gridBodyRef.current?.getBoundingClientRect()
      const source = milestonesRef.current.find(m => m.id === sourceId)
      if (!rect || !source) return 'right'
      const sp = spacingRef.current
      const x = clientX - rect.left + scrollLeftRef.current
      const sourceVisual = getVisualRange(source, timeZoomRef.current)
      return x >= (sourceVisual.startCol + sourceVisual.duration / 2) * sp.colW ? 'right' : 'left'
    }

    drawingRef.current = { fromId: sourceId }
    setDrawingState({ fromId: sourceId })
    updatePreviewArrow(sourceId, e.clientX, e.clientY)

    const onMove = moveEvent => {
      updatePreviewArrow(sourceId, moveEvent.clientX, moveEvent.clientY)
    }

    const onUp = async upEvent => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      drawingRef.current = null
      setDrawingState(null)
      if (previewArrowRef.current) previewArrowRef.current.style.display = 'none'

      const sourceSide = getSide(upEvent.clientX)
      const hit = document.elementFromPoint(upEvent.clientX, upEvent.clientY)
      const portEl = hit?.closest('[data-dep-port="true"]')
      let targetId, targetSide
      if (portEl) {
        targetId = portEl.dataset.msId
        targetSide = portEl.dataset.depSide
      } else {
        const msEl = hit?.closest('[data-ms-id]')
        if (msEl) {
          targetId = msEl.dataset.msId
          const r = msEl.getBoundingClientRect()
          targetSide = upEvent.clientX < r.left + r.width / 2 ? 'left' : 'right'
        }
      }
      if (!targetId || targetId === sourceId || targetSide === sourceSide) return
      if (sourceSide === 'right' && targetSide === 'left') await createDependencyFromDrag(sourceId, targetId)
      if (sourceSide === 'left' && targetSide === 'right') await createDependencyFromDrag(targetId, sourceId)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [createDependencyFromDrag, updatePreviewArrow])

  // ── Deadlines ──────────────────────────────────────────────────────────────
  const handleSetDeadline = useCallback(async (noteId, col) => {
    try {
      const dl = await api.setDeadline(noteId, col)
      setDeadlines(prev => { const next = prev.filter(d => d.noteId !== noteId); return [...next, dl] })
    } catch (err) { console.error(err) }
  }, [])

  const handleRemoveDeadline = useCallback(async noteId => {
    try {
      await api.removeDeadline(noteId)
      setDeadlines(prev => prev.filter(d => d.noteId !== noteId))
    } catch (err) { console.error(err) }
  }, [])

  const handleDeleteMilestoneRequest = useCallback((milestoneId, label) => {
    setDeleteDraft({ items: [{ key: `milestone:${milestoneId}`, type: 'milestone', id: milestoneId, label, checked: true }] })
  }, [])

  const handleDeleteDepRequest = useCallback((depId, label) => {
    setDeleteDraft({ items: [{ key: `dependency:${depId}`, type: 'dependency', id: depId, label, checked: true }] })
  }, [])

  const handleEditDepReason = useCallback((depId, currentReason) => {
    setReasonDraft(currentReason || '')
    setReasonModal({ depId })
  }, [])

  const handleSaveDepReason = useCallback(async () => {
    if (!reasonModal) return
    const reason = reasonDraft.trim()
    const current = dependenciesRef.current.find(d => d.id === reasonModal.depId)
    if (!current) { setReasonModal(null); return }
    const next = { ...current, reason }
    try {
      await commitTransaction({
        id: newClientId('tx'),
        type: 'dependency.update',
        label: 'Update dependency',
        before: { milestones: [], dependencies: [current] },
        after: { milestones: [], dependencies: [next] },
      })
    } catch (err) { console.error(err) }
    setReasonModal(null)
  }, [commitTransaction, reasonModal, reasonDraft])

  const buildDeleteItems = useCallback(() => {
    const milestoneIds = [...selectedIdsRef.current]
    const dependencyIds = [...selectedDepIdsRef.current]
    const milestoneItems = milestoneIds
      .map(id => {
        const milestone = milestonesRef.current.find(m => m.id === id)
        if (!milestone) return null
        const note = notes.find(g => g.id === milestone.noteId)
        return {
          key: `milestone:${id}`,
          type: 'milestone',
          id,
          label: `${note?.title ?? 'Milestone'} · ${milestone.title || minuteLabel(milestone.startCol)}`,
          checked: true,
        }
      })
      .filter(Boolean)
    const dependencyItems = dependencyIds
      .map(id => {
        const dep = dependenciesRef.current.find(d => d.id === id)
        if (!dep) return null
        const from = milestonesRef.current.find(m => m.id === dep.fromId)
        const to = milestonesRef.current.find(m => m.id === dep.toId)
        const fromNote = notes.find(g => g.id === from?.noteId)
        const toNote = notes.find(g => g.id === to?.noteId)
        return {
          key: `dependency:${id}`,
          type: 'dependency',
          id,
          label: `${fromNote?.title ?? 'Milestone'} -> ${toNote?.title ?? 'Milestone'}`,
          checked: true,
        }
      })
      .filter(Boolean)
    return [...milestoneItems, ...dependencyItems]
  }, [notes])

  const handleRequestDeleteSelection = useCallback(() => {
    const items = buildDeleteItems()
    if (items.length === 0) return
    setDeleteDraft({ items })
  }, [buildDeleteItems])

  const handleConfirmDeleteDraft = useCallback(async () => {
    if (!deleteDraft) return
    const checked = deleteDraft.items.filter(item => item.checked)
    if (checked.length === 0) { setDeleteDraft(null); return }
    const milestoneIds = checked.filter(item => item.type === 'milestone').map(item => item.id)
    const dependencyIds = checked.filter(item => item.type === 'dependency').map(item => item.id)

    const milestoneSet = new Set(milestoneIds)
    const dependencySet = new Set(dependencyIds)
    const depsToDelete = dependenciesRef.current
      .filter(d => dependencySet.has(d.id) || milestoneSet.has(d.fromId) || milestoneSet.has(d.toId))
    const milestonesToDelete = milestonesRef.current.filter(m => milestoneSet.has(m.id))

    try {
      const ok = await commitTransaction({
        id: newClientId('tx'),
        type: milestonesToDelete.length > 1 || depsToDelete.length > 1 ? 'delete-many' : milestonesToDelete.length ? 'milestone.delete' : 'dependency.delete',
        label: checked.length > 1 ? 'Delete selected items' : `Delete ${checked[0].type}`,
        before: { milestones: milestonesToDelete, dependencies: depsToDelete },
        after: { milestones: [], dependencies: [] },
      })
      if (ok) {
        setSelectedIds(new Set())
        setSelectedDepIds(new Set())
        setDeleteDraft(null)
      }
    } catch (err) { console.error(err) }
  }, [commitTransaction, deleteDraft])

  useEffect(() => {
    if (!isActive) return
    const onKeyDown = e => {
      const tag = e.target?.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable
      const key = e.key.toLowerCase()
      if (!isTyping && (e.ctrlKey || e.metaKey) && !e.altKey) {
        if (key === 'z') {
          e.preventDefault()
          undoGanttTransaction()
          return
        }
        if (key === 'y') {
          e.preventDefault()
          redoGanttTransaction()
          return
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (deleteDraft) {
        if (e.key === 'Enter') {
          e.preventDefault()
          handleConfirmDeleteDraft()
        }
        if (e.key === 'Escape') setDeleteDraft(null)
        return
      }
      if (isTyping) return
      if (key === 'd') setMode('dependency')
      if (key === 'e') setMode('milestone')
      if (e.key === 'Delete' || e.key === 'Del') handleRequestDeleteSelection()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [deleteDraft, handleConfirmDeleteDraft, handleRequestDeleteSelection, isActive, redoGanttTransaction, undoGanttTransaction])

  useEffect(() => {
    if (reasonModal) setTimeout(() => reasonInputRef.current?.focus(), 30)
  }, [reasonModal])

  // ── Left-panel resize ─────────────────────────────────────────────────────
  const [leftPanelWidth, setLeftPanelWidth] = useState(220)
  const leftPanelWidthRef = useRef(220)
  leftPanelWidthRef.current = leftPanelWidth

  const capturePerspectiveState = useCallback(() => ({
    activePerspectiveId,
    spacing,
    timeZoom,
    axisMode,
    showDepLabels,
    showDeps,
    hideCrossCatDeps,
    showCrucialDepsOnly,
    colorDependencyDirection,
    leftPanelWidth,
    group: {
      activeDimId,
      activeLaneFilterId,
    },
    collapsedCategories: [...hiddenCatIds],
    hiddenNotesByLane: Object.fromEntries(
      Object.entries(hiddenNotesByLane).map(([laneKey, ids]) => [laneKey, [...ids]])
    ),
    visibleNoteFilterIds: [...visibleNoteFilterIds],
    scrollLeft: scrollLeftRef.current,
    color: {
      colorDimId,
      activeFilterIds,
      quickFilters,
    },
    selection: {
      milestoneIds: [...selectedIdsRef.current],
      dependencyIds: [...selectedDepIdsRef.current],
    },
  }), [
    activeDimId, activeFilterIds, activeLaneFilterId, activePerspectiveId, axisMode, colorDimId,
    colorDependencyDirection, hiddenCatIds, hiddenNotesByLane, hideCrossCatDeps,
    leftPanelWidth, quickFilters, showCrucialDepsOnly, showDepLabels, showDeps, spacing, timeZoom, visibleNoteFilterIds,
  ])
  capturePerspectiveStateRef.current = capturePerspectiveState

  const applyPerspective = useCallback(perspective => {
    const state = perspective?.state ?? {}
    const nextActiveDimId = state.group?.activeDimId || ''
    const nextActiveLaneFilterId = state.group?.activeLaneFilterId || ''
    const nextColorDimId = state.color?.colorDimId || ''
    restoringPerspectiveRef.current = nextActiveDimId !== activeDimId || nextActiveLaneFilterId !== activeLaneFilterId
    restoringColorRef.current = nextColorDimId !== colorDimId

    if (state.spacing) setSpacing({ ...DEFAULT_SPACING, ...state.spacing })
    if (TIME_ZOOM_BY_VALUE[state.timeZoom]) setTimeZoom(state.timeZoom)
    if (state.axisMode) setAxisMode(state.axisMode)
    if (typeof state.showDepLabels === 'boolean') setShowDepLabels(state.showDepLabels)
    if (typeof state.showDeps === 'boolean') setShowDeps(state.showDeps)
    if (typeof state.hideCrossCatDeps === 'boolean') setHideCrossCatDeps(state.hideCrossCatDeps)
    if (typeof state.showCrucialDepsOnly === 'boolean') setShowCrucialDepsOnly(state.showCrucialDepsOnly)
    if (typeof state.colorDependencyDirection === 'boolean') setColorDependencyDirection(state.colorDependencyDirection)
    if (typeof state.leftPanelWidth === 'number') setLeftPanelWidth(Math.max(120, Math.min(600, state.leftPanelWidth)))

    setActiveDimId(nextActiveDimId)
    setActiveLaneFilterId(nextActiveLaneFilterId)
    setHiddenCatIds(new Set(Array.isArray(state.collapsedCategories) ? state.collapsedCategories : []))
    setHiddenNotesByLane(Object.fromEntries(
      Object.entries(state.hiddenNotesByLane ?? {}).map(([laneKey, ids]) => [laneKey, new Set(Array.isArray(ids) ? ids : [])])
    ))
    setVisibleNoteFilterIds(new Set(Array.isArray(state.visibleNoteFilterIds) ? state.visibleNoteFilterIds : []))

    setColorDimId(nextColorDimId)
    setActiveFilterIds(Array.isArray(state.color?.activeFilterIds) ? state.color.activeFilterIds : [])
    setQuickFilters(Array.isArray(state.color?.quickFilters) ? state.color.quickFilters : [])
    setPaintCat(null)
    setRevealedConflictNoteIds(new Set())
    setDependencyResolveSnapshot(null)
    setActivePerspectiveId(perspective?.id ?? NONE_PERSPECTIVE_ID)

    requestAnimationFrame(() => {
      const nextLeft = Math.max(0, Number(state.scrollLeft) || 0)
      if (gridBodyRef.current) gridBodyRef.current.scrollLeft = nextLeft
      scrollLeftRef.current = gridBodyRef.current?.scrollLeft ?? nextLeft
      setScrollLeft(scrollLeftRef.current)
    })
  }, [activeDimId, activeLaneFilterId, colorDimId])

  const returnToDependencyResolveSnapshot = useCallback(() => {
    if (!dependencyResolveSnapshot) return
    const state = dependencyResolveSnapshot
    const nextActiveDimId = state.group?.activeDimId || ''
    const nextActiveLaneFilterId = state.group?.activeLaneFilterId || ''
    const nextColorDimId = state.color?.colorDimId || ''
    restoringPerspectiveRef.current = nextActiveDimId !== activeDimId || nextActiveLaneFilterId !== activeLaneFilterId
    restoringColorRef.current = nextColorDimId !== colorDimId

    if (state.spacing) setSpacing({ ...DEFAULT_SPACING, ...state.spacing })
    if (TIME_ZOOM_BY_VALUE[state.timeZoom]) setTimeZoom(state.timeZoom)
    if (state.axisMode) setAxisMode(state.axisMode)
    if (typeof state.showDepLabels === 'boolean') setShowDepLabels(state.showDepLabels)
    if (typeof state.showDeps === 'boolean') setShowDeps(state.showDeps)
    if (typeof state.hideCrossCatDeps === 'boolean') setHideCrossCatDeps(state.hideCrossCatDeps)
    if (typeof state.showCrucialDepsOnly === 'boolean') setShowCrucialDepsOnly(state.showCrucialDepsOnly)
    if (typeof state.colorDependencyDirection === 'boolean') setColorDependencyDirection(state.colorDependencyDirection)
    if (typeof state.leftPanelWidth === 'number') setLeftPanelWidth(Math.max(120, Math.min(600, state.leftPanelWidth)))

    setActiveDimId(nextActiveDimId)
    setActiveLaneFilterId(nextActiveLaneFilterId)
    setHiddenCatIds(new Set(Array.isArray(state.collapsedCategories) ? state.collapsedCategories : []))
    setHiddenNotesByLane(Object.fromEntries(
      Object.entries(state.hiddenNotesByLane ?? {}).map(([laneKey, ids]) => [laneKey, new Set(Array.isArray(ids) ? ids : [])])
    ))
    setVisibleNoteFilterIds(new Set(Array.isArray(state.visibleNoteFilterIds) ? state.visibleNoteFilterIds : []))

    setColorDimId(nextColorDimId)
    setActiveFilterIds(Array.isArray(state.color?.activeFilterIds) ? state.color.activeFilterIds : [])
    setQuickFilters(Array.isArray(state.color?.quickFilters) ? state.color.quickFilters : [])
    setPaintCat(null)
    setRevealedConflictNoteIds(new Set())
    setSelectedIds(new Set(Array.isArray(state.selection?.milestoneIds) ? state.selection.milestoneIds : []))
    setSelectedDepIds(new Set(Array.isArray(state.selection?.dependencyIds) ? state.selection.dependencyIds : []))
    setActivePerspectiveId(state.activePerspectiveId ?? activePerspectiveId)
    setPendingDependencyResolveIds(new Set())
    setDependencyResolveSnapshot(null)

    requestAnimationFrame(() => {
      const nextLeft = Math.max(0, Number(state.scrollLeft) || 0)
      if (gridBodyRef.current) gridBodyRef.current.scrollLeft = nextLeft
      scrollLeftRef.current = gridBodyRef.current?.scrollLeft ?? nextLeft
      setScrollLeft(scrollLeftRef.current)
    })
  }, [activeDimId, activeLaneFilterId, activePerspectiveId, colorDimId, dependencyResolveSnapshot])

  const createPerspective = useCallback(async name => {
    try {
      const created = normalizePerspective(await api.createSchedulePerspective({ name, state: capturePerspectiveState() }))
      setPerspectives(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      setActivePerspectiveId(created.id)
    } catch (err) { console.error(err) }
  }, [capturePerspectiveState])

  const updatePerspectiveSnapshot = useCallback(async perspectiveId => {
    if (perspectiveId === NONE_PERSPECTIVE_ID) return
    const current = perspectives.find(p => p.id === perspectiveId)
    if (!current) return
    try {
      const saved = normalizePerspective(await api.updateSchedulePerspective(perspectiveId, { state: capturePerspectiveState() }))
      setPerspectives(prev => prev.map(p => p.id === saved.id ? saved : p))
      setActivePerspectiveId(saved.id)
    } catch (err) { console.error(err) }
  }, [capturePerspectiveState, perspectives])

  const renamePerspective = useCallback(async (perspectiveId, name) => {
    if (perspectiveId === NONE_PERSPECTIVE_ID) return
    try {
      const saved = normalizePerspective(await api.updateSchedulePerspective(perspectiveId, { name }))
      setPerspectives(prev => prev.map(p => p.id === saved.id ? saved : p).sort((a, b) => a.name.localeCompare(b.name)))
    } catch (err) { console.error(err) }
  }, [])

  const deletePerspective = useCallback(async perspectiveId => {
    if (perspectiveId === NONE_PERSPECTIVE_ID) return
    try {
      await api.deleteSchedulePerspective(perspectiveId)
      setPerspectives(prev => prev.filter(p => p.id !== perspectiveId))
      if (activePerspectiveId === perspectiveId) applyPerspective(nonePerspective)
      setDefaultPerspectiveId(prev => {
        if (prev !== perspectiveId) return prev
        try { window.localStorage.setItem(SCHEDULE_DEFAULT_PERSPECTIVE_KEY, NONE_PERSPECTIVE_ID) } catch {}
        return NONE_PERSPECTIVE_ID
      })
    } catch (err) { console.error(err) }
  }, [activePerspectiveId, applyPerspective, nonePerspective])

  const setScheduleDefaultPerspective = useCallback(perspectiveId => {
    const nextId = perspectiveId || NONE_PERSPECTIVE_ID
    setDefaultPerspectiveId(nextId)
    try { window.localStorage.setItem(SCHEDULE_DEFAULT_PERSPECTIVE_KEY, nextId) } catch {}
  }, [])

  useEffect(() => {
    if (!isActive) {
      appliedDefaultRef.current = false
      return
    }
    if (appliedDefaultRef.current || dimensions.length === 0) return
    const defaultPerspective = perspectiveOptions.find(p => p.id === defaultPerspectiveId) ?? nonePerspective
    appliedDefaultRef.current = true
    applyPerspective(defaultPerspective)
  }, [applyPerspective, defaultPerspectiveId, dimensions.length, isActive, nonePerspective, perspectiveOptions])

  const handlePanelResizeStart = useCallback(e => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startW = leftPanelWidthRef.current
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = mv => {
      const next = Math.max(120, Math.min(600, startW + mv.clientX - startX))
      leftPanelWidthRef.current = next
      setLeftPanelWidth(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // ── Milestone mouse-down (move / resize) ───────────────────────────────────
  const handleMilestoneMouseDown = useCallback((e, milestoneId, side) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setContextMenu(null)
    setSelectedDepIds(new Set())
    if (modeRef.current === 'dependency') return  // handled by dependency port dragging

    if (side) {
      startResizeDrag(e.clientX, milestoneId, side)
      return
    }

    const alreadySelected = selectedIdsRef.current.has(milestoneId)
    let idsToMove
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd: toggle this milestone in/out of the existing selection
      const next = new Set(selectedIdsRef.current)
      if (alreadySelected) next.delete(milestoneId)
      else next.add(milestoneId)
      idsToMove = [...next]
    } else {
      idsToMove = alreadySelected ? [...selectedIdsRef.current] : [milestoneId]
    }

    const originals = {}
    idsToMove.forEach(id => {
      const m = milestonesRef.current.find(m => m.id === id)
      if (m) originals[id] = { startCol: m.startCol, duration: m.duration }
    })
    startMoveDrag(e.clientX, originals)
    setSelectedIds(new Set(idsToMove))
  }, []) // eslint-disable-line

  // ── Grid mouse-down (marquee / deselect) ──────────────────────────────────
  const handleGridMouseDown = useCallback(e => {
    if (e.button === 1 && e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
      const el = gridBodyRef.current
      if (!el) return
      const startX = e.clientX
      const startScrollLeft = el.scrollLeft
      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'
      const onMove = mv => {
        el.scrollLeft = Math.max(0, startScrollLeft - (mv.clientX - startX))
      }
      const onUp = up => {
        up.preventDefault()
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      return
    }
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
  const endCol   = Math.min(totalCols, Math.ceil((scrollLeft + vpSize.w) / colW) + COL_BUF)
  const visCols  = Array.from({ length: Math.max(0, endCol - startCol) }, (_, i) => startCol + i)
  const visibleMonthSegments = ['minutes', 'hours', 'days', 'weeks'].includes(timeZoom) ? buildAxisSegments(
    visCols,
    col => minuteToDate(zoomColToMinute(col, timeZoom)),
    date => `${date.getFullYear()}-${date.getMonth()}`,
    date => `${MONTH_ABR[date.getMonth()]} ${date.getFullYear()}`
  ) : timeZoom === 'months' ? buildColSegments(
    visCols,
    col => Math.floor(col / 12),
    col => `Year ${Math.floor(col / 12) + 1}`
  ) : null
  const visibleWeekSegments = ['minutes', 'hours', 'days'].includes(timeZoom) ? buildAxisSegments(
    visCols,
    col => minuteToDate(zoomColToMinute(col, timeZoom)),
    date => {
      const { week, year } = isoWeekInfo(date)
      return `${year}-${week}`
    },
    date => `KW ${isoWeekInfo(date).week}`
  ) : timeZoom === 'weeks' ? buildColSegments(
    visCols,
    col => Math.floor(col / 4),
    col => `Mo ${Math.floor(col / 4) + 1}`
  ) : null

  const bufH    = ROW_BUF * rowH
  const visItems = rowItems.filter(r => r.top + r.height >= scrollTop - bufH && r.top <= scrollTop + vpSize.h + bufH)

  // Milestones: filter to visible columns + rows + always include dragged
  const draggedIds = dragRef.current?.type === 'move'
    ? new Set(Object.keys(dragRef.current?.originals || {}))
    : new Set()

  const visMilestones = milestones.filter(m => {
    if (draggedIds.has(m.id)) return true
    const visual = getVisualRange(m, timeZoom)
    if (visual.endCol < startCol || visual.startCol > endCol) return false
    const row = noteRowMap[m.noteId]; if (!row) return false
    return row.top + row.height >= scrollTop - bufH && row.top <= scrollTop + vpSize.h + bufH
  })

  const inLaneMode = Boolean(activeDimId) || Boolean(activeLaneFilter)

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className={`${styles.note} ${paintCat ? styles.paintMode : ''}`}
      style={paintCat ? { cursor: makeColorCursor(paintCat.color) } : undefined}
      onClick={paintCat ? () => setPaintCat(null) : undefined}>
      <GanttToolbar
        dimensions={dimensions} activeDimId={activeDimId}
        activeCategories={activeCategories}
        hiddenCatIds={hiddenCatIds}
        onToggleCategory={toggleCategoryVisibility}
        onShowAllCategories={showAllCategories}
        savedFilters={savedFilters}
        activeLaneFilterId={activeLaneFilterId}
        onLaneGroupChange={handleLaneGroupChange}
        canDeleteSelection={selectedIds.size > 0 || selectedDepIds.size > 0}
        onDeleteSelection={handleRequestDeleteSelection}
        canFilterToSelection={selectedIds.size > 0}
        onFilterToSelectedNotes={filterToSelectedNotes}
        onExpandEverything={expandEverything}
        canUndo={transactionHistory.undo.length > 0}
        canRedo={transactionHistory.redo.length > 0}
        onUndo={undoGanttTransaction}
        onRedo={redoGanttTransaction}
        spacing={spacing} onSpacingChange={handleSpacingChange}
        mode={mode} onModeChange={setMode}
        axisMode={axisMode} onAxisModeChange={setAxisMode}
        timeZoom={timeZoom} onTimeZoomChange={handleTimeZoomChange}
        showDepLabels={showDepLabels} onShowDepLabelsChange={setShowDepLabels}
        showDeps={showDeps} onShowDepsChange={setShowDeps}
        hideCrossCatDeps={hideCrossCatDeps} onHideCrossCatDepsChange={setHideCrossCatDeps}
        showCrucialDepsOnly={showCrucialDepsOnly} onShowCrucialDepsOnlyChange={setShowCrucialDepsOnly}
        colorDependencyDirection={colorDependencyDirection} onColorDependencyDirectionChange={setColorDependencyDirection}
        autoResolveDependencyView={autoResolveDependencyView}
        onAutoResolveDependencyViewChange={setAutoResolveDependencyView}
        warningSettings={warningSettings}
        onWarningSettingsChange={updateWarningSettings}
      />

      <div className={styles.canvasRow}>

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div className={styles.leftPanel} style={{ width: leftPanelWidth }}>
          <div className={styles.panelResizeHandle} onMouseDown={handlePanelResizeStart} />
          <div className={styles.corner} />
          <div className={styles.leftBodyClip}>
            <div ref={leftBodyInnerRef} className={styles.leftBodyInner} style={{ height: totalContentH }}>
              {visItems.map((item, idx) => {
                if (item.type === 'lane-gap')
                  return <div key={`lg-${idx}`} className={styles.laneGap} style={{ top: item.top, height: item.height }} />
                if (item.type === 'lane-header') {
                  const lhCatKey = item.cat?.id ?? UNASSIGNED_LANE
                  const lhIsOver = dragOverLaneCatId === lhCatKey
                  const lhReorderOver = dragOverCatReorderId === lhCatKey
                  const lhLaneNotes = notesForLane(item.cat)
                  const lhHiddenIds = hiddenNotesByLane[lhCatKey] ?? new Set()
                  const lhVisibleCount = lhLaneNotes.filter(g => !lhHiddenIds.has(g.id)).length
                  return (
                    <div key={`lh-${item.cat?.id ?? 'none'}`}
                      className={[
                        styles.laneHdr,
                        lhIsOver && styles.laneHdrDropTarget,
                        lhReorderOver && styles.laneHdrReorderTarget,
                      ].filter(Boolean).join(' ')}
                      style={{ top: item.top, height: item.height, borderLeftColor: item.cat?.color ?? '#bbb', background: item.cat ? `${item.cat.color}18` : '#f3f3f3' }}
                      draggable={Boolean(item.cat && activeDimId)}
                      onDragStart={e => {
                        if (!item.cat || !activeDimId) return
                        e.dataTransfer.setData('schedule-cat-id', item.cat.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDraggingCatId(item.cat.id)
                      }}
                      onDragEnd={() => { setDraggingCatId(null); setDragOverCatReorderId(null) }}
                      onDragOver={e => {
                        if (!activeDimId) return
                        if (e.dataTransfer.types.includes('schedule-cat-id')) {
                          e.preventDefault()
                          if (item.cat) { setDragOverCatReorderId(lhCatKey); setDragOverLaneCatId(null) }
                        } else if (e.dataTransfer.types.includes('schedule-note-id')) {
                          e.preventDefault()
                          setDragOverLaneCatId(lhCatKey); setDragOverNoteId(null); setDragOverCatReorderId(null)
                        }
                      }}
                      onDragLeave={e => {
                        if (!e.currentTarget.contains(e.relatedTarget)) {
                          setDragOverLaneCatId(null)
                          setDragOverCatReorderId(null)
                        }
                      }}
                      onDrop={e => {
                        e.preventDefault()
                        const catId = e.dataTransfer.getData('schedule-cat-id')
                        const noteId = e.dataTransfer.getData('schedule-note-id')
                        setDragOverLaneCatId(null)
                        setDragOverCatReorderId(null)
                        if (catId && item.cat) reorderCategoryInGantt(catId, item.cat.id)
                        else if (noteId) moveNoteToLane(noteId, item.cat?.id ?? null)
                      }}>
                      <span
                        className={styles.laneHdrName}
                        onDoubleClick={e => {
                          e.stopPropagation()
                          if (lhVisibleCount > 0) {
                            hideAllLaneNotes(lhCatKey, lhLaneNotes.map(g => g.id))
                          } else {
                            showAllLaneNotes(lhCatKey)
                          }
                        }}>
                        {item.cat?.name ?? 'Unassigned'}
                      </span>
                      <LaneNoteFilter
                        laneKey={laneKeyForCat(item.cat)}
                        notes={notesForLane(item.cat)}
                        hiddenNoteIds={hiddenNotesByLane[laneKeyForCat(item.cat)] ?? new Set()}
                        onToggleNote={toggleNoteVisibility}
                        onShowAllNotes={showAllLaneNotes}
                        onHideAllNotes={hideAllLaneNotes}
                      />
                      <button
                        className={styles.laneCollapseBtn}
                        title="Hide category"
                        onClick={() => toggleCategoryVisibility(item.cat?.id ?? UNASSIGNED_LANE)}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M19 13H5v-2h14v2z"/>
                        </svg>
                      </button>
                    </div>
                  )
                }
                if (item.type === 'note')
                  return (
                    <div key={item.note.id}
                      className={[
                        inLaneMode ? styles.noteRowLane : styles.noteRow,
                        dragOverNoteId === item.note.id && styles.noteRowDropTarget,
                        isNoteHighlighted(item.note.id) && styles.noteRowHighlight,
                      ].filter(Boolean).join(' ')}
                      draggable={Boolean(activeDimId) && !paintCat}
                      onDragStart={e => {
                        if (paintCat || !activeDimId) return
                        e.dataTransfer.setData('schedule-note-id', item.note.id)
                        e.dataTransfer.setData('schedule-note-cat', item.cat?.id ?? '')
                        e.dataTransfer.effectAllowed = 'move'
                        // Ghost must be in the viewport for browsers to render it at full opacity
                        const el = e.currentTarget
                        const r = el.getBoundingClientRect()
                        const ghost = el.cloneNode(true)
                        Object.assign(ghost.style, {
                          position: 'fixed', left: r.left + 'px', top: r.top + 'px',
                          width: r.width + 'px', margin: '0',
                          opacity: '1', pointerEvents: 'none', zIndex: '9999',
                        })
                        document.body.appendChild(ghost)
                        e.dataTransfer.setDragImage(ghost, e.nativeEvent.offsetX ?? 0, e.nativeEvent.offsetY ?? 0)
                        setTimeout(() => ghost.remove(), 0)
                      }}
                      onDragOver={e => {
                        if (!activeDimId || !e.dataTransfer.types.includes('schedule-note-id')) return
                        e.preventDefault()
                        setDragOverNoteId(item.note.id)
                        setDragOverLaneCatId(null)
                      }}
                      onDragLeave={() => setDragOverNoteId(prev => prev === item.note.id ? null : prev)}
                      onDrop={e => {
                        const dragNoteId = e.dataTransfer.getData('schedule-note-id')
                        const dragCat = e.dataTransfer.getData('schedule-note-cat')
                        setDragOverNoteId(null)
                        if (!dragNoteId) return
                        const targetCatId = item.cat?.id ?? null
                        const sourceCatId = dragCat || null
                        if (sourceCatId !== targetCatId) {
                          moveNoteToLane(dragNoteId, targetCatId)
                        } else {
                          reorderNoteInLane(dragNoteId, item.note.id)
                        }
                      }}
                      onDragEnd={() => setDragOverNoteId(null)}
                      onClick={paintCat ? e => {
                        e.stopPropagation()
                        paintNote(item.note.id)
                      } : undefined}
                      onDoubleClick={e => {
                        e.stopPropagation()
                        if (paintCat) return
                        onNoteOpen?.(item.note.id)
                      }}
                      style={{ top: item.top, height: item.height, borderLeftColor: item.cat?.color ?? 'transparent' }}>
                      <span
                        className={`${styles.noteTitle} ${paintCat ? styles.paintTarget : ''}`}
                        title={paintCat ? 'Apply selected category' : undefined}
                        onClick={paintCat ? undefined : e => {
                          e.stopPropagation()
                          setClickedNoteId(prev => prev === item.note.id ? null : item.note.id)
                        }}>
                        {item.note.title}
                      </span>
                      {!paintCat && (() => {
                        const c = getNoteColor(item.note.id)
                        return c ? <span className={styles.noteColorCorner} style={{ borderTopColor: c }} /> : null
                      })()}
                      {!paintCat && (
                        <button
                          className={styles.noteEyeBtn}
                          title="Hide note"
                          onClick={e => {
                            e.stopPropagation()
                            toggleNoteVisibility(laneKeyForCat(item.cat), item.note.id)
                          }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                            <circle cx="12" cy="12" r="3"/>
                          </svg>
                        </button>
                      )}
                    </div>
                  )
                return (
                  <div key={`em-${idx}`}
                    className={`${styles.emptyRow} ${dragOverLaneCatId === (item.cat?.id ?? UNASSIGNED_LANE) ? styles.laneHdrDropTarget : ''}`}
                    style={{ top: item.top, height: item.height }}
                    onDragOver={e => {
                      if (!activeDimId || !e.dataTransfer.types.includes('schedule-note-id')) return
                      e.preventDefault()
                      setDragOverLaneCatId(item.cat?.id ?? UNASSIGNED_LANE)
                      setDragOverNoteId(null)
                    }}
                    onDragLeave={e => {
                      if (!e.currentTarget.contains(e.relatedTarget)) setDragOverLaneCatId(null)
                    }}
                    onDrop={e => {
                      e.preventDefault()
                      const noteId = e.dataTransfer.getData('schedule-note-id')
                      setDragOverLaneCatId(null)
                      if (noteId) moveNoteToLane(noteId, item.cat?.id ?? null)
                    }}
                  />
                )
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
          onDoubleClick={handleGridDoubleClick}
          onAuxClick={e => { if (e.button === 1 && e.ctrlKey) e.preventDefault() }}
          onContextMenu={handleContextMenu}>

          <div ref={gridInnerRef} className={styles.gridInner}
            style={{ width: totalCols * colW, height: totalContentH + HEADER_H, '--col-w': `${colW}px` }}>

            {/* Sticky time axis */}
            <div className={styles.timeAxis}>
              {axisMode === 'full' && (<>
                {visibleMonthSegments && (
                  <div className={styles.monthBand}>
                    {visibleMonthSegments.map(segment => (
                      <div key={segment.key}
                        className={styles.monthSegment}
                        style={{ left: segment.startCol * colW, width: (segment.endCol - segment.startCol) * colW }}>
                        {segment.label}
                      </div>
                    ))}
                  </div>
                )}
                {visibleWeekSegments && (
                  <div className={styles.weekBand}>
                    {visibleWeekSegments.map(segment => (
                      <div key={segment.key}
                        className={styles.weekSegment}
                        style={{ left: segment.startCol * colW, width: (segment.endCol - segment.startCol) * colW }}>
                        {segment.label}
                      </div>
                    ))}
                  </div>
                )}
                {visCols.map(ci => {
                  const isToday = ci === 0
                  const date = minuteToDate(zoomColToMinute(ci, timeZoom))
                  const isWeekend = timeZoom === 'days' && (() => { const dow = date.getDay(); return dow === 0 || dow === 6 })()
                  return (
                    <div key={ci}
                      className={[styles.dayHeader, isToday && styles.dayHeaderToday, isWeekend && !isToday && styles.dayHeaderWeekend].filter(Boolean).join(' ')}
                      style={{ left: ci * colW, width: colW }}>
                      <span className={[styles.dayNum, isToday && styles.dayNumToday].filter(Boolean).join(' ')}>
                        {timeZoom === 'days' ? date.getDate() : zoomColToLabel(ci, timeZoom)}
                      </span>
                    </div>
                  )
                })}
              </>)}
              {axisMode === 'numbers' && (
                visCols.map(ci => (
                  <div key={ci}
                    className={[styles.dayHeader, styles.dayHeaderNumbers, ci === 0 && styles.dayHeaderToday].filter(Boolean).join(' ')}
                    style={{ left: ci * colW, width: colW }}>
                    <span className={[styles.dayNum, ci === 0 && styles.dayNumToday].filter(Boolean).join(' ')}>
                      {ci + 1}
                    </span>
                  </div>
                ))
              )}
            </div>

            {/* Today + weekend column tints */}
            <div className={styles.todayCol} style={{ left: 0, width: colW }} />
            {timeZoom === 'days' && visCols.map(ci => {
              const dow = minuteToDate(zoomColToMinute(ci, timeZoom)).getDay()
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
                  style={{
                    top: HEADER_H + item.top,
                    height: item.height,
                    background: item.cat ? `${item.cat.color}24` : 'rgba(0,0,0,0.05)',
                  }} />
              if (item.type === 'note')
                return <div key={`gr-${item.note.id}`}
                  className={`${styles.gridNoteRow} ${isNoteHighlighted(item.note.id) ? styles.gridNoteRowHighlight : ''}`}
                  style={{ top: HEADER_H + item.top, height: item.height }} />
              return null
            })}

            {/* Hard deadline markers */}
            {deadlines.map(dl => {
              const row = noteRowMap[dl.noteId]; if (!row) return null
              const visualCol = minuteToZoomCol(dl.col, timeZoom)
              const hatchLeft  = visualCol * colW
              const hatchWidth = Math.max(0, totalCols - visualCol) * colW
              return hatchWidth > 0 ? (
                <div key={`dl-${dl.noteId}`} className={styles.deadlineHatch}
                  style={{ left: hatchLeft, top: HEADER_H + row.top, width: hatchWidth, height: row.height }} />
              ) : null
            })}

            {/* Milestones */}
            {visMilestones.map(m => {
              const row = noteRowMap[m.noteId]; if (!row) return null
              const visual = getVisualRange(m, timeZoom)
              const isSelected    = selectedIds.has(m.id)
              const isViolating   = violationIds.has(m.id)
              const isBlinking    = blinkingMilestoneIds.has(m.id)
              const isDepMode     = mode === 'dependency'
              const isSource      = drawingState?.fromId === m.id
              const msColor       = getMilestoneColor(m)
              const isUnassigned  = msColor === null
              return (
                <div key={m.id}
                  data-ms-id={m.id}
                  ref={el => { el ? milestoneElsRef.current.set(m.id, el) : milestoneElsRef.current.delete(m.id) }}
                  className={[
                    styles.milestone,
                    isSelected   && styles.milestoneSelected,
                    isViolating  && styles.milestoneViolation,
                    isBlinking   && styles.milestoneBlink,
                    isDepMode    && styles.milestoneDepMode,
                    isUnassigned && styles.milestoneUnassigned,
                  ].filter(Boolean).join(' ')}
                  style={{
                    left:       visual.startCol * colW,
                    top:        HEADER_H + row.top + msY,
                    width:      visual.duration * colW,
                    height:     msH,
                    background: msColor ?? '#fff',
                  }}
                  onMouseDown={e => {
                    if (paintCat) {
                      e.preventDefault()
                      e.stopPropagation()
                      return
                    }
                    if (isDepMode) {
                      startDependencyDrag(e, m.id)
                      return
                    }
                    handleMilestoneMouseDown(e, m.id, null)
                  }}
                  onClick={paintCat ? e => {
                    e.stopPropagation()
                    paintNote(m.noteId)
                  } : undefined}
                  onContextMenu={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (paintCat) return
                    const note = notes.find(g => g.id === m.noteId)
                    const label = `${note?.title ?? 'Milestone'} · ${m.title || minuteToLabel(m.startCol, timeZoom)}`
                    setContextMenu({ type: 'milestone', x: e.clientX, y: e.clientY, milestoneId: m.id, label })
                  }}>
                  <div
                    className={[styles.msHandle, isDepMode && styles.depHandle, isDepMode && isSource && styles.depHandleSource].filter(Boolean).join(' ')}
                    data-ms-id={m.id}
                    data-dep-port={isDepMode ? 'true' : undefined}
                    data-dep-side={isDepMode ? 'left' : undefined}
                    onMouseDown={e => {
                      e.stopPropagation()
                      if (paintCat) return
                      if (isDepMode) startDependencyDrag(e, m.id)
                      else handleMilestoneMouseDown(e, m.id, 'left')
                    }} />
                  <span className={styles.msLabel}>{m.title || minuteToLabel(m.startCol, timeZoom)}</span>
                  <div
                    className={[styles.msHandle, styles.msHandleRight, isDepMode && styles.depHandle, isDepMode && isSource && styles.depHandleSource].filter(Boolean).join(' ')}
                    data-ms-id={m.id}
                    data-dep-port={isDepMode ? 'true' : undefined}
                    data-dep-side={isDepMode ? 'right' : undefined}
                    onMouseDown={e => {
                      e.stopPropagation()
                      if (paintCat) return
                      if (isDepMode) startDependencyDrag(e, m.id)
                      else handleMilestoneMouseDown(e, m.id, 'right')
                    }} />
                </div>
              )
            })}

            {/* Dependency arrows SVG — pointer-events none on container, individual paths can override */}
            <svg className={styles.depSvg}
              style={{ width: totalCols * colW, height: totalContentH + HEADER_H }}>
              {showDeps && dependencies.map(dep => {
                if (showCrucialDepsOnly && !crucialDependencyIds.has(dep.id)) return null
                const from = milestones.find(m => m.id === dep.fromId)
                const to   = milestones.find(m => m.id === dep.toId)
                if (!from || !to) return null
                const fromRow = noteRowMap[from.noteId]; const toRow = noteRowMap[to.noteId]
                if (!fromRow || !toRow) return null
                if (hideCrossCatDeps && activeDimId) {
                  const fromCat = assignments[from.noteId]?.[activeDimId] ?? null
                  const toCat   = assignments[to.noteId]?.[activeDimId] ?? null
                  if (fromCat !== toCat) return null
                }
                const fromVisual = getVisualRange(from, timeZoom)
                const toVisual = getVisualRange(to, timeZoom)
                const x1 = fromVisual.endCol * colW
                const y1 = HEADER_H + fromRow.top + Math.floor(fromRow.height / 2)
                const x2 = toVisual.startCol * colW
                const y2 = HEADER_H + toRow.top + Math.floor(toRow.height / 2)
                const cp = Math.max(40, Math.abs(x2 - x1) * 0.45)
                const isViol = violationIds.has(dep.toId)
                const isSelected = selectedDepIds.has(dep.id)
                const isBlinking = blinkingDepIds.has(dep.id)
                const isOutgoingFromSelection = selectedIds.has(dep.fromId)
                const isIncomingToSelection = selectedIds.has(dep.toId)
                const depColor = isViol
                  ? '#ef4444'
                  : colorDependencyDirection && isOutgoingFromSelection
                    ? '#16a34a'
                    : colorDependencyDirection && isIncomingToSelection
                      ? '#dc2626'
                      : '#555'
                const fromNote = notes.find(g => g.id === from.noteId)
                const toNote   = notes.find(g => g.id === to.noteId)
                const pathD = `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`
                const inDepMode = mode === 'dependency'
                const labelPathId = `dep-label-path-${dep.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
                const labelPreview = dependencyLabelPreview(dep.reason)
                return (
                  <g key={dep.id}>
                    {/* Invisible fat path — only active in dependency mode for selecting / editing deps */}
                    {inDepMode && (
                      <path
                        d={pathD}
                        stroke="#000" strokeOpacity="0" strokeWidth="16" fill="none"
                        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                        onMouseDown={e => {
                          e.stopPropagation()
                          setSelectedIds(new Set())
                          setSelectedDepIds(prev => {
                            const next = new Set(e.shiftKey ? prev : [])
                            if (next.has(dep.id)) next.delete(dep.id)
                            else next.add(dep.id)
                            return next
                          })
                        }}
                        onDoubleClick={e => {
                          e.stopPropagation()
                          setReasonDraft(dep.reason || '')
                          setReasonModal({ depId: dep.id })
                        }}
                        onContextMenu={e => {
                          e.preventDefault()
                          e.stopPropagation()
                          const label = `${fromNote?.title ?? '?'} → ${toNote?.title ?? '?'}`
                          setContextMenu({ type: 'dep', x: e.clientX, y: e.clientY, depId: dep.id, label, reason: dep.reason ?? '' })
                        }}
                      />
                    )}
                    {/* Visual path — pointer-events none, purely decorative */}
                    <path
                      id={labelPathId}
                      ref={el => { el ? depPathElsRef.current.set(dep.id, el) : depPathElsRef.current.delete(dep.id) }}
                      className={[
                        styles.depPath,
                        isSelected && styles.depPathSelected,
                        isBlinking && styles.depPathBlink,
                      ].filter(Boolean).join(' ')}
                      d={pathD}
                      stroke={depColor} strokeWidth="1.5" fill="none"
                      strokeOpacity="0.8"
                      style={{ pointerEvents: 'none' }}
                    />
                    {showDepLabels && dep.reason && (
                      <text className={styles.depLabel} dy="-5">
                        <title>{dep.reason}</title>
                        <textPath href={`#${labelPathId}`} startOffset="50%" textAnchor="middle">
                          {labelPreview}
                        </textPath>
                      </text>
                    )}
                  </g>
                )
              })}
              {/* Live preview arrow while drawing */}
              <path ref={previewArrowRef} className={styles.depPreviewPath} style={{ display: 'none' }}
                stroke="#333" strokeWidth="1.5" fill="none"
                strokeDasharray="5,3" strokeOpacity="0.9" />
            </svg>

            {/* Marquee selection rect */}
            <div ref={marqueeRef} className={styles.marqueeRect} />

            {/* Hover highlight */}
            <div ref={highlightRef} className={styles.cellHighlight} />

          </div>
        </div>

      </div>

      <div className={styles.floatingViewTools}>
        {dependencyResolveSnapshot && (
          <button
            type="button"
            className={styles.dependencyResolveReturnBtn}
            onClick={returnToDependencyResolveSnapshot}
          >
            <strong>Dependency resolving</strong>
            <span>Return to previous view</span>
          </button>
        )}
        <PerspectiveMenu
          perspectives={perspectiveOptions}
          activePerspectiveId={activePerspectiveId}
          defaultPerspectiveId={defaultPerspectiveId}
          open={floatingPanel === 'perspective'}
          onOpenChange={open => setFloatingPanel(open ? 'perspective' : null)}
          onApply={applyPerspective}
          onCreate={createPerspective}
          onUpdate={updatePerspectiveSnapshot}
          onRename={renamePerspective}
          onDelete={deletePerspective}
          onSetDefault={setScheduleDefaultPerspective}
        />
        <ScheduleColorLegendWidget
          dimensions={colorDimensions}
          categories={colorCategories}
          colorDimId={colorDimId}
          onColorDimChange={setColorDimId}
          activeFilterIds={activeFilterIds}
          onToggleSavedFilter={toggleSavedFilter}
          quickFilters={quickFilters}
          onToggleQuickFilter={toggleQuickFilter}
          onEditFilter={filterId => setEditingFilter(savedFilters.find(filter => filter.id === filterId))}
          paintCat={paintCat}
          onPaintActivate={activatePaint}
          expanded={floatingPanel === 'color'}
          onExpandedChange={open => setFloatingPanel(open ? 'color' : null)}
        />
      </div>

      <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)}
        onCreate={handleCreateMilestone}
        onInsertTimeUnit={handleInsertTimeUnit}
        onDeleteTimeUnit={handleDeleteTimeUnit}
        onSetDeadline={handleSetDeadline}
        onRemoveDeadline={handleRemoveDeadline}
        onDeleteMilestone={handleDeleteMilestoneRequest}
        onEditDepReason={handleEditDepReason}
        onDeleteDep={handleDeleteDepRequest} />

      {warningPrompt && (
        <div className={styles.warningPrompt} role="alertdialog" aria-modal="true">
          <div className={styles.warningPromptTitle}>{warningPrompt.title ?? 'Dependency warning'}</div>
          <div className={styles.warningPromptText}>
            {warningPrompt.message ??
              `This change would make ${warningPrompt.count} milestone${warningPrompt.count === 1 ? '' : 's'} violate dependency timing.`}
          </div>
          <div className={styles.warningPromptActions}>
            <button className={warningPrompt.actions === 'confirm' ? styles.warningSafeBtn : styles.warningUndoBtn} autoFocus={warningPrompt.actions === 'confirm'} onClick={() => {
              if (warningPrompt.actions === 'dependency') resolveDependencySelection()
              else clearWarningPrompt()
            }}>
              {warningPrompt.actions === 'dependency' ? 'Resolve dependency' : 'Close'}
            </button>
            {warningPrompt.actions === 'confirm' && (
              <button className={styles.warningDangerBtn} onClick={async () => {
                const action = warningPrompt.onConfirm
                clearWarningPrompt()
                await action?.()
              }}>
                {warningPrompt.confirmLabel || 'Confirm'}
              </button>
            )}
          </div>
        </div>
      )}

      {resizeConfirmDraft && createPortal(
        <div className={styles.deleteModalBackdrop} onMouseDown={() => setResizeConfirmDraft(null)}>
          <div className={styles.deleteModal} role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
            <div className={styles.deleteModalTitle}>Confirm unusual resize</div>
            <div className={styles.deleteModalText}>
              Magnitude level {resizeConfirmDraft.magnitude.toFixed(1)} is very high. This is probably an accidental or uncautious change: the duration would move from {formatMinutesDuration(resizeConfirmDraft.originalDuration)} to {formatMinutesDuration(resizeConfirmDraft.nextDuration)}. {resizeConfirmDraft.scaleJump >= 2 ? `It also jumps ${resizeConfirmDraft.scaleJump} natural time scale levels, from ${resizeConfirmDraft.originalScale} level to ${resizeConfirmDraft.nextScale} level. ` : ''}You typically should not have such a high difference in magnitude unless you are deliberately changing the plan scale.
            </div>
            <div className={styles.deleteModalActions}>
              <button className={`${styles.modalSafePrimaryBtn} ${styles.resizeConfirmActionBtn}`} autoFocus onClick={() => setResizeConfirmDraft(null)}>
                Cancel
              </button>
              <button className={`${styles.modalDangerMutedBtn} ${styles.resizeConfirmActionBtn}`} onClick={async () => {
                const action = resizeConfirmDraft.onConfirm
                setResizeConfirmDraft(null)
                await action?.()
              }}>
                Apply resize anyway
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {deleteDraft && createPortal(
        <div className={styles.deleteModalBackdrop} onMouseDown={() => setDeleteDraft(null)}>
          <div className={styles.deleteModal} role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
            <div className={styles.deleteModalTitle}>
              {deleteDraft.items.every(item => item.type === 'dependency') ? 'Delete constraint?' : 'Delete selected items?'}
            </div>
            <div className={styles.deleteModalText}>
              {deleteDraft.items.every(item => item.type === 'dependency') && deleteDraft.items.length > 1
                ? 'Choose which dependency constraints should be deleted.'
                : deleteDraft.items.length === 1
                ? 'This item will be deleted.'
                : 'Choose which selected items should be deleted.'}
            </div>
            <div className={styles.deleteList}>
              {deleteDraft.items.map(item => (
                <label key={item.key} className={styles.deleteItem}>
                  {deleteDraft.items.length > 1 && (
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={() => setDeleteDraft(prev => ({
                        ...prev,
                        items: prev.items.map(candidate =>
                          candidate.key === item.key ? { ...candidate, checked: !candidate.checked } : candidate
                        ),
                      }))}
                    />
                  )}
                  <span className={styles.deleteItemType}>{item.type === 'milestone' ? 'Milestone' : 'Dependency'}</span>
                  <span className={styles.deleteItemLabel}>{item.label}</span>
                </label>
              ))}
            </div>
            <div className={styles.deleteModalActions}>
              <button className={styles.deleteCancelBtn} onClick={() => setDeleteDraft(null)}>Cancel</button>
              <button
                className={styles.deleteConfirmBtn}
                disabled={!deleteDraft.items.some(item => item.checked)}
                onClick={handleConfirmDeleteDraft}>
                Delete
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {editingFilter && (
        <ScheduleFilterEditorModal
          filter={editingFilter}
          dimensions={dimensions}
          categories={categories}
          onSave={saveFilter}
          onDelete={deleteFilter}
          onClose={() => setEditingFilter(null)}
        />
      )}

      {reasonModal && createPortal(
        <div className={styles.deleteModalBackdrop} onMouseDown={() => setReasonModal(null)}>
          <div className={styles.reasonModal} role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
            <div className={styles.deleteModalTitle}>Dependency reason</div>
            <div className={styles.reasonModalSub}>Describe why this dependency exists (optional)</div>
            <textarea
              ref={reasonInputRef}
              className={styles.reasonInput}
              value={reasonDraft}
              onChange={e => setReasonDraft(e.target.value)}
              placeholder="e.g. Phase 2 cannot start until Phase 1 is signed off"
              rows={3}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveDepReason() }
                if (e.key === 'Escape') setReasonModal(null)
              }}
            />
            <div className={styles.deleteModalActions}>
              <button className={styles.deleteDepBtn} onClick={() => {
                const dep = dependencies.find(d => d.id === reasonModal.depId)
                const from = milestones.find(m => m.id === dep?.fromId)
                const to   = milestones.find(m => m.id === dep?.toId)
                const fromNote = notes.find(g => g.id === from?.noteId)
                const toNote   = notes.find(g => g.id === to?.noteId)
                const label = `${fromNote?.title ?? '?'} → ${toNote?.title ?? '?'}`
                setReasonModal(null)
                handleDeleteDepRequest(dep.id, label)
              }}>Delete</button>
              <div style={{ flex: 1 }} />
              <button className={styles.deleteCancelBtn} onClick={() => setReasonModal(null)}>Cancel</button>
              <button className={styles.deleteConfirmBtn} onClick={handleSaveDepReason}>Save</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
