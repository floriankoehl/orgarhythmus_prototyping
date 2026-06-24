import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import styles from './ClassificationPage.module.css'
import { api } from '../api'

const PRESET_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8']
const FILTER_DIMENSION_ID = '__filters__'
const FILTER_CATEGORY_PREFIX = 'filter:'

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

function filterMatchesGoal(filter, goalId, assignments) {
  if (!filter) return false
  const entries = Object.entries(filter.selections).filter(([, catIds]) => catIds.length > 0)
  if (entries.length === 0) return false
  const matchesDim = ([dimId, catIds]) => catIds.includes(assignments[goalId]?.[dimId])
  return filter.gate === 'OR' ? entries.some(matchesDim) : entries.every(matchesDim)
}

function filterCategoryId(filterId) {
  return `${FILTER_CATEGORY_PREFIX}${filterId}`
}

function filterIdFromCategoryId(catId) {
  return catId?.startsWith(FILTER_CATEGORY_PREFIX) ? catId.slice(FILTER_CATEGORY_PREFIX.length) : null
}

function ClassificationVisualSettings({ maxGridCols, onMaxGridColsChange, onClose, anchorRef }) {
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
    </div>
  )
}

// ── Classification toolbar ────────────────────────────────────────────────────
function ClassificationToolbar({
  dimensions, containerDimId, onContainerDimChange, onCreateDim, onRenameDim, onRequestDeleteDim,
  maxGridCols, onMaxGridColsChange,
}) {
  const [dimMenuOpen, setDimMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [adding, setAdding]           = useState(false)
  const [newDimName, setNewDimName]   = useState('')
  const [editingDimId, setEditingDimId] = useState('')
  const [editingDimName, setEditingDimName] = useState('')
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
    if (dim.dynamic) return
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

  return (
    <div className={styles.classToolbar}>
      {/* Left: inline group-by pills — no label */}
      <div className={styles.tbGroupBy}>
        <button
          className={`${styles.tbGroupByPill} ${!containerDimId ? styles.tbGroupByPillActive : ''}`}
          onClick={() => onContainerDimChange('')}>
          None
        </button>
        {dimensions.map(d => (
          <button key={d.id}
            className={`${styles.tbGroupByPill} ${d.id === containerDimId ? styles.tbGroupByPillActive : ''}`}
            onClick={() => onContainerDimChange(d.id)}>
            {d.name}
          </button>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      {/* Dimensions dropdown */}
      <div ref={dimMenuRef} className={styles.tbSelector}>
        <button
          className={`${styles.tbSelectorBtn} ${dimMenuOpen ? styles.tbSelectorBtnOpen : ''}`}
          onClick={() => setDimMenuOpen(v => !v)}>
          Dimensions<Chevron open={dimMenuOpen} />
        </button>
        {dimMenuOpen && (
          <div className={`${styles.tbDropdown} ${styles.tbDropdownRight}`}>
            {dimensions.length === 0
              ? <div className={styles.tbDropdownEmpty}>No dimensions yet</div>
              : dimensions.map(dim => (
                  <div key={dim.id} className={styles.tbDimRow}>
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
                    {!dim.dynamic && (
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
                ))
            }
          </div>
        )}
      </div>

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
            onClose={() => setSettingsOpen(false)}
            anchorRef={settingsBtnRef}
          />
        )}
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
            All goals assigned to <strong>"{cat.name}"</strong> will be unassigned.
            The goals themselves won't be deleted.
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

// ── Goal row inside a container ───────────────────────────────────────────────
function GoalRow({ goal, paintCat, onPaint, legendColor, onGoalDrop, onOpen, canDrag = true }) {
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)

  return (
    <div
      className={`${styles.goalRow} ${dragging ? styles.dragging : ''}`}
      style={legendColor ? { borderLeft: `3px solid ${legendColor}`, background: `${legendColor}28` } : undefined}
      draggable={!paintCat && canDrag}
      onDragStart={paintCat || !canDrag ? undefined : e => {
        e.dataTransfer.setData('goalId', goal.id)
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
      onDragOver={paintCat || !canDrag ? undefined : e => {
        if (!e.dataTransfer.types.includes('goalid')) return
        e.preventDefault()
      }}
      onDrop={paintCat || !canDrag ? undefined : e => {
        e.preventDefault()
        e.stopPropagation()
        const dragGoalId = e.dataTransfer.getData('goalId')
        if (dragGoalId) onGoalDrop?.(dragGoalId, goal.id)
      }}
      onDragEnd={paintCat ? undefined : () => setDragging(false)}
      onClick={paintCat ? e => { e.stopPropagation(); onPaint(goal.id) } : undefined}
      onDoubleClick={paintCat ? undefined : e => { e.stopPropagation(); onOpen?.(goal.id) }}
    >
      <div className={styles.goalRowHeader}>
        <button className={styles.rowChevron}
          onClick={paintCat ? undefined : () => setExpanded(e => !e)}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
            style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </button>
        <span className={styles.rowTitle}>{goal.title}</span>
      </div>
      {expanded && !paintCat && goal.html && (
        <div className={styles.goalContent} dangerouslySetInnerHTML={{ __html: goal.html }} />
      )}
    </div>
  )
}

// ── Category container box ────────────────────────────────────────────────────
function ContainerBox({ cat, goals, onDrop, paintCat, onPaint, getGoalColor, onEdit, onCollapse,
  onCatDragStart, onCatDragEnd, onCatDragOver, onCatDrop, onReorderGoal, insertSide, isDraggingCat, onGoalOpen, dynamic = false }) {
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounter = useRef(0)
  const boxRef = useRef()

  const clearDragOver = () => {
    dragCounter.current = 0
    setIsDragOver(false)
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
    setIsDragOver(true)
  }
  const handleDragLeave = () => {
    if (dragCounter.current === 0) return
    dragCounter.current--
    if (dragCounter.current === 0) setIsDragOver(false)
  }
  const handleDragOver = e => {
    if (dynamic) return
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
    clearDragOver()
    if (e.dataTransfer.types.includes('catdrag')) { onCatDrop?.(); return }
    const goalId = e.dataTransfer.getData('goalId')
    if (goalId) onDrop(goalId)
  }
  const handleGoalDrop = (dragGoalId, targetGoalId) => {
    clearDragOver()
    if (dragGoalId === targetGoalId) return
    if (goals.some(g => g.id === dragGoalId)) {
      onReorderGoal?.(cat?.id, dragGoalId, targetGoalId)
    } else {
      onDrop(dragGoalId)
    }
  }

  const cls = [
    styles.catBox,
    dynamic         ? styles.dynamicCatBox : '',
    isDragOver      ? styles.dragOver    : '',
    insertSide === 'before' ? styles.insertBefore : '',
    insertSide === 'after'  ? styles.insertAfter  : '',
    isDraggingCat   ? styles.catDragging  : '',
  ].filter(Boolean).join(' ')

  return (
    <div ref={boxRef} className={cls}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className={styles.catBoxHeader} style={{ borderTopColor: cat?.color ?? '#e0e0e0' }}>
        {cat && !dynamic && (
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
          {cat?.name ?? 'Unassigned'}
          {dynamic && <span className={styles.dynamicBadge}>Filter</span>}
          <span className={styles.catBoxCount}> {goals.length}</span>
        </span>
        {cat && onEdit && (
          <button className={styles.catEditBtn} onClick={onEdit} title="Edit category">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
            </svg>
          </button>
        )}
        {onCollapse && (
          <button className={styles.catCollapseBtn} onClick={onCollapse} title="Collapse">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 13H5v-2h14v2z"/>
            </svg>
          </button>
        )}
      </div>
      <div className={styles.catBoxBody}>
        {goals.length === 0
          ? <div className={styles.catBoxEmpty}>{dynamic ? 'No matching goals' : 'Drop goals here'}</div>
          : goals.map(g => <GoalRow key={g.id} goal={g} paintCat={paintCat} onPaint={onPaint} legendColor={getGoalColor?.(g.id)}
              onGoalDrop={handleGoalDrop}
              canDrag={!dynamic}
              onOpen={onGoalOpen} />)
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

  return (
    <div className={styles.dropUpWrap}>
      <button ref={btnRef} className={styles.dropUpBtn} onClick={toggle}>
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
          {dimensions.map(d => (
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
}) {
  const [expanded, setExpanded] = useState(false)
  const [addingCat, setAddingCat] = useState(false)
  const [catName, setCatName] = useState('')
  const [catColor, setCatColor] = useState(PRESET_COLORS[0])

  const legendCats = categories.filter(c => c.dimensionId === legendDimId)

  const handleAddCat = e => {
    e.preventDefault()
    if (!catName.trim() || !legendDimId || legendDimId === FILTER_DIMENSION_ID) return
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
          {legendDimId && legendDimId !== FILTER_DIMENSION_ID && (
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
                cat.dynamic && styles.dynamicLegendItem,
                (cat.dynamic ? activeFilterIds.includes(cat.filterId) : paintCat?.id === cat.id) && styles.legendItemActive,
              ].filter(Boolean).join(' ')}
              onClick={e => {
                e.stopPropagation()
                if (cat.dynamic) onToggleFilter(cat.filterId)
                else onPaintActivate(cat.id, cat.color)
              }}
              onDoubleClick={() => cat.dynamic ? onEditFilter(namedFilters.find(f => f.id === cat.filterId)) : onEditCat(cat)}>
              <span className={styles.legendDot} style={{ background: cat.color }} />
              <span className={styles.legendName}>{cat.name}</span>
              {cat.dynamic && <span className={styles.dynamicBadge}>Filter</span>}
              {cat.dynamic ? (
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
              ) : (
                <button
                  className={`${styles.legendPaintBtn} ${quickFilters.some(f => f.dimId === legendDimId && f.catId === cat.id) ? styles.legendPaintBtnActive : ''}`}
                  title="Quick filter goals by this category"
                  onClick={e => {
                    e.stopPropagation()
                    onToggleQuickFilter(legendDimId, cat.id)
                  }}
                  onDoubleClick={e => e.stopPropagation()}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"/>
                  </svg>
                </button>
              )}
            </div>
          ))}

          {/* Dimension selector */}
          <LegendDropUp dimensions={dimensions} legendDimId={legendDimId} onLegend={onLegend} />
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

// ── Main component ────────────────────────────────────────────────────────────
export default function ClassificationPage({ goals = [], onGoalOpen }) {
  const [dimensions, setDimensions]         = useState([])
  const [categories, setCategories]         = useState([])
  const [assignments, setAssignments]       = useState({})
  const [assignmentOrders, setAssignmentOrders] = useState({})
  const [containerDimId, setContainerDimId] = useState('')
  const [legendDimId, setLegendDimId]       = useState('')
  const [namedFilters, setNamedFilters] = useState([])
  const [activeFilterIds, setActiveFilterIds] = useState([])
  const [quickFilters, setQuickFilters] = useState([])
  const [editingFilter, setEditingFilter] = useState(null)
  const [maxGridCols, setMaxGridCols] = useState(6)
  const [paintCat, setPaintCat]             = useState(null)
  const [editCat, setEditCat]               = useState(null)
  const [confirmDeleteDimId, setConfirmDeleteDimId] = useState(null)
  const [catDragId, setCatDragId]         = useState(null)
  const [catInsertIdx, setCatInsertIdx]   = useState(null)
  const [collapsedCatIds, setCollapsedCatIds]     = useState(new Set())
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(false)

  useEffect(() => {
    Promise.all([api.getDimensions(), api.getAllCategories(), api.getAssignments(), api.getFilters()])
      .then(([dims, cats, assigns, filters]) => {
        setDimensions(dims)
        setCategories(cats)
        setNamedFilters(filters.map(normalizeFilter))
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
        const groupDim    = dims.find(d => d.name === 'Group')
        const priorityDim = dims.find(d => d.name === 'Priority')
        if (groupDim)    setContainerDimId(groupDim.id)
        if (priorityDim) setLegendDimId(priorityDim.id)
      })
      .catch(console.error)
  }, [])

  useEffect(() => {
    setPaintCat(null)
    setQuickFilters([])
    if (legendDimId !== FILTER_DIMENSION_ID) setActiveFilterIds([])
  }, [legendDimId])

  useEffect(() => { setCollapsedCatIds(new Set()); setUnassignedCollapsed(false) }, [containerDimId])

  const createDimension = async name => {
    try { const d = await api.createDimension({ name }); setDimensions(p => [...p, d]) }
    catch (e) { console.error(e) }
  }

  const renameDimension = async (id, name) => {
    try {
      const d = await api.updateDimension(id, { name })
      setDimensions(prev => prev.map(dim => dim.id === id ? d : dim))
    } catch (e) { console.error(e) }
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
    } catch (e) { console.error(e) }
  }

  const createCategory = async (dimId, name, color) => {
    try { const c = await api.createCategory(dimId, { name, color }); setCategories(p => [...p, c]) }
    catch (e) { console.error(e) }
  }

  const updateCategory = async (id, patch) => {
    try {
      const updated = await api.updateCategory(id, patch)
      setCategories(p => p.map(c => c.id === id ? updated : c))
    } catch (e) { console.error(e) }
  }

  const deleteCategory = async id => {
    try {
      await api.deleteCategory(id)
      setCategories(p => p.filter(c => c.id !== id))
      setAssignments(prev => {
        const next = {}
        for (const [goalId, dims] of Object.entries(prev)) {
          next[goalId] = Object.fromEntries(Object.entries(dims).filter(([, catId]) => catId !== id))
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
    if (!dimId || !catId || dimId === FILTER_DIMENSION_ID) return
    setQuickFilters(prev => {
      const exists = prev.some(f => f.dimId === dimId && f.catId === catId)
      return exists
        ? prev.filter(f => !(f.dimId === dimId && f.catId === catId))
        : [...prev, { dimId, catId }]
    })
  }

  const assignGoal = async (goalId, catId) => {
    if (!containerDimId) return
    try {
      if (catId) {
        await api.assign(goalId, containerDimId, catId)
        setAssignments(prev => ({ ...prev, [goalId]: { ...(prev[goalId] ?? {}), [containerDimId]: catId } }))
        setAssignmentOrders(prev => ({ ...prev, [goalId]: { ...(prev[goalId] ?? {}), [containerDimId]: Number.MAX_SAFE_INTEGER } }))
      } else {
        await api.unassign(goalId, containerDimId)
        setAssignments(prev => {
          const g = { ...(prev[goalId] ?? {}) }
          delete g[containerDimId]
          return { ...prev, [goalId]: g }
        })
        setAssignmentOrders(prev => {
          const g = { ...(prev[goalId] ?? {}) }
          delete g[containerDimId]
          return { ...prev, [goalId]: g }
        })
      }
    } catch (e) { console.error(e) }
  }

  const paintGoal = async goalId => {
    if (!paintCat || !legendDimId || legendDimId === FILTER_DIMENSION_ID) return
    try {
      await api.assign(goalId, legendDimId, paintCat.id)
      setAssignments(prev => ({ ...prev, [goalId]: { ...(prev[goalId] ?? {}), [legendDimId]: paintCat.id } }))
    } catch (e) { console.error(e) }
  }

  // ── Derived (needed by reorder handlers below) ───────────────────────────────
  const filterCategories = namedFilters.map((filter, idx) => ({
    id: filterCategoryId(filter.id),
    dimensionId: FILTER_DIMENSION_ID,
    name: filter.name,
    color: filter.color || PRESET_COLORS[idx % PRESET_COLORS.length],
    dynamic: true,
    filterId: filter.id,
  }))
  const dynamicDimensions = [...dimensions, { id: FILTER_DIMENSION_ID, name: 'Filters', dynamic: true }]
  const dynamicCategories = [...categories, ...filterCategories]
  const isFilterDimension = containerDimId === FILTER_DIMENSION_ID
  const containerCats = dynamicCategories.filter(c => c.dimensionId === containerDimId)

  // ── Category reorder ────────────────────────────────────────────────────────
  const handleCatDragOver = (overCatId, side) => {
    if (isFilterDimension) return
    const overIdx = containerCats.findIndex(c => c.id === overCatId)
    if (overIdx === -1) return
    setCatInsertIdx(side === 'before' ? overIdx : overIdx + 1)
  }

  const reorderCatsDrop = async () => {
    if (isFilterDimension) return
    if (!catDragId || catInsertIdx === null) return
    const oldIdx = containerCats.findIndex(c => c.id === catDragId)
    if (oldIdx === -1) return
    const reordered = [...containerCats]
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
    const idx = containerCats.findIndex(c => c.id === catId)
    if (idx === catInsertIdx) return 'before'
    if (idx + 1 === catInsertIdx) return 'after'
    return null
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const getGoalLegendColor = goalId => {
    if (!legendDimId) return null
    if (legendDimId === FILTER_DIMENSION_ID) {
      const match = filterCategories.find(cat => filterMatchesGoal(namedFilters.find(f => f.id === cat.filterId), goalId, assignments))
      return match?.color ?? null
    }
    const catId = assignments[goalId]?.[legendDimId]
    if (!catId) return null
    return categories.find(c => c.id === catId)?.color ?? null
  }

  const activeFilters = activeFilterIds
    .map(id => namedFilters.find(filter => filter.id === id))
    .filter(Boolean)

  const hasActiveFiltering = activeFilters.length > 0 || quickFilters.length > 0
  const matchesQuickFilter = goal => quickFilters.some(f => assignments[goal.id]?.[f.dimId] === f.catId)

  const visibleGoals = hasActiveFiltering
    ? goals.filter(g => activeFilters.some(filter => filterMatchesGoal(filter, g.id, assignments)) || matchesQuickFilter(g))
    : goals

  const goalsForCat = catId => {
    if (containerDimId === FILTER_DIMENSION_ID) {
      const filterId = filterIdFromCategoryId(catId)
      const filter = namedFilters.find(f => f.id === filterId)
      return filter ? visibleGoals.filter(g => filterMatchesGoal(filter, g.id, assignments)) : []
    }
    return visibleGoals.filter(g => assignments[g.id]?.[containerDimId] === catId)
      .sort((a, b) => (assignmentOrders[a.id]?.[containerDimId] ?? Number.MAX_SAFE_INTEGER) - (assignmentOrders[b.id]?.[containerDimId] ?? Number.MAX_SAFE_INTEGER))
  }
  const unassignedGoals = containerDimId
    ? (containerDimId === FILTER_DIMENSION_ID
      ? visibleGoals.filter(g => !namedFilters.some(filter => filterMatchesGoal(filter, g.id, assignments)))
      : visibleGoals.filter(g => !assignments[g.id]?.[containerDimId]))
    : visibleGoals

  const reorderGoalInCategory = async (catId, dragGoalId, targetGoalId) => {
    if (!containerDimId || !catId || dragGoalId === targetGoalId) return
    if (assignments[dragGoalId]?.[containerDimId] !== catId || assignments[targetGoalId]?.[containerDimId] !== catId) return
    const laneGoals = goalsForCat(catId)
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
        next[goalId] = { ...(next[goalId] ?? {}), [containerDimId]: idx }
      })
      return next
    })
    try { await api.reorderAssignments(containerDimId, catId, goalIds) }
    catch (e) { console.error(e) }
  }

  const visibleContainerCats = containerCats.filter(c => !collapsedCatIds.has(c.id))
  const numBoxes = visibleContainerCats.length + 1
  const gridCols = Math.min(numBoxes, maxGridCols)
  const colTemplate = gridCols === 1 ? 'min(100%, 480px)' : '1fr'
  const gridStyle = {
    gridTemplateColumns: `repeat(${gridCols}, ${colTemplate})`,
    justifyContent: gridCols === 1 ? 'center' : undefined,
  }

  const confirmDim = dimensions.find(d => d.id === confirmDeleteDimId)

  return (
    <div
      className={`${styles.page} ${paintCat ? styles.paintMode : ''}`}
      style={paintCat ? { cursor: makeColorCursor(paintCat.color) } : undefined}
      onClick={paintCat ? () => setPaintCat(null) : undefined}
    >
      <ClassificationToolbar
        dimensions={dynamicDimensions}
        containerDimId={containerDimId}
        onContainerDimChange={setContainerDimId}
        onCreateDim={createDimension}
        onRenameDim={renameDimension}
        onRequestDeleteDim={setConfirmDeleteDimId}
        maxGridCols={maxGridCols}
        onMaxGridColsChange={setMaxGridCols}
      />

      <div className={styles.body}>
        {/* Collapsed categories strip */}
        {(collapsedCatIds.size > 0 || unassignedCollapsed) && (
          <div className={styles.collapsedStrip}>
            {containerCats.filter(c => collapsedCatIds.has(c.id)).map(cat => (
              <button key={cat.id} className={styles.collapsedChip}
                style={{ borderColor: cat.color, borderStyle: cat.dynamic ? 'dashed' : undefined }}
                onClick={() => setCollapsedCatIds(prev => { const n = new Set(prev); n.delete(cat.id); return n })}>
                <span className={styles.collapsedDot} style={{ background: cat.color }} />
                <span style={{ color: '#444' }}>{cat.name}</span>
                {cat.dynamic && <span style={{ color: '#888', fontWeight: 700 }}> Filter</span>}
                <span style={{ color: '#aaa', fontWeight: 400 }}> {goalsForCat(cat.id).length}</span>
              </button>
            ))}
            {unassignedCollapsed && (
              <button className={styles.collapsedChip}
                style={{ borderColor: '#ccc' }}
                onClick={() => setUnassignedCollapsed(false)}>
                <span className={styles.collapsedDot} style={{ background: '#ccc' }} />
                <span style={{ color: '#444' }}>Unassigned</span>
                <span style={{ color: '#aaa', fontWeight: 400 }}> {unassignedGoals.length}</span>
              </button>
            )}
          </div>
        )}

        <div className={styles.canvas} style={gridStyle}
          onDragOver={e => { if (e.dataTransfer.types.includes('catdrag')) e.preventDefault() }}
          onDrop={e => { if (e.dataTransfer.types.includes('catdrag')) { reorderCatsDrop(); catDragCleanup() } }}
        >
          {containerCats.filter(c => !collapsedCatIds.has(c.id)).map(cat => (
            <ContainerBox key={cat.id} cat={cat} goals={goalsForCat(cat.id)}
              onDrop={cat.dynamic ? undefined : goalId => assignGoal(goalId, cat.id)}
              onEdit={() => cat.dynamic ? setEditingFilter(namedFilters.find(f => f.id === cat.filterId)) : setEditCat(cat)}
              onCollapse={() => setCollapsedCatIds(prev => new Set([...prev, cat.id]))}
              paintCat={paintCat} onPaint={paintGoal} getGoalColor={getGoalLegendColor}
              onCatDragStart={setCatDragId}
              onCatDragEnd={catDragCleanup}
              onCatDragOver={handleCatDragOver}
              onCatDrop={() => { reorderCatsDrop(); catDragCleanup() }}
              onReorderGoal={reorderGoalInCategory}
              insertSide={getCatInsertSide(cat.id)}
              isDraggingCat={catDragId === cat.id}
              dynamic={cat.dynamic}
              onGoalOpen={onGoalOpen}
            />
          ))}
          {!unassignedCollapsed && (
            <ContainerBox cat={null} goals={unassignedGoals}
              onDrop={goalId => assignGoal(goalId, null)}
              onCollapse={() => setUnassignedCollapsed(true)}
              onReorderGoal={reorderGoalInCategory}
              paintCat={paintCat} onPaint={paintGoal} getGoalColor={getGoalLegendColor}
              onGoalOpen={onGoalOpen} />
          )}
          {containerDimId && containerDimId !== FILTER_DIMENSION_ID && <AddCatBox onAdd={name => createCategory(containerDimId, name, PRESET_COLORS[containerCats.length % PRESET_COLORS.length])} />}
        </div>

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
          onPaintActivate={activatePaint}
          onEditCat={setEditCat}
          onCreateCat={createCategory}
        />

      </div>

      {/* Confirm delete dimension */}
      {confirmDim && createPortal(
        <div className={styles.modalBackdrop} onClick={() => setConfirmDeleteDimId(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <p className={styles.confirmText}>
              Delete dimension <strong>"{confirmDim.name}"</strong>?
              All its categories will be removed and any goals assigned to them will be unassigned.
              The goals themselves won't be deleted.
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
    </div>
  )
}
