import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import styles from './SchedulePage.module.css'
import { api } from '../api'
import DimensionDropUp from './DimensionDropUp'
import PeopleWidget from './PeopleWidget'
import PersonaAvatarStack from './PersonaAvatarStack'
import { useConfirmDialog } from './ConfirmDialog'
import { usePersonaCursor } from '../hooks/usePersonaCursor'
import { playSound } from '../sounds/sound_registry'

// ── Constants ─────────────────────────────────────────────────────────────────
const HEADER_H     = 64
const LANE_HDR_H   = 30
const TIME_SLOT_H  = 20   // block height in px
const COL_BUF      = 8
const ROW_BUF      = 3
const EXTEND_DELTA = 365  // extra columns added when scrolling to the right edge
const DRAG_AUTOSCROLL_EDGE_PX = 72
const DRAG_AUTOSCROLL_MAX_PX = 28
const WARNING_PROMPT_TIMEOUT_MS = 20000

const DEFAULT_SPACING = { colW: 110, rowH: 36, rowGap: 0, laneGap: 28 }
const COL_WIDTH_MIN = 20
const MINUTE_COL_WIDTH_MIN = 8
const COL_WIDTH_MAX = 250
const INIT_TOTAL_COLS = 60    // initial column count; grows to cover viewport + buffer on mount
const EDGE_COLS       = 5     // columns from right edge before extending

const MONTH_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const FILTER_DIMENSION_ID = '__filters__'
const FILTER_CATEGORY_PREFIX = 'filter:'
const NONE_PERSPECTIVE_ID = '__none__'
const SCHEDULE_DEFAULT_PERSPECTIVE_KEY = 'schedule.defaultPerspectiveId'

const TIME_ZOOM_LEVELS = [
  { value: 'minutes', label: '10 min', short: '10m', unit: 10 },
  { value: 'days', label: 'Days', short: 'd', unit: 60 * 24 },
  { value: 'months', label: 'Months', short: 'mo', unit: 60 * 24 * 30 },
]
const TIME_ZOOM_BY_VALUE = Object.fromEntries(TIME_ZOOM_LEVELS.map(level => [level.value, level]))
const DEFAULT_TIME_ZOOM = 'days'
const ZOOM_ORDER = TIME_ZOOM_LEVELS.map(l => l.value)
const SCALE_VISIBILITY_MODES = {
  HIERARCHY: 'hierarchy',
  ALL: 'all',
}
const TIME_SLOT_LABEL_MODES = [
  { value: 'people', label: 'People' },
  { value: 'date', label: 'Date' },
  { value: 'headline', label: 'Headline' },
]
const SCHEDULE_PERSPECTIVE_VERSION = 2

// Module-level anchor date. When set, col 0 = this date instead of today.
// Updated by SchedulePage whenever the active project changes.
let _timelineAnchor = null

function normalizeTimeZoom(value) {
  if (value === 'hours') return 'minutes'
  if (value === 'weeks') return 'days'
  if (value === 'minute') return 'minutes'
  if (value === 'day') return 'days'
  if (value === 'month') return 'months'
  return TIME_ZOOM_BY_VALUE[value] ? value : DEFAULT_TIME_ZOOM
}

function normalizeTimeSlotLabelMode(value) {
  return TIME_SLOT_LABEL_MODES.some(mode => mode.value === value) ? value : 'date'
}

function getTimeSlotLevel(duration, startCol = null) {
  const d = Math.max(0, Number(duration) || 0)
  if (startCol !== null && isCalendarMonthRange(startCol, d)) return 'months'
  if (d >= 60 * 24 * 30) return 'months'
  if (d >= 60 * 24)      return 'days'
  return 'minutes'
}

function normalizeScaleVisibilityMode(value) {
  if (value === undefined || value === null || value === '') return SCALE_VISIBILITY_MODES.ALL
  if (value === SCALE_VISIBILITY_MODES.ALL || value === 'everything' || value === 'showAll' || value === 'show-all' || value === 'show_all') {
    return SCALE_VISIBILITY_MODES.ALL
  }
  return SCALE_VISIBILITY_MODES.HIERARCHY
}

function persistedPlanningScaleForZoom(timeZoom) {
  const zoom = normalizeTimeZoom(timeZoom)
  if (zoom === 'minutes') return 'minute'
  if (zoom === 'months') return 'month'
  return 'day'
}

function normalizePerspectiveTimeZoom(state = {}) {
  return normalizeTimeZoom(
    state.timeZoom
    ?? state.planningScale
    ?? state.metric
    ?? state.timeScale
    ?? state.scale
  )
}

function normalizeToolbarMode(value) {
  return value === 'dependency' ? 'dependency' : 'timeSlot'
}

function normalizeAxisMode(value) {
  return value === 'numbers' || value === 'none' ? value : 'full'
}

function normalizeSchedulePerspectiveState(rawState = {}) {
  const state = rawState && typeof rawState === 'object' ? rawState : {}
  const timeZoom = normalizePerspectiveTimeZoom(state)
  const visibilityMode = normalizeScaleVisibilityMode(
    state.timeSlotScaleFilter
    ?? state.scaleVisibilityMode
    ?? state.scaleMode
    ?? state.visibilityMode
  )
  const spacing = { ...DEFAULT_SPACING, ...(state.spacing ?? {}) }
  spacing.colW = Math.max(
    minColWidthForZoom(timeZoom),
    Math.min(COL_WIDTH_MAX, Number(spacing.colW) || DEFAULT_SPACING.colW)
  )

  return {
    ...state,
    version: state.version ?? SCHEDULE_PERSPECTIVE_VERSION,
    timeZoom,
    planningScale: persistedPlanningScaleForZoom(timeZoom),
    axisMode: normalizeAxisMode(state.axisMode),
    mode: normalizeToolbarMode(state.mode),
    showDepLabels: typeof state.showDepLabels === 'boolean' ? state.showDepLabels : true,
    showDeps: typeof state.showDeps === 'boolean' ? state.showDeps : true,
    hideCrossCatDeps: typeof state.hideCrossCatDeps === 'boolean' ? state.hideCrossCatDeps : false,
    showCrucialDepsOnly: typeof state.showCrucialDepsOnly === 'boolean' ? state.showCrucialDepsOnly : false,
    colorDependencyDirection: typeof state.colorDependencyDirection === 'boolean' ? state.colorDependencyDirection : false,
    showRowScheduleMarker: typeof state.showRowScheduleMarker === 'boolean' ? state.showRowScheduleMarker : true,
    showRowTimeSlotMeta: typeof state.showRowTimeSlotMeta === 'boolean' ? state.showRowTimeSlotMeta : true,
    timeSlotLabelMode: normalizeTimeSlotLabelMode(state.timeSlotLabelMode),
    timeSlotScaleFilter: visibilityMode,
    scaleVisibilityMode: visibilityMode,
    spacing,
    leftPanelWidth: typeof state.leftPanelWidth === 'number'
      ? Math.max(120, Math.min(600, state.leftPanelWidth))
      : 220,
  }
}

function isTimeSlotVisibleAtZoom(duration, timeZoom, scaleMode = SCALE_VISIBILITY_MODES.HIERARCHY, startCol = null) {
  if (normalizeScaleVisibilityMode(scaleMode) === SCALE_VISIBILITY_MODES.ALL) return true
  const msIdx      = ZOOM_ORDER.indexOf(getTimeSlotLevel(duration, startCol))
  const currentIdx = ZOOM_ORDER.indexOf(timeZoom)
  return msIdx >= currentIdx
}

function isTimeSlotEditableAtZoom(duration, timeZoom, startCol = null) {
  return getTimeSlotLevel(duration, startCol) === normalizeTimeZoom(timeZoom)
}

function scaleLabelForZoom(timeZoom) {
  return TIME_ZOOM_BY_VALUE[normalizeTimeZoom(timeZoom)]?.label ?? 'this scale'
}

function planningScaleForZoom(timeZoom) {
  return durationScaleBucket(getZoomUnit(timeZoom))
}

function minColWidthForZoom(timeZoom) {
  return normalizeTimeZoom(timeZoom) === 'minutes' ? MINUTE_COL_WIDTH_MIN : COL_WIDTH_MIN
}

function getDeadlineLevel(deadline) {
  const scale = deadline?.scale
  if (scale === 'minute' || scale === 'minutes') return 'minutes'
  if (scale === 'day' || scale === 'days') return 'days'
  if (scale === 'month' || scale === 'months') return 'months'
  const col = Number(deadline?.col) || 0
  if (col % (60 * 24 * 30) === 0) return 'months'
  if (col % (60 * 24) === 0) return 'days'
  return 'minutes'
}

function deadlineScaleBucket(deadline) {
  return durationScaleBucket(getZoomUnit(getDeadlineLevel(deadline)))
}

function isDeadlineVisibleAtZoom(deadline, timeZoom, scaleMode = SCALE_VISIBILITY_MODES.HIERARCHY) {
  if (normalizeScaleVisibilityMode(scaleMode) === SCALE_VISIBILITY_MODES.ALL) return true
  const deadlineIdx = ZOOM_ORDER.indexOf(getDeadlineLevel(deadline))
  const currentIdx = ZOOM_ORDER.indexOf(normalizeTimeZoom(timeZoom))
  return deadlineIdx >= currentIdx
}

function deadlineAppliesToTimeSlot(deadline, timeSlot) {
  return deadline && timeSlot && deadlineScaleBucket(deadline) === timeSlotScaleBucket(timeSlot)
}

function getEarliestStartLevel(es) {
  const scale = es?.scale
  if (scale === 'minute' || scale === 'minutes') return 'minutes'
  if (scale === 'day' || scale === 'days') return 'days'
  if (scale === 'month' || scale === 'months') return 'months'
  const col = Number(es?.col) || 0
  if (col % (60 * 24 * 30) === 0) return 'months'
  if (col % (60 * 24) === 0) return 'days'
  return 'minutes'
}

function earliestStartScaleBucket(es) {
  return durationScaleBucket(getZoomUnit(getEarliestStartLevel(es)))
}

function isEarliestStartVisibleAtZoom(es, timeZoom, scaleMode = SCALE_VISIBILITY_MODES.HIERARCHY) {
  if (normalizeScaleVisibilityMode(scaleMode) === SCALE_VISIBILITY_MODES.ALL) return true
  const esIdx = ZOOM_ORDER.indexOf(getEarliestStartLevel(es))
  const currentIdx = ZOOM_ORDER.indexOf(normalizeTimeZoom(timeZoom))
  return esIdx >= currentIdx
}

function earliestStartAppliesToTimeSlot(es, timeSlot) {
  return es && timeSlot && earliestStartScaleBucket(es) === timeSlotScaleBucket(timeSlot)
}

function findApplicableDeadline(deadlines, timeSlot) {
  if (!timeSlot) return null
  return deadlines.find(d => d.noteId === timeSlot.noteId && deadlineAppliesToTimeSlot(d, timeSlot)) ?? null
}

function findApplicableEarliestStart(earliestStarts, timeSlot) {
  if (!timeSlot) return null
  return earliestStarts.find(es => es.noteId === timeSlot.noteId && earliestStartAppliesToTimeSlot(es, timeSlot)) ?? null
}

function noteTimeSlotScaleConflict(timeSlots, noteId, duration, startCol = null) {
  const newScale = durationScaleBucket(duration, startCol)
  return timeSlots.find(m => m.noteId === noteId && timeSlotScaleBucket(m) !== newScale) ?? null
}

const MIN_TIME_SLOT_DURATION = 10
const DEFAULT_MINUTE_TIME_SLOT_DURATION = 60
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

// minute 0 = project start date (or today if no project start is set).
function timelineStartDate() {
  if (_timelineAnchor) return new Date(_timelineAnchor.getTime())
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function minuteToDate(minute) {
  const d = timelineStartDate()
  d.setMinutes(d.getMinutes() + minute)
  return d
}

function addCalendarMonths(date, months) {
  const source = new Date(date)
  const day = source.getDate()
  const target = new Date(source)
  target.setDate(1)
  target.setMonth(target.getMonth() + months)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(day, lastDay))
  return target
}

function minutesBetweenDates(start, end) {
  return Math.round((end.getTime() - start.getTime()) / 60000)
}

function calendarMonthBoundaryMinute(col) {
  const today = timelineStartDate()
  const target = new Date(today.getFullYear(), today.getMonth() + col, 1)
  return minutesBetweenDates(today, target)
}

function calendarMonthColForMinute(minute, mode = 'floor') {
  const value = Math.max(0, Number(minute) || 0)
  let col = Math.max(0, Math.floor(value / (60 * 24 * 30)))
  while (calendarMonthBoundaryMinute(col + 1) <= value) col += 1
  while (col > 0 && calendarMonthBoundaryMinute(col) > value) col -= 1
  if (mode === 'ceil' && calendarMonthBoundaryMinute(col) < value) col += 1
  return col
}

function calendarMonthColForMinuteExact(minute) {
  const value = Math.max(0, Number(minute) || 0)
  const col = calendarMonthColForMinute(value, 'floor')
  const start = calendarMonthBoundaryMinute(col)
  const end = calendarMonthBoundaryMinute(col + 1)
  if (end <= start) return col
  return col + ((value - start) / (end - start))
}

function isCalendarMonthBoundary(minute) {
  const value = Math.max(0, Number(minute) || 0)
  return calendarMonthBoundaryMinute(calendarMonthColForMinute(value, 'floor')) === value
}

function isCalendarMonthRange(startCol, duration) {
  const start = Math.max(0, Number(startCol) || 0)
  const end = start + Math.max(0, Number(duration) || 0)
  return end > start && isCalendarMonthBoundary(start) && isCalendarMonthBoundary(end)
}

function calendarMonthSpanForRange(startCol, duration) {
  if (!isCalendarMonthRange(startCol, duration)) return 1
  return Math.max(1, calendarMonthColForMinute(startCol, 'floor') === calendarMonthColForMinute(startCol + duration, 'floor')
    ? 1
    : calendarMonthColForMinute(startCol + duration, 'floor') - calendarMonthColForMinute(startCol, 'floor'))
}

function calendarMonthDurationFromStart(startCol, span = 1) {
  const startMonthCol = calendarMonthColForMinute(startCol, 'floor')
  return calendarMonthBoundaryMinute(startMonthCol + Math.max(1, span)) - calendarMonthBoundaryMinute(startMonthCol)
}

function defaultDurationForZoom(timeZoom, startCol = 0) {
  const zoom = normalizeTimeZoom(timeZoom)
  if (zoom === 'minutes') return DEFAULT_MINUTE_TIME_SLOT_DURATION
  if (zoom === 'months') return calendarMonthDurationFromStart(startCol, 1)
  return Math.max(MIN_TIME_SLOT_DURATION, getZoomUnit(zoom))
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
  return TIME_ZOOM_BY_VALUE[normalizeTimeZoom(timeZoom)].unit
}

function zoomColToMinute(col, timeZoom) {
  if (normalizeTimeZoom(timeZoom) === 'months') {
    const baseCol = Math.floor(Math.max(0, Number(col) || 0))
    const fraction = Math.max(0, Number(col) || 0) - baseCol
    const start = calendarMonthBoundaryMinute(baseCol)
    const end = calendarMonthBoundaryMinute(baseCol + 1)
    return start + (end - start) * fraction
  }
  return col * getZoomUnit(timeZoom)
}

function minuteToZoomCol(minute, timeZoom) {
  if (normalizeTimeZoom(timeZoom) === 'months') return calendarMonthColForMinute(minute, 'floor')
  return Math.floor(Math.max(0, Number(minute) || 0) / getZoomUnit(timeZoom))
}

function minuteEndToZoomCol(minute, timeZoom) {
  if (normalizeTimeZoom(timeZoom) === 'months') return calendarMonthColForMinute(minute, 'ceil')
  return Math.ceil(Math.max(0, Number(minute) || 0) / getZoomUnit(timeZoom))
}

function minuteToZoomColExact(minute, timeZoom) {
  if (normalizeTimeZoom(timeZoom) === 'months') return calendarMonthColForMinuteExact(minute)
  return Math.max(0, Number(minute) || 0) / getZoomUnit(timeZoom)
}

function getVisualRange(item, timeZoom, proportional = false) {
  const start = Math.max(0, Number(item.startCol) || 0)
  const end = start + Math.max(MIN_TIME_SLOT_DURATION, Number(item.duration) || MIN_TIME_SLOT_DURATION)
  if (proportional) {
    const startCol = minuteToZoomColExact(start, timeZoom)
    const endCol = minuteToZoomColExact(end, timeZoom)
    return { startCol, endCol, duration: Math.max(0, endCol - startCol), proportional: true }
  }
  const startCol = minuteToZoomCol(start, timeZoom)
  const endCol = Math.max(startCol + 1, minuteEndToZoomCol(end, timeZoom))
  return { startCol, endCol, duration: endCol - startCol }
}

function getRenderedVisualRange(item, timeZoom, scaleMode) {
  return getVisualRange(item, timeZoom, normalizeScaleVisibilityMode(scaleMode) === SCALE_VISIBILITY_MODES.ALL)
}

function minuteToLabel(minute, timeZoom) {
  const date = minuteToDate(minute)
  switch (normalizeTimeZoom(timeZoom)) {
    case 'minutes':
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    case 'months':
      return `${MONTH_ABR[date.getMonth()]} ${date.getFullYear()}`
    default:
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
}

function zoomColToLabel(col, timeZoom) {
  return minuteToLabel(zoomColToMinute(col, timeZoom), timeZoom)
}

function axisColumnLabel(col, timeZoom) {
  const date = minuteToDate(zoomColToMinute(col, timeZoom))
  if (timeZoom === 'minutes') return date.getMinutes()
  if (timeZoom === 'days') return date.getDate()
  if (timeZoom === 'months') return MONTH_ABR[date.getMonth()]
  return zoomColToLabel(col, timeZoom)
}

function dayBandLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function hourBandLabel(date) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function durationOrderMagnitudeChange(originalDuration, nextDuration) {
  const original = Math.max(MIN_TIME_SLOT_DURATION, Number(originalDuration) || MIN_TIME_SLOT_DURATION)
  const next = Math.max(MIN_TIME_SLOT_DURATION, Number(nextDuration) || MIN_TIME_SLOT_DURATION)
  const ratio = Math.max(original, next) / Math.min(original, next)
  return Math.log10(ratio)
}

function durationScaleBucket(duration, startCol = null) {
  const value = Math.max(MIN_TIME_SLOT_DURATION, Number(duration) || MIN_TIME_SLOT_DURATION)
  if (startCol !== null && isCalendarMonthRange(startCol, value)) return 'month'
  if (value < 1440) return 'minute'
  if (value < 43200) return 'day'
  return 'month'
}

function timeSlotScaleBucket(timeSlot) {
  return durationScaleBucket(timeSlot?.duration, timeSlot?.startCol)
}

function durationScaleBucketIndex(bucket) {
  return ['minute', 'day', 'month'].indexOf(bucket)
}

function areTimeSlotScalesCompatible(timeSlotA, timeSlotB) {
  return timeSlotScaleBucket(timeSlotA) === timeSlotScaleBucket(timeSlotB)
}

function zoomForConflictGap(minutes) {
  const gap = Math.abs(Number(minutes) || 0)
  if (gap >= 43200) return 'months'
  if (gap >= 1440) return 'days'
  return 'minutes'
}

function lowerZoomForTimeSlot(timeSlot) {
  const level = getTimeSlotLevel(timeSlot?.duration, timeSlot?.startCol)
  const idx = ZOOM_ORDER.indexOf(level)
  return idx > 0 ? ZOOM_ORDER[idx - 1] : null
}

function formatMinutesDuration(minutes) {
  const value = Math.max(MIN_TIME_SLOT_DURATION, Number(minutes) || MIN_TIME_SLOT_DURATION)
  if (value < 60) return `${value} min`
  if (value < 60 * 24) return `${(value / 60).toFixed(value % 60 === 0 ? 0 : 1)} h`
  return `${(value / (60 * 24)).toFixed(value % (60 * 24) === 0 ? 0 : 1)} d`
}

function compactTimeSlotDurationLabel(timeSlot) {
  const value = Math.max(MIN_TIME_SLOT_DURATION, Number(timeSlot?.duration) || MIN_TIME_SLOT_DURATION)
  if (timeSlotScaleBucket(timeSlot) === 'month' && isCalendarMonthRange(timeSlot?.startCol, value)) {
    return `${calendarMonthSpanForRange(timeSlot.startCol, value)}mo`
  }
  if (value < 60) return `${value}m`
  if (value < 60 * 24) return `${Number((value / 60).toFixed(value % 60 === 0 ? 0 : 1))}h`
  if (value < 43200) return `${Number((value / (60 * 24)).toFixed(value % (60 * 24) === 0 ? 0 : 1))}d`
  return `${Number((value / 43200).toFixed(value % 43200 === 0 ? 0 : 1))}mo`
}

function compactScaleLabel(timeSlot) {
  const scale = timeSlotScaleBucket(timeSlot)
  if (scale === 'minute') return 'min'
  if (scale === 'month') return 'mo'
  return 'day'
}

function noteDescriptionText(note) {
  return String(note?.html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
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
    if (!from || !to) return
    if (!areTimeSlotScalesCompatible(from, to)) {
      violations.add(from.id)
      violations.add(to.id)
      return
    }
    if (from.startCol + from.duration > to.startCol) violations.add(to.id)
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
      if (!from || !to) return null
      if (!areTimeSlotScalesCompatible(from, to)) return { dep, from, to, type: 'scale_mismatch' }
      if (from.startCol + from.duration <= to.startCol) return null
      return { dep, from, to, type: 'dependency' }
    })
    .filter(Boolean)
}

function getCascadingDependencyConflict(msList, deps, initialViolations = null) {
  const msMap = Object.fromEntries(msList.map(m => [m.id, m]))
  const seedViolations = initialViolations ?? getDependencyViolations(msList, deps)

  // pushedStart tracks where each timeSlot would land after being pushed by the chain.
  // Starts at the real current position; gets updated as each cascade step forces a timeSlot right.
  const pushedStart = Object.fromEntries(msList.map(m => [m.id, m.startCol]))

  const violations = []
  const violationIds = new Set()
  const timeSlotIds = new Set()
  const queue = []

  const addViolation = violation => {
    if (!violation || violationIds.has(violation.dep.id)) return
    violationIds.add(violation.dep.id)
    violations.push(violation)
    timeSlotIds.add(violation.from.id)
    timeSlotIds.add(violation.to.id)
    // Push `to` to just after `from` ends in the pushed world
    const fromPushedEnd = pushedStart[violation.from.id] + violation.from.duration
    if (pushedStart[violation.to.id] < fromPushedEnd) {
      pushedStart[violation.to.id] = fromPushedEnd
    }
    queue.push(violation.to.id)
  }

  seedViolations.filter(v => v.type !== 'scale_mismatch').forEach(addViolation)
  seedViolations.filter(v => v.type === 'scale_mismatch').forEach(violation => {
    if (!violation || violationIds.has(violation.dep.id)) return
    violationIds.add(violation.dep.id)
    violations.push(violation)
    timeSlotIds.add(violation.from.id)
    timeSlotIds.add(violation.to.id)
  })

  while (queue.length) {
    const fromId = queue.shift()
    const from = msMap[fromId]
    if (!from) continue
    const fromPushedEnd = pushedStart[fromId] + from.duration
    deps.forEach(dep => {
      if (dep.fromId !== fromId || violationIds.has(dep.id)) return
      const to = msMap[dep.toId]
      // Use the pushed position of `to` to check if the chain would violate it
      if (to && fromPushedEnd > pushedStart[dep.toId]) addViolation({ dep, from, to })
    })
  }

  return { violations, depIds: [...violationIds], timeSlotIds }
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
  for (const laneTimeSlots of byNote.values()) {
    for (let i = 0; i < laneTimeSlots.length; i += 1) {
      for (let j = i + 1; j < laneTimeSlots.length; j += 1) {
        const a = laneTimeSlots[i]
        const b = laneTimeSlots[j]
        const overlaps = a.startCol < b.startCol + b.duration && b.startCol < a.startCol + a.duration
        if (overlaps && (movedIds.has(a.id) || movedIds.has(b.id))) return [a.id, b.id]
      }
    }
  }
  return null
}

function getTimeSlotOrderViolation(beforeList, afterList, movedIds = new Set()) {
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
    timeSlots: state.timeSlots ?? [],
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
  showRowScheduleMarker, onShowRowScheduleMarkerChange,
  showRowTimeSlotMeta, onShowRowTimeSlotMetaChange,
  timeSlotLabelMode, onTimeSlotLabelModeChange,
  timeSlotScaleFilter, onTimeSlotScaleFilterChange,
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
    ['colW',    'Column width', minColWidthForZoom(timeZoom), 250, 'px'],
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
        <span className={styles.spacingLabel}>Metric</span>
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
        <span className={`${styles.spacingLabel} ${styles.scaleHelpAnchor}`} tabIndex={0}>
          Scale
          <span className={styles.scaleHelpPopover}>
            <strong>Focused</strong> keeps the view readable by showing the current planning scale and broader time slots only: minute view shows all, day view shows day and month, and month view shows month time slots. <strong>Everything</strong> shows every time slot and dependency. In that mode, time slots use their true proportional position and duration instead of being rounded up to a full visible column, so a 10 minute time slot in month view may become only a tiny mark.
          </span>
        </span>
        <div className={styles.axisModePills}>
          {[
            [SCALE_VISIBILITY_MODES.HIERARCHY, 'Focused'],
            [SCALE_VISIBILITY_MODES.ALL, 'Everything'],
          ].map(([val, label]) => (
            <button key={val}
              className={`${styles.axisModePill} ${normalizeScaleVisibilityMode(timeSlotScaleFilter) === val ? styles.axisModePillActive : ''}`}
              onClick={() => onTimeSlotScaleFilterChange(val)}>
              {label}
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
          <label className={styles.depToggle} title="Color selected time slot incoming dependencies red and outgoing dependencies green" style={{ opacity: showDeps ? 1 : 0.4 }}>
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
        <span className={styles.spacingLabel}>Rows</span>
        <div className={styles.depToggles}>
          <label className={styles.depToggle} title="Show a small marker for notes that already have a time slot">
            <input type="checkbox" checked={showRowScheduleMarker} onChange={e => onShowRowScheduleMarkerChange(e.target.checked)} />
            <span>Scheduled marker</span>
          </label>
          <label className={styles.depToggle} title="Show each note row's time slot duration and planning scale">
            <input type="checkbox" checked={showRowTimeSlotMeta} onChange={e => onShowRowTimeSlotMetaChange(e.target.checked)} />
            <span>Duration scale</span>
          </label>
        </div>
      </div>
      <div className={styles.axisModeRow}>
        <span className={styles.spacingLabel}>Labels on time slots</span>
        <div className={styles.axisModePills}>
          {TIME_SLOT_LABEL_MODES.map(option => (
            <button key={option.value}
              className={`${styles.axisModePill} ${timeSlotLabelMode === option.value ? styles.axisModePillActive : ''}`}
              onClick={() => onTimeSlotLabelModeChange(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.axisModeRow}>
        <span className={styles.spacingLabel}>View</span>
        <div className={styles.panelActions}>
          <button
            className={styles.panelActionBtn}
            disabled={!canFilterToSelection}
            onClick={onFilterToSelectedNotes}
            title="Show only notes that have selected time slots">
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

function WarningSystemPanel({
  nostalgiaMode,
  onToggleNostalgia,
  onClose,
  anchorRef,
}) {
  const panelRef = useRef()
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })
  useEffect(() => {
    const handler = e => {
      if (panelRef.current?.contains(e.target)) return
      if (anchorRef?.current?.contains(e.target)) return
      closeRef.current?.()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [anchorRef])

  return (
    <div ref={panelRef} className={`${styles.spacingPanel} ${styles.warningSettingsPanel}`}>
      <div className={styles.spacingPanelHdr}>
        <span>Warning system</span>
        <button className={styles.spacingClose} onClick={onClose}>×</button>
      </div>
      <div className={styles.warningSettingsText}>
        Past dates are locked by default. Nostalgia mode temporarily allows editing before today and turns off when you leave the schedule page.
      </div>
      <button
        type="button"
        className={`${styles.warningModeBtn} ${nostalgiaMode ? styles.warningModeBtnActive : ''}`}
        onClick={onToggleNostalgia}
        aria-pressed={nostalgiaMode}>
        <span>Nostalgia mode</span>
        <strong>{nostalgiaMode ? 'On' : 'Off'}</strong>
      </button>
    </div>
  )
}

// ── Context menu ──────────────────────────────────────────────────────────────
function ContextMenu({
  menu, onClose, onCreate, onInsertTimeUnit, onDeleteTimeUnit, onSetDeadline, onRemoveDeadline,
  onSetEarliestStart, onRemoveEarliestStart,
  onCreateNoteInLane,
  onCopyNote, onDuplicateNote, onStartInheritancePick, onSeeInheritance,
  onDeleteTimeSlot, onToggleTimeSlotPin, pinnedTimeSlotId, onEditDepReason, onDeleteDep,
}) {
  if (!menu) return null
  return createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onMouseDown={onClose} />
      <div className={styles.ctxMenu} style={{ left: menu.x, top: menu.y }}>
        {menu.type === 'cell' && (<>
          <button className={styles.ctxItem}
            onClick={() => { onCopyNote(menu.noteId); onClose() }}>
            Copy note — {menu.noteTitle}
          </button>
          <button className={styles.ctxItem}
            onClick={() => { onDuplicateNote(menu.noteId); onClose() }}>
            Duplicate note
          </button>
          <button className={styles.ctxItem}
            onClick={() => { onStartInheritancePick(menu.noteId, 'child'); onClose() }}>
            Inherit from...
          </button>
          <button className={styles.ctxItem}
            onClick={() => { onStartInheritancePick(menu.noteId, 'parent'); onClose() }}>
            Make parent of...
          </button>
          {menu.hasTimeSlot && (
            <button className={styles.ctxItem}
              onClick={() => { onSeeInheritance(menu.noteId); onClose() }}>
              See inheritance
            </button>
          )}
          {menu.isReadOnly ? (
            <div className={styles.ctxReadOnly}>
              Switch to {menu.readOnlyLabel} view to edit this row
            </div>
          ) : (<>
          <button className={styles.ctxItem}
            onClick={() => { onCreate(menu.noteId, menu.col, menu.color); onClose() }}>
            Add time slot — {menu.noteTitle}
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
          {menu.hasEarliestStart
            ? <button className={styles.ctxItem}
                onClick={() => { onRemoveEarliestStart(menu.noteId); onClose() }}>
                Remove earliest start date
              </button>
            : <button className={styles.ctxItem}
                onClick={() => { onSetEarliestStart(menu.noteId, menu.col); onClose() }}>
                Set earliest start date here
              </button>
          }
        </>)}
        </>)}
        {menu.type === 'note' && (
          <>
            <button className={styles.ctxItem}
              onClick={() => { onCopyNote(menu.noteId); onClose() }}>
              Copy note — {menu.noteTitle}
            </button>
            <button className={styles.ctxItem}
              onClick={() => { onDuplicateNote(menu.noteId); onClose() }}>
              Duplicate note
            </button>
            <button className={styles.ctxItem}
              onClick={() => { onStartInheritancePick(menu.noteId, 'child'); onClose() }}>
              Inherit from...
            </button>
            <button className={styles.ctxItem}
              onClick={() => { onStartInheritancePick(menu.noteId, 'parent'); onClose() }}>
              Make parent of...
            </button>
            {menu.hasTimeSlot && (
              <button className={styles.ctxItem}
                onClick={() => { onSeeInheritance(menu.noteId); onClose() }}>
                See inheritance
              </button>
            )}
          </>
        )}
        {menu.type === 'header' && (<>
          <button className={styles.ctxItem} onClick={() => { onInsertTimeUnit(menu.col); onClose() }}>
            Insert {menu.unitLabel || 'unit'} before
          </button>
          <button className={styles.ctxItem} onClick={() => { onDeleteTimeUnit(menu.col); onClose() }}>
            Remove this {menu.unitLabel || 'unit'}
          </button>
        </>)}
        {menu.type === 'lane' && (
          <button className={styles.ctxItem}
            onClick={() => { onCreateNoteInLane(menu.categoryId); onClose() }}>
            Create note in {menu.categoryName}
          </button>
        )}
        {menu.type === 'timeSlot' && (<>
          <button className={styles.ctxItem}
            onClick={() => { onStartInheritancePick(menu.noteId, 'child'); onClose() }}>
            Make child of...
          </button>
          <button className={styles.ctxItem}
            onClick={() => { onStartInheritancePick(menu.noteId, 'parent'); onClose() }}>
            Make note parent of...
          </button>
          <button className={styles.ctxItem}
            onClick={() => { onSeeInheritance(menu.noteId); onClose() }}>
            See inheritance
          </button>
          <button className={styles.ctxItem}
            onClick={() => { onToggleTimeSlotPin(menu.timeSlotId); onClose() }}>
            {pinnedTimeSlotId === menu.timeSlotId ? 'Unpin time slot' : 'Pin time slot'}
          </button>
          <button className={`${styles.ctxItem} ${styles.ctxItemDanger}`}
            onClick={() => { onDeleteTimeSlot(menu.timeSlotId, menu.label); onClose() }}>
            Delete time slot
          </button>
        </>)}
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

function InheritanceInspectorModal({
  noteId, notes, timeSlots, noteInheritance, assignments, dimensions, categories, onUnlink, onClose,
}) {
  const noteById = useMemo(() => new Map(notes.map(note => [note.id, note])), [notes])
  const timeSlotByNote = useMemo(() => new Map(timeSlots.map(timeSlot => [timeSlot.noteId, timeSlot])), [timeSlots])
  const categoriesById = useMemo(() => new Map(categories.map(cat => [cat.id, cat])), [categories])
  const currentNote = noteById.get(noteId)
  const parentLinks = noteInheritance.filter(link => link.childNoteId === noteId)
  const childLinks = noteInheritance.filter(link => link.parentNoteId === noteId)

  const noteCategories = targetNoteId => dimensions
    .map(dim => {
      const catId = assignments[targetNoteId]?.[dim.id]
      const cat = catId ? categoriesById.get(catId) : null
      return cat ? { dim, cat } : null
    })
    .filter(Boolean)

  const renderRelation = (link, direction) => {
    const relatedNoteId = direction === 'parent' ? link.parentNoteId : link.childNoteId
    const relatedNote = noteById.get(relatedNoteId)
    const relatedTimeSlot = timeSlotByNote.get(relatedNoteId)
    const cats = noteCategories(relatedNoteId)
    const description = noteDescriptionText(relatedNote)
    return (
      <details key={`${direction}:${link.childNoteId}:${link.parentNoteId}`} className={styles.inheritanceRelation}>
        <summary className={styles.inheritanceSummary}>
          <span className={styles.inheritanceRelationKind}>{direction === 'parent' ? 'Parent' : 'Child'}</span>
          <span className={styles.inheritanceRelationTitle} title={description || relatedNote?.title || 'Untitled note'}>
            {relatedNote?.title || 'Untitled note'}
          </span>
          {relatedTimeSlot && (
            <span className={[
              styles.inheritanceSlotBadge,
              relatedTimeSlot.duration <= MIN_TIME_SLOT_DURATION && styles.inheritanceSlotBadgeMinimum,
            ].filter(Boolean).join(' ')}>
              {compactTimeSlotDurationLabel(relatedTimeSlot)} · {compactScaleLabel(relatedTimeSlot)}
            </span>
          )}
        </summary>
        <div className={styles.inheritanceDetails}>
          <div className={styles.inheritanceDetailRow}>
            <span className={styles.inheritanceDetailLabel}>Time slot</span>
            <span>{relatedTimeSlot ? `${formatMinutesDuration(relatedTimeSlot.duration)} · ${timeSlotScaleBucket(relatedTimeSlot)}` : 'No time slot'}</span>
          </div>
          <div className={styles.inheritanceCategoryList}>
            {cats.length ? cats.map(({ dim, cat }) => (
              <span
                key={`${dim.id}:${cat.id}`}
                className={styles.inheritanceCategoryChip}
                title={cat.description || `${dim.name}: ${cat.name}`}>
                <span className={styles.inheritanceCategoryDot} style={{ background: cat.color }} />
                <span className={styles.inheritanceCategoryDim}>{dim.name}</span>
                <span>{cat.name}</span>
              </span>
            )) : (
              <span className={styles.inheritanceEmptyText}>No assigned categories</span>
            )}
          </div>
          <button
            type="button"
            className={styles.inheritanceUnlinkBtn}
            onClick={() => onUnlink(link.childNoteId, link.parentNoteId)}>
            Remove inheritance
          </button>
        </div>
      </details>
    )
  }

  return createPortal(
    <div className={styles.modalBackdrop} onMouseDown={onClose}>
      <div className={`${styles.modal} ${styles.inheritanceInspectorModal}`} onMouseDown={e => e.stopPropagation()}>
        <div className={styles.inheritanceInspectorHeader}>
          <div>
            <div className={styles.inheritanceInspectorEyebrow}>Inheritance</div>
            <div className={styles.inheritanceInspectorTitle} title={noteDescriptionText(currentNote) || currentNote?.title || 'Untitled note'}>
              {currentNote?.title || 'Untitled note'}
            </div>
          </div>
          <button type="button" className={styles.spacingClose} onClick={onClose}>✕</button>
        </div>
        <div className={styles.inheritanceInspectorContent}>
          <section className={styles.inheritanceSection}>
            <div className={styles.inheritanceSectionTitle}>Parents</div>
            {parentLinks.length ? parentLinks.map(link => renderRelation(link, 'parent')) : (
              <div className={styles.inheritanceEmptyText}>No parent notes</div>
            )}
          </section>
          <section className={styles.inheritanceSection}>
            <div className={styles.inheritanceSectionTitle}>Children</div>
            {childLinks.length ? childLinks.map(link => renderRelation(link, 'child')) : (
              <div className={styles.inheritanceEmptyText}>No child notes</div>
            )}
          </section>
        </div>
      </div>
    </div>,
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

function ScheduleGroupScroller({
  dimensions,
  categories,
  savedFilters = [],
  activeDimId,
  activeLaneFilterId,
  hiddenCatIds,
  onDimensionChange,
  onFilterChange,
  onShowOnlyCategory,
}) {
  const wheelAtRef = useRef(0)
  const categoryWheelAtRef = useRef(0)
  const pickerRef = useRef(null)
  const categoryPickerRef = useRef(null)
  const [dimensionMenuOpen, setDimensionMenuOpen] = useState(false)
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)

  const activeIndex = activeDimId ? dimensions.findIndex(dim => dim.id === activeDimId) : -1
  const currentDim = activeIndex >= 0 ? dimensions[activeIndex] : null
  const currentFilter = activeLaneFilterId ? savedFilters.find(filter => filter.id === activeLaneFilterId) : null
  const activeCats = currentDim ? categories.filter(cat => cat.dimensionId === currentDim.id) : []
  const visibleActiveCats = activeCats.filter(cat => !hiddenCatIds.has(cat.id))
  const focusedCategory = visibleActiveCats.length === 1 ? visibleActiveCats[0] : null
  const focusedCategoryIndex = focusedCategory
    ? activeCats.findIndex(cat => cat.id === focusedCategory.id)
    : -1
  const canCycleDimension = dimensions.length > 0
  const canCycleCategory = activeCats.length > 0

  const dimensionSwatches = dim => categories
    .filter(cat => cat.dimensionId === dim.id)
    .slice(0, 3)

  const selectDimensionIndex = idx => {
    if (!dimensions.length) return
    const dim = dimensions[(idx + dimensions.length) % dimensions.length]
    onDimensionChange?.(dim.id)
  }
  const prevDimension = () => {
    if (!canCycleDimension) return
    selectDimensionIndex(activeIndex >= 0 ? activeIndex - 1 : dimensions.length - 1)
  }
  const nextDimension = () => {
    if (!canCycleDimension) return
    selectDimensionIndex(activeIndex >= 0 ? activeIndex + 1 : 0)
  }
  const selectCategoryIndex = idx => {
    if (!canCycleCategory) return
    const cat = activeCats[(idx + activeCats.length) % activeCats.length]
    onShowOnlyCategory?.(cat.id)
  }
  const prevCategory = () => {
    if (!canCycleCategory) return
    selectCategoryIndex(focusedCategoryIndex >= 0 ? focusedCategoryIndex - 1 : activeCats.length - 1)
  }
  const nextCategory = () => {
    if (!canCycleCategory) return
    selectCategoryIndex(focusedCategoryIndex >= 0 ? focusedCategoryIndex + 1 : 0)
  }

  const onWheel = e => {
    e.preventDefault()
    const now = Date.now()
    if (now - wheelAtRef.current < 180) return
    wheelAtRef.current = now
    e.deltaY > 0 ? nextDimension() : prevDimension()
  }
  const onCategoryWheel = e => {
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
      <div className={styles.groupScrollerUnit} onWheel={onWheel}>
        <span className={styles.groupScrollerLabel}>Dimension</span>
        <div ref={pickerRef} className={styles.groupScrollerRow}>
          <button className={styles.groupScrollerArrow} onClick={prevDimension} disabled={!canCycleDimension} title="Previous dimension">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <button
            className={styles.groupScrollerName}
            onClick={() => setDimensionMenuOpen(open => !open)}
            disabled={!canCycleDimension}
            title="Pick dimension"
          >
            <span className={styles.groupScrollerSwatches}>
              {(currentDim ? dimensionSwatches(currentDim) : []).map(cat => (
                <b key={cat.id} style={{ background: cat.color || '#aaa' }} />
              ))}
              {(!currentDim || dimensionSwatches(currentDim).length === 0) && <b style={{ background: '#9ca3af' }} />}
            </span>
            <span className={styles.groupScrollerText}>{currentDim?.name ?? currentFilter?.name ?? 'None'}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
          </button>
          <button className={styles.groupScrollerArrow} onClick={nextDimension} disabled={!canCycleDimension} title="Next dimension">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18l6-6-6-6"/></svg>
          </button>
          {dimensionMenuOpen && (
            <div className={styles.groupScrollerMenu}>
              <button
                className={!activeDimId && !activeLaneFilterId ? styles.groupScrollerMenuItemActive : styles.groupScrollerMenuItem}
                onClick={() => {
                  onDimensionChange?.('')
                  setDimensionMenuOpen(false)
                }}
              >
                <span className={styles.groupScrollerSingleSwatch}>
                  <b style={{ background: '#9ca3af' }} />
                </span>
                <strong>None</strong>
              </button>
              {dimensions.map(dim => (
                <button
                  key={dim.id}
                  className={dim.id === activeDimId ? styles.groupScrollerMenuItemActive : styles.groupScrollerMenuItem}
                  onClick={() => {
                    onDimensionChange?.(dim.id)
                    setDimensionMenuOpen(false)
                  }}
                >
                  <span>
                    {dimensionSwatches(dim).map(cat => (
                      <b key={cat.id} style={{ background: cat.color || '#aaa' }} />
                    ))}
                    {dimensionSwatches(dim).length === 0 && <b style={{ background: '#9ca3af' }} />}
                  </span>
                  <strong>{dim.name}</strong>
                </button>
              ))}
              {savedFilters.map(filter => (
                <button
                  key={filter.id}
                  className={filter.id === activeLaneFilterId ? styles.groupScrollerMenuItemActive : styles.groupScrollerMenuItem}
                  onClick={() => {
                    onFilterChange?.(filter.id)
                    setDimensionMenuOpen(false)
                  }}
                >
                  <span className={styles.groupScrollerSingleSwatch}>
                    <b style={{ background: filter.color || '#64748b' }} />
                  </span>
                  <strong>{filter.name}</strong>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className={styles.groupScrollerDots}>
          {dimensions.map(dim => (
            <button
              key={dim.id}
              className={`${styles.groupScrollerDot} ${dim.id === activeDimId ? styles.groupScrollerDotActive : ''}`}
              onClick={() => onDimensionChange?.(dim.id)}
              title={dim.name}
            />
          ))}
        </div>
      </div>

      {currentDim && (
        <div className={styles.groupScrollerUnit} onWheel={onCategoryWheel}>
          <span className={styles.groupScrollerLabel}>Category</span>
          <div ref={categoryPickerRef} className={styles.groupScrollerRow}>
            <button className={styles.groupScrollerArrow} onClick={prevCategory} disabled={!canCycleCategory} title="Previous category">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <button
              className={styles.groupScrollerName}
              onClick={() => setCategoryMenuOpen(open => !open)}
              disabled={!canCycleCategory}
              title="Pick category"
            >
              <span className={styles.groupScrollerCatDot} style={{ background: focusedCategory?.color || '#9ca3af' }} />
              <span className={styles.groupScrollerText}>{focusedCategory?.name ?? 'Custom'}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
            <button className={styles.groupScrollerArrow} onClick={nextCategory} disabled={!canCycleCategory} title="Next category">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18l6-6-6-6"/></svg>
            </button>
            {categoryMenuOpen && (
              <div className={styles.groupScrollerMenu}>
                {activeCats.map(cat => (
                  <button
                    key={cat.id}
                    className={cat.id === focusedCategory?.id ? styles.groupScrollerMenuItemActive : styles.groupScrollerMenuItem}
                    onClick={() => {
                      onShowOnlyCategory?.(cat.id)
                      setCategoryMenuOpen(false)
                    }}
                  >
                    <span className={styles.groupScrollerSingleSwatch}>
                      <b style={{ background: cat.color || '#aaa' }} />
                    </span>
                    <strong>{cat.name}</strong>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={styles.groupScrollerDots}>
            {activeCats.map(cat => (
              <button
                key={cat.id}
                className={`${styles.groupScrollerDot} ${cat.id === focusedCategory?.id ? styles.groupScrollerDotActive : ''}`}
                onClick={() => onShowOnlyCategory?.(cat.id)}
                title={cat.name}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function CornerGanttControls({ canUndo, canRedo, onUndo, onRedo, mode, onModeChange }) {
  return (
    <div className={styles.cornerControls}>
      <div className={styles.historyButtons}>
        <button className={styles.historyBtn} disabled={!canUndo} onClick={onUndo} title="Undo last Gantt transaction">
          Undo
        </button>
        <button className={styles.historyBtn} disabled={!canRedo} onClick={onRedo} title="Redo last undone Gantt transaction">
          Redo
        </button>
      </div>
      <div className={styles.modePills}>
        <button className={`${styles.modePill} ${mode === 'timeSlot' ? styles.modePillActive : ''}`}
          onClick={() => onModeChange('timeSlot')}>Time slot</button>
        <button className={`${styles.modePill} ${mode === 'dependency' ? styles.modePillActive : ''}`}
          onClick={() => onModeChange('dependency')}>Dependency</button>
      </div>
    </div>
  )
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
function GanttToolbar({
  dimensions, activeDimId, activeCategories, hiddenCatIds,
  categories, onToggleCategory, onShowAllCategories, onShowOnlyCategory,
  savedFilters, activeLaneFilterId, onLaneGroupChange,
  spacing, onSpacingChange,
  axisMode, onAxisModeChange,
  timeZoom, onTimeZoomChange,
  showDepLabels, onShowDepLabelsChange,
  showDeps, onShowDepsChange, hideCrossCatDeps, onHideCrossCatDepsChange,
  showCrucialDepsOnly, onShowCrucialDepsOnlyChange,
  colorDependencyDirection, onColorDependencyDirectionChange,
  showRowScheduleMarker, onShowRowScheduleMarkerChange,
  showRowTimeSlotMeta, onShowRowTimeSlotMetaChange,
  timeSlotLabelMode, onTimeSlotLabelModeChange,
	  timeSlotScaleFilter, onTimeSlotScaleFilterChange,
	  nostalgiaMode, onToggleNostalgia,
  canDeleteSelection, onDeleteSelection,
  canFilterToSelection, onFilterToSelectedNotes, onExpandEverything,
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
      <div className={styles.scaleQuickSwitch} aria-label="Gantt planning scale">
        <span className={styles.scaleQuickLabel}>Scale</span>
        <div className={styles.scaleQuickPills}>
          {TIME_ZOOM_LEVELS.map(level => (
            <button key={level.value}
              type="button"
              className={`${styles.scaleQuickPill} ${timeZoom === level.value ? styles.scaleQuickPillActive : ''}`}
              title={`Switch to ${level.label} scale`}
              onClick={() => onTimeZoomChange(level.value)}>
              {level.value === 'minutes' ? level.short : level.label}
            </button>
          ))}
        </div>
      </div>
      <ScheduleGroupScroller
        dimensions={dimensions}
        categories={categories}
        savedFilters={savedFilters}
        activeDimId={activeDimId}
        activeLaneFilterId={activeLaneFilterId}
        hiddenCatIds={hiddenCatIds}
        onDimensionChange={dimId => onLaneGroupChange(dimId ? `d:${dimId}` : '')}
        onFilterChange={filterId => onLaneGroupChange(filterId ? `f:${filterId}` : '')}
        onShowOnlyCategory={onShowOnlyCategory}
      />
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
	          className={`${styles.toolbarToggleBtn} ${warningSettingsOpen ? styles.toolbarToggleBtnActive : ''}`}
	          onClick={() => setWarningSettingsOpen(v => !v)}
	          title="Warning system">
	          Warnings
	        </button>
	        {warningSettingsOpen && (
	          <WarningSystemPanel
	            nostalgiaMode={nostalgiaMode}
	            onToggleNostalgia={onToggleNostalgia}
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
            showRowScheduleMarker={showRowScheduleMarker} onShowRowScheduleMarkerChange={onShowRowScheduleMarkerChange}
            showRowTimeSlotMeta={showRowTimeSlotMeta} onShowRowTimeSlotMetaChange={onShowRowTimeSlotMetaChange}
            timeSlotLabelMode={timeSlotLabelMode} onTimeSlotLabelModeChange={onTimeSlotLabelModeChange}
            timeSlotScaleFilter={timeSlotScaleFilter} onTimeSlotScaleFilterChange={onTimeSlotScaleFilterChange}
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
    state: normalizeSchedulePerspectiveState(perspective?.state ?? {}),
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
  const [savingActive, setSavingActive] = useState(false)
  const wrapRef = useRef()
  const wheelAtRef = useRef(0)
  const applyTimerRef = useRef(null)
  const active = perspectives.find(p => p.id === activePerspectiveId)
  const canSaveActive = Boolean(active && !active.readOnly)

  const saveActive = async e => {
    e?.preventDefault()
    e?.stopPropagation()
    if (!canSaveActive || savingActive) return
    setSavingActive(true)
    try {
      await onUpdate(active.id)
    } finally {
      setSavingActive(false)
    }
  }

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
        type="button"
        className={styles.perspectiveToolbarSaveBtn}
        title={canSaveActive ? (savingActive ? 'Saving perspective…' : 'Update current perspective snapshot') : 'None cannot be saved'}
        disabled={!canSaveActive || savingActive}
        onClick={saveActive}>
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
  dimensions, categories, colorDimId, onColorDimChange, onDimDataChanged,
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
          <DimensionDropUp
            dimensions={dimensions}
            categories={categories}
            value={colorDimId}
            onChange={onColorDimChange}
            onDimDataChanged={onDimDataChanged}
            emptyLabel="Color legend"
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
export default function SchedulePage({ notes = [], project = null, isActive = false, onNoteOpen, onProjectUpdate, onNoteCreated, onNotesChanged, refreshKey = 0, dimRefreshKey = 0, peopleRefreshKey = 0, onDimChanged, onPeopleChanged, externalResolveRequest = null, onExternalResolveReturn, contextDefaultPerspectiveId, contextApplyToken, activeContextId = '', archivedDimensionIds = [] }) {
  // ── Timeline anchor ────────────────────────────────────────────────────────
  // Keep the module-level anchor in sync with the project's creation date so that
  // col 0 = project creation date (fixed, immutable left boundary of the timeline).
  const _anchor = useMemo(() => {
    if (!project?.createdAt) return null
    // createdAt comes from SQLite as "YYYY-MM-DD HH:MM:SS" — normalise to midnight local
    const raw = String(project.createdAt).replace(' ', 'T')
    const d = new Date(raw)
    if (isNaN(d.getTime())) return null
    d.setHours(0, 0, 0, 0)
    return d
  }, [project?.createdAt])
  _timelineAnchor = _anchor

  // Compute today's position in minutes relative to the project creation date.
  // Result is 0 when there's no anchor (today IS col 0, legacy behaviour).
  const todayMinute = useMemo(() => {
    if (!_anchor) return 0
    const realToday = new Date(); realToday.setHours(0, 0, 0, 0)
    return Math.round((realToday.getTime() - _anchor.getTime()) / 60000)
  }, [_anchor])
  const todayMinuteRef = useRef(todayMinute)
  todayMinuteRef.current = todayMinute

  // Compute end date position in minutes relative to the anchor.
	  const endDateMinute = useMemo(() => {
	    if (!project?.endDate) return null
	    const anchor = _anchor || (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d })()
	    const endD = new Date(project.endDate + 'T00:00:00')
	    endD.setHours(0, 0, 0, 0)
	    return Math.round((endD.getTime() - anchor.getTime()) / 60000)
	  }, [project?.endDate, _anchor])
  const endDateMinuteRef = useRef(endDateMinute)
  endDateMinuteRef.current = endDateMinute

  // ── API data ───────────────────────────────────────────────────────────────
  const [dimensions,   setDimensions]   = useState([])
  const [categories,   setCategories]   = useState([])
  const [assignments,  setAssignments]  = useState({})
  const [assignmentOrders, setAssignmentOrders] = useState({})
  const [timeSlots,   setTimeSlots]   = useState([])
  const [dependencies, setDependencies] = useState([])
  const [deadlines,    setDeadlines]    = useState([])
  const [earliestStarts, setEarliestStarts] = useState([])
  const [noteInheritance, setNoteInheritance] = useState([])
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

  const refreshScheduleData = useCallback(async () => {
    const [assigns, mss, deps, dls, ess, inherited, history] = await Promise.all([
      api.getAssignments(),
      api.getTimeSlots(),
      api.getDependencies(),
      api.getDeadlines(),
      api.getEarliestStarts(),
      api.getNoteInheritance(),
      api.getTransactionHistory(),
    ])
    applyAssignments(assigns)
    setTimeSlots(mss)
    setDependencies(deps)
    setDeadlines(dls)
    setEarliestStarts(ess)
    setNoteInheritance(inherited)
    setTransactionHistory(history)
  }, [])

  useEffect(() => {
    if (!isActive) return
    Promise.all([
      api.getDimensions(), api.getAllCategories(), api.getAssignments(),
      api.getTimeSlots(), api.getDependencies(), api.getDeadlines(), api.getEarliestStarts(), api.getNoteInheritance(), api.getFilters(), api.getSchedulePerspectives(activeContextId),
      api.getTransactionHistory(), api.getPersonas(), api.getDirectPersonaNoteAssignments(), api.getDirectPersonaAssignments(),
    ]).then(([dims, cats, assigns, mss, deps, dls, ess, inherited, filters, loadedPerspectives, history, ps, pnas, pcas]) => {
      setDimensions(dims); setCategories(cats)
      setSavedFilters(filters)
      setPerspectives(loadedPerspectives.map(normalizePerspective))
      applyAssignments(assigns)
      setTimeSlots(mss)
      setDependencies(deps)
      setDeadlines(dls)
      setEarliestStarts(ess)
      setNoteInheritance(inherited)
      setTransactionHistory(history)
      setPersonas(ps)
      setPersonaNoteAssignments(pnas)
      setPersonaCatAssignments(pcas)
    }).catch(console.error)
  }, [isActive, activeContextId])

  useEffect(() => {
    if (!refreshKey) return
    api.getAssignments().then(applyAssignments).catch(console.error)
  }, [refreshKey])

  useEffect(() => {
    if (!peopleRefreshKey) return
    Promise.all([api.getPersonas(), api.getDirectPersonaNoteAssignments(), api.getDirectPersonaAssignments()])
      .then(([ps, pnas, pcas]) => {
        setPersonas(ps)
        setPersonaNoteAssignments(pnas)
        setPersonaCatAssignments(pcas)
      })
      .catch(console.error)
  }, [peopleRefreshKey])

  // Re-fetch dims+cats when another page changes dimension data
  const dimRefreshKeyRef = useRef(dimRefreshKey)
  useEffect(() => {
    if (dimRefreshKey === dimRefreshKeyRef.current) return
    dimRefreshKeyRef.current = dimRefreshKey
    Promise.all([api.getDimensions(), api.getAllCategories()])
      .then(([dims, cats]) => { setDimensions(dims); setCategories(cats) })
      .catch(console.error)
  }, [dimRefreshKey])

  // Called by DimensionDropUp after any dim/cat mutation
  const handleDimDataChanged = () => {
    Promise.all([api.getDimensions(), api.getAllCategories()])
      .then(([dims, cats]) => { setDimensions(dims); setCategories(cats) })
      .catch(console.error)
    onDimChanged?.()
  }

  const inheritedWindows = useMemo(() => {
    const timeSlotByNote = new Map(timeSlots.map(ms => [ms.noteId, ms]))
    const starts = []
    const ends = []
    noteInheritance.forEach(link => {
      const child = timeSlotByNote.get(link.childNoteId)
      const parent = timeSlotByNote.get(link.parentNoteId)
      if (!child || !parent) return
      const childScale = timeSlotScaleBucket(child)
      starts.push({
        id: `inh-start:${link.childNoteId}:${link.parentNoteId}`,
        noteId: link.childNoteId,
        col: parent.startCol,
        scale: childScale,
        inherited: true,
        parentNoteId: link.parentNoteId,
      })
      ends.push({
        id: `inh-deadline:${link.childNoteId}:${link.parentNoteId}`,
        noteId: link.childNoteId,
        col: parent.startCol + parent.duration,
        scale: childScale,
        inherited: true,
        parentNoteId: link.parentNoteId,
      })
    })
    return { starts, deadlines: ends }
  }, [timeSlots, noteInheritance])

  const effectiveDeadlines = useMemo(() => {
    const byKey = new Map()
    ;[...deadlines, ...inheritedWindows.deadlines].forEach(item => {
      const key = `${item.noteId}:${deadlineScaleBucket(item)}`
      const current = byKey.get(key)
      if (!current || item.col < current.col) byKey.set(key, item)
    })
    return [...byKey.values()]
  }, [deadlines, inheritedWindows.deadlines])

  const effectiveEarliestStarts = useMemo(() => {
    const byKey = new Map()
    ;[...earliestStarts, ...inheritedWindows.starts].forEach(item => {
      const key = `${item.noteId}:${earliestStartScaleBucket(item)}`
      const current = byKey.get(key)
      if (!current || item.col > current.col) byKey.set(key, item)
    })
    return [...byKey.values()]
  }, [earliestStarts, inheritedWindows.starts])

  const dependencyConstraintWindows = useMemo(() => {
    const timeSlotById = new Map(timeSlots.map(ms => [ms.id, ms]))
    const startsByNote = new Map()
    const deadlinesByNote = new Map()
    dependencies.forEach(dep => {
      const from = timeSlotById.get(dep.fromId)
      const to = timeSlotById.get(dep.toId)
      if (!from || !to) return
      const fromEnd = from.startCol + from.duration
      const incoming = startsByNote.get(to.noteId)
      if (!incoming || fromEnd > incoming.col) {
        startsByNote.set(to.noteId, {
          id: `dep-start:${to.noteId}`,
          noteId: to.noteId,
          timeSlotId: to.id,
          col: fromEnd,
          dependencyIds: [dep.id],
        })
      } else if (fromEnd === incoming.col) {
        incoming.dependencyIds.push(dep.id)
      }
      const outgoing = deadlinesByNote.get(from.noteId)
      if (!outgoing || to.startCol < outgoing.col) {
        deadlinesByNote.set(from.noteId, {
          id: `dep-deadline:${from.noteId}`,
          noteId: from.noteId,
          timeSlotId: from.id,
          col: to.startCol,
          dependencyIds: [dep.id],
        })
      } else if (to.startCol === outgoing.col) {
        outgoing.dependencyIds.push(dep.id)
      }
    })
    return {
      starts: [...startsByNote.values()],
      deadlines: [...deadlinesByNote.values()],
    }
  }, [dependencies, timeSlots])

  // ── Toolbar / mode state ───────────────────────────────────────────────────
  const [mode,              setMode]              = useState('timeSlot')
  const [activeDimId,       setActiveDimId]       = useState('')
  const [activeLaneFilterId, setActiveLaneFilterId] = useState('')
  const [axisMode, setAxisMode] = useState('full')
  const [timeZoom, setTimeZoom] = useState(DEFAULT_TIME_ZOOM)
  const [showDepLabels, setShowDepLabels] = useState(true)
  const [showDeps, setShowDeps] = useState(true)
  const [hideCrossCatDeps, setHideCrossCatDeps] = useState(false)
  const [showCrucialDepsOnly, setShowCrucialDepsOnly] = useState(false)
  const [colorDependencyDirection, setColorDependencyDirection] = useState(false)
  const [timeSlotScaleFilter, setTimeSlotScaleFilter] = useState(SCALE_VISIBILITY_MODES.ALL)
  const [showRowScheduleMarker, setShowRowScheduleMarker] = useState(true)
  const [showRowTimeSlotMeta, setShowRowTimeSlotMeta] = useState(true)
  const [timeSlotLabelMode, setTimeSlotLabelMode] = useState('date')
  const timeSlotLabelWheelAtRef = useRef(0)
  const [reasonModal, setReasonModal] = useState(null)   // null | { depId }
  const [reasonDraft, setReasonDraft] = useState('')
  const reasonInputRef = useRef()
  const [colorDimId,        setColorDimId]        = useState('')
  const [activeFilterIds, setActiveFilterIds] = useState([])
  const [quickFilters, setQuickFilters] = useState([])
  const [paintCat, setPaintCat] = useState(null)
  const [paintPersonaId, setPaintPersonaId] = useState(null)
  const [personas, setPersonas] = useState([])
  const [personaNoteAssignments, setPersonaNoteAssignments] = useState([])
  const [personaCatAssignments, setPersonaCatAssignments] = useState([])
  const { confirm: confirmDialog, dialog: confirmDialogNode } = useConfirmDialog()
  const activePersona = useMemo(() => personas.find(p => p.id === paintPersonaId) ?? null, [personas, paintPersonaId])
  const personaCursor = usePersonaCursor(activePersona)
  const [floatingPanel, setFloatingPanel] = useState(null)
  const [spacing,     setSpacing]     = useState(DEFAULT_SPACING)
  const [hiddenCatIds, setHiddenCatIds] = useState(new Set())
  const [hiddenNotesByLane, setHiddenNotesByLane] = useState({})
  const [revealedConflictNoteIds, setRevealedConflictNoteIds] = useState(new Set())
  const [visibleNoteFilterIds, setVisibleNoteFilterIds] = useState(new Set())
  const [pendingConflictTimeSlotIds, setPendingConflictTimeSlotIds] = useState(new Set())
  const [warningPrompt, setWarningPrompt] = useState(null)
  const [nostalgiaMode, setNostalgiaMode] = useState(false)
  const [blinkingDepIds, setBlinkingDepIds] = useState(new Set())
  const [blinkingTimeSlotIds, setBlinkingTimeSlotIds] = useState(new Set())
  const [pendingDependencyResolveIds, setPendingDependencyResolveIds] = useState(new Set())
  const [dependencyResolveSnapshot, setDependencyResolveSnapshot] = useState(null)
  const [deleteDraft, setDeleteDraft] = useState(null)
  const [resizeConfirmDraft, setResizeConfirmDraft] = useState(null)
  const [metricResizeDraft,  setMetricResizeDraft]  = useState(null)
  const warningPromptTimerRef = useRef(null)
  const nostalgiaModeRef = useRef(false)
  const capturePerspectiveStateRef = useRef(null)
  const restorePerspectiveSnapshotRef = useRef(null)
  const resolveDependencySelectionRef = useRef(null)
  const externalResolveHandledRef = useRef(null)
  const reportDependencyViolationsRef = useRef(null)
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

  useEffect(() => {
    if (!isActive) setNostalgiaMode(false)
  }, [isActive])

  useEffect(() => {
    setNostalgiaMode(false)
  }, [project?.id])

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
    }, WARNING_PROMPT_TIMEOUT_MS)
  }, [])

  const toggleNostalgiaMode = useCallback(async () => {
    if (nostalgiaModeRef.current) {
      setNostalgiaMode(false)
      return
    }
    const ok = await confirmDialog({
      title: 'Enable nostalgia mode?',
      message: 'You will be able to create, move, and resize time slots before today. This is temporary, turns off when you leave the schedule page, and is not saved in perspectives.',
      confirmLabel: 'Enable nostalgia',
      cancelLabel: 'Cancel',
    })
    if (ok) setNostalgiaMode(true)
  }, [confirmDialog])

	  const showPastWorkWarning = useCallback((message = 'This part of the schedule is before today. Enable nostalgia mode if you intentionally need to edit the past.') => {
	    showWarningPrompt({
	      title: 'You are in the past',
	      message,
	      actions: 'confirm',
	      confirmLabel: 'Enable nostalgia',
	      onConfirm: toggleNostalgiaMode,
	    })
	  }, [showWarningPrompt, toggleNostalgiaMode])

  const showProjectEndWarningIfNeeded = useCallback(timeSlotsToCheck => {
    const endMinute = endDateMinuteRef.current
    if (endMinute == null) return false
    const items = Array.isArray(timeSlotsToCheck) ? timeSlotsToCheck : [timeSlotsToCheck]
    const isPastEnd = items.some(item => item && Number(item.startCol) > endMinute)
    if (!isPastEnd) return false
    const label = project?.endDate
      ? new Date(`${project.endDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'the project end date'
    showWarningPrompt({
      title: 'Past project end date',
      message: `This time slot starts after ${label}. You can keep working there, but it is outside the current project window.`,
      actions: 'close',
    })
    return true
  }, [project?.endDate, showWarningPrompt])

  const activeCategories = useMemo(
    () => categories.filter(c => c.dimensionId === activeDimId),
    [categories, activeDimId]
  )

  const archivedDimensionSet = useMemo(() => new Set(archivedDimensionIds || []), [archivedDimensionIds])
  const visibleDimensions = useMemo(
    () => dimensions.filter(dim => !archivedDimensionSet.has(dim.id)),
    [dimensions, archivedDimensionSet]
  )

  useEffect(() => {
    if (activeDimId && archivedDimensionSet.has(activeDimId)) setActiveDimId('')
    if (colorDimId && archivedDimensionSet.has(colorDimId)) setColorDimId('')
  }, [activeDimId, archivedDimensionSet, colorDimId])

  const activeLaneFilter = useMemo(
    () => savedFilters.find(f => f.id === activeLaneFilterId) ?? null,
    [savedFilters, activeLaneFilterId]
  )

  const nonePerspective = useMemo(() => {
    const priorityDim = visibleDimensions.find(d => d.name === 'Priority')
    return normalizePerspective({
      id: NONE_PERSPECTIVE_ID,
      name: 'None',
      readOnly: true,
      state: {
        version: SCHEDULE_PERSPECTIVE_VERSION,
        spacing: DEFAULT_SPACING,
        timeZoom: DEFAULT_TIME_ZOOM,
        planningScale: persistedPlanningScaleForZoom(DEFAULT_TIME_ZOOM),
        mode: 'timeSlot',
        axisMode: 'full',
        showDepLabels: true,
        showDeps: true,
        hideCrossCatDeps: false,
        showCrucialDepsOnly: false,
        colorDependencyDirection: false,
        timeSlotScaleFilter: SCALE_VISIBILITY_MODES.ALL,
        scaleVisibilityMode: SCALE_VISIBILITY_MODES.ALL,
        showRowScheduleMarker: true,
        showRowTimeSlotMeta: true,
        timeSlotLabelMode: 'date',
        leftPanelWidth: 220,
        group: { activeDimId: '', activeLaneFilterId: '' },
        collapsedCategories: [],
        hiddenNotesByLane: {},
        scrollLeft: 0,
        timelineAnchorCreatedAt: project?.createdAt ?? '',
        color: {
          colorDimId: priorityDim?.id ?? '',
          activeFilterIds: [],
          quickFilters: [],
        },
      },
    })
  }, [project?.createdAt, visibleDimensions])

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
    setPaintPersonaId(null)
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

  const showOnlyCategory = useCallback(catId => {
    if (!activeDimId || !catId) return
    const next = new Set(activeCategories.map(cat => cat.id))
    next.add(UNASSIGNED_LANE)
    next.delete(catId)
    setHiddenCatIds(next)
  }, [activeCategories, activeDimId])

  const presentConflictTimeSlots = useCallback(ids => {
    const idSet = new Set(ids)
    const conflictTimeSlots = timeSlotsRef.current.filter(m => idSet.has(m.id))
    const noteIds = conflictTimeSlots.map(m => m.noteId)
    if (conflictTimeSlots.length === 0 || noteIds.length === 0) return
    const hiddenTimeSlotIds = conflictTimeSlots
      .filter(m => !noteRowMapRef.current[m.noteId])
      .map(m => m.id)
    setPendingConflictTimeSlotIds(new Set(hiddenTimeSlotIds.length ? hiddenTimeSlotIds : conflictTimeSlots.map(m => m.id)))
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
    setBlinkingTimeSlotIds(idSet)
    window.setTimeout(() => setBlinkingTimeSlotIds(new Set()), 3000)
    setSelectedDepIds(new Set())
    setSelectedIds(idSet)
  }, [activeDimId, activeLaneFilter, assignments, colorDimId])

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

  const notePersonasMap = useMemo(() => {
    const map = {}
    personaNoteAssignments.forEach(a => {
      const p = personas.find(p => p.id === a.personaId)
      if (p) (map[a.noteId] = map[a.noteId] || []).push(p)
    })
    return map
  }, [personas, personaNoteAssignments])

  const catPersonasMap = useMemo(() => {
    const map = {}
    const seen = new Set()
    const add = (categoryId, personaId) => {
      const p = personas.find(p => p.id === personaId)
      const key = `${categoryId}:${personaId}`
      if (p && !seen.has(key)) {
        seen.add(key)
        ;(map[categoryId] = map[categoryId] || []).push(p)
      }
    }
    personaCatAssignments.forEach(a => {
      add(a.categoryId, a.personaId)
    })
    personaNoteAssignments.forEach(a => {
      const noteDims = assignments[a.noteId] || {}
      Object.values(noteDims).forEach(categoryId => add(categoryId, a.personaId))
    })
    return map
  }, [assignments, personas, personaCatAssignments, personaNoteAssignments])

  const paintNote = useCallback(async noteId => {
    if (paintPersonaId) {
      setPersonaNoteAssignments(prev => [
        ...prev.filter(a => !(a.personaId === paintPersonaId && a.noteId === noteId)),
        { personaId: paintPersonaId, noteId },
      ])
      await api.assignPersonaToNote(paintPersonaId, noteId)
        .then(() => onPeopleChanged?.())
        .catch(console.error)
      return
    }
    if (!paintCat || !colorDimId || colorDimId === FILTER_DIMENSION_ID) return
    try {
      await api.assign(noteId, colorDimId, paintCat.id)
      setAssignments(prev => ({ ...prev, [noteId]: { ...(prev[noteId] ?? {}), [colorDimId]: paintCat.id } }))
    } catch (err) { console.error(err) }
  }, [colorDimId, onPeopleChanged, paintCat, paintPersonaId])

  const assignPersonaToNote = useCallback((personaId, noteId) => {
    if (!personaId || !noteId) return
    setPersonaNoteAssignments(prev => [
      ...prev.filter(a => !(a.personaId === personaId && a.noteId === noteId)),
      { personaId, noteId },
    ])
    api.assignPersonaToNote(personaId, noteId)
      .then(() => onPeopleChanged?.())
      .catch(console.error)
  }, [onPeopleChanged])

  const removePersonaFromNote = useCallback((personaId, noteId) => {
    if (!personaId || !noteId) return
    setPersonaNoteAssignments(prev => prev.filter(a => !(a.personaId === personaId && a.noteId === noteId)))
    api.unassignPersonaFromNote(personaId, noteId)
      .then(() => onPeopleChanged?.())
      .catch(console.error)
  }, [onPeopleChanged])

  const assignPersonaToLaneCategory = useCallback((personaId, catId) => {
    if (!personaId || !catId || !activeDimId || activeDimId === FILTER_DIMENSION_ID) return
    setPersonaCatAssignments(prev => [
      ...prev.filter(a => !(a.personaId === personaId && a.dimensionId === activeDimId && a.categoryId === catId)),
      { personaId, dimensionId: activeDimId, categoryId: catId },
    ])
    api.assignPersona(personaId, activeDimId, catId)
      .then(() => onPeopleChanged?.())
      .catch(console.error)
  }, [activeDimId, onPeopleChanged])

  const removePersonaFromLaneCategory = useCallback(async (personaId, catId) => {
    if (!personaId || !catId || !activeDimId || activeDimId === FILTER_DIMENSION_ID) return
    const affectedNoteIds = Object.entries(assignments)
      .filter(([noteId, dims]) =>
        dims?.[activeDimId] === catId &&
        personaNoteAssignments.some(a => a.personaId === personaId && a.noteId === noteId)
      )
      .map(([noteId]) => noteId)
    const affectedNotes = affectedNoteIds
      .map(noteId => notes.find(note => note.id === noteId))
      .filter(Boolean)
    const personaName = personas.find(p => p.id === personaId)?.name || 'this person'
    const categoryName = categories.find(c => c.id === catId)?.name || 'this category'
    const ok = await confirmDialog({
      title: `Remove ${personaName} from ${categoryName}?`,
      message: 'This will also unassign them from these notes:',
      items: affectedNotes.map(note => note.title || 'Untitled'),
      emptyText: 'No note assignments in this category will be removed.',
      confirmLabel: 'Remove person',
    })
    if (!ok) return
    setPersonaCatAssignments(prev => prev.filter(a => !(a.personaId === personaId && a.dimensionId === activeDimId && a.categoryId === catId)))
    setPersonaNoteAssignments(prev => prev.filter(a => !(a.personaId === personaId && affectedNoteIds.includes(a.noteId))))
    Promise.all([
      api.unassignPersona(personaId, activeDimId, catId),
      ...affectedNoteIds.map(noteId => api.unassignPersonaFromNote(personaId, noteId)),
    ])
      .then(() => onPeopleChanged?.())
      .catch(console.error)
  }, [activeDimId, assignments, categories, confirmDialog, notes, onPeopleChanged, personaNoteAssignments, personas])

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
  const [pinnedTimeSlotId, setPinnedTimeSlotId] = useState(null)
  const [contextMenu,  setContextMenu]  = useState(null)
  const [inheritanceInspectorNoteId, setInheritanceInspectorNoteId] = useState(null)
  const [clickedNoteId, setClickedNoteId] = useState(null)
  const [copiedNoteId, setCopiedNoteId] = useState(null)
  const [inheritancePick, setInheritancePick] = useState(null)

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
  const dragAutoScrollRef = useRef(null)
  const yWheelZoomRef     = useRef(false)
  const inheritancePickRef = useRef(null)
  const completeInheritancePickRef = useRef(null)
  const timeSlotElsRef = useRef(new Map())      // id → DOM element
  const hoveredCellRef  = useRef(null)
  const drawingRef      = useRef(null)           // { fromId } sync access during drawing
  const previewArrowRef = useRef(null)           // SVG path element for live preview
  const depPathElsRef   = useRef(new Map())      // dependency id -> SVG path element
  const dependenciesRef = useRef([])
  const deadlinesRef    = useRef([])
  const earliestStartsRef = useRef([])
  const modeRef         = useRef('timeSlot')
  const timeSlotScaleFilterRef = useRef(SCALE_VISIBILITY_MODES.ALL)

  // Keep imperative refs in sync with state (assigned synchronously in render)
  spacingRef.current       = spacing
  timeZoomRef.current      = timeZoom
  totalColsRef.current     = totalCols
  dependenciesRef.current  = dependencies
  deadlinesRef.current       = effectiveDeadlines
  earliestStartsRef.current  = effectiveEarliestStarts
  modeRef.current            = mode
  nostalgiaModeRef.current   = nostalgiaMode
  timeSlotScaleFilterRef.current = normalizeScaleVisibilityMode(timeSlotScaleFilter)

  // Derived today/end-date columns at the current zoom level (re-evaluated every render)
  const todayZoomCol        = minuteToZoomCol(todayMinute, timeZoom)
  const endDateZoomCol      = endDateMinute != null ? minuteToZoomCol(endDateMinute, timeZoom) : null
  const effectiveTodayZoomCol = Math.max(0, todayZoomCol)

	  const visualRangeFor = useCallback(item => getRenderedVisualRange(item, timeZoomRef.current, timeSlotScaleFilterRef.current), [])
	  const visualColToMinute = useCallback(col => zoomColToMinute(col, timeZoomRef.current), [])
	  const minuteLabel = useCallback(minute => minuteToLabel(minute, timeZoomRef.current), [])
	  const defaultScrollLeftForZoom = useCallback((zoom = timeZoomRef.current, colW = spacingRef.current.colW) => {
	    const normalizedZoom = normalizeTimeZoom(zoom)
	    const todayCol = minuteToZoomColExact(todayMinuteRef.current, normalizedZoom)
	    return Math.max(0, Math.round(todayCol * colW))
	  }, [])

  // Live refs that closures read — no useEffect needed
  const timeSlotsRef  = useRef([])
  timeSlotsRef.current = timeSlots
  const selectedIdsRef = useRef(new Set())
  selectedIdsRef.current = selectedIds
  const selectedDepIdsRef = useRef(new Set())
  selectedDepIdsRef.current = selectedDepIds
  const pinnedTimeSlotIdRef = useRef(null)
  pinnedTimeSlotIdRef.current = pinnedTimeSlotId
  inheritancePickRef.current = inheritancePick

  const applyTransactionState = useCallback((nextState, previousState = {}) => {
    const next = normalizeTransactionState(nextState)
    const previous = normalizeTransactionState(previousState)
    const touchedMsIds = new Set([...previous.timeSlots, ...next.timeSlots].map(m => m.id))
    const touchedDepIds = new Set([...previous.dependencies, ...next.dependencies].map(d => d.id))
    const nextMsById = new Map(next.timeSlots.map(m => [m.id, m]))
    const nextDepById = new Map(next.dependencies.map(d => [d.id, d]))
    setTimeSlots(prev => {
      const existingIds = new Set(prev.map(m => m.id))
      return [
        ...prev.flatMap(m => {
          if (!touchedMsIds.has(m.id)) return [m]
          return nextMsById.has(m.id) ? [nextMsById.get(m.id)] : []
        }),
        ...next.timeSlots.filter(m => !existingIds.has(m.id)),
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
    const [mss, deps, history, assigns] = await Promise.all([
      api.getTimeSlots(),
      api.getDependencies(),
      api.getTransactionHistory(),
      api.getAssignments(),
    ])
    setTimeSlots(mss)
    setDependencies(deps)
    setTransactionHistory(history)
    applyAssignments(assigns)
  }, [])

  const showTransactionFailure = useCallback(err => {
    const detail = err?.message || 'The backend rejected this transaction.'
    showWarningPrompt({ title: 'Transaction rejected', message: detail })
  }, [showWarningPrompt])

  const getDeadlineViolationContext = useCallback((timeSlotIds = []) => {
    const affectedIds = new Set(timeSlotIds.filter(Boolean))
    const resolveIds = new Set(affectedIds)
    let inheritedCount = 0
    let explicitCount = 0
    let projectStartCount = 0

    affectedIds.forEach(id => {
      const timeSlot = timeSlotsRef.current.find(m => m.id === id)
      const deadline = findApplicableDeadline(deadlinesRef.current, timeSlot)
      if (!deadline) {
        projectStartCount += 1
        return
      }
      if (deadline.inherited) {
        inheritedCount += 1
        const parentTimeSlot = timeSlotsRef.current.find(m => m.noteId === deadline.parentNoteId)
        if (parentTimeSlot) resolveIds.add(parentTimeSlot.id)
      } else {
        explicitCount += 1
      }
    })

    return { affectedIds, resolveIds, inheritedCount, explicitCount, projectStartCount }
  }, [])

  const showDeadlineViolationPrompt = useCallback((timeSlotIds = [], fallbackMessage = '') => {
    const { affectedIds, resolveIds, inheritedCount, explicitCount, projectStartCount } = getDeadlineViolationContext(timeSlotIds)
    const ids = resolveIds.size ? resolveIds : affectedIds
    if (ids.size) {
      setPendingConflictTimeSlotIds(ids)
      setPendingDependencyResolveIds(ids)
      setBlinkingTimeSlotIds(ids)
      window.setTimeout(() => setBlinkingTimeSlotIds(new Set()), 3000)
    }

    let title = 'Hard deadline'
    let message = fallbackMessage || "This time slot cannot move before the project start or past its note's hard deadline."
    if (inheritedCount > 0) {
      title = 'Inherited hard deadline'
      message = fallbackMessage || 'This time slot is bounded by its parent time slot. Resolve shows both the child and parent time slots.'
    } else if (explicitCount > 0 && projectStartCount === 0) {
      message = fallbackMessage || 'This time slot cannot move past its hard deadline. Resolve shows the affected time slot so you can adjust the deadline if needed.'
    }

    showWarningPrompt({
      title,
      message,
      actions: ids.size ? 'resolve' : 'close',
      timeSlotIds: ids,
      replaceSelection: true,
    })
  }, [getDeadlineViolationContext, showWarningPrompt])

  const getEarliestStartViolationContext = useCallback((timeSlotIds = []) => {
    const affectedIds = new Set(timeSlotIds.filter(Boolean))
    const resolveIds = new Set(affectedIds)
    let inheritedCount = 0
    let explicitCount = 0

    affectedIds.forEach(id => {
      const timeSlot = timeSlotsRef.current.find(m => m.id === id)
      const earliestStart = findApplicableEarliestStart(earliestStartsRef.current, timeSlot)
      if (!earliestStart) return
      if (earliestStart.inherited) {
        inheritedCount += 1
        const parentTimeSlot = timeSlotsRef.current.find(m => m.noteId === earliestStart.parentNoteId)
        if (parentTimeSlot) resolveIds.add(parentTimeSlot.id)
      } else {
        explicitCount += 1
      }
    })

    return { affectedIds, resolveIds, inheritedCount, explicitCount }
  }, [])

  const showEarliestStartViolationPrompt = useCallback((timeSlotIds = [], fallbackMessage = '') => {
    const { affectedIds, resolveIds, inheritedCount, explicitCount } = getEarliestStartViolationContext(timeSlotIds)
    const ids = resolveIds.size ? resolveIds : affectedIds
    if (ids.size) {
      setPendingConflictTimeSlotIds(ids)
      setPendingDependencyResolveIds(ids)
      setBlinkingTimeSlotIds(ids)
      window.setTimeout(() => setBlinkingTimeSlotIds(new Set()), 3000)
    }

    let title = 'Earliest start date'
    let message = fallbackMessage || "This time slot cannot start before the row's earliest start date."
    if (inheritedCount > 0) {
      title = 'Inherited earliest start'
      message = fallbackMessage || 'This time slot is bounded by its parent time slot. Resolve shows both the child and parent time slots.'
    } else if (explicitCount > 0) {
      message = fallbackMessage || 'This time slot cannot move before its earliest start date. Resolve shows the affected time slot so you can adjust the start boundary if needed.'
    }

    showWarningPrompt({
      title,
      message,
      actions: ids.size ? 'resolve' : 'close',
      timeSlotIds: ids,
      replaceSelection: true,
    })
  }, [getEarliestStartViolationContext, showWarningPrompt])

  const commitTransaction = useCallback(async transaction => {
    const before = normalizeTransactionState(transaction.before)
    const after = normalizeTransactionState(transaction.after)
    applyTransactionState(after, before)
    try {
      const result = await api.applyTransaction({ ...transaction, before, after })
      setTransactionHistory(result.history)
      await refreshGanttTransactions()
      const txSoundMap = {
        'timeSlot.create':    'timeSlotCreate',
        'timeSlot.move':      'timeSlotMove',
        'timeSlot.move-many': 'timeSlotMove',
        'timeSlot.resize':    'timeSlotResize',
        'timeSlot.delete':    'timeSlotDelete',
        'dependency.create':  'dependencyCreate',
        'dependency.delete':  'dependencyDelete',
        'dependency.update':  'dependencySelect',
        'delete-many':        'timeSlotDelete',
      }
      const txSound = txSoundMap[transaction.type]
      if (txSound) playSound(txSound)
      return true
    } catch (err) {
      console.error(err)
      applyTransactionState(before, after)
      const detail = err?.detail
      if (detail?.type === 'overlap' && Array.isArray(detail.timeSlotIds)) {
        showWarningPrompt({ title: 'Transaction rejected', message: detail.message, actions: 'close' })
      } else if (detail?.type === 'deadline' || detail?.type === 'inheritance_deadline') {
        showDeadlineViolationPrompt([detail.id].filter(Boolean), detail.message)
      } else if (detail?.type === 'earliest_start' || detail?.type === 'inheritance_earliest_start') {
        showEarliestStartViolationPrompt([detail.id].filter(Boolean), detail.message)
      } else if (detail?.type === 'dependency' || detail?.type === 'scale_mismatch') {
        const depIds = detail.dependencyIds ?? []
        const attemptedTimeSlots = [
          ...timeSlotsRef.current.filter(m => !after.timeSlots.some(next => next.id === m.id)),
          ...after.timeSlots,
        ]
        const attemptedDependencies = [
          ...dependenciesRef.current.filter(d => !after.dependencies.some(next => next.id === d.id)),
          ...after.dependencies,
        ]
        const msMap = Object.fromEntries(attemptedTimeSlots.map(m => [m.id, m]))
        const depMap = Object.fromEntries(attemptedDependencies.map(d => [d.id, d]))
        const violations = depIds
          .map(depId => {
            const dep = depMap[depId]
            const from = dep && msMap[dep.fromId]
            const to = dep && msMap[dep.toId]
            return dep && from && to ? { dep, from, to } : null
          })
          .filter(Boolean)
        if (violations.length) reportDependencyViolationsRef.current?.(violations, attemptedTimeSlots, attemptedDependencies)
        else showWarningPrompt({ title: 'Dependency violation', message: detail.message, actions: 'dependency', dependencyIds: depIds })
      } else {
        showTransactionFailure(err)
      }
      return false
    }
  }, [applyTransactionState, refreshGanttTransactions, showDeadlineViolationPrompt, showEarliestStartViolationPrompt, showTransactionFailure, showWarningPrompt])

  const undoGanttTransaction = useCallback(async () => {
    try {
      await api.undoTransaction()
      playSound('scheduleUndoRedo')
      await refreshGanttTransactions()
    } catch (err) {
      console.error(err)
      showTransactionFailure(err)
    }
  }, [refreshGanttTransactions, showTransactionFailure])

  const redoGanttTransaction = useCallback(async () => {
    try {
      await api.redoTransaction()
      playSound('scheduleUndoRedo')
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
    () => [...visibleDimensions, { id: FILTER_DIMENSION_ID, name: 'Filters', dynamic: true }],
    [visibleDimensions]
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
  const timeSlotByNote = useMemo(() => new Map(timeSlots.map(m => [m.noteId, m])), [timeSlots])
  const timeSlotByNoteRef = useRef(new Map())
  timeSlotByNoteRef.current = timeSlotByNote

  useEffect(() => {
    if (selectedIds.size === 0) return
    const timeSlotById = new Map(timeSlots.map(m => [m.id, m]))
    let changed = false
    const next = new Set()
    selectedIds.forEach(msId => {
      const timeSlot = timeSlotById.get(msId)
      if (timeSlot && noteRowMap[timeSlot.noteId]) {
        next.add(msId)
      } else {
        changed = true
      }
    })
    if (changed) setSelectedIds(next)
  }, [noteRowMap, timeSlots, selectedIds])

  useEffect(() => {
    if (!pinnedTimeSlotId) return
    if (!timeSlots.some(m => m.id === pinnedTimeSlotId)) setPinnedTimeSlotId(null)
  }, [timeSlots, pinnedTimeSlotId])

  useEffect(() => {
    if (pendingConflictTimeSlotIds.size === 0) return
    const conflictMs = timeSlots.filter(m => pendingConflictTimeSlotIds.has(m.id) && noteRowMap[m.noteId])
    if (conflictMs.length === 0) return
    const target = conflictMs[0]
    const row = noteRowMap[target.noteId]
    const earliest = conflictMs.reduce((min, m) => m.startCol < min.startCol ? m : min, conflictMs[0])
    requestAnimationFrame(() => {
      const el = gridBodyRef.current
      if (!el) return
      const sp = spacingRef.current
      const inset = Math.max(40, Math.floor(vpRef.current.h * 0.25))
      const nextTop = Math.max(0, row.top - inset)
      el.scrollTop = nextTop
      scrollTopRef.current = el.scrollTop
      if (leftBodyInnerRef.current) leftBodyInnerRef.current.style.transform = `translateY(${-el.scrollTop}px)`
      setScrollTop(el.scrollTop)
      const visual = getVisualRange(earliest, timeZoomRef.current)
      const nextLeft = Math.max(0, visual.startCol * sp.colW - sp.colW * 2)
      el.scrollLeft = nextLeft
      scrollLeftRef.current = el.scrollLeft
      setScrollLeft(el.scrollLeft)
      setPendingConflictTimeSlotIds(new Set())
    })
  }, [noteRowMap, timeSlots, pendingConflictTimeSlotIds])

  const selectedNoteIds = useMemo(() => {
    const set = new Set()
    selectedIds.forEach(msId => {
      const m = timeSlots.find(m => m.id === msId)
      if (m) set.add(m.noteId)
    })
    return set
  }, [selectedIds, timeSlots])

  const activeNoteIdForCopy = clickedNoteId || (selectedNoteIds.size === 1 ? [...selectedNoteIds][0] : null)

  const copyNoteToScheduleClipboard = useCallback(noteId => {
    if (!noteId) return
    setCopiedNoteId(noteId)
    setClickedNoteId(noteId)
  }, [])

  const duplicateNoteInSchedule = useCallback(async noteId => {
    if (!noteId) return
    try {
      const result = await api.duplicateNote(noteId)
      if (result?.note) {
        setClickedNoteId(result.note.id)
        if (!onNotesChanged) onNoteCreated?.(result.note)
      }
      await onNotesChanged?.()
      await refreshScheduleData()
    } catch (err) {
      console.error(err)
      showWarningPrompt({
        title: 'Copy note failed',
        message: err?.message || 'The selected note could not be copied.',
        actions: 'close',
      })
    }
  }, [onNoteCreated, onNotesChanged, refreshScheduleData, showWarningPrompt])

  const createNoteInLane = useCallback(async categoryId => {
    if (!activeDimId) return
    const targetCatId = categoryId === UNASSIGNED_LANE ? null : categoryId
    try {
      const note = await api.createNote({
        id: newClientId('note'),
        title: 'Untitled',
        html: '',
        collapsed: false,
      })
      if (targetCatId) await api.assign(note.id, activeDimId, targetCatId)
      setClickedNoteId(note.id)
      if (!onNotesChanged) onNoteCreated?.(note)
      playSound('noteCreate')
      await onNotesChanged?.()
      await refreshScheduleData()
      requestAnimationFrame(() => onNoteOpen?.(note.id))
    } catch (err) {
      console.error(err)
      showWarningPrompt({
        title: 'Create note failed',
        message: err?.message || 'The note could not be created for this category.',
        actions: 'close',
      })
    }
  }, [activeDimId, onNoteCreated, onNoteOpen, onNotesChanged, refreshScheduleData, showWarningPrompt])

  const pasteCopiedNote = useCallback(async () => {
    if (!copiedNoteId) return
    await duplicateNoteInSchedule(copiedNoteId)
  }, [copiedNoteId, duplicateNoteInSchedule])

  const startInheritancePick = useCallback((noteId, direction) => {
    if (!noteId) return
    setInheritancePick({ noteId, direction })
    setClickedNoteId(noteId)
    showWarningPrompt({
      title: direction === 'child' ? 'Pick parent note' : 'Pick child note',
      message: direction === 'child'
        ? 'Click the note or time slot this note should inherit from.'
        : 'Click the note or time slot that should inherit from this note.',
      actions: 'close',
    })
  }, [showWarningPrompt])

  const completeInheritancePick = useCallback(async targetNoteId => {
    const draft = inheritancePickRef.current
    if (!draft || !targetNoteId) return false
    if (draft.noteId === targetNoteId) {
      showWarningPrompt({ title: 'Inheritance not changed', message: 'A note cannot inherit from itself.', actions: 'close' })
      return true
    }
    const childNoteId = draft.direction === 'child' ? draft.noteId : targetNoteId
    const parentNoteId = draft.direction === 'child' ? targetNoteId : draft.noteId
    try {
      const saved = await api.setNoteInheritance(childNoteId, parentNoteId)
      setNoteInheritance(prev => [
        ...prev.filter(link => !(link.childNoteId === saved.childNoteId && link.parentNoteId === saved.parentNoteId)),
        saved,
      ])
      setClickedNoteId(childNoteId)
      setInheritancePick(null)
      clearWarningPrompt()
      playSound('inheritanceLink')
      await refreshScheduleData()
      return true
    } catch (err) {
      console.error(err)
      showWarningPrompt({
        title: 'Inheritance rejected',
        message: err?.message || 'This inheritance relationship is not valid.',
        actions: 'close',
      })
      return true
    }
  }, [clearWarningPrompt, refreshScheduleData, showWarningPrompt])

  completeInheritancePickRef.current = completeInheritancePick

  const removeInheritanceLink = useCallback(async (childNoteId, parentNoteId) => {
    try {
      await api.removeNoteInheritance(childNoteId, parentNoteId)
      playSound('inheritanceUnlink')
      setNoteInheritance(prev => prev.filter(link => !(link.childNoteId === childNoteId && link.parentNoteId === parentNoteId)))
      await refreshScheduleData()
    } catch (err) {
      console.error(err)
      showWarningPrompt({
        title: 'Inheritance not removed',
        message: err?.message || 'Could not remove this inheritance relationship.',
        actions: 'close',
      })
    }
  }, [refreshScheduleData, showWarningPrompt])

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

  const filterScheduleToPersona = useCallback(personaId => {
    if (!personaId) return
    const noteIds = new Set(
      personaNoteAssignments
        .filter(assignment => assignment.personaId === personaId)
        .map(assignment => assignment.noteId)
    )
    notes.forEach(note => {
      const noteDimensions = assignments[note.id] || {}
      const hasCategoryResponsibility = personaCatAssignments.some(assignment =>
        assignment.personaId === personaId &&
        noteDimensions[assignment.dimensionId] === assignment.categoryId
      )
      if (hasCategoryResponsibility) noteIds.add(note.id)
    })
    applyNoteVisibilityFilter(noteIds)
  }, [applyNoteVisibilityFilter, assignments, notes, personaCatAssignments, personaNoteAssignments])

  const expandEverything = useCallback(() => {
    setVisibleNoteFilterIds(new Set())
    setHiddenCatIds(new Set())
    setHiddenNotesByLane({})
  }, [])

  const resolveDependencySelection = useCallback((timeSlotIds = null, resolveZoom = null, options = {}) => {
    const explicitIds = timeSlotIds ? new Set(timeSlotIds) : null
    const idsToResolve = explicitIds?.size > 0
      ? explicitIds
      : pendingDependencyResolveIds.size > 0
      ? pendingDependencyResolveIds
      : selectedIdsRef.current
    const shouldAccumulate = options.accumulate !== false
    const accumulatedIds = shouldAccumulate
      ? new Set([...selectedIdsRef.current, ...idsToResolve])
      : new Set(idsToResolve)
    const noteIds = new Set()
    accumulatedIds.forEach(msId => {
      const timeSlot = timeSlotsRef.current.find(m => m.id === msId)
      if (timeSlot) noteIds.add(timeSlot.noteId)
    })
    if (options.captureSnapshot !== false) {
      const snapshot = capturePerspectiveStateRef.current?.()
      if (snapshot) setDependencyResolveSnapshot(prev => prev ?? snapshot)
    }
    if (resolveZoom) {
      const nextZoom = normalizeTimeZoom(resolveZoom)
      timeZoomRef.current = nextZoom
      setTimeZoom(nextZoom)
      const minColW = minColWidthForZoom(nextZoom)
      if (spacingRef.current.colW < minColW) setSpacing(prev => ({ ...prev, colW: minColW }))
    }
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

  useEffect(() => {
    if (!isActive || !externalResolveRequest?.id || timeSlots.length === 0) return
    if (externalResolveHandledRef.current === externalResolveRequest.id) return
    const requestedIds = externalResolveRequest.timeSlotIds ?? []
    if (requestedIds.length > 0 && !requestedIds.every(id => timeSlots.some(timeSlot => timeSlot.id === id))) return
    externalResolveHandledRef.current = externalResolveRequest.id
    setDependencyResolveSnapshot(null)
    if (externalResolveRequest.mode === 'inspect') {
      const context = externalResolveRequest.calendarContext ?? {}
      const nextDimId = visibleDimensions.some(dimension => dimension.id === context.canvasDimId) ? context.canvasDimId : ''
      const nextColorDimId = visibleDimensions.some(dimension => dimension.id === context.colorDimId) ? context.colorDimId : ''
      const hidden = new Set(Array.isArray(context.hiddenCatIds) ? context.hiddenCatIds : [])
      if (context.focusedCatId && nextDimId) {
        categories
          .filter(category => category.dimensionId === nextDimId && category.id !== context.focusedCatId)
          .forEach(category => hidden.add(category.id))
        if (context.focusedCatId !== UNASSIGNED_LANE) hidden.add(UNASSIGNED_LANE)
      }
      const zoom = externalResolveRequest.timeScale === 'month'
        ? 'months'
        : externalResolveRequest.timeScale === 'day' ? 'days' : 'minutes'
      restoringPerspectiveRef.current = nextDimId !== activeDimId || activeLaneFilterId !== ''
      restoringColorRef.current = nextColorDimId !== colorDimId
      timeZoomRef.current = zoom
      setTimeZoom(zoom)
      setSpacing(prev => ({ ...prev, colW: Math.max(prev.colW, minColWidthForZoom(zoom)) }))
      setActiveDimId(nextDimId)
      setActiveLaneFilterId('')
      setHiddenCatIds(hidden)
      setHiddenNotesByLane({})
      setVisibleNoteFilterIds(new Set(context.visibleNoteIds ?? []))
      setColorDimId(nextColorDimId)
      setActiveFilterIds([])
      setQuickFilters([])
      setPaintCat(null)
      setPaintPersonaId(null)
      setSelectedDepIds(new Set())
      setSelectedIds(new Set(requestedIds))
      setPinnedTimeSlotId(requestedIds[0] ?? null)
      setPendingConflictTimeSlotIds(new Set(requestedIds))
      setActivePerspectiveId(NONE_PERSPECTIVE_ID)
      clearWarningPrompt()
      return
    }
    const conflictNoteIds = new Set(
      requestedIds
        .map(id => timeSlots.find(timeSlot => timeSlot.id === id)?.noteId)
        .filter(Boolean)
    )
    restoringPerspectiveRef.current = activeDimId !== '' || activeLaneFilterId !== ''
    restoringColorRef.current = colorDimId !== ''
    timeZoomRef.current = 'minutes'
    setTimeZoom('minutes')
    setSpacing(prev => ({ ...prev, colW: Math.max(prev.colW, minColWidthForZoom('minutes')) }))
    setMode('timeSlot')
    setActiveDimId('')
    setActiveLaneFilterId('')
    setColorDimId('')
    setActiveFilterIds([])
    setQuickFilters([])
    setVisibleNoteFilterIds(conflictNoteIds)
    setHiddenCatIds(new Set())
    setHiddenNotesByLane({})
    setRevealedConflictNoteIds(new Set())
    setPaintCat(null)
    setPaintPersonaId(null)
    setShowDeps(true)
    setHideCrossCatDeps(false)
    setShowCrucialDepsOnly(false)
    setSelectedDepIds(new Set())
    setSelectedIds(new Set(requestedIds))
    setPinnedTimeSlotId(requestedIds[0] ?? null)
    setPendingConflictTimeSlotIds(new Set(requestedIds))
    setPendingDependencyResolveIds(new Set())
    setActivePerspectiveId(NONE_PERSPECTIVE_ID)
    clearWarningPrompt()
  }, [externalResolveRequest, isActive, resolveDependencySelection, timeSlots.length, dimensions, categories, activeDimId, activeLaneFilterId, colorDimId, clearWarningPrompt])

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

  const getTimeSlotColor = useCallback(timeSlot => {
    if (!colorDimId) return timeSlot.color
    if (colorDimId === FILTER_DIMENSION_ID) {
      const match = filterCategories.find(cat => filterMatchesNote(savedFilters.find(f => f.id === cat.filterId), timeSlot.noteId, assignments))
      return match?.color ?? null
    }
    const catId = assignments[timeSlot.noteId]?.[colorDimId]
    if (!catId) return null
    return categories.find(c => c.id === catId)?.color ?? null
  }, [assignments, categories, colorDimId, filterCategories, savedFilters])

  // Color for the note row indicator dot — same logic as timeSlots but returns null when unassigned
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
    const from = overrides[dep.fromId] ?? timeSlotsRef.current.find(m => m.id === dep.fromId)
    const to   = overrides[dep.toId]   ?? timeSlotsRef.current.find(m => m.id === dep.toId)
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

  // Violations: recomputed whenever timeSlots or dependencies change
  const violationIds = useMemo(() => computeViolations(timeSlots, dependencies), [timeSlots, dependencies])
  const crucialDependencyIds = useMemo(() => getCrucialDependencyIds(dependencies), [dependencies])

  const reportBoundaryViolation = useCallback((title, message, timeSlotIds = []) => {
    const ids = new Set(timeSlotIds.filter(Boolean))
    if (ids.size) {
      setPendingConflictTimeSlotIds(ids)
      setPendingDependencyResolveIds(ids)
      setBlinkingTimeSlotIds(ids)
      window.setTimeout(() => setBlinkingTimeSlotIds(new Set()), 3000)
    }
    showWarningPrompt({
      title,
      message,
      actions: ids.size ? 'resolve' : 'close',
      timeSlotIds: ids,
    })
  }, [showWarningPrompt])

  const reportDeadlineViolation = useCallback((timeSlotIds = []) => {
    showDeadlineViolationPrompt(timeSlotIds)
  }, [showDeadlineViolationPrompt])

  const getHardDeadlineContactIds = useCallback((timeSlotsToCheck = []) => {
    return timeSlotsToCheck
      .filter(timeSlot => {
        const deadline = findApplicableDeadline(deadlinesRef.current, timeSlot)
        if (!deadline) return false
        return timeSlot.startCol + timeSlot.duration >= deadline.col
      })
      .map(timeSlot => timeSlot.id)
  }, [])

  const reportEarliestStartViolation = useCallback((timeSlotIds = []) => {
    showEarliestStartViolationPrompt(timeSlotIds)
  }, [showEarliestStartViolationPrompt])

  const getEarliestStartContactIds = useCallback((timeSlotsToCheck = []) => {
    return timeSlotsToCheck
      .filter(timeSlot => {
        const earliestStart = findApplicableEarliestStart(earliestStartsRef.current, timeSlot)
        if (!earliestStart) return false
        return timeSlot.startCol <= earliestStart.col
      })
      .map(timeSlot => timeSlot.id)
  }, [])

  const reportDependencyViolations = useCallback((violations, allTimeSlots = timeSlotsRef.current, allDependencies = dependenciesRef.current) => {
    const conflict = getCascadingDependencyConflict(allTimeSlots, allDependencies, violations)
    const depIds = conflict.depIds
    const timeSlotIds = conflict.timeSlotIds
    const conflictTimeSlots = allTimeSlots.filter(m => timeSlotIds.has(m.id))
    const smallestDuration = conflictTimeSlots.length ? Math.min(...conflictTimeSlots.map(m => m.duration)) : 0

    setSelectedDepIds(new Set(depIds))
    setPendingConflictTimeSlotIds(timeSlotIds)
    setPendingDependencyResolveIds(timeSlotIds)
    setBlinkingDepIds(new Set(depIds))
    setBlinkingTimeSlotIds(new Set(timeSlotIds))
    window.setTimeout(() => setBlinkingDepIds(new Set()), 3000)
    window.setTimeout(() => setBlinkingTimeSlotIds(new Set()), 3000)
    showWarningPrompt({
      title: 'Dependency violation',
      message: conflict.violations.some(v => v.type === 'scale_mismatch')
        ? conflict.violations.length === 1
          ? 'Dependency scale mismatch. Dependencies can only link time slots on the same planning scale.'
          : `${conflict.violations.length} dependency constraints were violated, including scale mismatch.`
        : conflict.violations.length === 1
          ? 'A predecessor time slot must finish before its successor starts.'
          : `${conflict.violations.length} dependency constraints were violated.`,
      actions: 'dependency',
      dependencyIds: depIds,
      timeSlotIds,
      resolveZoom: zoomForConflictGap(smallestDuration),
    })
  }, [showWarningPrompt])
  reportDependencyViolationsRef.current = reportDependencyViolations

  const maybeBlockDependencyWarning = useCallback((nextTimeSlots, nextDependencies) => {
    const violations = getDependencyViolations(nextTimeSlots, nextDependencies)
    if (violations.length === 0) return false
    reportDependencyViolations(violations, nextTimeSlots, nextDependencies)
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
    if (modeRef.current !== 'timeSlot') {
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
    if (timeSlotByNoteRef.current.has(item.note.id)) {
      hoveredCellRef.current = null
      if (highlightRef.current) highlightRef.current.style.display = ''
      return
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
    if (previewArrowRef.current) previewArrowRef.current.style.display = 'none'
  }, [])

  // ── Spacing change ─────────────────────────────────────────────────────────
  const handleSpacingChange = useCallback(next => {
    next = {
      ...next,
      colW: Math.max(minColWidthForZoom(timeZoomRef.current), Math.min(COL_WIDTH_MAX, Number(next.colW) || DEFAULT_SPACING.colW)),
    }
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

  const handleGridWheel = useCallback(e => {
    if (!yWheelZoomRef.current) return
    const el = gridBodyRef.current
    if (!el) return
    e.preventDefault()
    e.stopPropagation()
    const prev = spacingRef.current
    const factor = Math.exp(-e.deltaY * 0.002)
    const rawNextColW = Math.round(prev.colW * factor)
    const currentZoom = normalizeTimeZoom(timeZoomRef.current)
    const nextColW = Math.max(minColWidthForZoom(currentZoom), Math.min(COL_WIDTH_MAX, rawNextColW))
    if (nextColW === prev.colW) return

    const anchorMinute = zoomColToMinute(scrollLeftRef.current / prev.colW, currentZoom)
    const nextScrollLeft = Math.max(0, Math.round(minuteToZoomColExact(anchorMinute, currentZoom) * nextColW))
    const needed = Math.ceil((nextScrollLeft + vpRef.current.w) / nextColW) + COL_BUF + EDGE_COLS + 1
    if (needed > totalColsRef.current) {
      totalColsRef.current = needed
      setTotalCols(needed)
    }
    if (gridInnerRef.current) {
      const widthCols = Math.max(totalColsRef.current, needed)
      gridInnerRef.current.style.width = `${widthCols * nextColW}px`
    }
    el.scrollLeft = nextScrollLeft
    scrollLeftRef.current = el.scrollLeft
    setScrollLeft(scrollLeftRef.current)
    setSpacing({ ...prev, colW: nextColW })
  }, [])

  const cycleTimeSlotLabelMode = useCallback(deltaY => {
    const now = Date.now()
    if (now - timeSlotLabelWheelAtRef.current < 180) return
    timeSlotLabelWheelAtRef.current = now
    const direction = deltaY > 0 ? 1 : -1
    setTimeSlotLabelMode(current => {
      const index = TIME_SLOT_LABEL_MODES.findIndex(mode => mode.value === current)
      const nextIndex = (Math.max(0, index) + direction + TIME_SLOT_LABEL_MODES.length) % TIME_SLOT_LABEL_MODES.length
      return TIME_SLOT_LABEL_MODES[nextIndex].value
    })
  }, [])

  useEffect(() => {
    const grid = gridBodyRef.current
    if (!grid) return
    const handleTimeSlotWheel = event => {
      if (!event.target.closest?.('[data-ms-id]')) return
      event.preventDefault()
      event.stopPropagation()
      cycleTimeSlotLabelMode(event.deltaY)
    }
    grid.addEventListener('wheel', handleTimeSlotWheel, { passive: false, capture: true })
    return () => grid.removeEventListener('wheel', handleTimeSlotWheel, { capture: true })
  }, [cycleTimeSlotLabelMode])

  const handleTimeZoomChange = useCallback(nextZoom => {
    nextZoom = normalizeTimeZoom(nextZoom)
    const prevZoom = timeZoomRef.current
    if (nextZoom === prevZoom) return
    const sp = spacingRef.current
    const nextColW = Math.max(minColWidthForZoom(nextZoom), sp.colW)
    const pinned = pinnedTimeSlotIdRef.current
      ? timeSlotsRef.current.find(m => m.id === pinnedTimeSlotIdRef.current)
      : null
    const selectedAnchor = [...selectedIdsRef.current]
      .map(id => timeSlotsRef.current.find(m => m.id === id))
      .find(Boolean)
    const anchor = pinned ?? selectedAnchor
	    const currentMinute = anchor
	      ? anchor.startCol + anchor.duration / 2
	      : todayMinuteRef.current
    const anchorLeft = minuteToZoomColExact(currentMinute, nextZoom) * nextColW
    const nextScrollLeft = Math.max(0, Math.round(anchor ? anchorLeft - vpRef.current.w / 2 : anchorLeft))
    const needed = Math.ceil((nextScrollLeft + vpRef.current.w) / nextColW) + COL_BUF + EDGE_COLS + 1
    if (needed > totalColsRef.current) {
      totalColsRef.current = needed
      setTotalCols(needed)
      if (gridInnerRef.current) gridInnerRef.current.style.width = `${needed * nextColW}px`
    }
    setTimeZoom(nextZoom)
    if (nextColW !== sp.colW) setSpacing(prev => ({ ...prev, colW: nextColW }))
    requestAnimationFrame(() => {
      if (gridBodyRef.current) gridBodyRef.current.scrollLeft = nextScrollLeft
      scrollLeftRef.current = gridBodyRef.current?.scrollLeft ?? nextScrollLeft
      setScrollLeft(scrollLeftRef.current)
    })
  }, [])

  const focusTimeSlotByDoubleClick = useCallback(timeSlotId => {
    const timeSlot = timeSlotsRef.current.find(m => m.id === timeSlotId)
    if (!timeSlot) return
    const slotZoom = getTimeSlotLevel(timeSlot.duration, timeSlot.startCol)
    const slotZoomIdx = ZOOM_ORDER.indexOf(slotZoom)
    const currentZoom = normalizeTimeZoom(timeZoomRef.current)
    const currentZoomIdx = ZOOM_ORDER.indexOf(currentZoom)
    const isInspectingOneScaleDown = slotZoomIdx > 0 && currentZoomIdx === slotZoomIdx - 1
    const nextZoom = isInspectingOneScaleDown ? slotZoom : lowerZoomForTimeSlot(timeSlot)
    if (!nextZoom) return

    const viewportW = Math.max(1, vpRef.current.w || gridBodyRef.current?.clientWidth || 1)
    const visual = getVisualRange(timeSlot, nextZoom, true)
    const nextColW = isInspectingOneScaleDown
      ? Math.max(minColWidthForZoom(nextZoom), Math.min(COL_WIDTH_MAX, spacingRef.current.colW))
      : Math.max(
          minColWidthForZoom(nextZoom),
          Math.min(COL_WIDTH_MAX, Math.round(viewportW / Math.max(1, visual.duration)))
        )
    const nextScrollLeft = Math.max(0, Math.round(visual.startCol * nextColW))
    const needed = Math.ceil((nextScrollLeft + viewportW) / nextColW) + COL_BUF + EDGE_COLS + 1
    const widthCols = Math.max(totalColsRef.current, needed)

    if (needed > totalColsRef.current) {
      totalColsRef.current = needed
      setTotalCols(needed)
    }
    if (gridInnerRef.current) gridInnerRef.current.style.width = `${widthCols * nextColW}px`
    setTimeZoom(nextZoom)
    setSpacing(prev => ({ ...prev, colW: nextColW }))
    requestAnimationFrame(() => {
      if (gridBodyRef.current) gridBodyRef.current.scrollLeft = nextScrollLeft
      scrollLeftRef.current = gridBodyRef.current?.scrollLeft ?? nextScrollLeft
      setScrollLeft(scrollLeftRef.current)
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

  const isNoteRowReadOnly = useCallback((noteId) => {
    const ms = timeSlotsRef.current.find(m => m.noteId === noteId)
    return !!ms && !isTimeSlotEditableAtZoom(ms.duration, timeZoomRef.current, ms.startCol)
  }, [])

  const handleContextMenu = useCallback(e => {
    e.preventDefault()
    const cell = getNoteCellFromPointer(e)
    if (!cell) return

	    if (cell.type === 'header') {
	      const { col } = cell
	      setContextMenu({ type: 'header', x: e.clientX, y: e.clientY, col, unitLabel: TIME_ZOOM_BY_VALUE[timeZoomRef.current]?.label.toLowerCase() ?? 'unit' })
	      return
	    }
	    if (e.target.closest('[data-ms-id]')) return  // right-click on timeSlot — skip for now
	    if (!nostalgiaModeRef.current && cell.col < todayMinuteRef.current) {
	      showPastWorkWarning('This canvas position is before today. Enable nostalgia mode if you intentionally want to work in the past.')
	      return
	    }
	    showProjectEndWarningIfNeeded({ startCol: cell.col })

    const hasDeadline = deadlines.some(d => d.noteId === cell.noteId)
    const hasEarliestStart = earliestStarts.some(e => e.noteId === cell.noteId)
    const rowMs = timeSlotsRef.current.find(m => m.noteId === cell.noteId)
    const readOnly = !!rowMs && !isTimeSlotEditableAtZoom(rowMs.duration, timeZoomRef.current, rowMs.startCol)
    const readOnlyLabel = rowMs ? scaleLabelForZoom(getTimeSlotLevel(rowMs.duration, rowMs.startCol)) : null
    setClickedNoteId(cell.noteId)
    setContextMenu({ type: 'cell', x: e.clientX, y: e.clientY, col: cell.col,
      noteId: cell.noteId, noteTitle: cell.noteTitle, color: cell.color, hasDeadline, hasEarliestStart,
      isReadOnly: readOnly, readOnlyLabel, hasTimeSlot: !!rowMs })
	  }, [deadlines, earliestStarts, getNoteCellFromPointer, showPastWorkWarning, showProjectEndWarningIfNeeded])

  // ── TimeSlot CRUD ─────────────────────────────────────────────────────────
  const handleCreateTimeSlot = useCallback(async (noteId, startCol, color) => {
    clearWarningPrompt()
    const duration = defaultDurationForZoom(timeZoomRef.current, startCol)
    const ms = { id: newClientId('ms'), noteId, startCol, duration, title: '', color: color || '#1a73e8' }
    const existingTimeSlot = timeSlotsRef.current.find(m => m.noteId === noteId)
    if (existingTimeSlot) {
      showWarningPrompt({
        title: 'Time slot exists',
        message: 'A note can only contain one time slot.',
        actions: 'close',
      })
      return
    }
    const scaleConflict = noteTimeSlotScaleConflict(timeSlotsRef.current, noteId, duration, startCol)
    if (scaleConflict) {
      showWarningPrompt({
        title: 'Planning scale locked',
        message: `This note already contains ${timeSlotScaleBucket(scaleConflict)}-scale time slots. New time slots in the same note must use that same planning scale.`,
        actions: 'close',
      })
      return
    }
    const dl = findApplicableDeadline(deadlinesRef.current, ms)
    const es = findApplicableEarliestStart(earliestStartsRef.current, ms)
    if (es && startCol < es.col) {
      reportEarliestStartViolation([ms.id])
      return
    }
    if (!nostalgiaModeRef.current && startCol < todayMinuteRef.current) {
      showPastWorkWarning('This canvas position is before today. Enable nostalgia mode if you intentionally want to create a time slot in the past.')
      return
    }
    if (startCol < 0 || (dl && startCol + duration > dl.col)) {
      reportDeadlineViolation([ms.id])
      return
    }
	    await commitTransaction({
	      id: newClientId('tx'),
	      type: 'timeSlot.create',
	      label: 'Create time slot',
	      before: { timeSlots: [], dependencies: [] },
	      after: { timeSlots: [ms], dependencies: [] },
	    })
	    showProjectEndWarningIfNeeded(ms)
	  }, [clearWarningPrompt, commitTransaction, reportDeadlineViolation, reportEarliestStartViolation, showPastWorkWarning, showProjectEndWarningIfNeeded, showWarningPrompt])

  const handleGridDoubleClick = useCallback(e => {
    if (modeRef.current !== 'timeSlot') return
    if (e.target.closest('[data-ms-id]')) return
    const cell = getNoteCellFromPointer(e)
    if (!cell || cell.type !== 'cell') return
    const existingTimeSlot = timeSlotByNoteRef.current.get(cell.noteId)
    if (existingTimeSlot) {
      e.preventDefault()
      focusTimeSlotByDoubleClick(existingTimeSlot.id)
      return
    }
    if (isNoteRowReadOnly(cell.noteId)) return
    e.preventDefault()
    handleCreateTimeSlot(cell.noteId, cell.col, cell.color)
  }, [focusTimeSlotByDoubleClick, getNoteCellFromPointer, handleCreateTimeSlot, isNoteRowReadOnly])

  // ── Column insert / delete ─────────────────────────────────────────────────
  const handleInsertTimeUnit = useCallback(async col => {
    const unit = getZoomUnit(timeZoomRef.current)
    const updates = []
    timeSlotsRef.current.forEach(m => {
      if (m.startCol >= col) updates.push({ id: m.id, startCol: m.startCol + unit })
    })
    if (updates.length) {
      const before = updates.map(u => timeSlotsRef.current.find(m => m.id === u.id)).filter(Boolean)
      const after = before.map(m => ({ ...m, startCol: m.startCol + unit }))
      const tx = {
        id: newClientId('tx'),
        type: 'timeSlot.move-many',
        label: 'Insert time unit',
        before: { timeSlots: before, dependencies: [] },
        after: { timeSlots: after, dependencies: [] },
      }
      const nextTimeSlots = timeSlotsRef.current.map(m => after.find(candidate => candidate.id === m.id) ?? m)
      if (maybeBlockDependencyWarning(nextTimeSlots, dependenciesRef.current)) return
	      await commitTransaction(tx)
	      showProjectEndWarningIfNeeded(after)
	    }
	  }, [commitTransaction, maybeBlockDependencyWarning, showProjectEndWarningIfNeeded])

  const handleDeleteTimeUnit = useCallback(async col => {
    const unit = getZoomUnit(timeZoomRef.current)
    const cutEnd = col + unit
    const updates = []
    const updated = timeSlotsRef.current.map(m => {
      if (m.startCol >= cutEnd) {
        updates.push({ id: m.id, startCol: Math.max(0, m.startCol - unit) })
        return { ...m, startCol: Math.max(0, m.startCol - unit) }
      }
      const overlapStart = Math.max(m.startCol, col)
      const overlapEnd = Math.min(m.startCol + m.duration, cutEnd)
      if (overlapStart < overlapEnd) {
        const d = Math.max(MIN_TIME_SLOT_DURATION, m.duration - (overlapEnd - overlapStart))
        updates.push({ id: m.id, duration: d })
        return { ...m, duration: d }
      }
      return m
    })
    if (updates.length) {
      const before = updates.map(u => timeSlotsRef.current.find(m => m.id === u.id)).filter(Boolean)
      const after = before.map(m => updated.find(next => next.id === m.id)).filter(Boolean)
      const tx = {
        id: newClientId('tx'),
        type: 'timeSlot.move-many',
        label: 'Delete time unit',
        before: { timeSlots: before, dependencies: [] },
        after: { timeSlots: after, dependencies: [] },
      }
      if (maybeBlockDependencyWarning(updated, dependenciesRef.current)) return
	      await commitTransaction(tx)
	      showProjectEndWarningIfNeeded(after)
	    }
	  }, [commitTransaction, maybeBlockDependencyWarning, showProjectEndWarningIfNeeded])

  // ── Drag helpers ───────────────────────────────────────────────────────────
  const showScaleEditBlocked = useCallback((timeSlot) => {
    const level = getTimeSlotLevel(timeSlot.duration, timeSlot.startCol)
    showWarningPrompt({
      title: 'Different planning scale',
      message: `This is a ${timeSlotScaleBucket(timeSlot)}-scale time slot. Switch to ${scaleLabelForZoom(level)} view to move, resize, or link it.`,
      actions: 'close',
    })
  }, [showWarningPrompt])

  const canEditTimeSlotNow = useCallback((timeSlot) => (
    timeSlot && isTimeSlotEditableAtZoom(timeSlot.duration, timeZoomRef.current, timeSlot.startCol)
  ), [])

  const findScaleLockedTimeSlot = useCallback((timeSlotIds) => {
    for (const id of timeSlotIds) {
      const timeSlot = timeSlotsRef.current.find(m => m.id === id)
      if (timeSlot && !canEditTimeSlotNow(timeSlot)) return timeSlot
    }
    return null
  }, [canEditTimeSlotNow])

  function startMoveDrag(startMouseX, originals) {
    if (Object.keys(originals).length === 0) return
    const blockedTimeSlot = findScaleLockedTimeSlot(Object.keys(originals))
    if (blockedTimeSlot) {
      showScaleEditBlocked(blockedTimeSlot)
      return
    }
    clearWarningPrompt()
    const sp = spacingRef.current
    const isMonthMove = normalizeTimeZoom(timeZoomRef.current) === 'months'
    const startScrollLeft = scrollLeftRef.current
    dragRef.current = { type: 'move', hasMoved: false, originals, lastValidColDelta: 0, blockedOverlap: null, blockedBarrier: null, hitBoundary: false }
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'

    let lastMoveClientX = startMouseX
    const getScrollAdjustedDx = clientX => clientX - startMouseX + (scrollLeftRef.current - startScrollLeft)

    const extendTimelineForScrollLeft = nextScrollLeft => {
      const needed = Math.ceil((nextScrollLeft + vpRef.current.w) / sp.colW) + COL_BUF + EDGE_COLS + 1
      if (needed > totalColsRef.current) {
        totalColsRef.current = needed
        setTotalCols(needed)
        if (gridInnerRef.current) gridInnerRef.current.style.width = `${needed * sp.colW}px`
      }
    }

    const getBounds = () => {
	      let minDelta = -Infinity
	      let maxDelta = Infinity
	      let minDeltaFromEarliest = -Infinity
	      let minDeltaFromPast = -Infinity
	      Object.entries(originals).forEach(([id, orig]) => {
        const ms = timeSlotsRef.current.find(m => m.id === id)
        const dl = findApplicableDeadline(deadlinesRef.current, ms)
        const es = findApplicableEarliestStart(earliestStartsRef.current, ms)
        if (isMonthMove) {
          const startVisual = minuteToZoomCol(orig.startCol, 'months')
          const span = calendarMonthSpanForRange(orig.startCol, orig.duration)
          minDelta = Math.max(minDelta, -startVisual)
	          if (!nostalgiaModeRef.current && todayMinuteRef.current > 0) {
	            const todayMonthCol = minuteToZoomCol(todayMinuteRef.current, 'months')
	            const todayD = todayMonthCol - startVisual
	            minDelta = Math.max(minDelta, todayD)
	            minDeltaFromPast = Math.max(minDeltaFromPast, todayD)
	          }
          if (dl) {
            maxDelta = Math.min(maxDelta, minuteToZoomCol(dl.col, 'months') - span - startVisual)
          }
          if (es) {
            const esD = minuteToZoomCol(es.col, 'months') - startVisual
            minDelta = Math.max(minDelta, esD)
            minDeltaFromEarliest = Math.max(minDeltaFromEarliest, esD)
          }
          return
        }
        minDelta = Math.max(minDelta, -orig.startCol)
	        if (!nostalgiaModeRef.current && todayMinuteRef.current > 0) {
	          const todayD = todayMinuteRef.current - orig.startCol
	          minDelta = Math.max(minDelta, todayD)
	          minDeltaFromPast = Math.max(minDeltaFromPast, todayD)
	        }
        if (dl) maxDelta = Math.min(maxDelta, dl.col - orig.duration - orig.startCol)
        if (es) {
          const esD = es.col - orig.startCol
          minDelta = Math.max(minDelta, esD)
          minDeltaFromEarliest = Math.max(minDeltaFromEarliest, esD)
        }
      })
	      return { minDelta, maxDelta, minDeltaFromEarliest, minDeltaFromPast }
    }

    const getSnappedColDelta = clientX => {
      const rawDx = getScrollAdjustedDx(clientX)
      const firstOrig = Object.values(originals)[0]
      if (!firstOrig) return 0
      const firstVisualStart = minuteToZoomCol(firstOrig.startCol, timeZoomRef.current)
      const requestedVisual = snapPxToCol(firstVisualStart * sp.colW + rawDx, sp.colW)
      let colDelta = isMonthMove
        ? requestedVisual - firstVisualStart
        : (requestedVisual - firstVisualStart) * getZoomUnit(timeZoomRef.current)
	      const { minDelta, maxDelta, minDeltaFromEarliest, minDeltaFromPast } = getBounds()
      const clamped = Math.max(minDelta, Math.min(maxDelta, colDelta))
      if (dragRef.current) {
        dragRef.current.hitBoundary = false
        dragRef.current.hitEarliestBoundary = false
      }
      if (dragRef.current && clamped !== colDelta) {
        if (colDelta > maxDelta) {
          dragRef.current.hitBoundary = true
	        } else {
	          // Left boundary hit — earliest start or today
	          if (minDeltaFromEarliest > -Infinity && colDelta < minDeltaFromEarliest) {
	            dragRef.current.hitEarliestBoundary = true
	          } else if (minDeltaFromPast > -Infinity && colDelta < minDeltaFromPast) {
	            dragRef.current.hitPastBoundary = true
	          } else {
	            dragRef.current.hitBoundary = true
	          }
        }
      }
      return clamped
    }

    const buildMovedTimeSlots = colDelta => timeSlotsRef.current.map(m => {
      if (!originals[m.id]) return m
      if (isMonthMove) {
        const origVisualStart = minuteToZoomCol(originals[m.id].startCol, 'months')
        const startCol = zoomColToMinute(origVisualStart + colDelta, 'months')
        const duration = calendarMonthDurationFromStart(startCol, calendarMonthSpanForRange(originals[m.id].startCol, originals[m.id].duration))
        return { ...m, startCol, duration }
      }
      return { ...m, startCol: originals[m.id].startCol + colDelta }
    })

    const getLiveDx = clientX => {
      const rawDx = getScrollAdjustedDx(clientX)
      let dx = rawDx
      Object.entries(originals).forEach(([id, orig]) => {
        const origVisual = getVisualRange(orig, timeZoomRef.current)
        dx = Math.max(dx, -origVisual.startCol * sp.colW)
        const ms = timeSlotsRef.current.find(m => m.id === id)
        const dl = findApplicableDeadline(deadlinesRef.current, ms)
        if (dl) {
          const maxVisual = isMonthMove
            ? minuteToZoomCol(dl.col, 'months') - calendarMonthSpanForRange(orig.startCol, orig.duration)
            : minuteToZoomCol(Math.max(0, dl.col - orig.duration), timeZoomRef.current)
          dx = Math.min(dx, (maxVisual - origVisual.startCol) * sp.colW)
        }
        const es = findApplicableEarliestStart(earliestStartsRef.current, ms)
        if (es) {
          const esMinVisual = isMonthMove
            ? minuteToZoomCol(es.col, 'months')
            : minuteToZoomCol(es.col, timeZoomRef.current)
          dx = Math.max(dx, (esMinVisual - origVisual.startCol) * sp.colW)
        }
      })
      return dx
    }

    const renderMoveAt = clientX => {
      const dx = getLiveDx(clientX)
      if (Math.abs(dx) > 2) dragRef.current.hasMoved = true
      const overrides = {}
      Object.entries(originals).forEach(([id, orig]) => {
        const ms = timeSlotsRef.current.find(m => m.id === id)
        const origVisual = getVisualRange(orig, timeZoomRef.current)
        const leftPx = origVisual.startCol * sp.colW + dx
        if (ms) overrides[id] = { ...ms, leftPx, widthPx: origVisual.duration * sp.colW }
        const el = timeSlotElsRef.current.get(id)
        if (el) el.style.left = `${leftPx}px`
      })
      updateDependencyPaths(overrides)
    }

    const stopAutoScroll = () => {
      if (dragAutoScrollRef.current?.frame) cancelAnimationFrame(dragAutoScrollRef.current.frame)
      dragAutoScrollRef.current = null
    }

    const autoScrollStep = () => {
      const el = gridBodyRef.current
      const drag = dragRef.current
      if (!el || !drag || drag.type !== 'move') {
        stopAutoScroll()
        return
      }
      const rect = el.getBoundingClientRect()
      let velocity = 0
      if (lastMoveClientX < rect.left + DRAG_AUTOSCROLL_EDGE_PX) {
        const t = Math.min(1, Math.max(0, (rect.left + DRAG_AUTOSCROLL_EDGE_PX - lastMoveClientX) / DRAG_AUTOSCROLL_EDGE_PX))
        velocity = -DRAG_AUTOSCROLL_MAX_PX * t * t
      } else if (lastMoveClientX > rect.right - DRAG_AUTOSCROLL_EDGE_PX) {
        const t = Math.min(1, Math.max(0, (lastMoveClientX - (rect.right - DRAG_AUTOSCROLL_EDGE_PX)) / DRAG_AUTOSCROLL_EDGE_PX))
        velocity = DRAG_AUTOSCROLL_MAX_PX * t * t
      }
      if (velocity !== 0) {
        const nextLeft = Math.max(0, el.scrollLeft + velocity)
        extendTimelineForScrollLeft(nextLeft)
        el.scrollLeft = nextLeft
        scrollLeftRef.current = el.scrollLeft
        if (leftBodyInnerRef.current) leftBodyInnerRef.current.style.transform = `translateY(${-el.scrollTop}px)`
        setScrollLeft(scrollLeftRef.current)
        renderMoveAt(lastMoveClientX)
      }
      dragAutoScrollRef.current = {
        frame: requestAnimationFrame(autoScrollStep),
      }
    }

    const ensureAutoScroll = () => {
      if (dragAutoScrollRef.current?.frame) return
      dragAutoScrollRef.current = { frame: requestAnimationFrame(autoScrollStep) }
    }

    const onMove = e => {
      e.preventDefault()
      lastMoveClientX = e.clientX
      renderMoveAt(lastMoveClientX)
      ensureAutoScroll()
    }

    const onUp = async e => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      stopAutoScroll()
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
	      const { hasMoved, hitBoundary, hitEarliestBoundary, hitPastBoundary } = dragRef.current || {}
      dragRef.current = null
      const resetToOriginal = () => {
        Object.entries(originals).forEach(([id, orig]) => {
          const el = timeSlotElsRef.current.get(id)
          const origVisual = getVisualRange(orig, timeZoomRef.current)
          if (el) el.style.left = `${origVisual.startCol * sp.colW}px`
        })
        updateDependencyPaths()
      }
      if (!hasMoved) { resetToOriginal(); return }

      const colDelta = getSnappedColDelta(e.clientX)
      const finalOverlap = getOverlapViolation(buildMovedTimeSlots(colDelta), new Set(Object.keys(originals)))
      if (finalOverlap) {
        resetToOriginal()
        return
      }
      const movedTimeSlotIds = Object.keys(originals)
      const movedTimeSlotIdSet = new Set(movedTimeSlotIds)
      const movedNextTimeSlots = buildMovedTimeSlots(colDelta).filter(candidate => movedTimeSlotIdSet.has(candidate.id))
      const deadlineContactIds = getHardDeadlineContactIds(movedNextTimeSlots)
      const earliestStartContactIds = getEarliestStartContactIds(movedNextTimeSlots)
	      if (hitPastBoundary) showPastWorkWarning('This move would place the time slot before today. Enable nostalgia mode if you intentionally want to work in the past.')
	      else if (hitBoundary) reportDeadlineViolation(movedTimeSlotIds)
      else if (deadlineContactIds.length) reportDeadlineViolation(deadlineContactIds)
      if (hitEarliestBoundary) reportEarliestStartViolation(movedTimeSlotIds)
      else if (earliestStartContactIds.length) reportEarliestStartViolation(earliestStartContactIds)
      const updates = []
      const next = timeSlotsRef.current.map(m => {
        if (!originals[m.id]) return m
        const moved = movedNextTimeSlots.find(candidate => candidate.id === m.id)
        if (moved && (moved.startCol !== originals[m.id].startCol || moved.duration !== originals[m.id].duration)) {
          updates.push({ id: m.id, startCol: moved.startCol, duration: moved.duration })
        }
        return moved ?? m
      })
      const finalOrder = getTimeSlotOrderViolation(timeSlotsRef.current, next, new Set(Object.keys(originals)))
      if (finalOrder) {
        resetToOriginal()
        return
      }
      if (updates.length) {
        const applyMove = async () => {
          const before = Object.entries(originals)
            .map(([id]) => timeSlotsRef.current.find(m => m.id === id))
            .filter(Boolean)
          const after = before.map(m => next.find(candidate => candidate.id === m.id)).filter(Boolean)
	          await commitTransaction({
            id: newClientId('tx'),
            type: before.length > 1 ? 'timeSlot.move-many' : 'timeSlot.move',
            label: before.length > 1 ? 'Move time slots' : 'Move time slot',
            before: { timeSlots: before, dependencies: [] },
            after: { timeSlots: after, dependencies: [] },
	          })
	          showProjectEndWarningIfNeeded(after)
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

  function startResizeDrag(startMouseX, timeSlotId, side) {
    const sp  = spacingRef.current
    const ms  = timeSlotsRef.current.find(m => m.id === timeSlotId)
    if (!ms) return
    if (!canEditTimeSlotNow(ms)) {
      showScaleEditBlocked(ms)
      return
    }
    clearWarningPrompt()
    const origStart = ms.startCol; const origDur = ms.duration
    const origRight = origStart + origDur
    dragRef.current = { type: `resize-${side}`, blockedOverlap: null, hitBoundary: false, lastValid: { startCol: origStart, duration: origDur } }
    document.body.style.cursor = 'col-resize'

    const resetToOriginal = () => {
      const el = timeSlotElsRef.current.get(timeSlotId)
      if (el) {
        const origVisual = getVisualRange({ startCol: origStart, duration: origDur }, timeZoomRef.current)
        el.style.left = `${origVisual.startCol * sp.colW}px`
        el.style.width = `${origVisual.duration * sp.colW}px`
      }
      updateDependencyPaths()
    }

    const getSnappedResize = clientX => {
      const dx = clientX - startMouseX
      const dl = findApplicableDeadline(deadlinesRef.current, ms)
      const maxRight = dl ? dl.col : Infinity
      const esResize = findApplicableEarliestStart(earliestStartsRef.current, ms)
      const isMonthResize = normalizeTimeZoom(timeZoomRef.current) === 'months'
      if (dragRef.current) {
        dragRef.current.hitBoundary = false
        dragRef.current.hitEarliestBoundary = false
      }
      if (side === 'left') {
        const origVisualStart = minuteToZoomCol(origStart, timeZoomRef.current)
        const requestedVisual = snapPxToCol(origVisualStart * sp.colW + dx, sp.colW)
        const requested = isMonthResize ? zoomColToMinute(requestedVisual, 'months') : requestedVisual * getZoomUnit(timeZoomRef.current)
        const minRightVisual = minuteEndToZoomCol(origRight, timeZoomRef.current) - 1
        const maxLeft = isMonthResize ? zoomColToMinute(minRightVisual, 'months') : origRight - MIN_TIME_SLOT_DURATION
        const esMinLeft = esResize ? esResize.col : 0
	        const pastMinLeft = nostalgiaModeRef.current ? 0 : todayMinuteRef.current
	        const minLeft = Math.max(esMinLeft, pastMinLeft)
	        const leftCol = Math.min(maxLeft, Math.max(minLeft, requested))
	        if (dragRef.current && leftCol !== requested) {
	          if (esMinLeft > 0 && requested < esMinLeft) dragRef.current.hitEarliestBoundary = true
	          else if (!nostalgiaModeRef.current && requested < pastMinLeft) dragRef.current.hitPastBoundary = true
	          else dragRef.current.hitBoundary = true
	        }
        return { startCol: leftCol, duration: origRight - leftCol }
      }
      const origVisualRight = minuteEndToZoomCol(origRight, timeZoomRef.current)
      const requestedVisual = snapPxToCol(origVisualRight * sp.colW + dx, sp.colW)
      const requested = isMonthResize ? zoomColToMinute(requestedVisual, 'months') : requestedVisual * getZoomUnit(timeZoomRef.current)
      const minRight = isMonthResize
        ? zoomColToMinute(minuteToZoomCol(origStart, 'months') + 1, 'months')
        : origStart + MIN_TIME_SLOT_DURATION
      const rightCol = Math.min(maxRight, Math.max(minRight, requested))
      if (dragRef.current && rightCol !== requested) dragRef.current.hitBoundary = true
      return { startCol: origStart, duration: rightCol - origStart }
    }

    const buildResizedTimeSlots = next => timeSlotsRef.current.map(m =>
      m.id === timeSlotId ? { ...m, startCol: next.startCol, duration: next.duration } : m
    )

    const getSafeResize = clientX => {
      const next = getSnappedResize(clientX)
      const overlap = getOverlapViolation(buildResizedTimeSlots(next), new Set([timeSlotId]))
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
      const el   = timeSlotElsRef.current.get(timeSlotId); if (!el) return
      const next = getLiveResize(e.clientX)
      const overrides = { [timeSlotId]: { ...ms, leftPx: next.leftPx, widthPx: next.widthPx } }
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
        buildResizedTimeSlots({ startCol: newStart, duration: newDur }),
        new Set([timeSlotId])
      )
      if (finalOverlap) {
        resetToOriginal()
        return
      }
      const deadlineContactIds = getHardDeadlineContactIds([{ ...ms, startCol: newStart, duration: newDur }])
      const earliestStartContactIds = getEarliestStartContactIds([{ ...ms, startCol: newStart, duration: newDur }])
	      if (dragState.hitPastBoundary) showPastWorkWarning('This resize would extend the time slot before today. Enable nostalgia mode if you intentionally want to work in the past.')
	      else if (dragState.hitBoundary) reportDeadlineViolation([timeSlotId])
      else if (deadlineContactIds.length) reportDeadlineViolation(deadlineContactIds)
      if (dragState.hitEarliestBoundary) reportEarliestStartViolation([timeSlotId])
      else if (earliestStartContactIds.length) reportEarliestStartViolation(earliestStartContactIds)
      const changed = newStart !== origStart || newDur !== origDur
      const nextAll = timeSlotsRef.current.map(m => m.id === timeSlotId ? { ...m, startCol: newStart, duration: newDur } : m)
      if (changed) {
        const dependencyBlocked = maybeBlockDependencyWarning(nextAll, dependenciesRef.current)
        if (dependencyBlocked) {
          resetToOriginal()
          return
        }
        const applyResize = async () => {
          const current = timeSlotsRef.current.find(m => m.id === timeSlotId)
          const next = nextAll.find(m => m.id === timeSlotId)
	          await commitTransaction({
            id: newClientId('tx'),
            type: 'timeSlot.resize',
            label: 'Resize time slot',
            before: { timeSlots: current ? [current] : [], dependencies: [] },
            after: { timeSlots: next ? [next] : [], dependencies: [] },
	          })
	          showProjectEndWarningIfNeeded(next)
	        }
        const applyResizeIfValid = async () => {
          const blocked = maybeBlockDependencyWarning(nextAll, dependenciesRef.current)
          if (blocked) {
            resetToOriginal()
            return
          }
          try { await applyResize() } catch (err) { console.error(err) }
        }
        if (durationScaleBucket(origDur, origStart) !== durationScaleBucket(newDur, newStart)) {
          const crossMetricDeps = dependenciesRef.current.filter(dep => {
            if (dep.fromId === timeSlotId) {
              const to = timeSlotsRef.current.find(m => m.id === dep.toId)
              return to && durationScaleBucket(newDur, newStart) !== timeSlotScaleBucket(to)
            }
            if (dep.toId === timeSlotId) {
              const from = timeSlotsRef.current.find(m => m.id === dep.fromId)
              return from && timeSlotScaleBucket(from) !== durationScaleBucket(newDur, newStart)
            }
            return false
          })
          if (crossMetricDeps.length > 0) {
            resetToOriginal()
            const origBucket = durationScaleBucket(origDur, origStart)
            const newBucket  = durationScaleBucket(newDur, newStart)
            const direction  = durationScaleBucketIndex(newBucket) > durationScaleBucketIndex(origBucket) ? 'UP' : 'DOWN'
            setMetricResizeDraft({ timeSlotId, newStart, newDur, origDur, origBucket, newBucket, direction, crossMetricDeps, applyResizeIfValid })
            return
          }
        }
        const magnitude = durationOrderMagnitudeChange(origDur, newDur)
        const warnThreshold = warningSettings.resizeWarnOrderThreshold
        const extraConfirmThreshold = warningSettings.resizeBlockOrderThreshold
        const originalScale = durationScaleBucket(origDur, origStart)
        const nextScale = durationScaleBucket(newDur, newStart)
        const scaleJump = Math.abs(durationScaleBucketIndex(nextScale) - durationScaleBucketIndex(originalScale))
        const crossedScale = warningSettings.resizeScaleCrossingWarningEnabled && originalScale !== nextScale
        const crossedMagnitude = magnitude >= warnThreshold
        const needsScaleJumpConfirm = crossedScale && scaleJump >= 2
        if (crossedMagnitude || crossedScale) {
          resetToOriginal()
          const durationChange = `The duration would move from ${formatMinutesDuration(origDur)} to ${formatMinutesDuration(newDur)}.`
          const concerns = [
            crossedMagnitude
              ? `Magnitude level ${magnitude.toFixed(1)} is unusually high for the currently picked duration of that time slot.`
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
      timeSlotsRef.current.forEach(m => {
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
    const fromMs = timeSlotsRef.current.find(m => m.id === fromId)
    const toMs   = timeSlotsRef.current.find(m => m.id === toId)
    const scaleLocked = [fromMs, toMs].find(m => m && !canEditTimeSlotNow(m))
    if (scaleLocked) {
      showScaleEditBlocked(scaleLocked)
      return
    }
    if (fromMs && toMs && timeSlotScaleBucket(fromMs) !== timeSlotScaleBucket(toMs)) {
      showWarningPrompt({
        title: 'Scale mismatch',
        message: `Dependencies can only link time slots on the same planning scale. ${timeSlotScaleBucket(fromMs)}-scale and ${timeSlotScaleBucket(toMs)}-scale time slots cannot be linked.`,
        actions: 'close',
      })
      return
    }
    const pendingDep = { id: newClientId('dep'), fromId, toId, reason: '' }
    const nextDependencies = [...dependenciesRef.current, pendingDep]
    const applyDependency = async () => {
      await commitTransaction({
        id: newClientId('tx'),
        type: 'dependency.create',
        label: 'Create dependency',
        before: { timeSlots: [], dependencies: [] },
        after: { timeSlots: [], dependencies: [pendingDep] },
      })
    }
    const blocked = maybeBlockDependencyWarning(timeSlotsRef.current, nextDependencies)
    if (blocked) return
    try { await applyDependency() } catch (err) { console.error(err) }
  }, [canEditTimeSlotNow, clearWarningPrompt, commitTransaction, maybeBlockDependencyWarning, showScaleEditBlocked, showWarningPrompt])

  const handleMetricResizeAccept = useCallback(async () => {
    const draft = metricResizeDraft
    setMetricResizeDraft(null)
    if (!draft) return
    if (draft.crossMetricDeps.length > 0) {
      try {
        await commitTransaction({
          id: newClientId('tx'),
          type: 'dependency.delete-many',
          label: `Delete ${draft.crossMetricDeps.length} incompatible dependenc${draft.crossMetricDeps.length === 1 ? 'y' : 'ies'}`,
          before: { timeSlots: [], dependencies: draft.crossMetricDeps },
          after:  { timeSlots: [], dependencies: [] },
        })
      } catch (err) { console.error(err) }
    }
    try { await draft.applyResizeIfValid() } catch (err) { console.error(err) }
  }, [commitTransaction, metricResizeDraft])

  const handleMetricResizeClone = useCallback(async () => {
    const draft = metricResizeDraft
    setMetricResizeDraft(null)
    if (!draft) return
    const originalMs = timeSlotsRef.current.find(m => m.id === draft.timeSlotId)
    if (!originalMs) return
    const originalNote = notes.find(n => n.id === originalMs.noteId)
    if (!originalNote) return
    try {
      const clonedNote = await api.createNote({
        id: newClientId('note'),
        title: `${originalNote.title} (Resized ${draft.direction})`,
        html: originalNote.html ?? '',
        collapsed: false,
      })
      onNoteCreated?.(clonedNote)
      const noteAssignments = assignments[originalNote.id] ?? {}
      await Promise.all(
        Object.entries(noteAssignments).map(([dimId, catId]) =>
          api.assign(clonedNote.id, dimId, catId).catch(console.error)
        )
      )
      const clonedMs = await api.createTimeSlot({
        id: newClientId('ms'),
        noteId: clonedNote.id,
        startCol: draft.newStart,
        duration: draft.newDur,
        title: originalMs.title ?? '',
        color: originalMs.color ?? '#1a73e8',
      })
      setTimeSlots(prev => [...prev, clonedMs])
    } catch (err) { console.error('Clone note failed', err) }
  }, [assignments, metricResizeDraft, notes, onNoteCreated])

  const updatePreviewArrow = useCallback((sourceId, clientX, clientY) => {
    const rect = gridBodyRef.current?.getBoundingClientRect()
    const source = timeSlotsRef.current.find(m => m.id === sourceId)
    const sourceRow = source && noteRowMapRef.current[source.noteId]
    if (!rect || !source || !sourceRow || !previewArrowRef.current) return
    const sp = spacingRef.current
    const x2 = clientX - rect.left + scrollLeftRef.current
    const y2 = clientY - rect.top + scrollTopRef.current
    const sourceVisual = getVisualRange(source, timeZoomRef.current)
    // Pick source edge based on which side of the timeSlot the cursor is on
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
    const source = timeSlotsRef.current.find(m => m.id === sourceId)
    if (!source || !canEditTimeSlotNow(source)) {
      if (source) showScaleEditBlocked(source)
      return
    }

    const getSide = (clientX) => {
      const rect = gridBodyRef.current?.getBoundingClientRect()
      if (!rect) return 'right'
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
  }, [canEditTimeSlotNow, createDependencyFromDrag, showScaleEditBlocked, updatePreviewArrow])

  // ── Deadlines ──────────────────────────────────────────────────────────────
  const handleSetDeadline = useCallback(async (noteId, col) => {
    try {
      const scale = planningScaleForZoom(timeZoomRef.current)
      const alignedCol = zoomColToMinute(minuteToZoomCol(col, timeZoomRef.current), timeZoomRef.current)
      const dl = await api.setDeadline(noteId, alignedCol, scale)
      playSound('deadlineSet')
      setDeadlines(prev => { const next = prev.filter(d => d.noteId !== noteId); return [...next, dl] })
    } catch (err) {
      console.error(err)
      showWarningPrompt({ title: 'Hard deadline', message: err.message || 'Hard deadline could not be set for this planning scale.', actions: 'close' })
    }
  }, [showWarningPrompt])

  const handleRemoveDeadline = useCallback(async noteId => {
    try {
      await api.removeDeadline(noteId)
      playSound('deadlineSet')
      setDeadlines(prev => prev.filter(d => d.noteId !== noteId))
    } catch (err) { console.error(err) }
  }, [])

  const handleSetEarliestStart = useCallback(async (noteId, col) => {
    try {
      const scale = planningScaleForZoom(timeZoomRef.current)
      const alignedCol = zoomColToMinute(minuteToZoomCol(col, timeZoomRef.current), timeZoomRef.current)
      const es = await api.setEarliestStart(noteId, alignedCol, scale)
      playSound('earliestStartSet')
      setEarliestStarts(prev => { const next = prev.filter(e => e.noteId !== noteId); return [...next, es] })
    } catch (err) {
      console.error(err)
      showWarningPrompt({ title: 'Earliest start date', message: err.message || 'Earliest start date could not be set for this planning scale.', actions: 'close' })
    }
  }, [showWarningPrompt])

  const handleRemoveEarliestStart = useCallback(async noteId => {
    try {
      await api.removeEarliestStart(noteId)
      playSound('earliestStartSet')
      setEarliestStarts(prev => prev.filter(e => e.noteId !== noteId))
    } catch (err) { console.error(err) }
  }, [])

  const handleDeleteTimeSlotRequest = useCallback((timeSlotId, label) => {
    setDeleteDraft({ items: [{ key: `timeSlot:${timeSlotId}`, type: 'timeSlot', id: timeSlotId, label, checked: true }] })
  }, [])

  const handleToggleTimeSlotPin = useCallback(timeSlotId => {
    playSound('timeSlotPin')
    setPinnedTimeSlotId(prev => prev === timeSlotId ? null : timeSlotId)
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
        before: { timeSlots: [], dependencies: [current] },
        after: { timeSlots: [], dependencies: [next] },
      })
    } catch (err) { console.error(err) }
    setReasonModal(null)
  }, [commitTransaction, reasonModal, reasonDraft])

  const buildDeleteItems = useCallback(() => {
    const timeSlotIds = [...selectedIdsRef.current]
    const dependencyIds = [...selectedDepIdsRef.current]
    const timeSlotItems = timeSlotIds
      .map(id => {
        const timeSlot = timeSlotsRef.current.find(m => m.id === id)
        if (!timeSlot) return null
        const note = notes.find(g => g.id === timeSlot.noteId)
        return {
          key: `timeSlot:${id}`,
          type: 'timeSlot',
          id,
          label: `${note?.title ?? 'Time slot'} · ${timeSlot.title || minuteLabel(timeSlot.startCol)}`,
          checked: true,
        }
      })
      .filter(Boolean)
    const dependencyItems = dependencyIds
      .map(id => {
        const dep = dependenciesRef.current.find(d => d.id === id)
        if (!dep) return null
        const from = timeSlotsRef.current.find(m => m.id === dep.fromId)
        const to = timeSlotsRef.current.find(m => m.id === dep.toId)
        const fromNote = notes.find(g => g.id === from?.noteId)
        const toNote = notes.find(g => g.id === to?.noteId)
        return {
          key: `dependency:${id}`,
          type: 'dependency',
          id,
          label: `${fromNote?.title ?? 'Time slot'} -> ${toNote?.title ?? 'Time slot'}`,
          checked: true,
        }
      })
      .filter(Boolean)
    return [...timeSlotItems, ...dependencyItems]
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
    const timeSlotIds = checked.filter(item => item.type === 'timeSlot').map(item => item.id)
    const dependencyIds = checked.filter(item => item.type === 'dependency').map(item => item.id)

    const timeSlotSet = new Set(timeSlotIds)
    const dependencySet = new Set(dependencyIds)
    const depsToDelete = dependenciesRef.current
      .filter(d => dependencySet.has(d.id) || timeSlotSet.has(d.fromId) || timeSlotSet.has(d.toId))
    const timeSlotsToDelete = timeSlotsRef.current.filter(m => timeSlotSet.has(m.id))

    try {
      const ok = await commitTransaction({
        id: newClientId('tx'),
        type: timeSlotsToDelete.length > 1 || depsToDelete.length > 1 ? 'delete-many' : timeSlotsToDelete.length ? 'timeSlot.delete' : 'dependency.delete',
        label: checked.length > 1 ? 'Delete selected items' : `Delete ${checked[0].type}`,
        before: { timeSlots: timeSlotsToDelete, dependencies: depsToDelete },
        after: { timeSlots: [], dependencies: [] },
      })
      if (ok) {
        setSelectedIds(new Set())
        setSelectedDepIds(new Set())
        setDeleteDraft(null)
      }
    } catch (err) { console.error(err) }
  }, [commitTransaction, deleteDraft])

  const handleWarningResolve = useCallback(() => {
    resolveDependencySelection(warningPrompt?.timeSlotIds ?? null, warningPrompt?.resolveZoom ?? null, {
      accumulate: !warningPrompt?.replaceSelection,
    })
  }, [resolveDependencySelection, warningPrompt])

  useEffect(() => {
    if (!isActive) return
    const onKeyDown = e => {
      const tag = e.target?.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable
      const key = e.key.toLowerCase()
      if (!isTyping && !e.ctrlKey && !e.metaKey && !e.altKey && key === 'y') {
        yWheelZoomRef.current = true
      }
      if (!isTyping && (e.ctrlKey || e.metaKey) && !e.altKey) {
        if (key === 'c' && activeNoteIdForCopy) {
          e.preventDefault()
          copyNoteToScheduleClipboard(activeNoteIdForCopy)
          return
        }
        if (key === 'v' && copiedNoteId) {
          e.preventDefault()
          pasteCopiedNote()
          return
        }
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
      if (key === 'escape' && inheritancePickRef.current) {
        setInheritancePick(null)
        clearWarningPrompt()
        return
      }
      if (key === 'd') setMode('dependency')
      if (key === 'e') setMode('timeSlot')
      if (e.key === 'Delete' || e.key === 'Del') handleRequestDeleteSelection()
    }
    const onKeyUp = e => {
      if (e.key?.toLowerCase() === 'y') yWheelZoomRef.current = false
    }
    const onBlur = () => {
      yWheelZoomRef.current = false
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      yWheelZoomRef.current = false
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [activeNoteIdForCopy, clearWarningPrompt, copiedNoteId, copyNoteToScheduleClipboard, deleteDraft, handleConfirmDeleteDraft, handleRequestDeleteSelection, isActive, pasteCopiedNote, redoGanttTransaction, undoGanttTransaction])

  useEffect(() => {
    if (reasonModal) setTimeout(() => reasonInputRef.current?.focus(), 30)
  }, [reasonModal])

  // ── Left-panel resize ─────────────────────────────────────────────────────
  const [leftPanelWidth, setLeftPanelWidth] = useState(220)
  const leftPanelWidthRef = useRef(220)
  leftPanelWidthRef.current = leftPanelWidth

  const capturePerspectiveState = useCallback(() => ({
    version: SCHEDULE_PERSPECTIVE_VERSION,
    activePerspectiveId,
    spacing,
    timeZoom,
    planningScale: persistedPlanningScaleForZoom(timeZoom),
    mode,
    axisMode,
    showDepLabels,
    showDeps,
    hideCrossCatDeps,
    showCrucialDepsOnly,
    colorDependencyDirection,
    timeSlotScaleFilter,
    scaleVisibilityMode: normalizeScaleVisibilityMode(timeSlotScaleFilter),
    showRowScheduleMarker,
    showRowTimeSlotMeta,
    timeSlotLabelMode,
    leftPanelWidth: leftPanelWidthRef.current,
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
	      timeSlotIds: [...selectedIdsRef.current],
	      dependencyIds: [...selectedDepIdsRef.current],
	      pinnedTimeSlotId: pinnedTimeSlotIdRef.current,
	    },
	    timelineAnchorCreatedAt: project?.createdAt ?? '',
	  }), [
    activeDimId, activeFilterIds, activeLaneFilterId, activePerspectiveId, axisMode, colorDimId,
    colorDependencyDirection, hiddenCatIds, hiddenNotesByLane, hideCrossCatDeps,
    mode, timeSlotScaleFilter, quickFilters, showCrucialDepsOnly, showDepLabels, showDeps,
	    project?.createdAt, showRowScheduleMarker, showRowTimeSlotMeta, spacing, timeSlotLabelMode, timeZoom, visibleNoteFilterIds,
	  ])
	  capturePerspectiveStateRef.current = capturePerspectiveState
	
	  const restoredScrollLeftForState = useCallback(state => {
	    const savedAnchor = state?.timelineAnchorCreatedAt
	    const currentAnchor = project?.createdAt ?? ''
	    if (!savedAnchor || savedAnchor !== currentAnchor) return defaultScrollLeftForZoom(state?.timeZoom, state?.spacing?.colW)
	    return Math.max(0, Number(state.scrollLeft) || defaultScrollLeftForZoom(state?.timeZoom, state?.spacing?.colW))
	  }, [defaultScrollLeftForZoom, project?.createdAt])
	
	  const applyPerspective = useCallback(perspective => {
    const state = normalizeSchedulePerspectiveState(perspective?.state ?? {})
    const nextActiveDimId = state.group?.activeDimId || ''
    const nextActiveLaneFilterId = state.group?.activeLaneFilterId || ''
    const nextColorDimId = state.color?.colorDimId || ''
    restoringPerspectiveRef.current = nextActiveDimId !== activeDimId || nextActiveLaneFilterId !== activeLaneFilterId
    restoringColorRef.current = nextColorDimId !== colorDimId

    setSpacing(state.spacing)
    setTimeZoom(state.timeZoom)
    setMode(state.mode)
    setAxisMode(state.axisMode)
    setShowDepLabels(state.showDepLabels)
    setShowDeps(state.showDeps)
    setHideCrossCatDeps(state.hideCrossCatDeps)
    setShowCrucialDepsOnly(state.showCrucialDepsOnly)
    setColorDependencyDirection(state.colorDependencyDirection)
    setShowRowScheduleMarker(state.showRowScheduleMarker)
    setShowRowTimeSlotMeta(state.showRowTimeSlotMeta)
    setTimeSlotLabelMode(state.timeSlotLabelMode)
    leftPanelWidthRef.current = state.leftPanelWidth
    setLeftPanelWidth(state.leftPanelWidth)
    setTimeSlotScaleFilter(state.timeSlotScaleFilter)

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
    setPinnedTimeSlotId(state.selection?.pinnedTimeSlotId ?? null)
	    setActivePerspectiveId(perspective?.id ?? NONE_PERSPECTIVE_ID)
	
	    requestAnimationFrame(() => {
	      const nextLeft = restoredScrollLeftForState(state)
	      const nextColW = state.spacing?.colW ?? spacingRef.current.colW
	      const needed = Math.ceil((nextLeft + vpRef.current.w) / nextColW) + COL_BUF + EDGE_COLS + 1
	      if (needed > totalColsRef.current) {
	        totalColsRef.current = needed
	        setTotalCols(needed)
	        if (gridInnerRef.current) gridInnerRef.current.style.width = `${needed * nextColW}px`
	      }
	      if (gridBodyRef.current) gridBodyRef.current.scrollLeft = nextLeft
	      scrollLeftRef.current = gridBodyRef.current?.scrollLeft ?? nextLeft
	      setScrollLeft(scrollLeftRef.current)
	    })
	  }, [activeDimId, activeLaneFilterId, colorDimId, restoredScrollLeftForState])
  restorePerspectiveSnapshotRef.current = state => {
    applyPerspective({ id: state?.activePerspectiveId ?? NONE_PERSPECTIVE_ID, state: state ?? {} })
  }

  const returnToDependencyResolveSnapshot = useCallback(() => {
    if (!dependencyResolveSnapshot) return
    const state = normalizeSchedulePerspectiveState(dependencyResolveSnapshot)
    const nextActiveDimId = state.group?.activeDimId || ''
    const nextActiveLaneFilterId = state.group?.activeLaneFilterId || ''
    const nextColorDimId = state.color?.colorDimId || ''
    restoringPerspectiveRef.current = nextActiveDimId !== activeDimId || nextActiveLaneFilterId !== activeLaneFilterId
    restoringColorRef.current = nextColorDimId !== colorDimId

    setSpacing(state.spacing)
    setTimeZoom(state.timeZoom)
    setMode(state.mode)
    setAxisMode(state.axisMode)
    setShowDepLabels(state.showDepLabels)
    setShowDeps(state.showDeps)
    setHideCrossCatDeps(state.hideCrossCatDeps)
    setShowCrucialDepsOnly(state.showCrucialDepsOnly)
    setColorDependencyDirection(state.colorDependencyDirection)
    setShowRowScheduleMarker(state.showRowScheduleMarker)
    setShowRowTimeSlotMeta(state.showRowTimeSlotMeta)
    setTimeSlotLabelMode(state.timeSlotLabelMode)
    leftPanelWidthRef.current = state.leftPanelWidth
    setLeftPanelWidth(state.leftPanelWidth)
    setTimeSlotScaleFilter(state.timeSlotScaleFilter)

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
    setSelectedIds(new Set(Array.isArray(state.selection?.timeSlotIds) ? state.selection.timeSlotIds : []))
    setSelectedDepIds(new Set(Array.isArray(state.selection?.dependencyIds) ? state.selection.dependencyIds : []))
    setPinnedTimeSlotId(state.selection?.pinnedTimeSlotId ?? null)
    setActivePerspectiveId(state.activePerspectiveId ?? activePerspectiveId)
    setPendingDependencyResolveIds(new Set())
    setDependencyResolveSnapshot(null)

	    requestAnimationFrame(() => {
	      const nextLeft = restoredScrollLeftForState(state)
	      const nextColW = state.spacing?.colW ?? spacingRef.current.colW
	      const needed = Math.ceil((nextLeft + vpRef.current.w) / nextColW) + COL_BUF + EDGE_COLS + 1
	      if (needed > totalColsRef.current) {
	        totalColsRef.current = needed
	        setTotalCols(needed)
	        if (gridInnerRef.current) gridInnerRef.current.style.width = `${needed * nextColW}px`
	      }
	      if (gridBodyRef.current) gridBodyRef.current.scrollLeft = nextLeft
	      scrollLeftRef.current = gridBodyRef.current?.scrollLeft ?? nextLeft
	      setScrollLeft(scrollLeftRef.current)
	    })
	  }, [activeDimId, activeLaneFilterId, activePerspectiveId, colorDimId, dependencyResolveSnapshot, restoredScrollLeftForState])

  const createPerspective = useCallback(async name => {
    try {
      const created = normalizePerspective(await api.createSchedulePerspective({ name, state: capturePerspectiveState() }, activeContextId))
      playSound('perspectiveSave')
      setPerspectives(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      setActivePerspectiveId(created.id)
    } catch (err) { console.error(err) }
  }, [activeContextId, capturePerspectiveState])

  const updatePerspectiveSnapshot = useCallback(async perspectiveId => {
    if (perspectiveId === NONE_PERSPECTIVE_ID) return
    try {
      const saved = normalizePerspective(await api.updateSchedulePerspective(perspectiveId, { state: capturePerspectiveState() }))
      playSound('perspectiveUpdate')
      setPerspectives(prev => prev.map(p => p.id === saved.id ? saved : p))
      setActivePerspectiveId(saved.id)
    } catch (err) { console.error(err) }
  }, [capturePerspectiveState])

  const renamePerspective = useCallback(async (perspectiveId, name) => {
    if (perspectiveId === NONE_PERSPECTIVE_ID) return
    try {
      const saved = normalizePerspective(await api.updateSchedulePerspective(perspectiveId, { name }))
      playSound('perspectiveRename')
      setPerspectives(prev => prev.map(p => p.id === saved.id ? saved : p).sort((a, b) => a.name.localeCompare(b.name)))
    } catch (err) { console.error(err) }
  }, [])

  const deletePerspective = useCallback(async perspectiveId => {
    if (perspectiveId === NONE_PERSPECTIVE_ID) return
    try {
      await api.deleteSchedulePerspective(perspectiveId)
      playSound('perspectiveDelete')
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
    if (contextDefaultPerspectiveId === undefined) return
    const nextId = contextDefaultPerspectiveId || NONE_PERSPECTIVE_ID
    setDefaultPerspectiveId(nextId)
    appliedDefaultRef.current = false
    try { window.localStorage.setItem(SCHEDULE_DEFAULT_PERSPECTIVE_KEY, nextId) } catch {}
  }, [contextDefaultPerspectiveId, contextApplyToken])

  useEffect(() => {
    if (!isActive) {
      appliedDefaultRef.current = false
      return
    }
    if (externalResolveRequest) {
      appliedDefaultRef.current = true
      return
    }
    if (appliedDefaultRef.current || dimensions.length === 0) return
    const defaultPerspective = perspectiveOptions.find(p => p.id === defaultPerspectiveId) ?? nonePerspective
    appliedDefaultRef.current = true
    applyPerspective(defaultPerspective)
  }, [applyPerspective, defaultPerspectiveId, visibleDimensions.length, isActive, nonePerspective, perspectiveOptions, externalResolveRequest])

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

  // ── TimeSlot mouse-down (move / resize) ───────────────────────────────────
  const handleTimeSlotMouseDown = useCallback((e, timeSlotId, side) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setContextMenu(null)
    setSelectedDepIds(new Set())
    const pickDraft = inheritancePickRef.current
    if (pickDraft) {
      const target = timeSlotsRef.current.find(m => m.id === timeSlotId)
      if (target) completeInheritancePickRef.current?.(target.noteId)
      return
    }
    if (modeRef.current === 'dependency') return  // handled by dependency port dragging

    if (side) {
      startResizeDrag(e.clientX, timeSlotId, side)
      return
    }

    const alreadySelected = selectedIdsRef.current.has(timeSlotId)
    let idsToMove
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd: toggle this timeSlot in/out of the existing selection
      const next = new Set(selectedIdsRef.current)
      if (alreadySelected) next.delete(timeSlotId)
      else next.add(timeSlotId)
      idsToMove = [...next]
    } else {
      idsToMove = alreadySelected ? [...selectedIdsRef.current] : [timeSlotId]
    }

    const originals = {}
    idsToMove.forEach(id => {
      const m = timeSlotsRef.current.find(m => m.id === id)
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
    if (inheritancePickRef.current) {
      const cell = getNoteCellFromPointer(e)
      if (cell?.type === 'cell') {
        e.preventDefault()
        e.stopPropagation()
        completeInheritancePickRef.current?.(cell.noteId)
      }
      return
    }
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
	    if (e.target.closest('[data-ms-id]')) return  // handled by timeSlot
	    const cell = getNoteCellFromPointer(e)
	    if (!nostalgiaModeRef.current && cell?.type === 'cell' && cell.col < todayMinuteRef.current) {
	      showPastWorkWarning('This canvas position is before today. Enable nostalgia mode if you intentionally want to work in the past.')
	      return
	    }
	    if (cell?.type === 'cell') showProjectEndWarningIfNeeded({ startCol: cell.col })
	    startMarqueeDrag(e.clientX, e.clientY)
	  }, [getNoteCellFromPointer, showPastWorkWarning, showProjectEndWarningIfNeeded]) // eslint-disable-line

  // ── Virtual ranges ─────────────────────────────────────────────────────────
  const { colW, rowH } = spacing
  // TimeSlot geometry — clamp to fit within row height
  const msH = Math.min(TIME_SLOT_H, Math.max(4, rowH - 8))
  const msY = Math.max(2, Math.floor((rowH - msH) / 2))

  const startCol = Math.max(0,         Math.floor(scrollLeft / colW) - COL_BUF)
  const endCol   = Math.min(totalCols, Math.ceil((scrollLeft + vpSize.w) / colW) + COL_BUF)
  const visCols  = Array.from({ length: Math.max(0, endCol - startCol) }, (_, i) => startCol + i)
  const visibleMonthSegments = timeZoom === 'minutes' ? buildAxisSegments(
    visCols,
    col => minuteToDate(zoomColToMinute(col, timeZoom)),
    date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
    dayBandLabel
  ) : timeZoom === 'months' ? buildAxisSegments(
    visCols,
    col => minuteToDate(zoomColToMinute(col, timeZoom)),
    date => `${date.getFullYear()}`,
    date => `${date.getFullYear()}`
  ) : timeZoom === 'days' ? buildAxisSegments(
    visCols,
    col => minuteToDate(zoomColToMinute(col, timeZoom)),
    date => `${date.getFullYear()}-${date.getMonth()}`,
    date => `${MONTH_ABR[date.getMonth()]} ${date.getFullYear()}`
  ) : null
  const visibleWeekSegments = timeZoom === 'minutes' ? buildAxisSegments(
    visCols,
    col => minuteToDate(zoomColToMinute(col, timeZoom)),
    date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`,
    hourBandLabel
  ) : timeZoom === 'days' ? buildAxisSegments(
    visCols,
    col => minuteToDate(zoomColToMinute(col, timeZoom)),
    date => {
      const { week, year } = isoWeekInfo(date)
      return `${year}-${week}`
    },
    date => `KW ${isoWeekInfo(date).week}`
  ) : null
  const visibleDayCuts = timeZoom === 'minutes'
    ? visCols.filter(col => col > 0 && zoomColToMinute(col, timeZoom) % (60 * 24) === 0)
    : []
  const visibleHourCuts = timeZoom === 'minutes'
    ? visCols.filter(col => {
        if (col <= 0) return false
        const minute = zoomColToMinute(col, timeZoom)
        return minute % 60 === 0 && minute % (60 * 24) !== 0
      })
    : []
  const visibleMonthCuts = timeZoom === 'days'
    ? visCols.filter(col => {
        if (col <= 0) return false
        const date = minuteToDate(zoomColToMinute(col, timeZoom))
        const prev = minuteToDate(zoomColToMinute(col - 1, timeZoom))
        return date.getMonth() !== prev.getMonth() || date.getFullYear() !== prev.getFullYear()
      })
    : []
  const axisLabelVertical = timeZoom === 'months' && colW < 58
  const scaleVisibilityMode = normalizeScaleVisibilityMode(timeSlotScaleFilter)
  const proportionalTimeSlots = scaleVisibilityMode === SCALE_VISIBILITY_MODES.ALL

  const bufH    = ROW_BUF * rowH
  const visItems = rowItems.filter(r => r.top + r.height >= scrollTop - bufH && r.top <= scrollTop + vpSize.h + bufH)

  // TimeSlots: filter to visible columns + rows + always include dragged
  const draggedIds = dragRef.current?.type === 'move'
    ? new Set(Object.keys(dragRef.current?.originals || {}))
    : new Set()

  const visTimeSlots = timeSlots.filter(m => {
    if (draggedIds.has(m.id)) return true
    if (!isTimeSlotVisibleAtZoom(m.duration, timeZoom, scaleVisibilityMode, m.startCol)) return false
    const visual = getRenderedVisualRange(m, timeZoom, scaleVisibilityMode)
    if (visual.endCol < startCol || visual.startCol > endCol) return false
    const row = noteRowMap[m.noteId]; if (!row) return false
    return row.top + row.height >= scrollTop - bufH && row.top <= scrollTop + vpSize.h + bufH
  })

  const inLaneMode = Boolean(activeDimId) || Boolean(activeLaneFilter)

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className={`${styles.note} ${paintCat || paintPersonaId ? styles.paintMode : ''} ${inheritancePick ? styles.inheritancePickMode : ''}`}
      style={paintCat ? { cursor: makeColorCursor(paintCat.color) } : personaCursor ? { cursor: personaCursor } : undefined}
      onClick={(paintCat || paintPersonaId) ? () => { setPaintCat(null); setPaintPersonaId(null) } : undefined}>
      <GanttToolbar
        dimensions={visibleDimensions} activeDimId={activeDimId}
        activeCategories={activeCategories}
        categories={categories}
        hiddenCatIds={hiddenCatIds}
        onToggleCategory={toggleCategoryVisibility}
        onShowAllCategories={showAllCategories}
        onShowOnlyCategory={showOnlyCategory}
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
        timeSlotScaleFilter={timeSlotScaleFilter} onTimeSlotScaleFilterChange={setTimeSlotScaleFilter}
        showRowScheduleMarker={showRowScheduleMarker} onShowRowScheduleMarkerChange={setShowRowScheduleMarker}
        showRowTimeSlotMeta={showRowTimeSlotMeta} onShowRowTimeSlotMetaChange={setShowRowTimeSlotMeta}
        timeSlotLabelMode={timeSlotLabelMode} onTimeSlotLabelModeChange={setTimeSlotLabelMode}
	        nostalgiaMode={nostalgiaMode}
	        onToggleNostalgia={toggleNostalgiaMode}
	      />

      <div className={styles.canvasRow}>

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div className={styles.leftPanel} style={{ width: leftPanelWidth }}>
          <div className={styles.panelResizeHandle} onMouseDown={handlePanelResizeStart} />
          <div className={styles.corner}>
            <CornerGanttControls
              canUndo={transactionHistory.undo.length > 0}
              canRedo={transactionHistory.redo.length > 0}
              onUndo={undoGanttTransaction}
              onRedo={redoGanttTransaction}
              mode={mode}
              onModeChange={setMode}
            />
          </div>
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
                      draggable={Boolean(item.cat && activeDimId && !paintCat && !paintPersonaId)}
                      onDragStart={e => {
                        if (!item.cat || !activeDimId || paintCat || paintPersonaId) return
                        e.dataTransfer.setData('schedule-cat-id', item.cat.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDraggingCatId(item.cat.id)
                      }}
                      onDragEnd={() => { setDraggingCatId(null); setDragOverCatReorderId(null) }}
                      onDragOver={e => {
                        if (e.dataTransfer.types.includes('persona-drag') && item.cat) {
                          e.preventDefault()
                          setDragOverLaneCatId(lhCatKey); setDragOverCatReorderId(null)
                          return
                        }
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
                        const personaId = e.dataTransfer.getData('persona-drag')
                        if (personaId && item.cat && activeDimId) {
                          setDragOverLaneCatId(null)
                          assignPersonaToLaneCategory(personaId, item.cat.id)
                          return
                        }
                        const catId = e.dataTransfer.getData('schedule-cat-id')
                        const noteId = e.dataTransfer.getData('schedule-note-id')
                        setDragOverLaneCatId(null)
                        setDragOverCatReorderId(null)
                        if (catId && item.cat) reorderCategoryInGantt(catId, item.cat.id)
                        else if (noteId) moveNoteToLane(noteId, item.cat?.id ?? null)
                      }}
                      onContextMenu={e => {
                        if (!activeDimId || activeLaneFilter) return
                        e.preventDefault()
                        e.stopPropagation()
                        setContextMenu({
                          type: 'lane',
                          x: e.clientX,
                          y: e.clientY,
                          categoryId: item.cat?.id ?? UNASSIGNED_LANE,
                          categoryName: item.cat?.name ?? 'Unassigned',
                        })
                      }}
                      onClick={paintPersonaId && item.cat ? e => {
                        e.stopPropagation()
                        assignPersonaToLaneCategory(paintPersonaId, item.cat.id)
                      } : undefined}>
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
                      {item.cat && (catPersonasMap[item.cat.id] || []).length > 0 && (
                        <span className={styles.lanePersonaStack}>
                          <PersonaAvatarStack
                            personas={catPersonasMap[item.cat.id]}
                            onRemove={personaId => removePersonaFromLaneCategory(personaId, item.cat.id)}
                          />
                        </span>
                      )}
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
                if (item.type === 'note') {
                  const noteTimeSlot = timeSlotByNote.get(item.note.id)
                  return (
                    <div key={item.note.id}
                      className={[
                        inLaneMode ? styles.noteRowLane : styles.noteRow,
                        dragOverNoteId === item.note.id && styles.noteRowDropTarget,
                        isNoteHighlighted(item.note.id) && styles.noteRowHighlight,
                      ].filter(Boolean).join(' ')}
                      draggable={Boolean(activeDimId) && !paintCat && !paintPersonaId}
                      onDragStart={e => {
                        if (paintCat || paintPersonaId || !activeDimId) return
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
                        if (e.dataTransfer.types.includes('persona-drag')) {
                          e.preventDefault()
                          setDragOverNoteId(item.note.id)
                          setDragOverLaneCatId(null)
                          return
                        }
                        if (!activeDimId || !e.dataTransfer.types.includes('schedule-note-id')) return
                        e.preventDefault()
                        setDragOverNoteId(item.note.id)
                        setDragOverLaneCatId(null)
                      }}
                      onDragLeave={() => setDragOverNoteId(prev => prev === item.note.id ? null : prev)}
                      onDrop={e => {
                        e.preventDefault()
                        const personaId = e.dataTransfer.getData('persona-drag')
                        if (personaId) {
                          setDragOverNoteId(null)
                          assignPersonaToNote(personaId, item.note.id)
                          return
                        }
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
                      onClick={(paintCat || paintPersonaId) ? e => {
                    e.stopPropagation()
                    paintNote(item.note.id)
                  } : undefined}
                      onMouseDown={e => {
                        if (e.button !== 0 || !inheritancePickRef.current) return
                        e.preventDefault()
                        e.stopPropagation()
                        completeInheritancePickRef.current?.(item.note.id)
                      }}
                      onContextMenu={e => {
                        e.preventDefault()
                        e.stopPropagation()
                        setClickedNoteId(item.note.id)
                        setContextMenu({
                          type: 'note',
                          x: e.clientX,
                          y: e.clientY,
                          noteId: item.note.id,
                          noteTitle: item.note.title,
                          hasTimeSlot: timeSlotByNote.has(item.note.id),
                        })
                      }}
                      onDoubleClick={e => {
                        e.stopPropagation()
                        if (paintCat || paintPersonaId) return
                        onNoteOpen?.(item.note.id)
                      }}
                      style={{ top: item.top, height: item.height, borderLeftColor: item.cat?.color ?? 'transparent' }}>
                      {showRowScheduleMarker && noteTimeSlot && (
                        <span className={styles.noteScheduleDot} title="Scheduled" aria-hidden="true" />
                      )}
                      <PersonaAvatarStack
                        personas={notePersonasMap[item.note.id] || []}
                        onRemove={personaId => removePersonaFromNote(personaId, item.note.id)}
                      />
                      <span
                        className={`${styles.noteTitle} ${paintCat ? styles.paintTarget : ''}`}
                        title={paintCat ? 'Apply selected category' : undefined}
                        onClick={(paintCat || paintPersonaId) ? undefined : e => {
                          e.stopPropagation()
                          setClickedNoteId(prev => prev === item.note.id ? null : item.note.id)
                        }}
                        onDoubleClick={e => {
                          e.stopPropagation()
                          if (paintCat || paintPersonaId) return
                          onNoteOpen?.(item.note.id)
                        }}>
                        {item.note.title}
                      </span>
                      {showRowTimeSlotMeta && noteTimeSlot && (
                        <span
                          className={[
                            styles.noteTimeSlotBadge,
                            noteTimeSlot.duration <= MIN_TIME_SLOT_DURATION && styles.noteTimeSlotBadgeMinimum,
                          ].filter(Boolean).join(' ')}
                          title={`${formatMinutesDuration(noteTimeSlot.duration)} ${timeSlotScaleBucket(noteTimeSlot)} time slot`}>
                          {compactTimeSlotDurationLabel(noteTimeSlot)} · {compactScaleLabel(noteTimeSlot)}
                        </span>
                      )}
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
                }
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
          onWheel={handleGridWheel}
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
                  const isToday = ci === effectiveTodayZoomCol
                  const isPast  = ci < effectiveTodayZoomCol
                  const date = minuteToDate(zoomColToMinute(ci, timeZoom))
                  const isWeekend = timeZoom === 'days' && (() => { const dow = date.getDay(); return dow === 0 || dow === 6 })()
                  const isDayCut = timeZoom === 'minutes' && ci > 0 && zoomColToMinute(ci, timeZoom) % (60 * 24) === 0
                  const isHourCut = timeZoom === 'minutes' && ci > 0 && zoomColToMinute(ci, timeZoom) % 60 === 0
                  const isMonthCut = timeZoom === 'days' && ci > 0 && (() => {
                    const prev = minuteToDate(zoomColToMinute(ci - 1, timeZoom))
                    return date.getMonth() !== prev.getMonth() || date.getFullYear() !== prev.getFullYear()
                  })()
                  return (
                    <div key={ci}
                      className={[
                        styles.dayHeader,
                        isToday && styles.dayHeaderToday,
                        isPast && !isToday && styles.dayHeaderPast,
                        isWeekend && !isToday && styles.dayHeaderWeekend,
                        isHourCut && !isDayCut && styles.dayHeaderHourCut,
                        isDayCut && styles.dayHeaderDayCut,
                        isMonthCut && styles.dayHeaderMonthCut,
                      ].filter(Boolean).join(' ')}
                      style={{ left: ci * colW, width: colW }}>
                      <span className={[styles.dayNum, axisLabelVertical && styles.dayNumVertical, isToday && styles.dayNumToday].filter(Boolean).join(' ')}>
                        {axisColumnLabel(ci, timeZoom)}
                      </span>
                    </div>
                  )
                })}
              </>)}
              {axisMode === 'numbers' && (
                visCols.map(ci => (
                  <div key={ci}
                    className={[styles.dayHeader, styles.dayHeaderNumbers, ci === effectiveTodayZoomCol && styles.dayHeaderToday].filter(Boolean).join(' ')}
                    style={{ left: ci * colW, width: colW }}>
                    <span className={[styles.dayNum, ci === effectiveTodayZoomCol && styles.dayNumToday].filter(Boolean).join(' ')}>
                      {ci + 1}
                    </span>
                  </div>
                ))
              )}
            </div>

            {/* Today + past region + weekend column tints */}
            {todayZoomCol > 0 && (
              <div className={styles.pastOverlay} style={{ left: 0, width: todayZoomCol * colW }} />
            )}
            <div className={styles.todayCol} style={{ left: effectiveTodayZoomCol * colW, width: colW }} />
            {visibleDayCuts.map(ci => (
              <div key={`day-cut-${ci}`} className={`${styles.scaleCut} ${styles.dayCut}`} style={{ left: ci * colW }} />
            ))}
            {visibleHourCuts.map(ci => (
              <div key={`hour-cut-${ci}`} className={`${styles.scaleCut} ${styles.hourCut}`} style={{ left: ci * colW }} />
            ))}
            {visibleMonthCuts.map(ci => (
              <div key={`month-cut-${ci}`} className={`${styles.scaleCut} ${styles.monthCut}`} style={{ left: ci * colW }} />
            ))}
            {timeZoom === 'days' && visCols.map(ci => {
              const dow = minuteToDate(zoomColToMinute(ci, timeZoom)).getDay()
              return (dow === 0 || dow === 6)
                ? <div key={`wk-${ci}`} className={styles.weekendCol} style={{ left: ci * colW, width: colW }} />
                : null
            })}

	            {/* Project end date marker */}
	            {endDateZoomCol != null && (
	              <>
	                <div
	                  className={styles.afterEndOverlay}
	                  style={{ left: endDateZoomCol * colW, width: Math.max(0, totalCols - endDateZoomCol) * colW }}
	                />
	                <div className={styles.endDateLine} style={{ left: endDateZoomCol * colW }}>
	                  <span>Project end</span>
	                </div>
	              </>
	            )}

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
                  className={[
                    styles.gridNoteRow,
                    isNoteHighlighted(item.note.id) && styles.gridNoteRowHighlight,
                  ].filter(Boolean).join(' ')}
                  style={{ top: HEADER_H + item.top, height: item.height }} />
              return null
            })}

            {/* Earliest start markers */}
            {effectiveEarliestStarts.map(es => {
              const row = noteRowMap[es.noteId]; if (!row) return null
              if (!isEarliestStartVisibleAtZoom(es, timeZoom, scaleVisibilityMode)) return null
              const visualCol = proportionalTimeSlots
                ? minuteToZoomColExact(es.col, timeZoom)
                : minuteToZoomCol(es.col, timeZoom)
              const hatchWidth = Math.max(0, visualCol) * colW
              return hatchWidth > 0 ? (
                <div key={`es-${es.noteId}`} className={styles.earliestStartHatch}
                  style={{ left: 0, top: HEADER_H + row.top, width: hatchWidth, height: row.height }} />
              ) : null
            })}

            {/* Hard deadline markers */}
            {effectiveDeadlines.map(dl => {
              const row = noteRowMap[dl.noteId]; if (!row) return null
              if (!isDeadlineVisibleAtZoom(dl, timeZoom, scaleVisibilityMode)) return null
              const visualCol = proportionalTimeSlots
                ? minuteToZoomColExact(dl.col, timeZoom)
                : minuteToZoomCol(dl.col, timeZoom)
              const hatchLeft  = visualCol * colW
              const hatchWidth = Math.max(0, totalCols - visualCol) * colW
              return hatchWidth > 0 ? (
                <div key={`dl-${dl.noteId}`} className={styles.deadlineHatch}
                  style={{ left: hatchLeft, top: HEADER_H + row.top, width: hatchWidth, height: row.height }} />
              ) : null
            })}

            {/* Dependency-derived movement limits */}
            {dependencyConstraintWindows.starts.map(es => {
              const row = noteRowMap[es.noteId]; if (!row) return null
              const affected = timeSlots.find(m => m.id === es.timeSlotId); if (!affected) return null
              const visualCol = proportionalTimeSlots
                ? minuteToZoomColExact(es.col, timeZoom)
                : minuteToZoomCol(es.col, timeZoom)
              const hatchWidth = Math.max(0, visualCol) * colW
              return hatchWidth > 0 ? (
                <div key={es.id}
                  className={`${styles.dependencyConstraintHatch} ${styles.dependencyStartConstraint}`}
                  title={`${es.dependencyIds.length} incoming dependency constraint${es.dependencyIds.length === 1 ? '' : 's'}`}
                  style={{ left: 0, top: HEADER_H + row.top + msY, width: hatchWidth, height: msH }} />
              ) : null
            })}
            {dependencyConstraintWindows.deadlines.map(dl => {
              const row = noteRowMap[dl.noteId]; if (!row) return null
              const affected = timeSlots.find(m => m.id === dl.timeSlotId); if (!affected) return null
              const visualCol = proportionalTimeSlots
                ? minuteToZoomColExact(dl.col, timeZoom)
                : minuteToZoomCol(dl.col, timeZoom)
              const hatchLeft = visualCol * colW
              const hatchWidth = Math.max(0, totalCols - visualCol) * colW
              return hatchWidth > 0 ? (
                <div key={dl.id}
                  className={`${styles.dependencyConstraintHatch} ${styles.dependencyDeadlineConstraint}`}
                  title={`${dl.dependencyIds.length} outgoing dependency constraint${dl.dependencyIds.length === 1 ? '' : 's'}`}
                  style={{ left: hatchLeft, top: HEADER_H + row.top + msY, width: hatchWidth, height: msH }} />
              ) : null
            })}

            {/* TimeSlots */}
	            {visTimeSlots.map(m => {
	              const row = noteRowMap[m.noteId]; if (!row) return null
	              const visual = getRenderedVisualRange(m, timeZoom, scaleVisibilityMode)
	              const isSelected    = selectedIds.has(m.id)
              const isPinned      = pinnedTimeSlotId === m.id
              const isViolating   = violationIds.has(m.id)
              const isBlinking    = blinkingTimeSlotIds.has(m.id)
              const isDepMode     = mode === 'dependency'
              const isSource      = drawingState?.fromId === m.id
	              const msColor       = getTimeSlotColor(m)
	              const isUnassigned  = msColor === null
	              const isMinimumDuration = m.duration <= MIN_TIME_SLOT_DURATION
	              const isScaleEditable = isTimeSlotEditableAtZoom(m.duration, timeZoom, m.startCol)
	              const widthPx = visual.duration * colW
	              const isTinyProportional = proportionalTimeSlots && widthPx < 12
	              return (
                <div key={m.id}
                  data-ms-id={m.id}
                  ref={el => { el ? timeSlotElsRef.current.set(m.id, el) : timeSlotElsRef.current.delete(m.id) }}
                  className={[
                    styles.timeSlot,
                    isSelected   && styles.timeSlotSelected,
                    isPinned     && styles.timeSlotPinned,
                    isViolating  && styles.timeSlotViolation,
                    isBlinking   && styles.timeSlotBlink,
	                    isDepMode    && styles.timeSlotDepMode,
	                    isUnassigned && styles.timeSlotUnassigned,
	                    isMinimumDuration && styles.timeSlotMinimum,
	                    proportionalTimeSlots && styles.timeSlotProportional,
	                    isTinyProportional && styles.timeSlotTiny,
	                    !isScaleEditable && styles.timeSlotScaleLocked,
	                  ].filter(Boolean).join(' ')}
	                  style={{
	                    left:       visual.startCol * colW,
	                    top:        HEADER_H + row.top + msY,
	                    width:      widthPx,
	                    minWidth:   proportionalTimeSlots ? 0 : undefined,
                    height:     msH,
                    background: msColor ?? '#fff',
                  }}
                  title={!isScaleEditable ? `Switch to ${scaleLabelForZoom(getTimeSlotLevel(m.duration, m.startCol))} view to edit this time slot.` : undefined}
                  onMouseDown={e => {
                    if (paintCat || paintPersonaId) {
                      e.preventDefault()
                      e.stopPropagation()
                      return
                    }
                    if (isDepMode) {
                      startDependencyDrag(e, m.id)
                      return
                    }
                    handleTimeSlotMouseDown(e, m.id, null)
                  }}
                  onClick={(paintCat || paintPersonaId) ? e => {
                    e.stopPropagation()
                    paintNote(m.noteId)
                  } : undefined}
                  onDoubleClick={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (paintCat || paintPersonaId) return
                    onNoteOpen?.(m.noteId)
                  }}
                  onContextMenu={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (paintCat || paintPersonaId) return
                    const note = notes.find(g => g.id === m.noteId)
                    const label = `${note?.title ?? 'Time slot'} · ${m.title || minuteToLabel(m.startCol, timeZoom)}`
                    setContextMenu({ type: 'timeSlot', x: e.clientX, y: e.clientY, timeSlotId: m.id, noteId: m.noteId, label })
	                  }}>
	                  <div
                    className={[styles.msHandle, isDepMode && styles.depHandle, isDepMode && isSource && styles.depHandleSource].filter(Boolean).join(' ')}
                    data-ms-id={m.id}
                    data-dep-port={isDepMode && isScaleEditable ? 'true' : undefined}
                    data-dep-side={isDepMode ? 'left' : undefined}
                    onMouseDown={e => {
                      e.stopPropagation()
                      if (paintCat) return
                      if (isDepMode) startDependencyDrag(e, m.id)
                      else handleTimeSlotMouseDown(e, m.id, 'left')
	                    }} />
	                  {timeSlotLabelMode === 'people' ? (
                      <div className={styles.msPeopleLabel}>
                        <PersonaAvatarStack personas={notePersonasMap[m.noteId] || []} />
                      </div>
                    ) : (
                      <span className={styles.msLabel}>
                        {timeSlotLabelMode === 'headline'
                          ? (row.note?.title || 'Untitled')
                          : (m.title || minuteToLabel(m.startCol, timeZoom))}
                      </span>
                    )}
                    {isMinimumDuration && !isTinyProportional && <span className={styles.msMinBadge}>10m</span>}
	                  <div
                    className={[styles.msHandle, styles.msHandleRight, isDepMode && styles.depHandle, isDepMode && isSource && styles.depHandleSource].filter(Boolean).join(' ')}
                    data-ms-id={m.id}
                    data-dep-port={isDepMode && isScaleEditable ? 'true' : undefined}
                    data-dep-side={isDepMode ? 'right' : undefined}
                    onMouseDown={e => {
                      e.stopPropagation()
                      if (paintCat) return
                      if (isDepMode) startDependencyDrag(e, m.id)
                      else handleTimeSlotMouseDown(e, m.id, 'right')
                    }} />
                </div>
              )
            })}

            {/* Dependency arrows SVG — pointer-events none on container, individual paths can override */}
            <svg className={styles.depSvg}
              style={{ width: totalCols * colW, height: totalContentH + HEADER_H }}>
              {showDeps && dependencies.map(dep => {
                if (showCrucialDepsOnly && !crucialDependencyIds.has(dep.id)) return null
	                const from = timeSlots.find(m => m.id === dep.fromId)
	                const to   = timeSlots.find(m => m.id === dep.toId)
	                if (!from || !to) return null
	                if (!isTimeSlotVisibleAtZoom(from.duration, timeZoom, scaleVisibilityMode, from.startCol)) return null
	                if (!isTimeSlotVisibleAtZoom(to.duration, timeZoom, scaleVisibilityMode, to.startCol)) return null
                const fromRow = noteRowMap[from.noteId]; const toRow = noteRowMap[to.noteId]
                if (!fromRow || !toRow) return null
                if (hideCrossCatDeps && activeDimId) {
                  const fromCat = assignments[from.noteId]?.[activeDimId] ?? null
                  const toCat   = assignments[to.noteId]?.[activeDimId] ?? null
                  if (fromCat !== toCat) return null
                }
	                const fromVisual = getRenderedVisualRange(from, timeZoom, scaleVisibilityMode)
	                const toVisual = getRenderedVisualRange(to, timeZoom, scaleVisibilityMode)
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
	        {externalResolveRequest && (
	          <button
	            type="button"
            className={styles.dependencyResolveReturnBtn}
            onClick={onExternalResolveReturn}
          >
            <strong>{externalResolveRequest.mode === 'inspect' ? 'Calendar inspection' : 'Calendar resolve'}</strong>
	            <span>Return to the previous calendar view</span>
	          </button>
	        )}
	        {dependencyResolveSnapshot && (
	          <button
	            type="button"
            className={styles.dependencyResolveReturnBtn}
            onClick={returnToDependencyResolveSnapshot}
          >
            <strong>Resolve view</strong>
	            <span>{scaleLabelForZoom(timeZoom)} scale · Return to previous view</span>
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
          onDimDataChanged={handleDimDataChanged}
          activeFilterIds={activeFilterIds}
          onToggleSavedFilter={toggleSavedFilter}
          quickFilters={quickFilters}
          onToggleQuickFilter={toggleQuickFilter}
          onEditFilter={filterId => setEditingFilter(savedFilters.find(filter => filter.id === filterId))}
          paintCat={paintCat}
          onPaintActivate={(catId, color) => { setPaintPersonaId(null); activatePaint(catId, color) }}
          expanded={floatingPanel === 'color'}
          onExpandedChange={open => setFloatingPanel(open ? 'color' : null)}
        />
        <PeopleWidget
          paintPersonaId={paintPersonaId}
          onPaintPersonaChange={id => { setPaintCat(null); setPaintPersonaId(id) }}
          onApplyQuickFilter={filterScheduleToPersona}
          expanded={floatingPanel === 'people'}
          onExpandedChange={open => setFloatingPanel(open ? 'people' : null)}
          refreshKey={peopleRefreshKey}
        />
      </div>

      <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)}
        onCreate={handleCreateTimeSlot}
        onInsertTimeUnit={handleInsertTimeUnit}
        onDeleteTimeUnit={handleDeleteTimeUnit}
        onSetDeadline={handleSetDeadline}
        onRemoveDeadline={handleRemoveDeadline}
        onSetEarliestStart={handleSetEarliestStart}
        onRemoveEarliestStart={handleRemoveEarliestStart}
        onCreateNoteInLane={createNoteInLane}
        onCopyNote={copyNoteToScheduleClipboard}
        onDuplicateNote={duplicateNoteInSchedule}
        onStartInheritancePick={startInheritancePick}
        onSeeInheritance={setInheritanceInspectorNoteId}
        onDeleteTimeSlot={handleDeleteTimeSlotRequest}
        onToggleTimeSlotPin={handleToggleTimeSlotPin}
        pinnedTimeSlotId={pinnedTimeSlotId}
        onEditDepReason={handleEditDepReason}
        onDeleteDep={handleDeleteDepRequest} />

      {inheritanceInspectorNoteId && (
        <InheritanceInspectorModal
          noteId={inheritanceInspectorNoteId}
          notes={notes}
          timeSlots={timeSlots}
          noteInheritance={noteInheritance}
          assignments={assignments}
          dimensions={visibleDimensions}
          categories={categories}
          onUnlink={removeInheritanceLink}
          onClose={() => setInheritanceInspectorNoteId(null)}
        />
      )}

      {warningPrompt && (
        <div className={styles.warningPrompt} role="alertdialog" aria-modal="true">
          <button
            type="button"
            className={styles.warningPromptClose}
            aria-label="Close warning"
            onClick={clearWarningPrompt}>
            ×
          </button>
          <div className={styles.warningPromptTitle}>{warningPrompt.title ?? 'Dependency warning'}</div>
          <div className={styles.warningPromptText}>
            {warningPrompt.message ??
              `This change would make ${warningPrompt.count} time slot${warningPrompt.count === 1 ? '' : 's'} violate dependency timing.`}
          </div>
          <div className={styles.warningPromptActions}>
            {warningPrompt.actions === 'dependency' || warningPrompt.actions === 'resolve' ? (
              <>
                <button className={styles.warningSafeBtn} autoFocus onClick={handleWarningResolve}>
                  Resolve
                </button>
              </>
            ) : (
              <button className={warningPrompt.actions === 'confirm' ? styles.warningSafeBtn : styles.warningUndoBtn} autoFocus={warningPrompt.actions === 'confirm'} onClick={clearWarningPrompt}>
                Close
              </button>
            )}
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

      {metricResizeDraft && createPortal(
        <div className={styles.deleteModalBackdrop} onMouseDown={() => setMetricResizeDraft(null)}>
          <div className={styles.deleteModal} role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
            <div className={styles.deleteModalTitle}>Time scale change</div>
            <div className={styles.deleteModalText}>
              This resize moves the time slot from <strong>{metricResizeDraft.origBucket}</strong>-level to <strong>{metricResizeDraft.newBucket}</strong>-level.{' '}
              {metricResizeDraft.crossMetricDeps.length} existing dependenc{metricResizeDraft.crossMetricDeps.length === 1 ? 'y' : 'ies'} would become incompatible across time scales.
            </div>
            <div className={styles.deleteModalActions}>
              <button className={styles.modalSafePrimaryBtn} autoFocus onClick={() => setMetricResizeDraft(null)}>
                Cancel
              </button>
              <button className={styles.modalDangerMutedBtn} onClick={handleMetricResizeAccept}>
                Resize & remove {metricResizeDraft.crossMetricDeps.length === 1 ? 'dep' : `${metricResizeDraft.crossMetricDeps.length} deps`}
              </button>
              <button className={styles.modalDangerMutedBtn} onClick={handleMetricResizeClone}>
                Clone note (Resized {metricResizeDraft.direction})
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
                  <span className={styles.deleteItemType}>{item.type === 'timeSlot' ? 'Time slot' : 'Dependency'}</span>
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
          dimensions={visibleDimensions}
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
                const from = timeSlots.find(m => m.id === dep?.fromId)
                const to   = timeSlots.find(m => m.id === dep?.toId)
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
      {confirmDialogNode}
    </div>
  )
}
