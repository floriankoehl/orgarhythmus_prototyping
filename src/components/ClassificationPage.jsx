import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import styles from './ClassificationPage.module.css'
import { api } from '../api'
import PeopleWidget from './PeopleWidget'
import PersonaAvatarStack from './PersonaAvatarStack'
import { useConfirmDialog } from './ConfirmDialog'
import { usePersonaCursor } from '../hooks/usePersonaCursor'

const PRESET_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8']
const FILTER_DIMENSION_ID = '__filters__'
const FILTER_CATEGORY_PREFIX = 'filter:'
const ALL_NOTES_CATEGORY_PREFIX = '__all_notes__:'
const TIME_DIMENSION_ID = '__time__'
const UNASSIGNED_CATEGORY_ID = '__unassigned__'
const TIME_CATEGORY_PREFIX = 'time:'
const TIME_DYNAMIC_CATEGORIES = [
  { id: `${TIME_CATEGORY_PREFIX}hour`, name: 'Last hour', color: '#22c55e', maxAgeMs: 60 * 60 * 1000 },
  { id: `${TIME_CATEGORY_PREFIX}day`, name: 'Last day', color: '#3b82f6', maxAgeMs: 24 * 60 * 60 * 1000 },
  { id: `${TIME_CATEGORY_PREFIX}week`, name: 'Last week', color: '#8b5cf6', maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
  { id: `${TIME_CATEGORY_PREFIX}older`, name: 'Older than a week', color: '#94a3b8', maxAgeMs: Infinity },
]
const NONE_PERSPECTIVE_ID = '__none__'
const CLASSIFICATION_DEFAULT_PERSPECTIVE_KEY = 'classification.defaultPerspectiveId'

function makeColorCursor(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="${color}" stroke="white" stroke-width="2"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`
}

function makeFilterId() {
  return `filter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function normalizeFilter(filter) {
  const selections = {}
  Object.entries(filter?.selections ?? {}).forEach(([dimId, catIds]) => {
    const ids = Array.isArray(catIds) ? [...new Set(catIds)].filter(Boolean) : []
    if (ids.length) selections[dimId] = ids
  })
  return {
    id: filter?.id || makeFilterId(),
    name: (filter?.name || 'Untitled filter').trim(),
    gate: filter?.gate === 'OR' ? 'OR' : 'AND',
    color: filter?.color || '#64748b',
    selections,
    quickKey: filter?.quickKey || null,
  }
}

function filterMatchesNote(filter, noteId, assignments) {
  if (!filter) return false
  const entries = Object.entries(filter.selections).filter(([, catIds]) => catIds.length > 0)
  if (entries.length === 0) return false
  const matchesDim = ([dimId, catIds]) => catIds.includes(assignments[noteId]?.[dimId])
  return filter.gate === 'OR' ? entries.some(matchesDim) : entries.every(matchesDim)
}

function filterCategoryId(filterId) {
  return `${FILTER_CATEGORY_PREFIX}${filterId}`
}

function filterIdFromCategoryId(catId) {
  return catId?.startsWith(FILTER_CATEGORY_PREFIX) ? catId.slice(FILTER_CATEGORY_PREFIX.length) : null
}

function allNotesCategoryId(dimId) {
  return `${ALL_NOTES_CATEGORY_PREFIX}${dimId}`
}

function dimensionIdFromAllNotesCategoryId(catId) {
  return catId?.startsWith(ALL_NOTES_CATEGORY_PREFIX) ? catId.slice(ALL_NOTES_CATEGORY_PREFIX.length) : null
}

function noteCreatedAtMs(note) {
  const raw = note?.createdAt ?? note?.created_at
  if (!raw) return Date.now()
  // SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' (UTC, space-separated).
  // Normalize to ISO 8601 so Date.parse works reliably across all browsers.
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z'
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : Date.now()
}

function timeCategoryIdForNote(note, nowMs = Date.now()) {
  const createdAt = noteCreatedAtMs(note)
  const age = createdAt > 0 ? Math.max(0, nowMs - createdAt) : Infinity
  return TIME_DYNAMIC_CATEGORIES.find(cat => age <= cat.maxAgeMs)?.id ?? `${TIME_CATEGORY_PREFIX}older`
}

function isDynamicDimensionId(dimId) {
  return dimId === FILTER_DIMENSION_ID || dimId === TIME_DIMENSION_ID
}

function isSystemDimension(dim) {
  return Boolean(dim?.system)
}

function isLockedDimension(dim) {
  return Boolean(dim?.dynamic || dim?.system)
}

function isKanbanDimension(dim) {
  return dim?.systemType === 'kanban'
}

function dynamicDimensionLabel(cat) {
  if (cat?.dynamicType === 'all_notes') return 'All'
  if (cat?.systemType === 'kanban') return 'Status'
  if (cat?.dynamicType === 'filter') return 'Filter'
  if (cat?.dynamicType === 'time') return 'Time'
  return 'Dynamic'
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
    onApply(perspectives[(activeIdx + dir + perspectives.length) % perspectives.length])
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
          <small>Switch saved canvas views</small>
        </span>
      )}
      {open && (
        <div className={styles.perspectiveMenu}>
          <div className={styles.perspectiveCreateRow}>
            <input value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') create() }}
              placeholder="Perspective name" />
            <button onClick={create}>Save</button>
          </div>
          <div className={styles.perspectiveList}>
            {perspectives.map(p => (
              <div key={p.id} className={`${styles.perspectiveItem} ${p.id === activePerspectiveId ? styles.perspectiveItemActive : ''}`}>
                {editingId === p.id ? (
                  <input className={styles.perspectiveRenameInput} value={editingName} autoFocus
                    onChange={e => setEditingName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') { setEditingId(''); setEditingName('') }
                    }} />
                ) : (
                  <button className={styles.perspectiveApplyBtn}
                    onClick={() => applyFromMenu(p)}
                    onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); if (!p.readOnly) startRename(p) }}>
                    <span>{p.name}</span>
                  </button>
                )}
                <button className={`${styles.perspectiveIconBtn} ${defaultPerspectiveId === p.id ? styles.perspectiveIconBtnActive : ''}`}
                  title="Use as classification default"
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

function ClassificationVisualSettings({ maxGridCols, onMaxGridColsChange, singleColumnWidth, onSingleColumnWidthChange, onClose, anchorRef }) {
  const panelRef = useRef()

  useEffect(() => {
    const close = e => {
      if (panelRef.current?.contains(e.target)) return
      if (anchorRef.current?.contains(e.target)) return
      onClose()
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [anchorRef, onClose])

  const setCols = value => onMaxGridColsChange(Math.max(1, Math.min(12, Number(value) || 1)))
  const setSingleWidth = value => onSingleColumnWidthChange(Math.max(320, Math.min(900, Number(value) || 480)))

  return (
    <div ref={panelRef} className={styles.visualPanel}>
      <div className={styles.visualPanelHdr}>
        <span>Visual settings</span>
        <button className={styles.visualClose} onClick={onClose}>✕</button>
      </div>
      <div className={styles.visualSectionTitle}>Grid structure</div>
      <label className={styles.visualRow}>
        <span className={styles.visualLabel}>Max columns</span>
        <input
          type="range"
          min="1"
          max="12"
          value={maxGridCols}
          className={styles.visualSlider}
          onChange={e => setCols(e.target.value)}
        />
        <input
          type="number"
          min="1"
          max="12"
          value={maxGridCols}
          className={styles.visualNumber}
          onChange={e => setCols(e.target.value)}
        />
      </label>
      <label className={styles.visualRow}>
        <span className={styles.visualLabel}>Single width</span>
        <input
          type="range"
          min="320"
          max="900"
          step="20"
          value={singleColumnWidth}
          className={styles.visualSlider}
          onChange={e => setSingleWidth(e.target.value)}
        />
        <input
          type="number"
          min="320"
          max="900"
          step="20"
          value={singleColumnWidth}
          className={styles.visualNumber}
          onChange={e => setSingleWidth(e.target.value)}
        />
      </label>
    </div>
  )
}

// ── Classification toolbar ────────────────────────────────────────────────────
function ClassificationCategoryVisibilityDropdown({ categories, hiddenCatIds, onToggle, onShowAll }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef()

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
                <button className={styles.categoryFilterAll} onClick={() =>
                  categories.forEach(cat => { if (!hiddenCatIds.has(cat.id)) onToggle(cat.id) })
                }>Hide all</button>
              </div>
              {categories.map((cat, index) => {
                const isUnassigned = cat.id === UNASSIGNED_CATEGORY_ID
                return (
                  <label key={cat.id} className={styles.categoryFilterItem}
                    style={isUnassigned && index > 0 ? { borderTop: '1px solid #f0f0f0', marginTop: 2 } : undefined}>
                    <input type="checkbox" checked={!hiddenCatIds.has(cat.id)} onChange={() => onToggle(cat.id)} />
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

function ClassificationGroupScroller({
  dimensions, categories, activeCategories, activeDimId, hiddenCatIds,
  onDimensionChange, onShowOnlyCategory,
}) {
  const wheelAtRef = useRef(0)
  const categoryWheelAtRef = useRef(0)
  const pickerRef = useRef(null)
  const categoryPickerRef = useRef(null)
  const [dimensionMenuOpen, setDimensionMenuOpen] = useState(false)
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)

  const activeIndex = activeDimId ? dimensions.findIndex(dim => dim.id === activeDimId) : -1
  const currentDim = activeIndex >= 0 ? dimensions[activeIndex] : null
  const visibleActiveCategories = activeCategories.filter(cat => !hiddenCatIds.has(cat.id))
  const focusedCategory = visibleActiveCategories.length === 1 ? visibleActiveCategories[0] : null
  const focusedCategoryIndex = focusedCategory
    ? activeCategories.findIndex(cat => cat.id === focusedCategory.id)
    : -1
  const canCycleDimension = dimensions.length > 0
  const canCycleCategory = activeCategories.length > 0
  const dimensionSwatches = dim => categories.filter(cat => cat.dimensionId === dim.id).slice(0, 3)

  const selectDimensionIndex = index => {
    if (!canCycleDimension) return
    onDimensionChange(dimensions[(index + dimensions.length) % dimensions.length].id)
  }
  const prevDimension = () => selectDimensionIndex(activeIndex >= 0 ? activeIndex - 1 : dimensions.length - 1)
  const nextDimension = () => selectDimensionIndex(activeIndex >= 0 ? activeIndex + 1 : 0)
  const selectCategoryIndex = index => {
    if (!canCycleCategory) return
    onShowOnlyCategory(activeCategories[(index + activeCategories.length) % activeCategories.length].id)
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
        <span className={styles.groupScrollerLabel}>Dimension</span>
        <div ref={pickerRef} className={styles.groupScrollerRow}>
          <button className={styles.groupScrollerArrow} onClick={prevDimension} disabled={!canCycleDimension} title="Previous dimension">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <button className={styles.groupScrollerName} onClick={() => setDimensionMenuOpen(value => !value)}
            disabled={!canCycleDimension} title="Pick dimension">
            <span className={styles.groupScrollerSwatches}>
              {(currentDim ? dimensionSwatches(currentDim) : []).map(cat => <b key={cat.id} style={{ background: cat.color || '#aaa' }} />)}
              {(!currentDim || dimensionSwatches(currentDim).length === 0) && <b style={{ background: '#9ca3af' }} />}
            </span>
            <span className={styles.groupScrollerText}>{currentDim?.name ?? 'None'}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
          </button>
          <button className={styles.groupScrollerArrow} onClick={nextDimension} disabled={!canCycleDimension} title="Next dimension">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18l6-6-6-6"/></svg>
          </button>
          {dimensionMenuOpen && (
            <div className={styles.groupScrollerMenu}>
              <button className={!activeDimId ? styles.groupScrollerMenuItemActive : styles.groupScrollerMenuItem}
                onClick={() => { onDimensionChange(''); setDimensionMenuOpen(false) }}>
                <span className={styles.groupScrollerSingleSwatch}><b style={{ background: '#9ca3af' }} /></span>
                <strong>None</strong>
              </button>
              {dimensions.map(dim => (
                <button key={dim.id}
                  className={dim.id === activeDimId ? styles.groupScrollerMenuItemActive : styles.groupScrollerMenuItem}
                  onClick={() => { onDimensionChange(dim.id); setDimensionMenuOpen(false) }}>
                  <span>
                    {dimensionSwatches(dim).map(cat => <b key={cat.id} style={{ background: cat.color || '#aaa' }} />)}
                    {dimensionSwatches(dim).length === 0 && <b style={{ background: '#9ca3af' }} />}
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
          <span className={styles.groupScrollerLabel}>Category</span>
          <div ref={categoryPickerRef} className={styles.groupScrollerRow}>
            <button className={styles.groupScrollerArrow} onClick={prevCategory} disabled={!canCycleCategory} title="Previous category">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <button className={styles.groupScrollerName} onClick={() => setCategoryMenuOpen(value => !value)}
              disabled={!canCycleCategory} title="Pick category">
              <span className={styles.groupScrollerCatDot} style={{ background: focusedCategory?.color || '#9ca3af' }} />
              <span className={styles.groupScrollerText}>{focusedCategory?.name ?? 'Custom'}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
            <button className={styles.groupScrollerArrow} onClick={nextCategory} disabled={!canCycleCategory} title="Next category">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18l6-6-6-6"/></svg>
            </button>
            {categoryMenuOpen && (
              <div className={styles.groupScrollerMenu}>
                {activeCategories.map(cat => (
                  <button key={cat.id}
                    className={cat.id === focusedCategory?.id ? styles.groupScrollerMenuItemActive : styles.groupScrollerMenuItem}
                    onClick={() => { onShowOnlyCategory(cat.id); setCategoryMenuOpen(false) }}>
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
                className={`${styles.groupScrollerDot} ${cat.id === focusedCategory?.id ? styles.groupScrollerDotActive : ''}`}
                onClick={() => onShowOnlyCategory(cat.id)} title={cat.name} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ClassificationToolbar({
  dimensions, categories, activeCategories, visibilityCategories, containerDimId, hiddenCatIds,
  onContainerDimChange, onToggleCategory, onShowAllCategories, onShowOnlyCategory,
  onCreateDim, onRenameDim, onRequestDeleteDim,
  onReorderDims, maxGridCols, onMaxGridColsChange, singleColumnWidth, onSingleColumnWidthChange,
}) {
  const [dimMenuOpen, setDimMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [adding, setAdding]           = useState(false)
  const [newDimName, setNewDimName]   = useState('')
  const [editingDimId, setEditingDimId] = useState('')
  const [editingDimName, setEditingDimName] = useState('')
  const [dragIdx, setDragIdx]         = useState(null)
  const [overIdx, setOverIdx]         = useState(null)
  const dimMenuRef  = useRef()
  const settingsBtnRef = useRef()
  const addInputRef = useRef()

  useEffect(() => {
    if (!dimMenuOpen) return
    const close = e => { if (!dimMenuRef.current?.contains(e.target)) setDimMenuOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [dimMenuOpen])

  useEffect(() => { if (adding) addInputRef.current?.focus() }, [adding])

  const submit = e => {
    e.preventDefault()
    if (!newDimName.trim()) return
    onCreateDim(newDimName.trim())
    setNewDimName('')
    setAdding(false)
  }

  const cancel = () => { setAdding(false); setNewDimName('') }

  const startEditDim = dim => {
    if (isLockedDimension(dim)) return
    setEditingDimId(dim.id)
    setEditingDimName(dim.name)
  }

  const commitEditDim = () => {
    const name = editingDimName.trim()
    if (editingDimId && name) onRenameDim(editingDimId, name)
    setEditingDimId('')
    setEditingDimName('')
  }

  const Chevron = ({ open }) => (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
      style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}>
      <path d="M7 10l5 5 5-5z"/>
    </svg>
  )

  const normalDimensions = dimensions.filter(d => !d.dynamic && !d.system)
  const specialDimensions = dimensions.filter(d => d.dynamic || d.system)

  return (
    <div className={styles.classToolbar}>
      <ClassificationGroupScroller
        dimensions={dimensions}
        categories={categories}
        activeCategories={activeCategories}
        activeDimId={containerDimId}
        hiddenCatIds={hiddenCatIds}
        onDimensionChange={onContainerDimChange}
        onShowOnlyCategory={onShowOnlyCategory}
      />

      {visibilityCategories.length > 0 && (
        <ClassificationCategoryVisibilityDropdown
          categories={visibilityCategories}
          hiddenCatIds={hiddenCatIds}
          onToggle={onToggleCategory}
          onShowAll={onShowAllCategories}
        />
      )}

      <div style={{ flex: 1 }} />

      <div className={styles.tbSettingsWrap}>
        <button
          ref={settingsBtnRef}
          className={`${styles.tbSelectorBtn} ${settingsOpen ? styles.tbSelectorBtnOpen : ''}`}
          onClick={() => setSettingsOpen(v => !v)}>
          Visual settings<Chevron open={settingsOpen} />
        </button>
        {settingsOpen && (
          <ClassificationVisualSettings
            maxGridCols={maxGridCols}
            onMaxGridColsChange={onMaxGridColsChange}
            singleColumnWidth={singleColumnWidth}
            onSingleColumnWidthChange={onSingleColumnWidthChange}
            onClose={() => setSettingsOpen(false)}
            anchorRef={settingsBtnRef}
          />
        )}
      </div>

      {/* Dimensions dropdown */}
      <div ref={dimMenuRef} className={styles.tbSelector}>
        <button
          className={`${styles.tbSelectorBtn} ${dimMenuOpen ? styles.tbSelectorBtnOpen : ''}`}
          onClick={() => setDimMenuOpen(v => !v)}>
          Dimensions<Chevron open={dimMenuOpen} />
        </button>
        {dimMenuOpen && (() => {
          const realDims = normalDimensions
          const virtualDims = specialDimensions
          const previewDims = dragIdx !== null && overIdx !== null && dragIdx !== overIdx
            ? (() => { const a = [...realDims]; const [x] = a.splice(dragIdx, 1); a.splice(overIdx, 0, x); return a })()
            : realDims
          return (
            <div className={`${styles.tbDropdown} ${styles.tbDropdownRight}`}>
              {[...previewDims, ...virtualDims].length === 0
                ? <div className={styles.tbDropdownEmpty}>No dimensions yet</div>
                : <>
                  {previewDims.length > 0 && <div className={styles.tbDropdownSectionTitle}>Normal dimensions</div>}
                  {previewDims.map((dim) => {
                    const realIdx = previewDims.indexOf(dim)
                    return (
                      <div
                        key={dim.id}
                        className={`${styles.tbDimRow} ${overIdx === realIdx && !isLockedDimension(dim) ? styles.tbDimRowOver : ''}`}
                        draggable={!isLockedDimension(dim)}
                        onDragStart={isLockedDimension(dim) ? undefined : e => { e.dataTransfer.effectAllowed = 'move'; setDragIdx(realIdx) }}
                        onDragOver={isLockedDimension(dim) ? undefined : e => { e.preventDefault(); if (dragIdx !== null) setOverIdx(realIdx) }}
                        onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
                        onDrop={isLockedDimension(dim) ? undefined : e => {
                          e.preventDefault()
                          if (dragIdx === null || dragIdx === realIdx) { setDragIdx(null); setOverIdx(null); return }
                          const arr = [...realDims]
                          const [item] = arr.splice(dragIdx, 1)
                          arr.splice(realIdx, 0, item)
                          onReorderDims(arr.map(d => d.id))
                          setDragIdx(null); setOverIdx(null)
                        }}
                      >
                        {!isLockedDimension(dim) && (
                          <span className={styles.tbDimDragHandle} title="Drag to reorder">
                            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                              <circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/>
                              <circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/>
                              <circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/>
                            </svg>
                          </span>
                        )}
                        {editingDimId === dim.id ? (
                          <input
                            className={styles.tbDimRowInput}
                            value={editingDimName}
                            autoFocus
                            onChange={e => setEditingDimName(e.target.value)}
                            onBlur={commitEditDim}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitEditDim()
                              if (e.key === 'Escape') { setEditingDimId(''); setEditingDimName('') }
                            }}
                          />
                        ) : (
                          <span className={styles.tbDimRowName} onDoubleClick={() => startEditDim(dim)}>
                            {dim.name}
                          </span>
                        )}
                        {!isLockedDimension(dim) && (
                          <>
                            <button className={styles.tbDimRowEdit}
                              title="Rename dimension"
                              onClick={() => startEditDim(dim)}>
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                              </svg>
                            </button>
                            <button className={styles.tbDimRowDelete}
                              title="Delete dimension"
                              onClick={() => onRequestDeleteDim(dim.id)}>✕</button>
                          </>
                        )}
                      </div>
                    )
                  })}
                  {virtualDims.length > 0 && <div className={styles.tbDropdownSectionTitle}>System and dynamic dimensions</div>}
                  {virtualDims.map(dim => (
                    <div key={dim.id} className={`${styles.tbDimRow} ${styles.tbDimRowDynamic}`}>
                      <span className={styles.tbDimRowName}>{dim.name}</span>
                      <span className={styles.dynamicBadge}>{dim.systemType === 'kanban' ? 'Status' : dim.dynamicLabel ?? 'Dynamic'}</span>
                    </div>
                  ))}
                </>
              }
            </div>
          )
        })()}
      </div>

      {/* Far right: add dimension */}
      {adding ? (
        <form className={styles.tbAddDimForm} onSubmit={submit}>
          <input ref={addInputRef} className={styles.tbAddDimInput} value={newDimName}
            onChange={e => setNewDimName(e.target.value)} placeholder="Dimension name…"
            onKeyDown={e => e.key === 'Escape' && cancel()} />
          <button type="submit" className={styles.tbAddDimBtn}>Add</button>
          <button type="button" className={styles.cancelBtn} onClick={cancel}>✕</button>
        </form>
      ) : (
        <button className={styles.tbAddDimTrigger} onClick={() => setAdding(true)}>
          + Add dimension
        </button>
      )}
    </div>
  )
}

// ── Category edit modal ───────────────────────────────────────────────────────
function CategoryEditModal({ cat, onClose, onSave, onDelete }) {
  const [name, setName]           = useState(cat.name)
  const [color, setColor]         = useState(cat.color)
  const [editingName, setEditingName] = useState(false)
  const [confirm, setConfirm]     = useState(false)
  const nameInputRef = useRef()

  useEffect(() => { if (editingName) nameInputRef.current?.select() }, [editingName])

  const save = () => {
    onSave(cat.id, { name: name.trim() || cat.name, color })
    onClose()
  }

  return createPortal(
    <div className={styles.modalBackdrop} onClick={onClose}>
      {confirm ? (
        <div className={styles.modal} onClick={e => e.stopPropagation()}>
          <p className={styles.confirmText}>
            All notes assigned to <strong>"{cat.name}"</strong> will be unassigned.
            The notes themselves won't be deleted.
          </p>
          <div className={styles.modalActions}>
            <button className={styles.dangerBtn}
              onClick={() => { onDelete(cat.id); onClose() }}>
              Yes, delete category
            </button>
            <button className={styles.cancelBtn} onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className={styles.modal} onClick={e => e.stopPropagation()}>
          <div className={styles.modalHeader}>
            <span className={styles.modalColorDot} style={{ background: color }} />
            {editingName ? (
              <input ref={nameInputRef} className={styles.modalNameInput}
                value={name} onChange={e => setName(e.target.value)}
                onBlur={() => setEditingName(false)}
                onKeyDown={e => {
                  if (e.key === 'Enter') setEditingName(false)
                  if (e.key === 'Escape') { setName(cat.name); setEditingName(false) }
                }} />
            ) : (
              <span className={styles.modalCatName} title="Double-click to rename"
                onDoubleClick={() => setEditingName(true)}>
                {name}
              </span>
            )}
          </div>

          <div className={styles.colorSection}>
            <span className={styles.sectionLabel}>Color</span>
            <div className={styles.colorSwatches}>
              {PRESET_COLORS.map(c => (
                <button key={c} type="button" className={styles.colorSwatch}
                  style={{ background: c, boxShadow: color === c ? `0 0 0 2px #fff, 0 0 0 3.5px ${c}` : 'none' }}
                  onClick={() => setColor(c)} />
              ))}
              <input type="color" className={styles.colorFullPicker}
                value={color} title="Custom color"
                onChange={e => setColor(e.target.value)} />
            </div>
          </div>

          <div className={styles.modalActions}>
            <button className={styles.dangerBtn} onClick={() => setConfirm(true)}>Delete</button>
            <div style={{ flex: 1 }} />
            <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
            <button className={styles.submitBtn} onClick={save}>Save</button>
          </div>
        </div>
      )}
    </div>,
    document.body
  )
}

// ── Note row inside a container ───────────────────────────────────────────────
function NoteRow({ note, paintCat, onPaint, paintPersona, onPersonaPaint, legendColor, onNoteDrop, onOpen, canDrag = true, forceExpanded = false, getNotePersonas, onRemovePersona }) {
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const showContent = Boolean(note.html && (expanded || forceExpanded))

  return (
    <div
      className={`${styles.noteRow} ${dragging ? styles.dragging : ''}`}
      style={legendColor ? { borderLeft: `3px solid ${legendColor}`, background: `${legendColor}28` } : undefined}
      draggable={!paintCat && !paintPersona && canDrag}
      onDragStart={paintCat || paintPersona || !canDrag ? undefined : e => {
        e.dataTransfer.setData('noteId', note.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
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
      onDragOver={paintCat || paintPersona || !canDrag ? undefined : e => {
        if (!e.dataTransfer.types.includes('noteid')) return
        e.preventDefault()
      }}
      onDrop={paintCat || paintPersona || !canDrag ? undefined : e => {
        e.preventDefault()
        e.stopPropagation()
        const dragNoteId = e.dataTransfer.getData('noteId')
        if (dragNoteId) onNoteDrop?.(dragNoteId, note.id)
      }}
      onDragEnd={paintCat || paintPersona ? undefined : () => setDragging(false)}
      onClick={paintPersona ? e => { e.stopPropagation(); onPersonaPaint?.(note.id) } : paintCat ? e => { e.stopPropagation(); onPaint(note.id) } : undefined}
      onDoubleClick={paintCat || paintPersona ? undefined : e => { e.stopPropagation(); onOpen?.(note.id) }}
    >
      <div className={styles.noteRowHeader}>
        <button className={styles.rowChevron}
          onClick={paintCat || paintPersona ? undefined : () => setExpanded(e => !e)}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
            style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </button>
        <PersonaAvatarStack personas={getNotePersonas?.(note.id) ?? []} onRemove={onRemovePersona ? personaId => onRemovePersona(personaId, note.id) : undefined} />
        <span className={styles.rowTitle}>{note.title}</span>
      </div>
      {showContent && (
        <div className={styles.noteContent} dangerouslySetInnerHTML={{ __html: note.html }} />
      )}
      {!showContent && note.html && (
        <div className={styles.noteHoverContent} dangerouslySetInnerHTML={{ __html: note.html }} />
      )}
    </div>
  )
}

// ── Category container box ────────────────────────────────────────────────────
function ContainerBox({ cat, notes, onDrop, paintCat, onPaint, paintPersona, onPersonaCategoryPaint, onPersonaNotePaint, getNoteColor, getNotePersonas, onRemovePersona, catPersonas, onPersonaCatDrop, onRemoveCatPersona, onEdit, onCollapse,
  onCatDragStart, onCatDragEnd, onCatDragOver, onCatDrop, onReorderNote, insertSide, isDraggingCat, onNoteOpen,
  onBulkPaint, dynamic = false, readOnlyCategory = false, unassignedLabel = 'Unassigned' }) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [isPersonaDragOver, setIsPersonaDragOver] = useState(false)
  const [allExpanded, setAllExpanded] = useState(false)
  const dragCounter = useRef(0)
  const boxRef = useRef()

  const clearDragOver = () => {
    dragCounter.current = 0
    setIsDragOver(false)
    setIsPersonaDragOver(false)
  }

  useEffect(() => {
    window.addEventListener('dragend', clearDragOver)
    window.addEventListener('drop', clearDragOver)
    return () => {
      window.removeEventListener('dragend', clearDragOver)
      window.removeEventListener('drop', clearDragOver)
    }
  }, [])

  const handleDragEnter = e => {
    if (dynamic) return
    e.preventDefault()
    if (e.dataTransfer.types.includes('catdrag')) return
    dragCounter.current++
    if (e.dataTransfer.types.includes('persona-drag')) {
      if (cat && !readOnlyCategory) setIsPersonaDragOver(true)
    } else {
      setIsDragOver(true)
    }
  }
  const handleDragLeave = () => {
    if (dragCounter.current === 0) return
    dragCounter.current--
    if (dragCounter.current === 0) {
      setIsDragOver(false)
      setIsPersonaDragOver(false)
    }
  }
  const handleDragOver = e => {
    if (dynamic) return
    if (e.dataTransfer.types.includes('persona-drag') && cat && !readOnlyCategory) {
      e.preventDefault()
      return
    }
    e.preventDefault()
    if (e.dataTransfer.types.includes('catdrag')) {
      const rect = boxRef.current?.getBoundingClientRect()
      if (rect && cat && onCatDragOver) {
        onCatDragOver(cat.id, e.clientX < rect.left + rect.width / 2 ? 'before' : 'after')
      }
      return
    }
    e.dataTransfer.dropEffect = 'move'
  }
  const handleDrop = e => {
    if (dynamic) return
    e.preventDefault()
    e.stopPropagation()
    const personaId = e.dataTransfer.getData('persona-drag')
    if (personaId && cat && !readOnlyCategory) {
      setIsPersonaDragOver(false)
      onPersonaCatDrop?.(personaId, cat.id)
      return
    }
    clearDragOver()
    if (e.dataTransfer.types.includes('catdrag')) { onCatDrop?.(); return }
    const noteId = e.dataTransfer.getData('noteId')
    if (noteId) onDrop(noteId)
  }
  const handleNoteDrop = (dragNoteId, targetNoteId) => {
    clearDragOver()
    if (dragNoteId === targetNoteId) return
    if (notes.some(g => g.id === dragNoteId)) {
      onReorderNote?.(cat?.id, dragNoteId, targetNoteId)
    } else {
      onDrop(dragNoteId)
    }
  }

  const cls = [
    styles.catBox,
    dynamic         ? styles.dynamicCatBox : '',
    readOnlyCategory ? styles.systemCatBox : '',
    isDragOver      ? styles.dragOver    : '',
    insertSide === 'before' ? styles.insertBefore : '',
    insertSide === 'after'  ? styles.insertAfter  : '',
    isDraggingCat   ? styles.catDragging  : '',
  ].filter(Boolean).join(' ')

  return (
    <div ref={boxRef} className={cls}
      style={{ '--cat-color': cat?.color ?? '#cbd5e1' }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div
        className={`${styles.catBoxHeader} ${paintCat ? styles.catBoxHeaderPaintable : ''} ${paintPersona && cat && !dynamic ? styles.catBoxHeaderPersonaPaintable : ''} ${isPersonaDragOver ? styles.catBoxHeaderPersonaDrop : ''}`}
        style={{ borderTopColor: cat?.color ?? '#e0e0e0' }}
        onClick={paintPersona && cat && !dynamic ? e => { e.stopPropagation(); onPersonaCategoryPaint?.(cat.id) } : undefined}
      >
        {cat && !dynamic && !readOnlyCategory && (
          <div className={styles.dragHandle}
            draggable
            onDragStart={e => {
              e.dataTransfer.setData('catdrag', cat.id)
              e.dataTransfer.effectAllowed = 'move'
              onCatDragStart?.(cat.id)
              const ghostSrc = e.currentTarget.parentElement || e.currentTarget
              const r = ghostSrc.getBoundingClientRect()
              const ghost = ghostSrc.cloneNode(true)
              Object.assign(ghost.style, {
                position: 'fixed', left: r.left + 'px', top: r.top + 'px',
                width: r.width + 'px', margin: '0',
                opacity: '1', pointerEvents: 'none', zIndex: '9999',
              })
              document.body.appendChild(ghost)
              e.dataTransfer.setDragImage(ghost, e.nativeEvent.offsetX ?? 0, e.nativeEvent.offsetY ?? 0)
              setTimeout(() => ghost.remove(), 0)
            }}
            onDragEnd={() => onCatDragEnd?.()}
            title="Drag to reorder"
          >
            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
              <circle cx="3" cy="2.5" r="1.3"/><circle cx="7" cy="2.5" r="1.3"/>
              <circle cx="3" cy="7"   r="1.3"/><circle cx="7" cy="7"   r="1.3"/>
              <circle cx="3" cy="11.5" r="1.3"/><circle cx="7" cy="11.5" r="1.3"/>
            </svg>
          </div>
        )}
        <span className={styles.catBoxName}>
          {cat?.name ?? unassignedLabel}
          {(dynamic || readOnlyCategory) && <span className={styles.dynamicBadge}>{dynamicDimensionLabel(cat)}</span>}
          <span className={styles.catBoxCount}> {notes.length}</span>
        </span>
        {cat && !dynamic && !readOnlyCategory && catPersonas?.length > 0 && (
          <PersonaAvatarStack
            personas={catPersonas}
            onRemove={personaId => onRemoveCatPersona?.(personaId, cat.id)}
          />
        )}
        {paintCat && onBulkPaint && (
          <button
            className={styles.catBulkPaintBtn}
            onClick={e => { e.stopPropagation(); onBulkPaint(cat, notes) }}
            title={`Assign all ${notes.length} note${notes.length === 1 ? '' : 's'} in "${cat?.name ?? unassignedLabel}" to the selected category`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18 4l-12 8 12 8V4z"/>
            </svg>
            <span>Assign all</span>
          </button>
        )}
        {!paintCat && cat && onEdit && !readOnlyCategory && (
          <button className={styles.catEditBtn} onClick={e => { e.stopPropagation(); onEdit() }} title="Edit category">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
            </svg>
          </button>
        )}
        {!paintCat && notes.some(note => note.html) && (
          <button
            className={styles.catExpandBtn}
            onClick={e => { e.stopPropagation(); setAllExpanded(v => !v) }}
            title={allExpanded ? 'Fold note descriptions' : 'Unfold all note descriptions'}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d={allExpanded ? 'M7 14l5-5 5 5H7z' : 'M7 10l5 5 5-5H7z'} />
            </svg>
          </button>
        )}
        {!paintCat && onCollapse && (
          <button className={styles.catCollapseBtn} onClick={e => { e.stopPropagation(); onCollapse() }} title="Collapse">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 13H5v-2h14v2z"/>
            </svg>
          </button>
        )}
      </div>
      <div className={styles.catBoxBody}>
        {notes.length === 0
          ? <div className={styles.catBoxEmpty}>{dynamic ? 'No matching notes' : 'Drop notes here'}</div>
          : notes.map(g => <NoteRow key={g.id} note={g} paintCat={paintCat} onPaint={onPaint} paintPersona={paintPersona} onPersonaPaint={onPersonaNotePaint} legendColor={getNoteColor?.(g.id)}
              onNoteDrop={handleNoteDrop}
              canDrag={!dynamic}
              forceExpanded={allExpanded}
              getNotePersonas={getNotePersonas}
              onRemovePersona={onRemovePersona}
              onOpen={onNoteOpen} />)
        }
      </div>
    </div>
  )
}

// ── Add category box (last grid item) ─────────────────────────────────────────
function AddCatBox({ onAdd }) {
  const [active, setActive] = useState(false)
  const [name, setName] = useState('')

  const submit = e => {
    e.preventDefault()
    if (!name.trim()) return
    onAdd(name.trim())
    setName('')
    setActive(false)
  }

  if (active) {
    return (
      <div className={`${styles.catBox} ${styles.addCatActive}`}>
        <form className={styles.addCatForm} onSubmit={submit}>
          <input className={styles.addCatInput} value={name}
            onChange={e => setName(e.target.value)} placeholder="Category name"
            autoFocus onKeyDown={e => e.key === 'Escape' && setActive(false)} />
          <div className={styles.addCatActions}>
            <button type="submit" className={styles.submitBtn}>Add</button>
            <button type="button" className={styles.cancelBtn}
              onClick={() => { setActive(false); setName('') }}>✕</button>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className={styles.addCatBox} onClick={() => setActive(true)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
      </svg>
    </div>
  )
}

// ── Legend drop-up (portal) ───────────────────────────────────────────────────
function LegendDropUp({ dimensions, legendDimId, onLegend }) {
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

  const current = dimensions.find(d => d.id === legendDimId)
  const cycleDimension = deltaY => {
    const options = ['', ...dimensions.map(d => d.id)]
    const now = Date.now()
    if (now - wheelAtRef.current < 180) return
    wheelAtRef.current = now
    const activeIdx = Math.max(0, options.indexOf(legendDimId))
    const dir = deltaY > 0 ? 1 : -1
    onLegend(options[(activeIdx + dir + options.length) % options.length])
  }

  return (
    <div className={styles.dropUpWrap}>
      <button
        ref={btnRef}
        className={styles.dropUpBtn}
        onWheel={e => { e.preventDefault(); cycleDimension(e.deltaY) }}
        onClick={toggle}>
        <span className={styles.dropUpLabel}>{current?.name ?? 'Color legend'}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className={styles.dropUpMenu}
          style={{ position: 'fixed', bottom: pos.bottom, left: pos.left, minWidth: pos.width }}>
          <button className={`${styles.dropUpOption} ${!legendDimId ? styles.dropUpActive : ''}`}
            onClick={() => { onLegend(''); setOpen(false) }}>None</button>
          {dimensions.filter(d => !d.dynamic && !d.system).map(d => (
            <button key={d.id}
              className={`${styles.dropUpOption} ${d.id === legendDimId ? styles.dropUpActive : ''}`}
              onClick={() => { onLegend(d.id); setOpen(false) }}>
              {d.name}
            </button>
          ))}
          {dimensions.some(d => d.dynamic || d.system) && (
            <div className={styles.dropUpDivider}><span>Special</span></div>
          )}
          {dimensions.filter(d => d.dynamic || d.system).map(d => (
            <button key={d.id}
              className={`${styles.dropUpOption} ${d.id === legendDimId ? styles.dropUpActive : ''}`}
              onClick={() => { onLegend(d.id); setOpen(false) }}>
              {d.name}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

function FilterEditorModal({ filter, dimensions, categories, onSave, onDelete, onClose }) {
  const [name, setName] = useState(filter?.name ?? 'New filter')
  const [gate, setGate] = useState(filter?.gate ?? 'AND')
  const [color, setColor] = useState(filter?.color ?? '#64748b')
  const [selections, setSelections] = useState(filter?.selections ?? {})
  const isEdit = Boolean(filter?.id)

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
    onSave(normalizeFilter({
      ...filter,
      name: name.trim() || 'Untitled filter',
      gate,
      color,
      selections,
    }))
  }

  return createPortal(
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={`${styles.modal} ${styles.filterModal}`} onClick={e => e.stopPropagation()}>
        <div className={styles.filterModalHeader}>
          <input
            className={styles.filterNameInput}
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
          />
          <div className={styles.filterGateToggle}>
            <button
              className={gate === 'AND' ? styles.filterGateActive : ''}
              onClick={() => setGate('AND')}>
              AND
            </button>
            <button
              className={gate === 'OR' ? styles.filterGateActive : ''}
              onClick={() => setGate('OR')}>
              OR
            </button>
          </div>
        </div>

        <div className={styles.colorSection}>
          <span className={styles.sectionLabel}>Color</span>
          <div className={styles.colorSwatches}>
            {PRESET_COLORS.map(c => (
              <button key={c} type="button" className={styles.colorSwatch}
                style={{ background: c, boxShadow: color === c ? `0 0 0 2px #fff, 0 0 0 3.5px ${c}` : 'none' }}
                onClick={() => setColor(c)} />
            ))}
            <input type="color" className={styles.colorFullPicker}
              value={color} title="Custom color"
              onChange={e => setColor(e.target.value)} />
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
          {isEdit && (
            <button className={styles.dangerBtn} onClick={() => onDelete(filter.id)}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button className={styles.submitBtn} onClick={save}>{isEdit ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Legend widget (floating, collapsible) ─────────────────────────────────────
function LegendWidget({
  dimensions, categories, legendDimId, onLegend,
  namedFilters, activeFilterIds, onToggleFilter, onCreateFilter,
  onEditFilter, quickFilters, onToggleQuickFilter, paintCat, onPaintActivate, onEditCat, onCreateCat,
  expanded, onExpandedChange,
}) {
  const [addingCat, setAddingCat] = useState(false)
  const [catName, setCatName] = useState('')
  const [catColor, setCatColor] = useState(PRESET_COLORS[0])

  const legendCats = categories.filter(c => c.dimensionId === legendDimId)
  const legendDim = dimensions.find(d => d.id === legendDimId)
  const isDynamicLegend = isDynamicDimensionId(legendDimId)
  const isSystemLegend = isSystemDimension(legendDim)

  const handleAddCat = e => {
    e.preventDefault()
    if (!catName.trim() || !legendDimId || isDynamicLegend || isSystemLegend) return
    onCreateCat(legendDimId, catName.trim(), catColor)
    setCatName('')
    setAddingCat(false)
    setCatColor(PRESET_COLORS[(legendCats.length + 1) % PRESET_COLORS.length])
  }

  return (
    <div className={styles.legendWidget}>
      {expanded && (
        <div className={styles.legendPanel} onClick={e => e.stopPropagation()}>
          {/* Add category form */}
          {legendDimId === FILTER_DIMENSION_ID && (
            <button className={styles.addLegendCatBtn} onClick={onCreateFilter}>
              + Create filter
            </button>
          )}
          {legendDimId && !isDynamicLegend && !isSystemLegend && (
            addingCat ? (
              <form className={styles.legendCatForm} onSubmit={handleAddCat}>
                <div className={styles.colorPicker}>
                  {PRESET_COLORS.map(c => (
                    <button key={c} type="button" className={styles.colorSwatch}
                      style={{ background: c, boxShadow: catColor === c ? `0 0 0 2px #fff, 0 0 0 3.5px ${c}` : 'none' }}
                      onClick={() => setCatColor(c)} />
                  ))}
                </div>
                <div className={styles.legendCatInputRow}>
                  <input className={styles.textInput} value={catName}
                    onChange={e => setCatName(e.target.value)}
                    placeholder="Category name" autoFocus />
                  <button type="submit" className={styles.submitBtn}>Add</button>
                  <button type="button" className={styles.cancelBtn}
                    onClick={() => { setAddingCat(false); setCatName('') }}>✕</button>
                </div>
              </form>
            ) : (
              <button className={styles.addLegendCatBtn} onClick={() => setAddingCat(true)}>
                + Add category
              </button>
            )
          )}

          {/* Legend items */}
          {legendCats.map(cat => (
            <div key={cat.id}
              className={[
                styles.legendItem,
                (cat.dynamic || cat.system) && styles.dynamicLegendItem,
                (cat.dynamicType === 'filter' ? activeFilterIds.includes(cat.filterId) : paintCat?.id === cat.id) && styles.legendItemActive,
              ].filter(Boolean).join(' ')}
              onClick={e => {
                e.stopPropagation()
                if (cat.dynamicType === 'filter') onToggleFilter(cat.filterId)
                else if (cat.dynamic) return
                else onPaintActivate(cat.id, cat.color)
              }}
              onDoubleClick={() => cat.dynamicType === 'filter' ? onEditFilter(namedFilters.find(f => f.id === cat.filterId)) : cat.dynamic || cat.system ? undefined : onEditCat(cat)}>
              <span className={styles.legendDot} style={{ background: cat.color }} />
              <span className={styles.legendName}>{cat.name}</span>
              {(cat.dynamic || cat.system) && <span className={styles.dynamicBadge}>{dynamicDimensionLabel(cat)}</span>}
              {cat.dynamicType === 'filter' ? (
                <button
                  className={`${styles.legendPaintBtn} ${activeFilterIds.includes(cat.filterId) ? styles.legendPaintBtnActive : ''}`}
                  title="Edit filter"
                  onClick={e => {
                    e.stopPropagation()
                    onEditFilter(namedFilters.find(f => f.id === cat.filterId))
                  }}
                  onDoubleClick={e => e.stopPropagation()}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                  </svg>
                </button>
              ) : !cat.dynamic ? (
                <button
                  className={`${styles.legendPaintBtn} ${quickFilters.some(f => f.dimId === legendDimId && f.catId === cat.id) ? styles.legendPaintBtnActive : ''}`}
                  title="Quick filter notes by this category"
                  onClick={e => {
                    e.stopPropagation()
                    onToggleQuickFilter(legendDimId, cat.id)
                  }}
                  onDoubleClick={e => e.stopPropagation()}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"/>
                  </svg>
                </button>
              ) : (
                <span className={styles.legendPaintBtn} title="Computed category" />
              )}
            </div>
          ))}

          {/* Dimension selector */}
          <LegendDropUp dimensions={dimensions} legendDimId={legendDimId} onLegend={onLegend} />
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

// ── Main component ────────────────────────────────────────────────────────────
export default function ClassificationPage({ notes = [], isActive = false, onNoteOpen, refreshKey = 0, dimRefreshKey = 0, peopleRefreshKey = 0, onDimChanged, onPeopleChanged }) {
  const [dimensions, setDimensions]         = useState([])
  const [categories, setCategories]         = useState([])
  const [timeSlots, setTimeSlots]           = useState([])
  const [assignments, setAssignments]       = useState({})
  const [assignmentOrders, setAssignmentOrders] = useState({})
  const [perspectives, setPerspectives] = useState([])
  const [activePerspectiveId, setActivePerspectiveId] = useState(NONE_PERSPECTIVE_ID)
  const [defaultPerspectiveId, setDefaultPerspectiveId] = useState(() => {
    try { return window.localStorage.getItem(CLASSIFICATION_DEFAULT_PERSPECTIVE_KEY) || NONE_PERSPECTIVE_ID }
    catch { return NONE_PERSPECTIVE_ID }
  })
  const appliedDefaultRef = useRef(false)
  const restoringPerspectiveRef = useRef(false)
  const [containerDimId, setContainerDimId] = useState('')
  const [legendDimId, setLegendDimId]       = useState('')
  const [namedFilters, setNamedFilters] = useState([])
  const [activeFilterIds, setActiveFilterIds] = useState([])
  const [quickFilters, setQuickFilters] = useState([])
  const [peopleVisibleNoteIds, setPeopleVisibleNoteIds] = useState(null)
  const [editingFilter, setEditingFilter] = useState(null)
  const [maxGridCols, setMaxGridCols] = useState(6)
  const [singleColumnWidth, setSingleColumnWidth] = useState(800)
  const [paintCat, setPaintCat]             = useState(null)
  const [paintPersonaId, setPaintPersonaId] = useState(null)
  const [personas, setPersonas] = useState([])
  const [personaNoteAssignments, setPersonaNoteAssignments] = useState([])
  const [personaCatAssignments, setPersonaCatAssignments] = useState([])
  const activePersona = useMemo(() => personas.find(p => p.id === paintPersonaId) ?? null, [personas, paintPersonaId])
  const personaCursor = usePersonaCursor(activePersona)
  const [bulkPaintConfirm, setBulkPaintConfirm] = useState(null)
  const [editCat, setEditCat]               = useState(null)
  const [confirmDeleteDimId, setConfirmDeleteDimId] = useState(null)
  const [catDragId, setCatDragId]         = useState(null)
  const [catInsertIdx, setCatInsertIdx]   = useState(null)
  const [collapsedCatIds, setCollapsedCatIds]     = useState(new Set())
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(false)
  const [floatingPanel, setFloatingPanel] = useState(null)
  const [statusNotice, setStatusNotice] = useState('')
  const { confirm: confirmDialog, dialog: confirmDialogNode } = useConfirmDialog()

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
    Promise.all([api.getDimensions(), api.getAllCategories(), api.getAssignments(), api.getFilters(), api.getClassificationPerspectives(), api.getTimeSlots(), api.getPersonas(), api.getDirectPersonaNoteAssignments(), api.getDirectPersonaAssignments()])
      .then(([dims, cats, assigns, filters, loadedPerspectives, loadedTimeSlots, ps, pnas, pcas]) => {
        setDimensions(dims)
        setCategories(cats)
        setTimeSlots(loadedTimeSlots)
        setNamedFilters(filters.map(normalizeFilter))
        setPerspectives(loadedPerspectives.map(normalizePerspective))
        applyAssignments(assigns)
        setPersonas(ps)
        setPersonaNoteAssignments(pnas)
        setPersonaCatAssignments(pcas)
        const groupDim    = dims.find(d => d.name === 'Group')
        const priorityDim = dims.find(d => d.name === 'Priority')
        if (groupDim)    setContainerDimId(groupDim.id)
        if (priorityDim) setLegendDimId(priorityDim.id)
      })
      .catch(console.error)
  }, [])

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

  const notePersonasMap = useMemo(() => {
    const map = {}
    personaNoteAssignments.forEach(a => {
      const p = personas.find(p => p.id === a.personaId)
      if (p) (map[a.noteId] = map[a.noteId] || []).push(p)
    })
    return map
  }, [personas, personaNoteAssignments])

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

  useEffect(() => {
    if (!refreshKey) return
    Promise.all([api.getAssignments(), api.getTimeSlots()])
      .then(([assigns, loadedTimeSlots]) => {
        applyAssignments(assigns)
        setTimeSlots(loadedTimeSlots)
      })
      .catch(console.error)
  }, [refreshKey])

  const dimRefreshKeyRef = useRef(dimRefreshKey)
  useEffect(() => {
    if (dimRefreshKey === dimRefreshKeyRef.current) return
    dimRefreshKeyRef.current = dimRefreshKey
    Promise.all([api.getDimensions(), api.getAllCategories()])
      .then(([dims, cats]) => { setDimensions(dims); setCategories(cats) })
      .catch(console.error)
  }, [dimRefreshKey])

  useEffect(() => {
    if (!statusNotice) return
    const timer = window.setTimeout(() => setStatusNotice(''), 4500)
    return () => window.clearTimeout(timer)
  }, [statusNotice])

  useEffect(() => {
    setPaintCat(null)
    setQuickFilters([])
    if (legendDimId !== FILTER_DIMENSION_ID) setActiveFilterIds([])
  }, [legendDimId])

  useEffect(() => {
    if (restoringPerspectiveRef.current) {
      restoringPerspectiveRef.current = false
      return
    }
    setCollapsedCatIds(new Set())
    setUnassignedCollapsed(false)
  }, [containerDimId])

  const makeNonePerspective = () => {
    const groupDim = dimensions.find(d => d.name === 'Group')
    const priorityDim = dimensions.find(d => d.name === 'Priority')
    return normalizePerspective({
      id: NONE_PERSPECTIVE_ID,
      name: 'None',
      readOnly: true,
      state: {
        maxGridCols: 6,
        singleColumnWidth: 800,
        containerDimId: groupDim?.id ?? '',
        legendDimId: priorityDim?.id ?? '',
        collapsedCatIds: [],
        unassignedCollapsed: false,
        activeFilterIds: [],
        quickFilters: [],
      },
    })
  }

  const nonePerspective = makeNonePerspective()
  const perspectiveOptions = [nonePerspective, ...perspectives]

  const capturePerspectiveState = () => ({
    maxGridCols,
    singleColumnWidth,
    containerDimId,
    legendDimId,
    collapsedCatIds: [...collapsedCatIds],
    unassignedCollapsed,
    activeFilterIds,
    quickFilters,
  })

  const applyPerspective = perspective => {
    const state = perspective?.state ?? {}
    restoringPerspectiveRef.current = (state.containerDimId || '') !== containerDimId
    setMaxGridCols(Math.max(1, Math.min(12, Number(state.maxGridCols) || 6)))
    setSingleColumnWidth(Math.max(320, Math.min(900, Number(state.singleColumnWidth) || 800)))
    setContainerDimId(state.containerDimId || '')
    setLegendDimId(state.legendDimId || '')
    setCollapsedCatIds(new Set(Array.isArray(state.collapsedCatIds) ? state.collapsedCatIds : []))
    setUnassignedCollapsed(Boolean(state.unassignedCollapsed))
    setActiveFilterIds(Array.isArray(state.activeFilterIds) ? state.activeFilterIds : [])
    setQuickFilters(Array.isArray(state.quickFilters) ? state.quickFilters : [])
    setPeopleVisibleNoteIds(null)
    setPaintCat(null)
    setActivePerspectiveId(perspective?.id ?? NONE_PERSPECTIVE_ID)
  }

  useEffect(() => {
    if (!isActive) {
      appliedDefaultRef.current = false
      return
    }
    if (appliedDefaultRef.current || dimensions.length === 0) return
    const defaultPerspective = perspectiveOptions.find(p => p.id === defaultPerspectiveId) ?? nonePerspective
    appliedDefaultRef.current = true
    applyPerspective(defaultPerspective)
  }, [defaultPerspectiveId, dimensions.length, isActive, perspectives])

  const createDimension = async name => {
    try { const d = await api.createDimension({ name }); setDimensions(p => [...p, d]); onDimChanged?.() }
    catch (e) { console.error(e) }
  }

  const reorderDimensions = async ids => {
    // Preserve system/dynamic dims — only normal dims are passed by ID
    const systemDims = dimensions.filter(d => d.dynamic || d.system)
    const ordered = ids.map(id => dimensions.find(d => d.id === id)).filter(Boolean)
    setDimensions([...ordered, ...systemDims])
    try { await api.reorderDimensions(ids); onDimChanged?.() }
    catch (e) { console.error(e) }
  }

  const renameDimension = async (id, name) => {
    try {
      const d = await api.updateDimension(id, { name })
      setDimensions(prev => prev.map(dim => dim.id === id ? d : dim))
      onDimChanged?.()
    } catch (e) { console.error(e) }
  }

  const createPerspective = async name => {
    try {
      const created = normalizePerspective(await api.createClassificationPerspective({ name, state: capturePerspectiveState() }))
      setPerspectives(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      setActivePerspectiveId(created.id)
    } catch (e) { console.error(e) }
  }

  const updatePerspectiveSnapshot = async perspectiveId => {
    if (perspectiveId === NONE_PERSPECTIVE_ID) return
    try {
      const saved = normalizePerspective(await api.updateClassificationPerspective(perspectiveId, { state: capturePerspectiveState() }))
      setPerspectives(prev => prev.map(p => p.id === saved.id ? saved : p))
      setActivePerspectiveId(saved.id)
    } catch (e) { console.error(e) }
  }

  const renamePerspective = async (perspectiveId, name) => {
    if (perspectiveId === NONE_PERSPECTIVE_ID) return
    try {
      const saved = normalizePerspective(await api.updateClassificationPerspective(perspectiveId, { name }))
      setPerspectives(prev => prev.map(p => p.id === saved.id ? saved : p).sort((a, b) => a.name.localeCompare(b.name)))
    } catch (e) { console.error(e) }
  }

  const deletePerspective = async perspectiveId => {
    if (perspectiveId === NONE_PERSPECTIVE_ID) return
    try {
      await api.deleteClassificationPerspective(perspectiveId)
      setPerspectives(prev => prev.filter(p => p.id !== perspectiveId))
      if (activePerspectiveId === perspectiveId) applyPerspective(nonePerspective)
      if (defaultPerspectiveId === perspectiveId) setClassificationDefaultPerspective(NONE_PERSPECTIVE_ID)
    } catch (e) { console.error(e) }
  }

  const setClassificationDefaultPerspective = perspectiveId => {
    const nextId = perspectiveId || NONE_PERSPECTIVE_ID
    setDefaultPerspectiveId(nextId)
    try { window.localStorage.setItem(CLASSIFICATION_DEFAULT_PERSPECTIVE_KEY, nextId) } catch {}
  }

  const deleteDimension = async id => {
    try {
      await api.deleteDimension(id)
      setDimensions(p => p.filter(d => d.id !== id))
      setCategories(p => p.filter(c => c.dimensionId !== id))
      if (containerDimId === id) setContainerDimId('')
      if (legendDimId === id) setLegendDimId('')
      setNamedFilters(prev => prev.map(filter => {
        const selections = { ...filter.selections }
        delete selections[id]
        return normalizeFilter({ ...filter, selections })
      }))
      onDimChanged?.()
    } catch (e) { console.error(e) }
  }

  const createCategory = async (dimId, name, color) => {
    try { const c = await api.createCategory(dimId, { name, color }); setCategories(p => [...p, c]); onDimChanged?.() }
    catch (e) { console.error(e) }
  }

  const updateCategory = async (id, patch) => {
    try {
      const updated = await api.updateCategory(id, patch)
      setCategories(p => p.map(c => c.id === id ? updated : c))
      onDimChanged?.()
    } catch (e) { console.error(e) }
  }

  const deleteCategory = async id => {
    try {
      await api.deleteCategory(id)
      setCategories(p => p.filter(c => c.id !== id))
      setAssignments(prev => {
        const next = {}
        for (const [noteId, dims] of Object.entries(prev)) {
          next[noteId] = Object.fromEntries(Object.entries(dims).filter(([, catId]) => catId !== id))
        }
        return next
      })
      if (paintCat?.id === id) setPaintCat(null)
      setQuickFilters(prev => prev.filter(f => f.catId !== id))
      setNamedFilters(prev => prev.map(filter => normalizeFilter({
        ...filter,
        selections: Object.fromEntries(
          Object.entries(filter.selections).map(([dimId, catIds]) => [dimId, catIds.filter(catId => catId !== id)])
        ),
      })))
    } catch (e) { console.error(e) }
  }

  const activatePaint = (catId, color) => {
    setPaintCat(prev => prev?.id === catId ? null : { id: catId, color })
  }

  const requestBulkPaint = (sourceCat, sourceNotes) => {
    if (!paintCat || !legendDimId || isDynamicDimensionId(legendDimId)) return
    if (!sourceNotes.length) {
      setStatusNotice('No notes in this category to assign.')
      return
    }
    const sourceName = sourceCat?.name ?? unassignedLabel
    setBulkPaintConfirm({
      sourceName,
      noteIds: sourceNotes.map(note => note.id),
    })
  }

  const confirmBulkPaint = async () => {
    if (!bulkPaintConfirm || !paintCat || !legendDimId || isDynamicDimensionId(legendDimId)) return
    const legendDim = dynamicDimensions.find(d => d.id === legendDimId)
    const targetCat = dynamicCategories.find(c => c.id === paintCat.id)
    const noteIds = bulkPaintConfirm.noteIds
    if (isKanbanDimension(legendDim) && targetCat?.kanbanState === 'scheduled') {
      const blocked = noteIds.filter(noteId => !timeSlotNoteIds.has(noteId))
      if (blocked.length) {
        setStatusNotice(`${blocked.length} note${blocked.length === 1 ? '' : 's'} need a time slot before they can be moved to Scheduled.`)
        setBulkPaintConfirm(null)
        return
      }
    }
    try {
      await Promise.all(noteIds.map(noteId => api.assign(noteId, legendDimId, paintCat.id)))
      setAssignments(prev => {
        const next = { ...prev }
        noteIds.forEach(noteId => {
          next[noteId] = { ...(next[noteId] ?? {}), [legendDimId]: paintCat.id }
        })
        return next
      })
      setBulkPaintConfirm(null)
    } catch (e) {
      setStatusNotice(e.message || 'The notes could not be assigned.')
      console.error(e)
    }
  }

  const saveNamedFilter = async filter => {
    const normalized = normalizeFilter(filter)
    try {
      const exists = namedFilters.some(f => f.id === normalized.id)
      const saved = exists
        ? await api.updateFilter(normalized.id, normalized)
        : await api.createFilter(normalized)
      const savedFilter = normalizeFilter(saved)
      setNamedFilters(prev => exists
        ? prev.map(f => f.id === savedFilter.id ? savedFilter : f)
        : [...prev, savedFilter])
      setActiveFilterIds(prev => prev.includes(savedFilter.id) ? prev : [...prev, savedFilter.id])
      setEditingFilter(null)
    } catch (e) { console.error(e) }
  }

  const deleteNamedFilter = async id => {
    try {
      await api.deleteFilter(id)
      setNamedFilters(prev => prev.filter(f => f.id !== id))
      setActiveFilterIds(prev => prev.filter(filterId => filterId !== id))
      setEditingFilter(null)
    } catch (e) { console.error(e) }
  }

  const toggleNamedFilter = id => {
    setActiveFilterIds(prev => prev.includes(id) ? prev.filter(filterId => filterId !== id) : [...prev, id])
  }

  const toggleQuickFilter = (dimId, catId) => {
    if (!dimId || !catId || isDynamicDimensionId(dimId)) return
    setQuickFilters(prev => {
      const exists = prev.some(f => f.dimId === dimId && f.catId === catId)
      return exists
        ? prev.filter(f => !(f.dimId === dimId && f.catId === catId))
        : [...prev, { dimId, catId }]
    })
  }

  const filterClassificationToPersona = personaId => {
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
    setPeopleVisibleNoteIds(noteIds)
  }

  const assignNote = async (noteId, catId) => {
    if (!containerDimId || isDynamicDimensionId(containerDimId)) return
    if (catId && isKanbanContainerDimension && catId === scheduledCategory?.id && !timeSlotNoteIds.has(noteId)) {
      setStatusNotice('A note needs a time slot before it can be moved to Scheduled.')
      return
    }
    try {
      if (catId) {
        await api.assign(noteId, containerDimId, catId)
        setAssignments(prev => ({ ...prev, [noteId]: { ...(prev[noteId] ?? {}), [containerDimId]: catId } }))
        setAssignmentOrders(prev => ({ ...prev, [noteId]: { ...(prev[noteId] ?? {}), [containerDimId]: Number.MAX_SAFE_INTEGER } }))
      } else {
        await api.unassign(noteId, containerDimId)
        setAssignments(prev => {
          const g = { ...(prev[noteId] ?? {}) }
          delete g[containerDimId]
          return { ...prev, [noteId]: g }
        })
        setAssignmentOrders(prev => {
          const g = { ...(prev[noteId] ?? {}) }
          delete g[containerDimId]
          return { ...prev, [noteId]: g }
        })
      }
    } catch (e) {
      setStatusNotice(e.message || 'The note could not be assigned.')
      console.error(e)
    }
  }

  const paintNote = async noteId => {
    if (!paintCat || !legendDimId || isDynamicDimensionId(legendDimId)) return
    const legendDim = dynamicDimensions.find(d => d.id === legendDimId)
    const targetCat = dynamicCategories.find(c => c.id === paintCat.id)
    if (isKanbanDimension(legendDim) && targetCat?.kanbanState === 'scheduled' && !timeSlotNoteIds.has(noteId)) {
      setStatusNotice('A note needs a time slot before it can be moved to Scheduled.')
      return
    }
    try {
      await api.assign(noteId, legendDimId, paintCat.id)
      setAssignments(prev => ({ ...prev, [noteId]: { ...(prev[noteId] ?? {}), [legendDimId]: paintCat.id } }))
    } catch (e) {
      setStatusNotice(e.message || 'The note could not be assigned.')
      console.error(e)
    }
  }

  const assignPersonaToCategory = (personaId, dimId, catId) => {
    if (!personaId || !dimId || !catId || isDynamicDimensionId(dimId)) return
    setPersonaCatAssignments(prev => [
      ...prev.filter(a => !(a.personaId === personaId && a.dimensionId === dimId && a.categoryId === catId)),
      { personaId, dimensionId: dimId, categoryId: catId },
    ])
    api.assignPersona(personaId, dimId, catId)
      .then(() => onPeopleChanged?.())
      .catch(console.error)
  }

  const removePersonaFromCategory = async (personaId, dimId, catId) => {
    if (!personaId || !dimId || !catId || isDynamicDimensionId(dimId)) return
    const affectedNotes = notes
      .filter(note =>
        assignments[note.id]?.[dimId] === catId &&
        personaNoteAssignments.some(a => a.personaId === personaId && a.noteId === note.id)
      )
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
    const noteIdsInCategory = affectedNotes
      .map(note => note.id)
    setPersonaCatAssignments(prev => prev.filter(a => !(a.personaId === personaId && a.dimensionId === dimId && a.categoryId === catId)))
    setPersonaNoteAssignments(prev => prev.filter(a => !(a.personaId === personaId && noteIdsInCategory.includes(a.noteId))))
    Promise.all([
      api.unassignPersona(personaId, dimId, catId),
      ...noteIdsInCategory.map(noteId => api.unassignPersonaFromNote(personaId, noteId)),
    ])
      .then(() => onPeopleChanged?.())
      .catch(console.error)
  }

  // ── Derived (needed by reorder handlers below) ───────────────────────────────
  const filterCategories = namedFilters.map((filter, idx) => ({
    id: filterCategoryId(filter.id),
    dimensionId: FILTER_DIMENSION_ID,
    name: filter.name,
    color: filter.color || PRESET_COLORS[idx % PRESET_COLORS.length],
    dynamic: true,
    dynamicType: 'filter',
    dynamicLabel: 'Filter',
    filterId: filter.id,
  }))
  const timeCategories = TIME_DYNAMIC_CATEGORIES.map(cat => ({
    ...cat,
    dimensionId: TIME_DIMENSION_ID,
    dynamic: true,
    dynamicType: 'time',
    dynamicLabel: 'Time',
  }))
  const systemDynamicDimensions = [
    { id: FILTER_DIMENSION_ID, name: 'Filters', dynamic: true, dynamicType: 'filter', dynamicLabel: 'Filter' },
    { id: TIME_DIMENSION_ID, name: 'Time', dynamic: true, dynamicType: 'time', dynamicLabel: 'Time' },
  ]
  const dynamicDimensions = [...dimensions, ...systemDynamicDimensions]
  const dynamicCategories = [...categories, ...filterCategories, ...timeCategories]
  const containerDim = dynamicDimensions.find(d => d.id === containerDimId)
  const isDynamicContainerDimension = isDynamicDimensionId(containerDimId)
  const isSystemContainerDimension = isSystemDimension(containerDim)
  const isKanbanContainerDimension = isKanbanDimension(containerDim)
  const isLockedContainerStructure = isDynamicContainerDimension || isSystemContainerDimension
  const scheduledCategory = isKanbanContainerDimension
    ? categories.find(c => c.dimensionId === containerDimId && c.kanbanState === 'scheduled')
    : null
  const timeSlotNoteIds = new Set(timeSlots.map(ms => ms.noteId))
  const allNotesCategory = containerDimId
    ? {
        id: allNotesCategoryId(containerDimId),
        dimensionId: containerDimId,
        name: 'All notes',
        color: '#64748b',
        dynamic: true,
        dynamicType: 'all_notes',
        dynamicLabel: 'All',
      }
    : null
  const baseContainerCats = dynamicCategories.filter(c => c.dimensionId === containerDimId)
  const containerCats = allNotesCategory ? [allNotesCategory, ...baseContainerCats] : baseContainerCats
  const reorderableContainerCats = baseContainerCats.filter(c => !c.dynamic && !c.system)

  // ── Category reorder ────────────────────────────────────────────────────────
  const handleCatDragOver = (overCatId, side) => {
    if (isLockedContainerStructure) return
    const overCat = reorderableContainerCats.find(c => c.id === overCatId)
    if (!overCat) return
    const overIdx = reorderableContainerCats.findIndex(c => c.id === overCat.id)
    if (overIdx === -1) return
    setCatInsertIdx(side === 'before' ? overIdx : overIdx + 1)
  }

  const reorderCatsDrop = async () => {
    if (isLockedContainerStructure) return
    if (!catDragId || catInsertIdx === null) return
    const oldIdx = reorderableContainerCats.findIndex(c => c.id === catDragId)
    if (oldIdx === -1) return
    const reordered = [...reorderableContainerCats]
    const [moved] = reordered.splice(oldIdx, 1)
    const target = catInsertIdx > oldIdx ? catInsertIdx - 1 : catInsertIdx
    reordered.splice(target, 0, moved)
    setCategories(prev => [...prev.filter(c => c.dimensionId !== containerDimId), ...reordered])
    try { await api.reorderCategories(reordered.map(c => c.id)) }
    catch (e) { console.error(e) }
  }

  const catDragCleanup = () => { setCatDragId(null); setCatInsertIdx(null) }

  const getCatInsertSide = catId => {
    if (!catDragId || catInsertIdx === null) return null
    const idx = reorderableContainerCats.findIndex(c => c.id === catId)
    if (idx === catInsertIdx) return 'before'
    if (idx + 1 === catInsertIdx) return 'after'
    return null
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const getNoteLegendColor = noteId => {
    if (!legendDimId) return null
    if (legendDimId === FILTER_DIMENSION_ID) {
      const match = filterCategories.find(cat => filterMatchesNote(namedFilters.find(f => f.id === cat.filterId), noteId, assignments))
      return match?.color ?? null
    }
    if (legendDimId === TIME_DIMENSION_ID) {
      const note = notes.find(g => g.id === noteId)
      const catId = timeCategoryIdForNote(note)
      return timeCategories.find(cat => cat.id === catId)?.color ?? null
    }
    const catId = assignments[noteId]?.[legendDimId]
    if (!catId) return null
    return categories.find(c => c.id === catId)?.color ?? null
  }

  const activeFilters = activeFilterIds
    .map(id => namedFilters.find(filter => filter.id === id))
    .filter(Boolean)

  const hasActiveFiltering = activeFilters.length > 0 || quickFilters.length > 0
  const matchesQuickFilter = note => quickFilters.some(f => assignments[note.id]?.[f.dimId] === f.catId)

  const filterMatchedNotes = hasActiveFiltering
    ? notes.filter(g => activeFilters.some(filter => filterMatchesNote(filter, g.id, assignments)) || matchesQuickFilter(g))
    : notes
  const visibleNotes = peopleVisibleNoteIds === null
    ? filterMatchedNotes
    : filterMatchedNotes.filter(note => peopleVisibleNoteIds.has(note.id))

  const notesForCat = catId => {
    const allNotesDimId = dimensionIdFromAllNotesCategoryId(catId)
    if (allNotesDimId) {
      if (allNotesDimId === FILTER_DIMENSION_ID) {
        return visibleNotes.filter(g => namedFilters.some(filter => filterMatchesNote(filter, g.id, assignments)))
      }
      if (allNotesDimId === TIME_DIMENSION_ID) {
        return [...visibleNotes].sort((a, b) => noteCreatedAtMs(b) - noteCreatedAtMs(a))
      }
      return visibleNotes.filter(g => assignments[g.id]?.[allNotesDimId])
        .sort((a, b) => {
          const aCatId = assignments[a.id]?.[allNotesDimId]
          const bCatId = assignments[b.id]?.[allNotesDimId]
          const aOrder = assignmentOrders[a.id]?.[allNotesDimId] ?? Number.MAX_SAFE_INTEGER
          const bOrder = assignmentOrders[b.id]?.[allNotesDimId] ?? Number.MAX_SAFE_INTEGER
          return aCatId === bCatId ? aOrder - bOrder : String(aCatId).localeCompare(String(bCatId))
        })
    }
    if (containerDimId === FILTER_DIMENSION_ID) {
      const filterId = filterIdFromCategoryId(catId)
      const filter = namedFilters.find(f => f.id === filterId)
      return filter ? visibleNotes.filter(g => filterMatchesNote(filter, g.id, assignments)) : []
    }
    if (containerDimId === TIME_DIMENSION_ID) {
      return visibleNotes
        .filter(g => timeCategoryIdForNote(g) === catId)
        .sort((a, b) => noteCreatedAtMs(b) - noteCreatedAtMs(a))
    }
    return visibleNotes.filter(g => assignments[g.id]?.[containerDimId] === catId)
      .sort((a, b) => (assignmentOrders[a.id]?.[containerDimId] ?? Number.MAX_SAFE_INTEGER) - (assignmentOrders[b.id]?.[containerDimId] ?? Number.MAX_SAFE_INTEGER))
  }
  const unassignedNotes = containerDimId
    ? (containerDimId === FILTER_DIMENSION_ID
      ? visibleNotes.filter(g => !namedFilters.some(filter => filterMatchesNote(filter, g.id, assignments)))
      : containerDimId === TIME_DIMENSION_ID
      ? []
      : visibleNotes.filter(g => !assignments[g.id]?.[containerDimId]))
    : visibleNotes
  const showUnassignedBox = containerDimId !== TIME_DIMENSION_ID
  const unassignedLabel = isKanbanContainerDimension ? 'Not scheduled yet' : 'Unassigned'
  const visibilityCategories = showUnassignedBox
    ? [...containerCats, { id: UNASSIGNED_CATEGORY_ID, name: unassignedLabel, color: '#bbb' }]
    : containerCats
  const hiddenContainerCategoryIds = new Set(collapsedCatIds)
  if (unassignedCollapsed) hiddenContainerCategoryIds.add(UNASSIGNED_CATEGORY_ID)

  const toggleContainerCategoryVisibility = catId => {
    if (catId === UNASSIGNED_CATEGORY_ID) {
      setUnassignedCollapsed(value => !value)
      return
    }
    setCollapsedCatIds(prev => {
      const next = new Set(prev)
      if (next.has(catId)) next.delete(catId)
      else next.add(catId)
      return next
    })
  }

  const showAllContainerCategories = () => {
    setCollapsedCatIds(new Set())
    setUnassignedCollapsed(false)
  }

  const showOnlyContainerCategory = catId => {
    if (!catId) return
    setCollapsedCatIds(new Set(containerCats.filter(cat => cat.id !== catId).map(cat => cat.id)))
    setUnassignedCollapsed(true)
  }

  const reorderNoteInCategory = async (catId, dragNoteId, targetNoteId) => {
    if (!containerDimId || isDynamicDimensionId(containerDimId) || !catId || dragNoteId === targetNoteId) return
    if (assignments[dragNoteId]?.[containerDimId] !== catId || assignments[targetNoteId]?.[containerDimId] !== catId) return
    const laneNotes = notesForCat(catId)
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
        next[noteId] = { ...(next[noteId] ?? {}), [containerDimId]: idx }
      })
      return next
    })
    try { await api.reorderAssignments(containerDimId, catId, noteIds) }
    catch (e) { console.error(e) }
  }

  const visibleContainerCats = containerCats.filter(c => !collapsedCatIds.has(c.id))
  const numBoxes = visibleContainerCats.length + (showUnassignedBox && !unassignedCollapsed ? 1 : 0)
  const gridCols = Math.max(1, Math.min(numBoxes, maxGridCols))
  const colTemplate = gridCols === 1 ? `min(100%, ${singleColumnWidth}px)` : '1fr'
  const gridStyle = {
    gridTemplateColumns: `repeat(${gridCols}, ${colTemplate})`,
    justifyContent: gridCols === 1 ? 'center' : undefined,
  }

  const confirmDim = dimensions.find(d => d.id === confirmDeleteDimId)

  return (
    <div
      className={`${styles.note} ${paintCat || paintPersonaId ? styles.paintMode : ''}`}
      style={paintCat ? { cursor: makeColorCursor(paintCat.color) } : personaCursor ? { cursor: personaCursor } : undefined}
      onClick={(paintCat || paintPersonaId) ? () => { setPaintCat(null); setPaintPersonaId(null) } : undefined}
    >
      <ClassificationToolbar
        dimensions={dynamicDimensions}
        categories={dynamicCategories}
        activeCategories={containerCats}
        visibilityCategories={visibilityCategories}
        containerDimId={containerDimId}
        hiddenCatIds={hiddenContainerCategoryIds}
        onContainerDimChange={setContainerDimId}
        onToggleCategory={toggleContainerCategoryVisibility}
        onShowAllCategories={showAllContainerCategories}
        onShowOnlyCategory={showOnlyContainerCategory}
        onCreateDim={createDimension}
        onRenameDim={renameDimension}
        onRequestDeleteDim={setConfirmDeleteDimId}
        onReorderDims={reorderDimensions}
        maxGridCols={maxGridCols}
        onMaxGridColsChange={setMaxGridCols}
        singleColumnWidth={singleColumnWidth}
        onSingleColumnWidthChange={setSingleColumnWidth}
      />

      <div className={styles.body}>
        <div className={styles.canvas} style={gridStyle}
          onDragOver={e => {
            if (e.dataTransfer.types.includes('catdrag') || e.dataTransfer.types.includes('persona-drag')) e.preventDefault()
          }}
          onDrop={e => { if (e.dataTransfer.types.includes('catdrag')) { reorderCatsDrop(); catDragCleanup() } }}
        >
          {containerCats.filter(c => !collapsedCatIds.has(c.id)).map(cat => (
            <ContainerBox key={cat.id} cat={cat} notes={notesForCat(cat.id)}
              onDrop={cat.dynamic ? undefined : noteId => assignNote(noteId, cat.id)}
              onEdit={cat.dynamicType === 'filter' ? () => setEditingFilter(namedFilters.find(f => f.id === cat.filterId)) : cat.dynamic || cat.system ? undefined : () => setEditCat(cat)}
              onCollapse={() => setCollapsedCatIds(prev => new Set([...prev, cat.id]))}
              paintCat={paintCat} onPaint={paintNote}
              paintPersona={paintPersonaId ? true : null}
              onPersonaCategoryPaint={catId => assignPersonaToCategory(paintPersonaId, containerDimId, catId)}
              onPersonaNotePaint={noteId => {
                if (!paintPersonaId) return
                api.assignPersonaToNote(paintPersonaId, noteId).then(() => onPeopleChanged?.()).catch(console.error)
                setPersonaNoteAssignments(prev => [
                  ...prev.filter(a => !(a.personaId === paintPersonaId && a.noteId === noteId)),
                  { personaId: paintPersonaId, noteId },
                ])
              }}
              getNoteColor={getNoteLegendColor}
              getNotePersonas={noteId => notePersonasMap[noteId] || []}
              onRemovePersona={(personaId, noteId) => {
                api.unassignPersonaFromNote(personaId, noteId).then(() => onPeopleChanged?.()).catch(console.error)
                setPersonaNoteAssignments(prev => prev.filter(a => !(a.personaId === personaId && a.noteId === noteId)))
              }}
              catPersonas={cat.id ? catPersonasMap[cat.id] || [] : []}
              onPersonaCatDrop={(personaId, catId) => assignPersonaToCategory(personaId, containerDimId, catId)}
              onRemoveCatPersona={(personaId, catId) => removePersonaFromCategory(personaId, containerDimId, catId)}
              onCatDragStart={setCatDragId}
              onCatDragEnd={catDragCleanup}
              onCatDragOver={handleCatDragOver}
              onCatDrop={() => { reorderCatsDrop(); catDragCleanup() }}
              onReorderNote={reorderNoteInCategory}
              insertSide={getCatInsertSide(cat.id)}
              isDraggingCat={catDragId === cat.id}
              onBulkPaint={requestBulkPaint}
              dynamic={cat.dynamic}
              readOnlyCategory={cat.system}
              onNoteOpen={onNoteOpen}
            />
          ))}
          {showUnassignedBox && !unassignedCollapsed && (
            <ContainerBox cat={null} notes={unassignedNotes}
              onDrop={noteId => assignNote(noteId, null)}
              onCollapse={() => setUnassignedCollapsed(true)}
              unassignedLabel={unassignedLabel}
              onReorderNote={reorderNoteInCategory}
              paintCat={paintCat} onPaint={paintNote}
              paintPersona={paintPersonaId ? true : null}
              onPersonaCategoryPaint={() => {}}
              onPersonaNotePaint={noteId => {
                if (!paintPersonaId) return
                api.assignPersonaToNote(paintPersonaId, noteId).then(() => onPeopleChanged?.()).catch(console.error)
                setPersonaNoteAssignments(prev => [
                  ...prev.filter(a => !(a.personaId === paintPersonaId && a.noteId === noteId)),
                  { personaId: paintPersonaId, noteId },
                ])
              }}
              getNoteColor={getNoteLegendColor}
              getNotePersonas={noteId => notePersonasMap[noteId] || []}
              onRemovePersona={(personaId, noteId) => {
                api.unassignPersonaFromNote(personaId, noteId).then(() => onPeopleChanged?.()).catch(console.error)
                setPersonaNoteAssignments(prev => prev.filter(a => !(a.personaId === personaId && a.noteId === noteId)))
              }}
              catPersonas={[]}
              onBulkPaint={requestBulkPaint}
              onNoteOpen={onNoteOpen} />
          )}
          {containerDimId && !isLockedContainerStructure && <AddCatBox onAdd={name => createCategory(containerDimId, name, PRESET_COLORS[containerCats.length % PRESET_COLORS.length])} />}
        </div>

        {statusNotice && (
          <div className={styles.statusNotice}>
            <span>{statusNotice}</span>
            <button onClick={() => setStatusNotice('')} aria-label="Close notice">×</button>
          </div>
        )}

        <div className={styles.floatingViewTools}>
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
            onSetDefault={setClassificationDefaultPerspective}
          />
          <LegendWidget
            dimensions={dynamicDimensions}
            categories={dynamicCategories}
            legendDimId={legendDimId}
            onLegend={setLegendDimId}
            namedFilters={namedFilters}
            activeFilterIds={activeFilterIds}
            onToggleFilter={toggleNamedFilter}
            onCreateFilter={() => setEditingFilter({})}
            onEditFilter={setEditingFilter}
            quickFilters={quickFilters}
            onToggleQuickFilter={toggleQuickFilter}
            paintCat={paintCat}
            onPaintActivate={(catId, color) => { setPaintPersonaId(null); activatePaint(catId, color) }}
            onEditCat={setEditCat}
            onCreateCat={createCategory}
            expanded={floatingPanel === 'color'}
            onExpandedChange={open => setFloatingPanel(open ? 'color' : null)}
          />
          <PeopleWidget
            paintPersonaId={paintPersonaId}
            onPaintPersonaChange={id => { setPaintCat(null); setPaintPersonaId(id) }}
            onApplyQuickFilter={filterClassificationToPersona}
            appliedFilterActive={peopleVisibleNoteIds !== null}
            onClearAppliedFilter={() => setPeopleVisibleNoteIds(null)}
            expanded={floatingPanel === 'people'}
            onExpandedChange={open => setFloatingPanel(open ? 'people' : null)}
            refreshKey={peopleRefreshKey}
          />
        </div>

      </div>

      {/* Confirm delete dimension */}
      {confirmDim && createPortal(
        <div className={styles.modalBackdrop} onClick={() => setConfirmDeleteDimId(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <p className={styles.confirmText}>
              Delete dimension <strong>"{confirmDim.name}"</strong>?
              All its categories will be removed and any notes assigned to them will be unassigned.
              The notes themselves won't be deleted.
            </p>
            <div className={styles.modalActions}>
              <button className={styles.dangerBtn} onClick={() => {
                deleteDimension(confirmDeleteDimId)
                setConfirmDeleteDimId(null)
              }}>
                Yes, delete dimension
              </button>
              <button className={styles.cancelBtn} onClick={() => setConfirmDeleteDimId(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {editCat && (
        <CategoryEditModal
          cat={editCat}
          onClose={() => setEditCat(null)}
          onSave={updateCategory}
          onDelete={deleteCategory}
        />
      )}

      {editingFilter && (
        <FilterEditorModal
          filter={editingFilter.id ? editingFilter : null}
          dimensions={dimensions}
          categories={categories}
          onSave={saveNamedFilter}
          onDelete={deleteNamedFilter}
          onClose={() => setEditingFilter(null)}
        />
      )}

      {bulkPaintConfirm && createPortal(
        <div className={styles.modalBackdrop} onClick={() => setBulkPaintConfirm(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <p className={styles.confirmText}>
              Assign <strong>{bulkPaintConfirm.noteIds.length}</strong> note{bulkPaintConfirm.noteIds.length === 1 ? '' : 's'} from
              {' '}<strong>"{bulkPaintConfirm.sourceName}"</strong> to this category?
            </p>
            <div className={styles.modalActions}>
              <button className={styles.submitBtn} onClick={confirmBulkPaint}>
                Assign notes
              </button>
              <button className={styles.cancelBtn} onClick={() => setBulkPaintConfirm(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {confirmDialogNode}
    </div>
  )
}
