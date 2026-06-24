import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import styles from './SchedulePage.module.css'
import { api } from '../api'

// ── Constants ─────────────────────────────────────────────────────────────────
const HEADER_H     = 52
const LANE_HDR_H   = 30
const MILESTONE_H  = 20   // block height in px
const COL_BUF      = 8
const ROW_BUF      = 3
const EXTEND_DELTA = 365  // days added per extension

const DEFAULT_SPACING = { colW: 110, rowH: 36, rowGap: 0, laneGap: 28 }
const INIT_TOTAL_DAYS = 60    // initial days; grows to cover viewport + buffer on mount
const EDGE_COLS       = 5     // columns from right edge before extending

const MONTH_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const FILTER_DIMENSION_ID = '__filters__'
const FILTER_CATEGORY_PREFIX = 'filter:'

function makeColorCursor(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="${color}" stroke="white" stroke-width="2"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`
}

function filterMatchesGoal(filter, goalId, assignments) {
  if (!filter) return false
  const entries = Object.entries(filter.selections ?? {}).filter(([, catIds]) => catIds.length > 0)
  if (entries.length === 0) return false
  const matchesDim = ([dimId, catIds]) => catIds.includes(assignments[goalId]?.[dimId])
  return filter.gate === 'OR' ? entries.some(matchesDim) : entries.every(matchesDim)
}

function filterCategoryId(filterId) {
  return `${FILTER_CATEGORY_PREFIX}${filterId}`
}

// col 0 = today; col N = N days from today
function colToDate(col) {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + col)
  return d
}

function dateFmt(col) {
  return colToDate(col).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function isoWeekInfo(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
  return { week, year: d.getUTCFullYear() }
}

function buildAxisSegments(cols, getKey, getLabel) {
  const segments = []
  cols.forEach(col => {
    const date = colToDate(col)
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

// ── Row model ─────────────────────────────────────────────────────────────────
const UNASSIGNED_LANE = '__unassigned__'

function laneKeyForCat(cat) {
  return cat?.id ?? UNASSIGNED_LANE
}

function buildRowItems(goals, categories, assignments, assignmentOrders, activeDimId, spacing, hiddenCatIds = new Set(), hiddenGoalsByLane = {}, filterAsLane = null) {
  const { rowH, rowGap, laneGap } = spacing
  const slotH = rowH + rowGap

  // Filter-as-lane: two lanes — goals matching the filter, and the rest
  if (filterAsLane) {
    const matchCat   = { id: filterAsLane.id, name: filterAsLane.name, color: filterAsLane.color }
    const matchGoals = goals.filter(g => filterMatchesGoal(filterAsLane, g.id, assignments))
    const otherGoals = goals.filter(g => !filterMatchesGoal(filterAsLane, g.id, assignments))
    const items = []; let top = 0
    const addFilterLane = (cat, laneGoals, key, first) => {
      const hiddenGoalIds = hiddenGoalsByLane[key] ?? new Set()
      const visible = laneGoals.filter(g => !hiddenGoalIds.has(g.id))
      if (!first) { items.push({ type: 'lane-gap', cat: null, top, height: laneGap }); top += laneGap }
      items.push({ type: 'lane-header', cat, top, height: LANE_HDR_H }); top += LANE_HDR_H
      if (laneGoals.length === 0) {
        items.push({ type: 'empty', cat, top, height: slotH }); top += slotH
      } else {
        visible.forEach(g => { items.push({ type: 'goal', goal: g, cat, top, height: slotH }); top += slotH })
      }
    }
    const matchHidden = hiddenCatIds.has(filterAsLane.id)
    const otherHidden = hiddenCatIds.has(UNASSIGNED_LANE)
    if (!matchHidden) addFilterLane(matchCat, matchGoals, filterAsLane.id, true)
    if (!otherHidden) addFilterLane(null, otherGoals, UNASSIGNED_LANE, matchHidden)
    return items
  }

  if (!activeDimId) {
    return goals.map((g, i) => ({ type: 'goal', goal: g, cat: null, top: i * slotH, height: slotH }))
  }

  const allCats = categories.filter(c => c.dimensionId === activeDimId)
  const cats    = allCats.filter(c => !hiddenCatIds.has(c.id))
  const allCatIds = new Set(allCats.map(c => c.id))
  const catMap  = Object.fromEntries(cats.map(c => [c.id, []]))
  const unassigned = []
  goals.forEach(g => {
    const cid = assignments[g.id]?.[activeDimId]
    if (cid && catMap[cid]) catMap[cid].push(g)
    else if (cid && allCatIds.has(cid)) return
    else unassigned.push(g)
  })

  const sortLaneGoals = laneGoals => [...laneGoals].sort((a, b) => {
    const ao = assignmentOrders[a.id]?.[activeDimId] ?? Number.MAX_SAFE_INTEGER
    const bo = assignmentOrders[b.id]?.[activeDimId] ?? Number.MAX_SAFE_INTEGER
    return ao - bo
  })

  const items = []; let top = 0
  const addLane = (cat, laneGoals, first) => {
    const hiddenGoalIds = hiddenGoalsByLane[laneKeyForCat(cat)] ?? new Set()
    const visibleLaneGoals = sortLaneGoals(laneGoals).filter(g => !hiddenGoalIds.has(g.id))
    if (!first) { items.push({ type: 'lane-gap', cat: null, top, height: laneGap }); top += laneGap }
    items.push({ type: 'lane-header', cat, top, height: LANE_HDR_H }); top += LANE_HDR_H
    if (laneGoals.length === 0) {
      items.push({ type: 'empty', cat, top, height: slotH }); top += slotH
    } else {
      visibleLaneGoals.forEach(g => { items.push({ type: 'goal', goal: g, cat, top, height: slotH }); top += slotH })
    }
  }
  cats.forEach((cat, i) => addLane(cat, catMap[cat.id] ?? [], i === 0))
  if (!hiddenCatIds.has(UNASSIGNED_LANE) && (unassigned.length > 0 || cats.length === 0))
    addLane(null, unassigned, cats.length === 0)
  return items
}

// ── Visual settings panel ─────────────────────────────────────────────────────
function SpacingPanel({ spacing, onChange, onClose, anchorRef, axisMode, onAxisModeChange, showDepLabels, onShowDepLabelsChange, showDeps, onShowDepsChange, hideCrossCatDeps, onHideCrossCatDepsChange }) {
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
        <span className={styles.spacingLabel}>Time axis</span>
        <div className={styles.axisModePills}>
          {[['full', 'All days'], ['numbers', 'Numbers'], ['none', 'None']].map(([val, label]) => (
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
          <label className={styles.depToggle} title="Show dependency labels">
            <input type="checkbox" checked={showDepLabels} onChange={e => onShowDepLabelsChange(e.target.checked)} />
            <span>Labels</span>
          </label>
        </div>
      </div>
    </div>
  )
}

// ── Context menu ──────────────────────────────────────────────────────────────
function ContextMenu({ menu, onClose, onCreate, onInsertDay, onDeleteDay, onSetDeadline, onRemoveDeadline, onDeleteMilestone, onEditDepReason, onDeleteDep }) {
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

function LaneGoalFilter({ laneKey, goals, hiddenGoalIds, onToggleGoal, onShowAllGoals, onHideAllGoals }) {
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

  const hiddenCount = goals.filter(g => hiddenGoalIds.has(g.id)).length

  return (
    <>
      <button
        ref={btnRef}
        className={`${styles.laneFilterBtn} ${hiddenCount > 0 ? styles.laneFilterBtnActive : ''}`}
        disabled={goals.length === 0}
        title="Filter goals in this lane"
        onClick={openMenu}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"/>
        </svg>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className={styles.laneFilterMenu}
          style={{ top: pos.top, left: pos.left, minWidth: pos.width }}>
          {goals.length === 0 ? (
            <div className={styles.laneFilterEmpty}>No goals</div>
          ) : (
            <>
              <div className={styles.laneFilterActions}>
                <button className={styles.laneFilterAll} onClick={() => onShowAllGoals(laneKey)}>Show all</button>
                <button className={styles.laneFilterAll} onClick={() => onHideAllGoals(laneKey, goals.map(g => g.id))}>Show none</button>
              </div>
              {goals.map(goal => (
                <label key={goal.id} className={styles.laneFilterItem}>
                  <input
                    type="checkbox"
                    checked={!hiddenGoalIds.has(goal.id)}
                    onChange={() => onToggleGoal(laneKey, goal.id)}
                  />
                  <span className={styles.laneFilterName}>{goal.title}</span>
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
  showDepLabels, onShowDepLabelsChange,
  showDeps, onShowDepsChange, hideCrossCatDeps, onHideCrossCatDepsChange,
  warningPopupsEnabled, onWarningPopupsEnabledChange,
  canDeleteSelection, onDeleteSelection,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [warningsOpen, setWarningsOpen] = useState(false)
  const settingsBtnRef = useRef()
  const warningsRef = useRef()
  const closeSettings  = useCallback(() => setSettingsOpen(false), [])

  useEffect(() => {
    if (!warningsOpen) return
    const close = e => { if (!warningsRef.current?.contains(e.target)) setWarningsOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [warningsOpen])

  return (
    <div className={styles.toolbar}>
      <button
        className={styles.toolbarDeleteBtn}
        disabled={!canDeleteSelection}
        onClick={onDeleteSelection}>
        Delete
      </button>
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
      <div ref={warningsRef} className={styles.warningWrap}>
        <button
          className={`${styles.warningBtn} ${warningsOpen ? styles.warningBtnOpen : ''}`}
          onClick={() => setWarningsOpen(v => !v)}>
          Warning system
        </button>
        {warningsOpen && (
          <div className={styles.warningMenu}>
            <label className={styles.warningMenuItem}>
              <input
                type="checkbox"
                checked={warningPopupsEnabled}
                onChange={e => onWarningPopupsEnabledChange(e.target.checked)}
              />
              <span>Show dependency warnings</span>
            </label>
          </div>
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
            showDepLabels={showDepLabels} onShowDepLabelsChange={onShowDepLabelsChange}
            showDeps={showDeps} onShowDepsChange={onShowDepsChange}
            hideCrossCatDeps={hideCrossCatDeps} onHideCrossCatDepsChange={onHideCrossCatDepsChange} />
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

  return (
    <div className={styles.legendDropUpWrap}>
      <button ref={btnRef} className={styles.legendDropUpBtn} onClick={toggle}>
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

function ScheduleColorLegendWidget({
  dimensions, categories, colorDimId, onColorDimChange,
  activeFilterIds, onToggleSavedFilter, quickFilters, onToggleQuickFilter, onEditFilter, paintCat, onPaintActivate,
}) {
  const [expanded, setExpanded] = useState(false)
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
                  title="Quick filter goals by this category"
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
        onClick={() => setExpanded(v => !v)}
        title={expanded ? 'Collapse legend' : 'Color legend'}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
        </svg>
      </button>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function SchedulePage({ goals = [], isActive = false, onGoalOpen }) {
  // ── API data ───────────────────────────────────────────────────────────────
  const [dimensions,   setDimensions]   = useState([])
  const [categories,   setCategories]   = useState([])
  const [assignments,  setAssignments]  = useState({})
  const [assignmentOrders, setAssignmentOrders] = useState({})
  const [milestones,   setMilestones]   = useState([])
  const [dependencies, setDependencies] = useState([])
  const [deadlines,    setDeadlines]    = useState([])
  const [savedFilters, setSavedFilters] = useState([])
  const [editingFilter, setEditingFilter] = useState(null)
  const [drawingState, setDrawingState] = useState(null)  // { fromId } while drawing

  useEffect(() => {
    if (!isActive) return
    Promise.all([
      api.getDimensions(), api.getAllCategories(), api.getAssignments(),
      api.getMilestones(), api.getDependencies(), api.getDeadlines(), api.getFilters(),
    ]).then(([dims, cats, assigns, mss, deps, dls, filters]) => {
      setDimensions(dims); setCategories(cats)
      setSavedFilters(filters)
      const map = {}
      const orderMap = {}
      assigns.forEach(a => {
        if (!map[a.goalId]) map[a.goalId] = {}
        if (!orderMap[a.goalId]) orderMap[a.goalId] = {}
        map[a.goalId][a.dimensionId] = a.categoryId
        orderMap[a.goalId][a.dimensionId] = a.orderIdx ?? 0
      })
      setAssignments(map)
      setAssignmentOrders(orderMap)
      setMilestones(mss)
      setDependencies(deps)
      setDeadlines(dls)
      const priorityDim = dims.find(d => d.name === 'Priority')
      if (priorityDim) setColorDimId(priorityDim.id)
    }).catch(console.error)
  }, [isActive])

  // ── Toolbar / mode state ───────────────────────────────────────────────────
  const [mode,              setMode]              = useState('milestone')
  const [activeDimId,       setActiveDimId]       = useState('')
  const [activeLaneFilterId, setActiveLaneFilterId] = useState('')
  const [axisMode, setAxisMode] = useState('full')
  const [showDepLabels, setShowDepLabels] = useState(true)
  const [showDeps, setShowDeps] = useState(true)
  const [hideCrossCatDeps, setHideCrossCatDeps] = useState(false)
  const [reasonModal, setReasonModal] = useState(null)   // null | { depId }
  const [reasonDraft, setReasonDraft] = useState('')
  const reasonInputRef = useRef()
  const [colorDimId,        setColorDimId]        = useState('')
  const [activeFilterIds, setActiveFilterIds] = useState([])
  const [quickFilters, setQuickFilters] = useState([])
  const [paintCat, setPaintCat] = useState(null)
  const [spacing,     setSpacing]     = useState(DEFAULT_SPACING)
  const [hiddenCatIds, setHiddenCatIds] = useState(new Set())
  const [hiddenGoalsByLane, setHiddenGoalsByLane] = useState({})
  const [warningPopupsEnabled, setWarningPopupsEnabled] = useState(true)
  const [warningPrompt, setWarningPrompt] = useState(null)
  const [deleteDraft, setDeleteDraft] = useState(null)
  const [dragOverGoalId, setDragOverGoalId] = useState(null)
  const [dragOverLaneCatId, setDragOverLaneCatId] = useState(null)
  const [draggingCatId, setDraggingCatId] = useState(null)
  const [dragOverCatReorderId, setDragOverCatReorderId] = useState(null)

  const activeCategories = useMemo(
    () => categories.filter(c => c.dimensionId === activeDimId),
    [categories, activeDimId]
  )

  const activeLaneFilter = useMemo(
    () => savedFilters.find(f => f.id === activeLaneFilterId) ?? null,
    [savedFilters, activeLaneFilterId]
  )

  const handleLaneGroupChange = useCallback((value) => {
    if (!value) { setActiveDimId(''); setActiveLaneFilterId('') }
    else if (value.startsWith('d:')) { setActiveDimId(value.slice(2)); setActiveLaneFilterId('') }
    else { setActiveLaneFilterId(value.slice(2)); setActiveDimId('') }
  }, [])

  useEffect(() => {
    setHiddenCatIds(activeLaneFilterId ? new Set([UNASSIGNED_LANE]) : new Set())
    setHiddenGoalsByLane({})
  }, [activeDimId, activeLaneFilterId])

  useEffect(() => {
    setQuickFilters([])
    if (colorDimId !== FILTER_DIMENSION_ID) setActiveFilterIds([])
    setPaintCat(null)
  }, [colorDimId])

  const toggleGoalVisibility = useCallback((laneKey, goalId) => {
    setHiddenGoalsByLane(prev => {
      const nextLane = new Set(prev[laneKey] ?? [])
      if (nextLane.has(goalId)) nextLane.delete(goalId)
      else nextLane.add(goalId)
      return { ...prev, [laneKey]: nextLane }
    })
  }, [])

  const showAllLaneGoals = useCallback(laneKey => {
    setHiddenGoalsByLane(prev => ({ ...prev, [laneKey]: new Set() }))
  }, [])

  const hideAllLaneGoals = useCallback((laneKey, goalIds) => {
    setHiddenGoalsByLane(prev => ({ ...prev, [laneKey]: new Set(goalIds) }))
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

  const paintGoal = useCallback(async goalId => {
    if (!paintCat || !colorDimId || colorDimId === FILTER_DIMENSION_ID) return
    try {
      await api.assign(goalId, colorDimId, paintCat.id)
      setAssignments(prev => ({ ...prev, [goalId]: { ...(prev[goalId] ?? {}), [colorDimId]: paintCat.id } }))
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
  const [totalDays,  setTotalDays]  = useState(INIT_TOTAL_DAYS)

  // ── Selection + context menu ───────────────────────────────────────────────
  const [selectedIds,  setSelectedIds]  = useState(new Set())
  const [selectedDepIds, setSelectedDepIds] = useState(new Set())
  const [contextMenu,  setContextMenu]  = useState(null)
  const [clickedGoalId, setClickedGoalId] = useState(null)

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
  const depPathElsRef   = useRef(new Map())      // dependency id -> SVG path element
  const dependenciesRef = useRef([])
  const deadlinesRef    = useRef([])
  const modeRef         = useRef('milestone')

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
  const selectedDepIdsRef = useRef(new Set())
  selectedDepIdsRef.current = selectedDepIds

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

  const visibleGoals = useMemo(
    () => {
      const activeSavedFilters = activeFilterIds
        .map(id => savedFilters.find(filter => filter.id === id))
        .filter(Boolean)
      const hasActiveFiltering = activeSavedFilters.length > 0 || quickFilters.length > 0
      if (!hasActiveFiltering) return goals
      return goals.filter(goal =>
        activeSavedFilters.some(filter => filterMatchesGoal(filter, goal.id, assignments)) ||
        quickFilters.some(filter => assignments[goal.id]?.[filter.dimId] === filter.catId)
      )
    },
    [activeFilterIds, assignments, goals, quickFilters, savedFilters]
  )

  // ── Row model ──────────────────────────────────────────────────────────────
  const rowItems = useMemo(
    () => buildRowItems(visibleGoals, categories, assignments, assignmentOrders, activeDimId, spacing, hiddenCatIds, hiddenGoalsByLane, activeLaneFilter),
    [visibleGoals, categories, assignments, assignmentOrders, activeDimId, spacing, hiddenCatIds, hiddenGoalsByLane, activeLaneFilter]
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

  const selectedGoalIds = useMemo(() => {
    const set = new Set()
    selectedIds.forEach(msId => {
      const m = milestones.find(m => m.id === msId)
      if (m) set.add(m.goalId)
    })
    return set
  }, [selectedIds, milestones])

  const isGoalHighlighted = goalId => selectedGoalIds.has(goalId) || goalId === clickedGoalId

  const goalsForLane = useCallback(cat => {
    if (activeLaneFilter) {
      const key = laneKeyForCat(cat)
      return key === UNASSIGNED_LANE
        ? visibleGoals.filter(g => !filterMatchesGoal(activeLaneFilter, g.id, assignments))
        : visibleGoals.filter(g => filterMatchesGoal(activeLaneFilter, g.id, assignments))
    }
    if (!activeDimId) return visibleGoals
    const key = laneKeyForCat(cat)
    return visibleGoals.filter(goal => {
      const assignedCatId = assignments[goal.id]?.[activeDimId]
      return key === UNASSIGNED_LANE ? !assignedCatId : assignedCatId === key
    }).sort((a, b) => {
      const ao = assignmentOrders[a.id]?.[activeDimId] ?? Number.MAX_SAFE_INTEGER
      const bo = assignmentOrders[b.id]?.[activeDimId] ?? Number.MAX_SAFE_INTEGER
      return ao - bo
    })
  }, [activeDimId, activeLaneFilter, assignmentOrders, assignments, visibleGoals])

  const reorderGoalInLane = useCallback(async (dragGoalId, targetGoalId) => {
    if (!activeDimId || dragGoalId === targetGoalId) return
    const catId = assignments[dragGoalId]?.[activeDimId]
    if (!catId || assignments[targetGoalId]?.[activeDimId] !== catId) return
    const laneGoals = goalsForLane(categories.find(c => c.id === catId))
    const fromIdx = laneGoals.findIndex(g => g.id === dragGoalId)
    const toIdx = laneGoals.findIndex(g => g.id === targetGoalId)
    if (fromIdx === -1 || toIdx === -1) return
    const reordered = [...laneGoals]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    const goalIds = reordered.map(g => g.id)
    setAssignmentOrders(prev => {
      const next = { ...prev }
      goalIds.forEach((goalId, idx) => {
        next[goalId] = { ...(next[goalId] ?? {}), [activeDimId]: idx }
      })
      return next
    })
    try { await api.reorderAssignments(activeDimId, catId, goalIds) }
    catch (err) { console.error(err) }
  }, [activeDimId, assignments, categories, goalsForLane])

  const moveGoalToLane = useCallback(async (goalId, targetCatId) => {
    if (!activeDimId) return
    const currentCatId = assignments[goalId]?.[activeDimId] ?? null
    if (currentCatId === targetCatId) return
    // Optimistic update
    setAssignments(prev => {
      const next = { ...prev }
      if (targetCatId === null) {
        const ga = { ...(next[goalId] ?? {}) }
        delete ga[activeDimId]
        next[goalId] = ga
      } else {
        next[goalId] = { ...(next[goalId] ?? {}), [activeDimId]: targetCatId }
      }
      return next
    })
    try {
      if (targetCatId === null) await api.unassign(goalId, activeDimId)
      else await api.assign(goalId, activeDimId, targetCatId)
    } catch (err) {
      console.error(err)
      // Revert
      setAssignments(prev => {
        const next = { ...prev }
        if (currentCatId === null) {
          const ga = { ...(next[goalId] ?? {}) }
          delete ga[activeDimId]
          next[goalId] = ga
        } else {
          next[goalId] = { ...(next[goalId] ?? {}), [activeDimId]: currentCatId }
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
      const match = filterCategories.find(cat => filterMatchesGoal(savedFilters.find(f => f.id === cat.filterId), milestone.goalId, assignments))
      return match?.color ?? milestone.color
    }
    const catId = assignments[milestone.goalId]?.[colorDimId]
    if (!catId) return milestone.color
    return categories.find(c => c.id === catId)?.color ?? milestone.color
  }, [assignments, categories, colorDimId, filterCategories, savedFilters])

  // Color for the goal row indicator dot — same logic as milestones but returns null when unassigned
  const getGoalColor = useCallback(goalId => {
    if (!colorDimId) return null
    if (colorDimId === FILTER_DIMENSION_ID) {
      const match = filterCategories.find(cat => filterMatchesGoal(savedFilters.find(f => f.id === cat.filterId), goalId, assignments))
      return match?.color ?? null
    }
    const catId = assignments[goalId]?.[colorDimId]
    if (!catId) return null
    return categories.find(c => c.id === catId)?.color ?? null
  }, [assignments, categories, colorDimId, filterCategories, savedFilters])

  const getDependencyPathD = useCallback((dep, overrides = {}) => {
    const from = overrides[dep.fromId] ?? milestonesRef.current.find(m => m.id === dep.fromId)
    const to   = overrides[dep.toId]   ?? milestonesRef.current.find(m => m.id === dep.toId)
    if (!from || !to) return null
    const fromRow = goalRowMapRef.current[from.goalId]
    const toRow   = goalRowMapRef.current[to.goalId]
    if (!fromRow || !toRow) return null
    const sp = spacingRef.current
    const fromLeftPx = from.leftPx ?? from.startCol * sp.colW
    const fromWidthPx = from.widthPx ?? from.duration * sp.colW
    const toLeftPx = to.leftPx ?? to.startCol * sp.colW
    const x1 = fromLeftPx + fromWidthPx
    const y1 = HEADER_H + fromRow.top + Math.floor(fromRow.height / 2)
    const x2 = toLeftPx
    const y2 = HEADER_H + toRow.top + Math.floor(toRow.height / 2)
    const cp = Math.max(40, Math.abs(x2 - x1) * 0.45)
    return `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`
  }, [])

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

  const maybeBlockDependencyWarning = useCallback((nextMilestones, nextDependencies, apply) => {
    const viol = computeViolations(nextMilestones, nextDependencies)
    if (viol.size > 0) setSelectedIds(prev => new Set([...prev, ...viol]))
    if (!warningPopupsEnabled || viol.size === 0) return false
    setWarningPrompt({ count: viol.size, apply })
    return true
  }, [warningPopupsEnabled])

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
      const leftDay = scrollLeftRef.current / prev.colW
      const nextScrollLeft = Math.max(0, Math.round(leftDay * next.colW))
      if (gridInnerRef.current) gridInnerRef.current.style.width = `${totalDaysRef.current * next.colW}px`
      gridBodyRef.current.scrollLeft = nextScrollLeft
      scrollLeftRef.current = gridBodyRef.current.scrollLeft
      setScrollLeft(scrollLeftRef.current)
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
  const getGoalCellFromPointer = useCallback(e => {
    const rect = gridBodyRef.current?.getBoundingClientRect(); if (!rect) return
    const sp   = spacingRef.current
    const relY = e.clientY - rect.top
    const rawX = e.clientX - rect.left + scrollLeftRef.current
    const col  = Math.floor(rawX / sp.colW)
    if (col < 0 || col >= totalDaysRef.current) return null

    if (relY < HEADER_H) return { type: 'header', col }

    const rawY = e.clientY - rect.top + scrollTopRef.current - HEADER_H
    const item = rowItemsRef.current.find(r => rawY >= r.top && rawY < r.top + r.height)
    if (!item || item.type !== 'goal') return null

    let color = '#1a73e8'
    if (item.cat?.color) color = item.cat.color

    return { type: 'cell', col, goalId: item.goal.id, goalTitle: item.goal.title, color }
  }, [])

  const handleContextMenu = useCallback(e => {
    e.preventDefault()
    const cell = getGoalCellFromPointer(e)
    if (!cell) return

    if (cell.type === 'header') {
      const { col } = cell
      setContextMenu({ type: 'header', x: e.clientX, y: e.clientY, col })
      return
    }
    if (e.target.closest('[data-ms-id]')) return  // right-click on milestone — skip for now

    const hasDeadline = deadlinesRef.current.some(d => d.goalId === cell.goalId)
    setContextMenu({ type: 'cell', x: e.clientX, y: e.clientY, col: cell.col,
      goalId: cell.goalId, goalTitle: cell.goalTitle, color: cell.color, hasDeadline })
  }, [getGoalCellFromPointer])

  // ── Milestone CRUD ─────────────────────────────────────────────────────────
  const handleCreateMilestone = useCallback(async (goalId, startCol, color) => {
    const data = { goal_id: goalId, start_col: startCol, duration: 1, title: '', color: color || '#1a73e8' }
    try {
      const ms = await api.createMilestone(data)
      setMilestones(prev => [...prev, ms])
    } catch (err) { console.error(err) }
  }, [])

  const handleGridDoubleClick = useCallback(e => {
    if (modeRef.current !== 'milestone') return
    if (e.target.closest('[data-ms-id]')) return
    const cell = getGoalCellFromPointer(e)
    if (!cell || cell.type !== 'cell') return
    e.preventDefault()
    handleCreateMilestone(cell.goalId, cell.col, cell.color)
  }, [getGoalCellFromPointer, handleCreateMilestone])

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

    const getSnappedColDelta = clientX => {
      const rawDx = clientX - startMouseX
      const firstOrig = Object.values(originals)[0]
      if (!firstOrig) return 0
      let colDelta = snapPxToCol(firstOrig.startCol * sp.colW + rawDx, sp.colW) - firstOrig.startCol
      Object.entries(originals).forEach(([id, orig]) => {
        colDelta = Math.max(colDelta, -orig.startCol)
        const ms = milestonesRef.current.find(m => m.id === id)
        const dl = deadlinesRef.current.find(d => d.goalId === ms?.goalId)
        if (dl) colDelta = Math.min(colDelta, dl.col - orig.duration - orig.startCol)
      })
      return colDelta
    }

    const getLiveDx = clientX => {
      const rawDx = clientX - startMouseX
      let dx = rawDx
      Object.entries(originals).forEach(([id, orig]) => {
        dx = Math.max(dx, -orig.startCol * sp.colW)
        const ms = milestonesRef.current.find(m => m.id === id)
        const dl = deadlinesRef.current.find(d => d.goalId === ms?.goalId)
        if (dl) dx = Math.min(dx, (dl.col - orig.duration - orig.startCol) * sp.colW)
      })
      return dx
    }

    const onMove = e => {
      const dx = getLiveDx(e.clientX)
      if (Math.abs(dx) > 2) dragRef.current.hasMoved = true
      const overrides = {}
      Object.entries(originals).forEach(([id, orig]) => {
        const ms = milestonesRef.current.find(m => m.id === id)
        const leftPx = orig.startCol * sp.colW + dx
        if (ms) overrides[id] = { ...ms, leftPx, widthPx: orig.duration * sp.colW }
        const el = milestoneElsRef.current.get(id)
        if (el) el.style.left = `${leftPx}px`
      })
      updateDependencyPaths(overrides)
    }

    const onUp = async e => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      const { hasMoved } = dragRef.current || {}
      dragRef.current = null
      if (!hasMoved) return

      const colDelta = getSnappedColDelta(e.clientX)
      const updates = []
      const next = milestonesRef.current.map(m => {
        if (!originals[m.id]) return m
        const newStartCol = Math.max(0, originals[m.id].startCol + colDelta)
        if (newStartCol !== originals[m.id].startCol) {
          updates.push({ id: m.id, startCol: newStartCol })
        }
        return { ...m, startCol: newStartCol }
      })
      if (updates.length) {
        const applyMove = async () => {
          setMilestones(next)
          await api.batchUpdateMilestones(updates)
        }
        const blocked = maybeBlockDependencyWarning(next, dependenciesRef.current, applyMove)
        if (blocked) {
          Object.entries(originals).forEach(([id, orig]) => {
            const el = milestoneElsRef.current.get(id)
            if (el) el.style.left = `${orig.startCol * sp.colW}px`
          })
          updateDependencyPaths()
          return
        }
        try { await applyMove() } catch (e) { console.error(e) }
      } else {
        Object.entries(originals).forEach(([id, orig]) => {
          const el = milestoneElsRef.current.get(id)
          if (el) el.style.left = `${orig.startCol * sp.colW}px`
        })
        updateDependencyPaths()
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function startResizeDrag(startMouseX, milestoneId, side) {
    const sp  = spacingRef.current
    const ms  = milestonesRef.current.find(m => m.id === milestoneId)
    if (!ms) return
    const origStart = ms.startCol; const origDur = ms.duration
    const origRight = origStart + origDur
    dragRef.current = { type: `resize-${side}` }
    document.body.style.cursor = 'col-resize'

    const getSnappedResize = clientX => {
      const dx = clientX - startMouseX
      if (side === 'left') {
        const leftCol = Math.min(origRight - 1, Math.max(0, snapPxToCol(origStart * sp.colW + dx, sp.colW)))
        return { startCol: leftCol, duration: origRight - leftCol }
      }
      const rightCol = Math.max(origStart + 1, snapPxToCol(origRight * sp.colW + dx, sp.colW))
      return { startCol: origStart, duration: rightCol - origStart }
    }

    const getLiveResize = clientX => {
      const dx = clientX - startMouseX
      const origLeftPx = origStart * sp.colW
      const origRightPx = origRight * sp.colW
      if (side === 'left') {
        const leftPx = Math.min(origRightPx - sp.colW, Math.max(0, origLeftPx + dx))
        return { leftPx, widthPx: origRightPx - leftPx }
      }
      const rightPx = Math.max(origLeftPx + sp.colW, origRightPx + dx)
      return { leftPx: origLeftPx, widthPx: rightPx - origLeftPx }
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
      dragRef.current = null

      const { startCol: newStart, duration: newDur } = getSnappedResize(e.clientX)
      const changed = newStart !== origStart || newDur !== origDur
      const nextAll = milestonesRef.current.map(m => m.id === milestoneId ? { ...m, startCol: newStart, duration: newDur } : m)
      if (changed) {
        const applyResize = async () => {
          setMilestones(nextAll)
          await api.updateMilestone(milestoneId, { startCol: newStart, duration: newDur })
        }
        const blocked = maybeBlockDependencyWarning(nextAll, dependenciesRef.current, applyResize)
        if (blocked) {
          const el = milestoneElsRef.current.get(milestoneId)
          if (el) {
            el.style.left = `${origStart * sp.colW}px`
            el.style.width = `${origDur * sp.colW}px`
          }
          updateDependencyPaths()
          return
        }
        try { await applyResize() } catch (err) { console.error(err) }
      } else {
        const el = milestoneElsRef.current.get(milestoneId)
        if (el) {
          el.style.left = `${origStart * sp.colW}px`
          el.style.width = `${origDur * sp.colW}px`
        }
        updateDependencyPaths()
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
  const createDependencyFromDrag = useCallback(async (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return
    if (hasCycle(fromId, toId, dependenciesRef.current)) return
    if (dependenciesRef.current.some(d => d.fromId === fromId && d.toId === toId)) return
    const pendingDep = { id: `pending-${fromId}-${toId}`, fromId, toId }
    const nextDependencies = [...dependenciesRef.current, pendingDep]
    const applyDependency = async () => {
      const dep = await api.createDependency({ from_id: fromId, to_id: toId })
      setDependencies(prev => [...prev, dep])
    }
    const blocked = maybeBlockDependencyWarning(milestonesRef.current, nextDependencies, applyDependency)
    if (blocked) return
    try { await applyDependency() } catch (err) { console.error(err) }
  }, [maybeBlockDependencyWarning])

  const updatePreviewArrow = useCallback((sourceId, clientX, clientY) => {
    const rect = gridBodyRef.current?.getBoundingClientRect()
    const source = milestonesRef.current.find(m => m.id === sourceId)
    const sourceRow = source && goalRowMapRef.current[source.goalId]
    if (!rect || !source || !sourceRow || !previewArrowRef.current) return
    const sp = spacingRef.current
    const x2 = clientX - rect.left + scrollLeftRef.current
    const y2 = clientY - rect.top + scrollTopRef.current
    // Pick source edge based on which side of the milestone the cursor is on
    const sourceCenter = (source.startCol + source.duration / 2) * sp.colW
    const x1 = x2 >= sourceCenter
      ? (source.startCol + source.duration) * sp.colW
      : source.startCol * sp.colW
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
      return x >= (source.startCol + source.duration / 2) * sp.colW ? 'right' : 'left'
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
    try {
      await api.updateDependencyReason(reasonModal.depId, reason)
      setDependencies(prev => prev.map(d => d.id === reasonModal.depId ? { ...d, reason } : d))
    } catch (err) { console.error(err) }
    setReasonModal(null)
  }, [reasonModal, reasonDraft])

  const buildDeleteItems = useCallback(() => {
    const milestoneIds = [...selectedIdsRef.current]
    const dependencyIds = [...selectedDepIdsRef.current]
    const milestoneItems = milestoneIds
      .map(id => {
        const milestone = milestonesRef.current.find(m => m.id === id)
        if (!milestone) return null
        const goal = goals.find(g => g.id === milestone.goalId)
        return {
          key: `milestone:${id}`,
          type: 'milestone',
          id,
          label: `${goal?.title ?? 'Milestone'} · ${milestone.title || dateFmt(milestone.startCol)}`,
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
        const fromGoal = goals.find(g => g.id === from?.goalId)
        const toGoal = goals.find(g => g.id === to?.goalId)
        return {
          key: `dependency:${id}`,
          type: 'dependency',
          id,
          label: `${fromGoal?.title ?? 'Milestone'} -> ${toGoal?.title ?? 'Milestone'}`,
          checked: true,
        }
      })
      .filter(Boolean)
    return [...milestoneItems, ...dependencyItems]
  }, [goals])

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
      .map(d => d.id)

    setMilestones(prev => prev.filter(m => !milestoneSet.has(m.id)))
    setDependencies(prev => prev.filter(d => !depsToDelete.includes(d.id)))
    setDeadlines(prev => prev.filter(d => !milestoneSet.has(d.goalId)))
    setSelectedIds(new Set())
    setSelectedDepIds(new Set())
    setDeleteDraft(null)

    try {
      await Promise.all([
        ...depsToDelete.map(id => api.deleteDependency(id)),
        ...milestoneIds.map(id => api.deleteMilestone(id)),
      ])
    } catch (err) { console.error(err) }
  }, [deleteDraft])

  useEffect(() => {
    if (!isActive) return
    const onKeyDown = e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = e.target?.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable
      if (deleteDraft) {
        if (e.key === 'Enter') {
          e.preventDefault()
          handleConfirmDeleteDraft()
        }
        if (e.key === 'Escape') setDeleteDraft(null)
        return
      }
      if (isTyping) return
      if (e.key.toLowerCase() === 'd') setMode('dependency')
      if (e.key.toLowerCase() === 'e') setMode('milestone')
      if (e.key === 'Delete' || e.key === 'Del') handleRequestDeleteSelection()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [deleteDraft, handleConfirmDeleteDraft, handleRequestDeleteSelection, isActive])

  useEffect(() => {
    if (reasonModal) setTimeout(() => reasonInputRef.current?.focus(), 30)
  }, [reasonModal])

  // ── Left-panel resize ─────────────────────────────────────────────────────
  const [leftPanelWidth, setLeftPanelWidth] = useState(220)
  const leftPanelWidthRef = useRef(220)
  leftPanelWidthRef.current = leftPanelWidth

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
    e.stopPropagation()
    if (e.button !== 0) return
    setContextMenu(null)
    setSelectedDepIds(new Set())
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
      setSelectedIds(next)
      idsToMove = [...next]
    } else {
      idsToMove = alreadySelected ? [...selectedIdsRef.current] : [milestoneId]
      // Always call setSelectedIds — this triggers a re-render that picks up dragRef.current.originals
      // so dragged milestones are never culled from visMilestones during the drag.
      setSelectedIds(new Set(idsToMove))
    }

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
  const visibleMonthSegments = buildAxisSegments(
    visCols,
    date => `${date.getFullYear()}-${date.getMonth()}`,
    date => `${MONTH_ABR[date.getMonth()]} ${date.getFullYear()}`
  )
  const visibleWeekSegments = buildAxisSegments(
    visCols,
    date => {
      const { week, year } = isoWeekInfo(date)
      return `${year}-${week}`
    },
    date => `KW ${isoWeekInfo(date).week}`
  )

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

  const inLaneMode = Boolean(activeDimId) || Boolean(activeLaneFilter)

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className={`${styles.page} ${paintCat ? styles.paintMode : ''}`}
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
        warningPopupsEnabled={warningPopupsEnabled}
        onWarningPopupsEnabledChange={setWarningPopupsEnabled}
        canDeleteSelection={selectedIds.size > 0 || selectedDepIds.size > 0}
        onDeleteSelection={handleRequestDeleteSelection}
        spacing={spacing} onSpacingChange={handleSpacingChange}
        mode={mode} onModeChange={setMode}
        axisMode={axisMode} onAxisModeChange={setAxisMode}
        showDepLabels={showDepLabels} onShowDepLabelsChange={setShowDepLabels}
        showDeps={showDeps} onShowDepsChange={setShowDeps}
        hideCrossCatDeps={hideCrossCatDeps} onHideCrossCatDepsChange={setHideCrossCatDeps}
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
                  const lhLaneGoals = goalsForLane(item.cat)
                  const lhHiddenIds = hiddenGoalsByLane[lhCatKey] ?? new Set()
                  const lhVisibleCount = lhLaneGoals.filter(g => !lhHiddenIds.has(g.id)).length
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
                        } else if (e.dataTransfer.types.includes('schedule-goal-id')) {
                          e.preventDefault()
                          setDragOverLaneCatId(lhCatKey); setDragOverGoalId(null); setDragOverCatReorderId(null)
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
                        const goalId = e.dataTransfer.getData('schedule-goal-id')
                        setDragOverLaneCatId(null)
                        setDragOverCatReorderId(null)
                        if (catId && item.cat) reorderCategoryInGantt(catId, item.cat.id)
                        else if (goalId) moveGoalToLane(goalId, item.cat?.id ?? null)
                      }}>
                      <span
                        className={styles.laneHdrName}
                        onDoubleClick={e => {
                          e.stopPropagation()
                          if (lhVisibleCount > 0) {
                            hideAllLaneGoals(lhCatKey, lhLaneGoals.map(g => g.id))
                          } else {
                            showAllLaneGoals(lhCatKey)
                          }
                        }}>
                        {item.cat?.name ?? 'Unassigned'}
                      </span>
                      <LaneGoalFilter
                        laneKey={laneKeyForCat(item.cat)}
                        goals={goalsForLane(item.cat)}
                        hiddenGoalIds={hiddenGoalsByLane[laneKeyForCat(item.cat)] ?? new Set()}
                        onToggleGoal={toggleGoalVisibility}
                        onShowAllGoals={showAllLaneGoals}
                        onHideAllGoals={hideAllLaneGoals}
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
                if (item.type === 'goal')
                  return (
                    <div key={item.goal.id}
                      className={[
                        inLaneMode ? styles.goalRowLane : styles.goalRow,
                        dragOverGoalId === item.goal.id && styles.goalRowDropTarget,
                        isGoalHighlighted(item.goal.id) && styles.goalRowHighlight,
                      ].filter(Boolean).join(' ')}
                      draggable={Boolean(activeDimId) && !paintCat}
                      onDragStart={e => {
                        if (paintCat || !activeDimId) return
                        e.dataTransfer.setData('schedule-goal-id', item.goal.id)
                        e.dataTransfer.setData('schedule-goal-cat', item.cat?.id ?? '')
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
                        if (!activeDimId || !e.dataTransfer.types.includes('schedule-goal-id')) return
                        e.preventDefault()
                        setDragOverGoalId(item.goal.id)
                        setDragOverLaneCatId(null)
                      }}
                      onDragLeave={() => setDragOverGoalId(prev => prev === item.goal.id ? null : prev)}
                      onDrop={e => {
                        const dragGoalId = e.dataTransfer.getData('schedule-goal-id')
                        const dragCat = e.dataTransfer.getData('schedule-goal-cat')
                        setDragOverGoalId(null)
                        if (!dragGoalId) return
                        const targetCatId = item.cat?.id ?? null
                        const sourceCatId = dragCat || null
                        if (sourceCatId !== targetCatId) {
                          moveGoalToLane(dragGoalId, targetCatId)
                        } else {
                          reorderGoalInLane(dragGoalId, item.goal.id)
                        }
                      }}
                      onDragEnd={() => setDragOverGoalId(null)}
                      onClick={paintCat ? e => {
                        e.stopPropagation()
                        paintGoal(item.goal.id)
                      } : undefined}
                      onDoubleClick={e => {
                        e.stopPropagation()
                        if (paintCat) return
                        onGoalOpen?.(item.goal.id)
                      }}
                      style={{ top: item.top, height: item.height, borderLeftColor: item.cat?.color ?? 'transparent' }}>
                      <span
                        className={`${styles.goalTitle} ${paintCat ? styles.paintTarget : ''}`}
                        title={paintCat ? 'Apply selected category' : undefined}
                        onClick={paintCat ? undefined : e => {
                          e.stopPropagation()
                          setClickedGoalId(prev => prev === item.goal.id ? null : item.goal.id)
                        }}>
                        {item.goal.title}
                      </span>
                      {!paintCat && (() => {
                        const c = getGoalColor(item.goal.id)
                        return c ? <span className={styles.goalColorCorner} style={{ borderTopColor: c }} /> : null
                      })()}
                      {!paintCat && (
                        <button
                          className={styles.goalEyeBtn}
                          title="Hide goal"
                          onClick={e => {
                            e.stopPropagation()
                            toggleGoalVisibility(laneKeyForCat(item.cat), item.goal.id)
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
                      if (!activeDimId || !e.dataTransfer.types.includes('schedule-goal-id')) return
                      e.preventDefault()
                      setDragOverLaneCatId(item.cat?.id ?? UNASSIGNED_LANE)
                      setDragOverGoalId(null)
                    }}
                    onDragLeave={e => {
                      if (!e.currentTarget.contains(e.relatedTarget)) setDragOverLaneCatId(null)
                    }}
                    onDrop={e => {
                      e.preventDefault()
                      const goalId = e.dataTransfer.getData('schedule-goal-id')
                      setDragOverLaneCatId(null)
                      if (goalId) moveGoalToLane(goalId, item.cat?.id ?? null)
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
          onContextMenu={handleContextMenu}>

          <div ref={gridInnerRef} className={styles.gridInner}
            style={{ width: totalDays * colW, height: totalContentH + HEADER_H, '--col-w': `${colW}px` }}>

            {/* Sticky time axis */}
            <div className={styles.timeAxis}>
              {axisMode === 'full' && (<>
                <div className={styles.monthBand}>
                  {visibleMonthSegments.map(segment => (
                    <div key={segment.key}
                      className={styles.monthSegment}
                      style={{ left: segment.startCol * colW, width: (segment.endCol - segment.startCol) * colW }}>
                      {segment.label}
                    </div>
                  ))}
                </div>
                <div className={styles.weekBand}>
                  {visibleWeekSegments.map(segment => (
                    <div key={segment.key}
                      className={styles.weekSegment}
                      style={{ left: segment.startCol * colW, width: (segment.endCol - segment.startCol) * colW }}>
                      {segment.label}
                    </div>
                  ))}
                </div>
                {visCols.map(ci => {
                  const date = colToDate(ci)
                  const dow  = date.getDay()
                  const isToday   = ci === 0
                  const isWeekend = dow === 0 || dow === 6
                  return (
                    <div key={ci}
                      className={[styles.dayHeader, isToday && styles.dayHeaderToday, isWeekend && !isToday && styles.dayHeaderWeekend].filter(Boolean).join(' ')}
                      style={{ left: ci * colW, width: colW }}>
                      <span className={[styles.dayNum, isToday && styles.dayNumToday].filter(Boolean).join(' ')}>
                        {date.getDate()}
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
                  style={{
                    top: HEADER_H + item.top,
                    height: item.height,
                    background: item.cat ? `${item.cat.color}24` : 'rgba(0,0,0,0.05)',
                  }} />
              if (item.type === 'goal')
                return <div key={`gr-${item.goal.id}`}
                  className={`${styles.gridGoalRow} ${isGoalHighlighted(item.goal.id) ? styles.gridGoalRowHighlight : ''}`}
                  style={{ top: HEADER_H + item.top, height: item.height }} />
              return null
            })}

            {/* Hard deadline markers */}
            {deadlines.map(dl => {
              const row = goalRowMap[dl.goalId]; if (!row) return null
              const hatchLeft  = dl.col * colW
              const hatchWidth = Math.max(0, totalDays - dl.col) * colW
              return hatchWidth > 0 ? (
                <div key={`dl-${dl.goalId}`} className={styles.deadlineHatch}
                  style={{ left: hatchLeft, top: HEADER_H + row.top, width: hatchWidth, height: row.height }} />
              ) : null
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
                    background: getMilestoneColor(m),
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
                    paintGoal(m.goalId)
                  } : undefined}
                  onContextMenu={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (paintCat) return
                    const goal = goals.find(g => g.id === m.goalId)
                    const label = `${goal?.title ?? 'Milestone'} · ${m.title || dateFmt(m.startCol)}`
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
                  <span className={styles.msLabel}>{m.title || dateFmt(m.startCol)}</span>
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
              style={{ width: totalDays * colW, height: totalContentH + HEADER_H }}>
              {showDeps && dependencies.map(dep => {
                const from = milestones.find(m => m.id === dep.fromId)
                const to   = milestones.find(m => m.id === dep.toId)
                if (!from || !to) return null
                const fromRow = goalRowMap[from.goalId]; const toRow = goalRowMap[to.goalId]
                if (!fromRow || !toRow) return null
                if (hideCrossCatDeps && activeDimId) {
                  const fromCat = assignments[from.goalId]?.[activeDimId] ?? null
                  const toCat   = assignments[to.goalId]?.[activeDimId] ?? null
                  if (fromCat !== toCat) return null
                }
                const x1 = (from.startCol + from.duration) * colW
                const y1 = HEADER_H + fromRow.top + Math.floor(fromRow.height / 2)
                const x2 = to.startCol * colW
                const y2 = HEADER_H + toRow.top + Math.floor(toRow.height / 2)
                const cp = Math.max(40, Math.abs(x2 - x1) * 0.45)
                const isViol = violationIds.has(dep.toId)
                const isSelected = selectedDepIds.has(dep.id)
                const midX = (x1 + x2) / 2
                const midY = (y1 + y2) / 2
                const depColor = isViol ? '#ef4444' : '#555'
                const fromGoal = goals.find(g => g.id === from.goalId)
                const toGoal   = goals.find(g => g.id === to.goalId)
                const pathD = `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`
                const inDepMode = mode === 'dependency'
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
                          const label = `${fromGoal?.title ?? '?'} → ${toGoal?.title ?? '?'}`
                          setContextMenu({ type: 'dep', x: e.clientX, y: e.clientY, depId: dep.id, label, reason: dep.reason ?? '' })
                        }}
                      />
                    )}
                    {/* Visual path — pointer-events none, purely decorative */}
                    <path
                      ref={el => { el ? depPathElsRef.current.set(dep.id, el) : depPathElsRef.current.delete(dep.id) }}
                      className={`${styles.depPath} ${isSelected ? styles.depPathSelected : ''}`}
                      d={pathD}
                      stroke={depColor} strokeWidth="1.5" fill="none"
                      strokeOpacity="0.8"
                      style={{ pointerEvents: 'none' }}
                    />
                    {showDepLabels && dep.reason && (
                      <text className={styles.depLabel} x={midX} y={midY}
                        textAnchor="middle" dominantBaseline="central">
                        {dep.reason.length > 45 ? dep.reason.slice(0, 42) + '…' : dep.reason}
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
      />

      <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)}
        onCreate={handleCreateMilestone}
        onInsertDay={handleInsertDay}
        onDeleteDay={handleDeleteDay}
        onSetDeadline={handleSetDeadline}
        onRemoveDeadline={handleRemoveDeadline}
        onDeleteMilestone={handleDeleteMilestoneRequest}
        onEditDepReason={handleEditDepReason}
        onDeleteDep={handleDeleteDepRequest} />

      {warningPrompt && (
        <div className={styles.warningPrompt} role="alertdialog" aria-modal="true">
          <div className={styles.warningPromptTitle}>Dependency warning</div>
          <div className={styles.warningPromptText}>
            This change would make {warningPrompt.count} milestone{warningPrompt.count === 1 ? '' : 's'} violate dependency timing.
          </div>
          <div className={styles.warningPromptActions}>
            <button className={styles.warningIgnoreBtn} onClick={async () => {
              const apply = warningPrompt.apply
              setWarningPrompt(null)
              await apply?.()
            }}>
              Ignore warning
            </button>
            <button className={styles.warningUndoBtn} onClick={() => {
              setWarningPrompt(null)
            }}>
              Undo
            </button>
          </div>
        </div>
      )}

      {deleteDraft && createPortal(
        <div className={styles.deleteModalBackdrop} onMouseDown={() => setDeleteDraft(null)}>
          <div className={styles.deleteModal} role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
            <div className={styles.deleteModalTitle}>Delete selected items?</div>
            <div className={styles.deleteModalText}>
              {deleteDraft.items.length === 1
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
                const fromGoal = goals.find(g => g.id === from?.goalId)
                const toGoal   = goals.find(g => g.id === to?.goalId)
                const label = `${fromGoal?.title ?? '?'} → ${toGoal?.title ?? '?'}`
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
